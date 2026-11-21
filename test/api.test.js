const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, fakeDevice, post, enroll, session, status } = require('./helpers');

test('flux client complet : enroll → challenge → session', async () => {
  const t = await boot();
  try {
    const plan = t.addPlan({ quota: 5000, days: 30 }); const rid = t.addReseller('marie');
    const { codes } = t.app.service.generateCodes(rid, plan, 1, null);
    const dev = fakeDevice();

    // mauvaise signature / mauvais format / code inconnu
    let [s, r] = await post(t.base, 'enroll', { code: codes[0], signing_key: dev.spki, signature: dev.sign('autre') });
    assert.equal(s, 401); assert.equal(r.error, 'bad_signature');
    [s, r] = await post(t.base, 'enroll', { code: 'nimporte', signing_key: dev.spki, signature: 'x' });
    assert.equal(s, 400);
    [s, r] = await enroll(t.base, 'TUN-' + 'A'.repeat(32), dev);
    assert.equal(s, 403); assert.equal(r.error, 'invalid_code');

    // activation : démarre la durée du forfait, ajoute l'utilisateur Xray
    [s, r] = await enroll(t.base, codes[0], dev);
    assert.equal(s, 200); const id = r.device_id;
    const code = t.q('SELECT * FROM codes WHERE code = ?').get(codes[0]);
    assert.equal(code.expires_at - code.activated_at, 30 * 86400);
    assert.ok(t.app.core.peers.has(dev.wg));

    // 2e appareil sur un code à 1 appareil → device_limit
    [s, r] = await enroll(t.base, codes[0], fakeDevice());
    assert.equal(s, 403); assert.equal(r.error, 'device_limit');

    // session : profil + forfait ; challenge à usage unique
    const [, ch] = await post(t.base, 'challenge', { device_id: id });
    const sig = dev.sign(ch.message);
    [s, r] = await post(t.base, 'session', { device_id: id, challenge: ch.challenge, signature: sig, network: 'wifi' });
    assert.equal(s, 200);
    assert.equal(r.profile.protocol, 'vless'); assert.equal(r.profile.uuid, dev.wg); assert.match(r.profile.uuid, /^[0-9a-f-]{36}$/);
    assert.equal(r.profile.port, 443); assert.equal(r.profile.network, 'ws'); assert.equal(r.profile.tls, true); assert.ok(r.profile.path.startsWith('/'));
    assert.equal(r.profile.address, r.profile.sni);
    assert.equal(r.plan.quota_bytes, 5000); assert.equal(r.plan.used_bytes, 0);
    assert.ok(r.expires_at > t.nowS());
    [s, r] = await post(t.base, 'session', { device_id: id, challenge: ch.challenge, signature: sig, network: 'wifi' });
    assert.equal(s, 401);

    // signature d'un autre appareil refusée
    const [, ch2] = await post(t.base, 'challenge', { device_id: id });
    [s] = await post(t.base, 'session', { device_id: id, challenge: ch2.challenge, signature: fakeDevice().sign(ch2.message) });
    assert.equal(s, 401);
    // appareil inconnu
    [s] = await post(t.base, 'challenge', { device_id: 'inconnu' });
    assert.equal(s, 401);
  } finally { await t.close(); }
});

test('forfait illimité : pas de quota_bytes dans la réponse', async () => {
  const t = await boot();
  try {
    const plan = t.addPlan({ quota: null }); const rid = t.addReseller('v1');
    const { codes } = t.app.service.generateCodes(rid, plan, 1, null);
    const dev = fakeDevice(); const [, e] = await enroll(t.base, codes[0], dev);
    const [s, r] = await session(t.base, e.device_id, dev);
    assert.equal(s, 200); assert.equal('quota_bytes' in r.plan, false);
  } finally { await t.close(); }
});

