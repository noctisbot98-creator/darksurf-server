const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, fakeDevice, enroll } = require('./helpers');
const { run } = require('../src/admin');

const form = (o) => new URLSearchParams(o).toString();
const H = { 'Content-Type': 'application/x-www-form-urlencoded' };

async function login(t, user, pw = 'Mot-de-passe-test') {
  const r = await fetch(t.base + '/login', { method: 'POST', headers: H, body: form({ login: user, password: pw }), redirect: 'manual' });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return { r, cookie };
}
const get = (t, path, cookie) => fetch(t.base + path, { headers: { cookie }, redirect: 'manual' });
const csrfOf = (html) => html.match(/name="csrf" value="([0-9a-f]+)"/)[1];

test('page de connexion : form#form, #login, #password (contrat de l\'appli vendeur)', async () => {
  const t = await boot();
  try {
    const html = await (await fetch(t.base + '/login')).text();
    for (const id of ['form', 'login', 'password']) assert.match(html, new RegExp(`id="${id}"`));
    const r = await fetch(t.base + '/login');
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal((await fetch(t.base + '/', { redirect: 'manual' })).status, 303);   // non connecté → /login
  } finally { await t.close(); }
});

test('connexion : cookie sécurisé, mauvais mot de passe refusé, limite de tentatives', async () => {
  const t = await boot();
  try {
    t.addReseller('marie');
    const ok = await login(t, 'marie');
    assert.equal(ok.r.status, 303);
    const setCookie = ok.r.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
    const bad = await login(t, 'marie', 'faux'); assert.equal(bad.r.status, 401);
    const unknown = await login(t, 'personne', 'faux'); assert.equal(unknown.r.status, 401);
    let last; for (let i = 0; i < 10; i++) last = await login(t, 'marie', 'faux');
    assert.equal(last.r.status, 429);
  } finally { await t.close(); }
});

test('génération de clés : CSRF, crédits débités, note échappée, bout en bout avec l\'appli client', async () => {
  const t = await boot();
  try {
    const plan = t.addPlan({ name: 'Mensuel', credits: 5, quota: 1e9 });
    t.addReseller('marie', 12);
    const { cookie } = await login(t, 'marie');
    const page = await (await get(t, '/sell', cookie)).text();
    const csrf = csrfOf(page);
    assert.match(page, /Mensuel/); assert.match(page, /5 crédits/);
    assert.match(page, /500 FCFA/);                                          // crédits ET FCFA affichés

    // sans jeton CSRF → refusé ; origine étrangère → refusé
    let r = await fetch(t.base + '/sell', { method: 'POST', headers: { ...H, cookie }, body: form({ plan, qty: 1 }) });
    assert.equal(r.status, 403);
    r = await fetch(t.base + '/sell', { method: 'POST', headers: { ...H, cookie, origin: 'https://evil.example' }, body: form({ csrf, plan, qty: 1 }) });
    assert.equal(r.status, 403);
    assert.equal(t.q('SELECT COUNT(*) n FROM codes').get().n, 0);

    // création : 2 clés × 5 = 10 crédits, la note HTML est échappée
    r = await fetch(t.base + '/sell', { method: 'POST', headers: { ...H, cookie }, body: form({ csrf, plan, qty: 2, note: '<script>alert(1)</script>' }) });
    const html = await r.text();
    assert.equal(r.status, 200);
    const codes = [...html.matchAll(/TUN-[A-Za-z0-9_-]{32}/g)].map((m) => m[0]);
    assert.ok(new Set(codes).size >= 2);
    assert.equal(t.q('SELECT balance FROM resellers').get().balance, 200);
    assert.equal(html.includes('<script>alert(1)</script>'), false);
    assert.match(html, /Crédits restants/);

    // crédits insuffisants (2 < 5) → rien n'est créé, rien n'est débité
    r = await fetch(t.base + '/sell', { method: 'POST', headers: { ...H, cookie }, body: form({ csrf, plan, qty: 1 }), redirect: 'manual' });
    assert.equal(r.status, 303);
    assert.equal(t.q('SELECT COUNT(*) n FROM codes').get().n, 2);
    assert.equal(t.q('SELECT balance FROM resellers').get().balance, 200);
    assert.match(await (await get(t, '/sell', cookie)).text(), /Crédits insuffisants/);

    // un client active une clé générée par le portail
    const dev = fakeDevice(); const [s] = await enroll(t.base, codes[0], dev);
    assert.equal(s, 200);
    assert.match(await (await get(t, '/codes', cookie)).text(), /Active/);
    assert.match(await (await get(t, '/devices', cookie)).text(), /Test phone/);
  } finally { await t.close(); }
});

