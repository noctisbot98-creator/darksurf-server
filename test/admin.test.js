const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, fakeDevice, enroll } = require('./helpers');

const H = { 'Content-Type': 'application/x-www-form-urlencoded' };
const form = (o) => new URLSearchParams(o).toString();
async function login(t, user) {
  const r = await fetch(t.base + '/login', { method: 'POST', headers: H, body: form({ login: user, password: 'Mot-de-passe-test' }), redirect: 'manual' });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const get = (t, path, cookie) => fetch(t.base + path, { headers: { cookie }, redirect: 'manual' });
const csrfOf = (html) => html.match(/name="csrf" value="([0-9a-f]+)"/)[1];
const post = (t, cookie, csrf, path, extra = {}) => fetch(t.base + path, { method: 'POST', headers: { ...H, cookie }, body: form({ csrf, ...extra }), redirect: 'manual' });

test('admin : vue en direct des clients (en ligne, états, filtres, recherche, fiche détaillée)', async () => {
  const t = await boot();
  try {
    const svc = t.app.service;
    const plan = t.addPlan({ name: 'Pass Flash', credits: 1, quota: 1000 });
    const marie = t.addReseller('marie', 10), paul = t.addReseller('paul', 10);
    const { codes: [c1, c2] } = svc.generateCodes(marie, plan, 2, 'Client A');
    const { codes: [c3] } = svc.generateCodes(paul, plan, 1, null);
    const d1 = fakeDevice(); const [, e1] = await enroll(t.base, c1, d1);
    t.app.core.counters.set(d1.wg, 400);
    await svc.enforce();
    // pas encore de poignée de main : hors ligne
    let r = await svc.adminClients();
    assert.equal(r.total, 3); assert.equal(r.counts.online, 0); assert.equal(r.counts.active, 1); assert.equal(r.counts.unused, 2);
    // WireGuard signale une poignée de main récente : en ligne
    t.app.core.hs = new Map([[d1.wg, svc.now() - 20]]);
    r = await svc.adminClients();
    assert.equal(r.counts.online, 1);
    const row = r.rows.find((c) => c.code === c1);
    assert.equal(row.online, true); assert.equal(row.used, 400); assert.equal(row.seller, 'marie'); assert.equal(row.devices.length, 1);
    assert.equal(r.bySeller.get(marie.id), 1);
    // poignée de main ancienne : hors ligne
    t.app.core.hs = new Map([[d1.wg, svc.now() - 600]]);
    assert.equal((await svc.adminClients()).counts.online, 0);
    // filtres et recherche
    assert.equal((await svc.adminClients({ seller: paul.id })).total, 1);
    assert.equal((await svc.adminClients({ state: 'unused' })).total, 2);
    assert.equal((await svc.adminClients({ q: 'paul' })).total, 1);
    assert.equal((await svc.adminClients({ q: c2.slice(0, 10) })).rows[0].code, c2);
    assert.equal((await svc.adminClients({ q: "%' OR 1=1 --" })).total, 0);
    // quota épuisé
    t.app.core.counters.set(d1.wg, 1500); await svc.enforce();
    assert.equal((await svc.adminClients({ state: 'quota' })).total, 1);
    const one = await svc.adminClient(c1);
    assert.equal(one.state, 'quota'); assert.equal(one.devices[0].used_bytes, 1500); assert.equal(one.price, 100);
    assert.equal(await svc.adminClient('TUN-inconnu'), null);
    void c3; void e1;
  } finally { await t.close(); }
});

test('admin : pages Clients / fiche / tableau de bord ; blocage d\'appareil ; un vendeur n\'y a pas accès', async () => {
  const t = await boot();
  try {
    t.addAdmin('patron'); const marie = t.addReseller('marie', 10);
    const plan = t.addPlan({ name: 'Pass Flash', credits: 1, quota: 1000 });
    const { codes: [c1] } = t.app.service.generateCodes(marie, plan, 1, 'Paul <b>');
    const d1 = fakeDevice(); await enroll(t.base, c1, d1);
    t.app.core.hs = new Map([[d1.wg, t.app.service.now() - 5]]);
    const a = await login(t, 'patron');
    const dash = await (await get(t, '/admin', a)).text();
    assert.match(dash, /Clients connectés maintenant/); assert.match(dash, /id="live"/); assert.match(dash, /setInterval/);
    const list = await (await get(t, '/admin/clients?state=online', a)).text();
    assert.match(list, /marie/); assert.match(list, /connecté/); assert.doesNotMatch(list, /<b>/);
    assert.equal((await get(t, '/admin/clients?state=revoked', a)).status, 200);
    const fiche = await (await get(t, `/admin/clients/${c1}`, a)).text();
    assert.match(fiche, new RegExp(c1)); assert.match(fiche, /Pass Flash/); assert.match(fiche, /connecté/); assert.match(fiche, /Libérer/);
    assert.equal((await get(t, '/admin/clients/TUN-introuvable1234', a)).status, 404);
    // bloquer l'appareil depuis la fiche
    const csrf = csrfOf(fiche); const devId = t.q('SELECT id FROM devices').get().id;
    const rr = await post(t, a, csrf, `/devices/${devId}/toggle`, { back: `/admin/clients/${c1}` });
    assert.equal(rr.status, 303); assert.equal(rr.headers.get('location'), `/admin/clients/${c1}`);
    assert.equal(t.q('SELECT disabled FROM devices').get().disabled, 1);
    // l'admin n'a pas de pages de vente
    for (const p of ['/sell', '/codes', '/credits']) assert.equal((await get(t, p, a)).headers.get('location'), '/admin', p);
    // un vendeur ne voit rien de tout ça
    const m = await login(t, 'marie');
    for (const p of ['/admin', '/admin/clients', `/admin/clients/${c1}`]) assert.equal((await get(t, p, m)).status, 403, p);
  } finally { await t.close(); }
});

test('mot de passe administrateur : modifiable, anciennes sessions coupées', async () => {
  const t = await boot();
  try {
    t.addAdmin('patron');
    const cookie = await login(t, 'patron');
    assert.equal((await get(t, '/admin', cookie)).status, 200);
    t.app.service.resetAdminPassword('patron', 'Un-autre-mot-de-passe-9');
    assert.equal((await get(t, '/admin', cookie)).status, 303);
    assert.throws(() => t.app.service.resetAdminPassword('patron', 'court'), (e) => e.code === 'bad_password');
    assert.throws(() => t.app.service.resetAdminPassword('inconnu', 'Un-autre-mot-de-passe-9'), (e) => e.code === 'not_found');
  } finally { await t.close(); }
});