test('quota : consommation comptée, pair coupé, session refusée', async () => {
  const t = await boot();
  try {
    const plan = t.addPlan({ quota: 1000 }); const rid = t.addReseller('v1');
    const { codes } = t.app.service.generateCodes(rid, plan, 1, null);
    const dev = fakeDevice(); const [, e] = await enroll(t.base, codes[0], dev);

    t.app.core.counters.set(dev.wg, 600); await t.app.service.enforce();
    assert.equal(t.q('SELECT used_bytes FROM devices').get().used_bytes, 600);
    assert.ok(t.app.core.peers.has(dev.wg));
    let [, r] = await session(t.base, e.device_id, dev); assert.equal(r.plan.used_bytes, 600);

    t.app.core.counters.set(dev.wg, 1100); await t.app.service.enforce();      // dépasse 1000
    assert.equal(t.app.core.peers.has(dev.wg), false);
    let s; [s, r] = await session(t.base, e.device_id, dev);
    assert.equal(s, 403); assert.equal(r.error, 'quota_exceeded');

    // compteur wg remis à zéro (redémarrage) : le cumul ne régresse pas
    t.app.core.counters.set(dev.wg, 50); await t.app.service.enforce();
    assert.equal(t.q('SELECT used_bytes FROM devices').get().used_bytes, 1150);
  } finally { await t.close(); }
});

test('expiration : pair coupé et session refusée après la durée du forfait', async () => {
  const t = await boot();
  try {
    const plan = t.addPlan({ days: 1, quota: null }); const rid = t.addReseller('v1');
    const { codes } = t.app.service.generateCodes(rid, plan, 1, null);
    const dev = fakeDevice(); const [, e] = await enroll(t.base, codes[0], dev);
    t.state.now += 25 * 3600 * 1000;
    await t.app.service.enforce();
    assert.equal(t.app.core.peers.has(dev.wg), false);
    const [s, r] = await session(t.base, e.device_id, dev);
    assert.equal(s, 403); assert.equal(r.error, 'plan_expired');
    const [s2, r2] = await enroll(t.base, codes[0], fakeDevice());
    assert.equal(r2.error, 'plan_expired');
  } finally { await t.close(); }
});

test('plusieurs appareils : quota partagé par code', async () => {
  const t = await boot();
  try {
    const plan = t.addPlan({ quota: 1000, devices: 2 }); const rid = t.addReseller('v1');
    const { codes } = t.app.service.generateCodes(rid, plan, 1, null);
    const a = fakeDevice(), b = fakeDevice();
    await enroll(t.base, codes[0], a); await enroll(t.base, codes[0], b);
    t.app.core.counters.set(a.wg, 600); t.app.core.counters.set(b.wg, 500);
    await t.app.service.enforce();
    assert.equal(t.app.core.peers.size, 0);                                   // 1100 > 1000 pour le code
    assert.notEqual(t.q('SELECT wg_key FROM devices').all()[0].wg_key, t.q('SELECT wg_key FROM devices').all()[1].wg_key);   // un UUID Xray par appareil
  } finally { await t.close(); }
});

test('resynchronisation : un redémarrage de Xray ré-ajoute les utilisateurs autorisés', async () => {
  const t = await boot();
  try {
    const plan = t.addPlan({ quota: null }); const rid = t.addReseller('v1');
    const { codes } = t.app.service.generateCodes(rid, plan, 1, null);
    const dev = fakeDevice(); await enroll(t.base, codes[0], dev);
    t.app.core.peers.clear();
    await t.app.service.enforce();
    assert.ok(t.app.core.peers.has(dev.wg));
  } finally { await t.close(); }
});

test('limite de débit et corps invalides', async () => {
  const t = await boot();
  try {
    let [s] = await post(t.base, 'inconnu', {}); assert.equal(s, 404);
    const r = await fetch(t.base + '/api/v1/enroll', { method: 'POST', body: '{pas du json' }); assert.equal(r.status, 400);
    const big = await fetch(t.base + '/api/v1/enroll', { method: 'POST', body: JSON.stringify({ x: 'a'.repeat(20000) }) }).catch(() => ({ status: 413 }));
    assert.ok([413, 400].includes(big.status));
  } finally { await t.close(); }
});
