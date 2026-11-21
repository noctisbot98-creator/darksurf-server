const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const os = require('os'), fs = require('fs'), path = require('path');
const { boot, fakeDevice, enroll } = require('./helpers');
const ACT = require('../src/activation');

test('le vendeur choisit 1 à 3 appareils par clé (max 3)', async () => {
  const t = await boot();
  try {
    const plan = t.addPlan({ credits: 1, devices: 1 }); const v = t.addReseller('marie', 50);
    const { codes } = t.app.service.generateCodes(v, plan, 1, 'Paul', 3);
    assert.equal(t.q('SELECT max_devices FROM codes WHERE code = ?').get(codes[0]).max_devices, 3);
    const devs = [fakeDevice(), fakeDevice(), fakeDevice(), fakeDevice()];
    for (let i = 0; i < 3; i++) assert.equal((await enroll(t.base, codes[0], devs[i]))[0], 200);
    assert.equal((await enroll(t.base, codes[0], devs[3]))[0], 403);          // 4e appareil refusé
    for (const bad of [4, 0, -1, 'x']) assert.throws(() => t.app.service.generateCodes(v, plan, 1, null, bad), (e) => e.code === 'bad_devices');
    const one = t.app.service.generateCodes(v, plan, 1, null).codes[0];       // sans choix : valeur du forfait
    assert.equal(t.q('SELECT max_devices FROM codes WHERE code = ?').get(one).max_devices, 1);
  } finally { await t.close(); }
});

test('forfait illimité : 30 Go par 24 h puis blocage, reprise après 24 h', async () => {
  const t = await boot();
  try {
    const plan = t.addPlan({ credits: 1, quota: null, days: 30 }); const v = t.addReseller('marie', 50);
    const code = t.app.service.generateCodes(v, plan, 1, null, 1).codes[0];
    const dev = fakeDevice(); assert.equal((await enroll(t.base, code, dev))[0], 200);
    const svc = t.app.service;
    await svc.enforce();                                                       // ouvre la fenêtre de 24 h
    assert.ok(t.q('SELECT day_start FROM codes WHERE code = ?').get(code).day_start);
    t.q('UPDATE devices SET used_bytes = ? WHERE code = ?').run(29e9, code);
    await svc.enforce();
    assert.equal(svc.dayBlock(t.q('SELECT * FROM codes WHERE code = ?').get(code), svc.usage(code, 0), t.nowS()), 0);
    t.q('UPDATE devices SET used_bytes = ? WHERE code = ?').run(30e9, code);
    const c = t.q('SELECT * FROM codes WHERE code = ?').get(code);
    assert.ok(svc.dayBlock(c, svc.usage(code, 0), t.nowS()) > t.nowS());       // bloqué
    t.state.now += 25 * 3600 * 1000;                                           // 25 h plus tard : nouvelle fenêtre
    await svc.enforce();
    const c2 = t.q('SELECT * FROM codes WHERE code = ?').get(code);
    assert.equal(svc.dayBlock(c2, svc.usage(code, 0), t.nowS()), 0);
  } finally { await t.close(); }
});

test('codes d\'activation vendeur : émission, vérification, mauvais téléphone, expiration', () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pub = ACT.publicB64(pem), dev = 'AAAA-BBBB-CCCC-DDDD-EEEE';
  const code = ACT.issue({ privatePem: pem, device: dev, days: 30, label: 'Jean' });
  assert.deepEqual(ACT.verify({ code, device: dev, publicB64: pub }).ok, true);
  assert.equal(ACT.verify({ code, device: '1111-2222-3333-4444-5555', publicB64: pub }).ok, false);
  assert.equal(ACT.verify({ code, device: dev, publicB64: pub, nowSec: Math.floor(Date.now() / 1000) + 31 * 86400 }).ok, false);
  assert.throws(() => ACT.issue({ privatePem: pem, device: 'xx' }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'act-')); process.env.DS_SELLER_KEY = path.join(dir, 'k.pem');
  assert.equal(ACT.readKey(), null); assert.equal(ACT.saveKey(pem), pub); assert.ok(ACT.readKey());
  assert.throws(() => ACT.saveKey('pas une clé'));
  delete process.env.DS_SELLER_KEY;
});

test('panel admin : page Activation vendeur (installer la clé puis émettre un code)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'act2-')); process.env.DS_SELLER_KEY = path.join(dir, 'k.pem');
  const t = await boot();
  try {
    t.addAdmin('patron');
    const H = { 'Content-Type': 'application/x-www-form-urlencoded' };
    const f = (o) => new URLSearchParams(o).toString();
    const l = await fetch(t.base + '/login', { method: 'POST', headers: H, body: f({ login: 'patron', password: 'Mot-de-passe-test' }), redirect: 'manual' });
    const cookie = l.headers.get('set-cookie').split(';')[0];
    let html = await (await fetch(t.base + '/admin/activation', { headers: { cookie } })).text();
    assert.match(html, /seller-private\.pem/);
    const csrf = html.match(/name="csrf" value="([0-9a-f]+)"/)[1];
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    let r = await fetch(t.base + '/admin/activation/key', { method: 'POST', headers: { ...H, cookie }, body: f({ csrf, pem }), redirect: 'manual' });
    assert.equal(r.status, 303);
    r = await fetch(t.base + '/admin/activation/issue', { method: 'POST', headers: { ...H, cookie }, body: f({ csrf, device: 'aaaa-bbbb-cccc-dddd-eeee', label: 'Jean', days: 7 }) });
    html = await r.text();
    const code = html.match(/class="mono"[^>]*>([A-Za-z0-9_.-]{40,})</)[1];
    assert.equal(ACT.verify({ code, device: 'AAAA-BBBB-CCCC-DDDD-EEEE', publicB64: ACT.publicB64(pem) }).ok, true);
  } finally { await t.close(); delete process.env.DS_SELLER_KEY; }
});