test('appareils : désactiver, supprimer, révoquer ; isolation entre vendeurs', async () => {
  const t = await boot();
  try {
    const plan = t.addPlan({ quota: null });
    const r1 = t.addReseller('un'), r2 = t.addReseller('deux');
    const { codes } = t.app.service.generateCodes(r1, plan, 2, null);
    const a = fakeDevice(), b = fakeDevice();
    const [, ea] = await enroll(t.base, codes[0], a); await enroll(t.base, codes[1], b);

    const v1 = (await login(t, 'un')).cookie, v2 = (await login(t, 'deux')).cookie;
    const csrf1 = csrfOf(await (await get(t, '/codes', v1)).text()), csrf2 = csrfOf(await (await get(t, '/codes', v2)).text());
    const post = (cookie, csrf, path, extra = {}) => fetch(t.base + path, { method: 'POST', headers: { ...H, cookie }, body: form({ csrf, ...extra }), redirect: 'manual' });

    // le vendeur 2 ne peut ni voir ni toucher les appareils/codes du vendeur 1
    assert.doesNotMatch(await (await get(t, '/devices', v2)).text(), /Test phone/);
    await post(v2, csrf2, `/devices/${ea.device_id}/toggle`);
    assert.equal(t.q('SELECT disabled FROM devices WHERE id = ?').get(ea.device_id).disabled, 0);
    await post(v2, csrf2, '/codes/revoke', { code: codes[0] });
    assert.equal(t.q('SELECT revoked FROM codes WHERE code = ?').get(codes[0]).revoked, 0);

    // le propriétaire désactive → le pair est coupé immédiatement
    await post(v1, csrf1, `/devices/${ea.device_id}/toggle`);
    assert.equal(t.app.core.peers.has(a.wg), false);
    await post(v1, csrf1, `/devices/${ea.device_id}/toggle`);
    assert.ok(t.app.core.peers.has(a.wg));
    // révocation du code de b → pair coupé
    await post(v1, csrf1, '/codes/revoke', { code: codes[1] });
    assert.equal(t.app.core.peers.has(b.wg), false);
    // suppression libère la place
    await post(v1, csrf1, `/devices/${ea.device_id}/delete`);
    assert.equal(t.q('SELECT COUNT(*) n FROM devices WHERE code = ?').get(codes[0]).n, 0);
    assert.equal(t.app.core.peers.has(a.wg), false);
    const [s] = await enroll(t.base, codes[0], fakeDevice()); assert.equal(s, 200);
  } finally { await t.close(); }
});

test('export CSV protégé contre l\'injection de formules ; déconnexion', async () => {
  const t = await boot();
  try {
    const plan = t.addPlan(); const rid = t.addReseller('marie');
    t.app.service.generateCodes(rid, plan, 1, '=HYPERLINK("http://x")');
    const { cookie } = await login(t, 'marie');
    const r = await get(t, '/codes.csv', cookie);
    assert.match(r.headers.get('content-disposition'), /attachment/);
    const csv = await r.text();
    assert.match(csv, /"'=HYPERLINK/); assert.doesNotMatch(csv, /,"=HYPERLINK/);
    const csrf = csrfOf(await (await get(t, '/codes', cookie)).text());
    await fetch(t.base + '/logout', { method: 'POST', headers: { ...H, cookie }, body: form({ csrf }), redirect: 'manual' });
    assert.equal((await get(t, '/codes', cookie)).status, 303);                      // session détruite
  } finally { await t.close(); }
});

test('admin CLI : forfaits, vendeurs, crédits, désactivation', async () => {
  const t = await boot();
  try {
    assert.match(run(['add-plan', 'Gold', '--days', '30', '--quota-gb', '20', '--credits', '5'], t.app.db), /créé/);
    assert.match(run(['add-plan', 'Illimité', '--days', '30', '--unlimited', '--credits', '9', '--devices', '2'], t.app.db), /créé/);
    assert.throws(() => run(['add-plan', 'X', '--days', '30'], t.app.db));
    const out = run(['add-seller', 'marie', '--credits', '10'], t.app.db);
    const pw = out.match(/Mot de passe : (\S+)/)[1];
    assert.equal(run(['add-credit', 'marie', '5'], t.app.db), 'Crédits de marie : 15');
    assert.ok((await login(t, 'marie', pw)).r.status === 303);                   // mot de passe généré utilisable
    run(['disable-seller', 'marie'], t.app.db);
    assert.equal((await login(t, 'marie', pw)).r.status, 401);
    run(['enable-seller', 'marie'], t.app.db);
    assert.ok((await login(t, 'marie', pw)).r.status === 303);
    assert.throws(() => run(['add-seller', 'a'], t.app.db));
    assert.throws(() => run(['add-seller', 'valide', '--password', 'court'], t.app.db));
    assert.match(run(['add-admin', 'patron', '--password', 'Mot-de-passe-long'], t.app.db), /Administrateur/);
  } finally { await t.close(); }
});

test('contrôle d\'origine : navigateur réel (Origin: null + Sec-Fetch-Site) accepté seulement si same-origin', async () => {
  const t = await boot();
  try {
    t.addReseller('marie');
    const post = (headers) => fetch(t.base + '/login', { method: 'POST', redirect: 'manual', headers: { ...H, ...headers }, body: form({ login: 'marie', password: 'Mot-de-passe-test' }) });
    assert.equal((await post({ 'sec-fetch-site': 'same-origin', origin: 'null' })).status, 303);   // Referrer-Policy strict → Origin: null
    assert.equal((await post({ 'sec-fetch-site': 'cross-site', origin: `http://127.0.0.1` })).status, 403);
    assert.equal((await post({ 'sec-fetch-site': 'same-site' })).status, 403);
    assert.equal((await post({ origin: 'null' })).status, 403);                                    // ancien navigateur : refusé
    assert.equal((await fetch(t.base + '/login')).headers.get('referrer-policy'), 'same-origin');
  } finally { await t.close(); }
});
