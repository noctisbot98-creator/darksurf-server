const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, fakeDevice, enroll, session, status } = require('./helpers');
const dbMod = require('../src/db');
const { DatabaseSync } = require('node:sqlite');

const at = (t, iso) => { t.state.now = Date.parse(iso); };

test('grille Geny : 12 forfaits, prix en F, 1 appareil, idempotent', async () => {
  const t = await boot();
  try {
    assert.equal(t.app.service.seedPlans(), 12);
    assert.equal(t.app.service.seedPlans(), 0);
    const p = Object.fromEntries(t.q('SELECT * FROM plans').all().map((r) => [r.name, r]));
    assert.equal(Object.keys(p).length, 12);
    assert.deepEqual([p['Pass Flash'].price, p['Pass Flash'].hours, p['Pass Flash'].quota_bytes], [100, 24, 1e9]);
    assert.equal(p['Pass Journée'].price, 250);                      // 2,5 crédits
    assert.deepEqual([p['Pass Week-end'].hours, p['Pass Week-end'].price], [72, 500]);
    assert.deepEqual([p['Pass Mensuel Maxi'].price, p['Pass Mensuel Maxi'].quota_bytes, p['Pass Mensuel Maxi'].hours], [8000, null, 720]);
    assert.deepEqual([p['Pass 2 Semaines Illimité'].price, p['Pass 2 Semaines Illimité'].hours], [3600, 336]);
    assert.deepEqual([p['Nuit Blanche'].window_start, p['Nuit Blanche'].window_end], [0, 360]);
    assert.deepEqual([p['Pass Test'].price, p['Pass Test'].hours, p['Pass Test'].seller_limit, p['Pass Test'].quota_bytes], [0, 2, 3, null]);
    assert.ok(t.q('SELECT * FROM plans').all().every((r) => r.max_devices === 1));
  } finally { await t.close(); }
});

test('Pass Test : 3 clés par compte vendeur, ensuite c\'est fini ; gratuit ; non rechargeable', async () => {
  const t = await boot();
  try {
    t.app.service.seedPlans();
    const test_ = t.q("SELECT id FROM plans WHERE name = 'Pass Test'").get().id;
    const v = t.addReseller('marie', 0), w = t.addReseller('paul', 0);
    t.app.service.generateCodes(v, test_, 2, null);                  // gratuit : solde 0 suffit
    t.app.service.generateCodes(v, test_, 1, null);
    assert.throws(() => t.app.service.generateCodes(v, test_, 1, null), (e) => e.code === 'limit_reached' && e.status === 403);
    assert.equal(t.q('SELECT COUNT(*) n FROM codes WHERE reseller_id = ?').get(v.id).n, 3);
    t.app.service.generateCodes(w, test_, 3, null);                  // la limite est par compte
    assert.equal(t.app.service.plansFor(v).find((p) => p.id === test_).remaining, 0);
    assert.equal(t.app.service.plansFor(t.addAdmin()).find((p) => p.id === test_).remaining, null);
    // la clé test expire après 2 h exactement
    const { codes } = t.app.service.generateCodes(t.addReseller('zoe', 0), test_, 1, null);
    const dev = fakeDevice(); const [, e] = await enroll(t.base, codes[0], dev);
    assert.equal((await session(t.base, e.device_id, dev))[0], 200);
    t.state.now += 2 * 3600e3 + 2000;
    const [, st] = await status(t.base, e.device_id, dev);
    assert.equal(st.state, 'expired');
    assert.equal((await session(t.base, e.device_id, dev))[1].error, 'plan_expired');
    // pas de recharge avec un forfait d'essai
    await assert.rejects(t.app.service.rechargeCode(v, codes[0], test_), (e2) => ['trial_plan', 'not_found'].includes(e2.code));
  } finally { await t.close(); }
});

test('demi-crédit : Pass Journée 250 F débite 2,5 crédits', async () => {
  const t = await boot();
  try {
    t.app.service.seedPlans();
    const j = t.q("SELECT id FROM plans WHERE name = 'Pass Journée'").get().id;
    const v = t.addReseller('marie', 10);
    const r = t.app.service.generateCodes(v, j, 2, null);
    assert.equal(r.cost, 500); assert.equal(r.balance, 500);
    assert.equal(t.app.service.addCredits(v.id, '2,5', 'x'), 750);
    assert.throws(() => t.app.service.addCredits(v.id, '2,555', 'x'), (e) => e.code === 'bad_amount');
  } finally { await t.close(); }
});

test('Nuit Blanche : utilisable seulement de 00h à 06h (heure du Cameroun), fin à 06h', async () => {
  const t = await boot();
  try {
    t.app.service.seedPlans();
    const nb = t.q("SELECT id FROM plans WHERE name = 'Nuit Blanche'").get().id;
    const v = t.addReseller('marie', 10);
    const { codes } = t.app.service.generateCodes(v, nb, 1, null);
    at(t, '2026-11-09T23:30:00Z');                                  // 00h30 à Douala : dans la plage
    const dev = fakeDevice(); const [, e] = await enroll(t.base, codes[0], dev);
    assert.equal((await session(t.base, e.device_id, dev))[0], 200);
    assert.equal(t.q('SELECT expires_at FROM codes').get().expires_at, Date.parse('2026-11-10T05:00:00Z') / 1000);   // 06h00 locale
    at(t, '2026-11-10T04:59:00Z'); assert.equal((await status(t.base, e.device_id, dev))[1].state, 'active');
    at(t, '2026-11-10T05:00:30Z'); assert.equal((await status(t.base, e.device_id, dev))[1].state, 'expired');
    // activée en dehors de la plage : le forfait attend la prochaine nuit
    const { codes: c2 } = t.app.service.generateCodes(v, nb, 1, null);
    at(t, '2026-11-10T12:00:00Z');                                  // 13h locale
    const d2 = fakeDevice(); const [, e2] = await enroll(t.base, c2[0], d2);
    const [, st] = await status(t.base, e2.device_id, d2);
    assert.equal(st.state, 'outside_window'); assert.deepEqual(st.plan.window, { start: 0, end: 360 });
    const [code, body] = await session(t.base, e2.device_id, d2);
    assert.equal(code, 403); assert.equal(body.error, 'outside_window');
    at(t, '2026-11-10T23:10:00Z'); assert.equal((await session(t.base, e2.device_id, d2))[0], 200);   // 00h10 locale
  } finally { await t.close(); }
});

test('demandes de recharge : le vendeur demande, l\'admin accepte/refuse, journal + suppression de vendeur', async () => {
  const t = await boot();
  try {
    const v = t.addReseller('marie', 0), svc = t.app.service;
    assert.throws(() => svc.requestRecharge(v, 'abc'), (e) => e.code === 'bad_amount');
    svc.requestRecharge(v, '50'); svc.requestRecharge(v, '10');
    assert.equal(svc.adminStats().requests_pending, 2);
    const [first, second] = svc.listRequests().map((r) => r.id).sort();
    svc.decideRequest(first, true);
    assert.equal(t.q('SELECT balance FROM resellers WHERE id = ?').get(v.id).balance, 5000);
    svc.decideRequest(second, false);
    assert.equal(t.q('SELECT balance FROM resellers WHERE id = ?').get(v.id).balance, 5000);
    assert.throws(() => svc.decideRequest(first, true), (e) => e.code === 'not_found');      // déjà traitée : pas de double crédit
    svc.requestRecharge(v, 1); svc.requestRecharge(v, 1); svc.requestRecharge(v, 1);
    assert.throws(() => svc.requestRecharge(v, 1), (e) => e.code === 'too_many_requests');
    // suppression : refusée si le vendeur a des clés
    const plan = t.addPlan({ credits: 1 }); svc.generateCodes(v, plan, 1, null);
    assert.throws(() => svc.deleteSeller(v.id), (e) => e.code === 'seller_has_keys');
    const w = t.addReseller('paul', 0); svc.deleteSeller(w.id);
    assert.equal(t.q("SELECT COUNT(*) n FROM resellers WHERE login = 'paul'").get().n, 0);
    svc.audit('patron', 'Test', 'détail'); assert.equal(svc.auditLog()[0].action, 'Test');
    const info = await svc.serverInfo(); assert.ok(info.ram.total > 0);
  } finally { await t.close(); }
});

test('migration : une ancienne base (jours + crédits entiers) est convertie sans perte', () => {
  const f = require('os').tmpdir() + `/ds-mig-${process.pid}.db`;
  require('fs').rmSync(f, { force: true });
  const old = new DatabaseSync(f);
  old.exec(`CREATE TABLE plans (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, days INTEGER NOT NULL, quota_bytes INTEGER, credits INTEGER NOT NULL DEFAULT 1, max_devices INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE resellers (id INTEGER PRIMARY KEY, login TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'seller', credit INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0), active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_login INTEGER);
    CREATE TABLE credit_ledger (id INTEGER PRIMARY KEY, reseller_id INTEGER NOT NULL, delta INTEGER NOT NULL, balance_after INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT, note TEXT, created_at INTEGER NOT NULL);
    INSERT INTO plans (name, days, quota_bytes, credits) VALUES ('20 Go', 30, 20000000000, 5);
    INSERT INTO resellers (login, name, password_hash, credit, created_at) VALUES ('marie','M','x',7,1);
    INSERT INTO credit_ledger (reseller_id, delta, balance_after, kind, created_at) VALUES (1, 7, 7, 'recharge', 1);`);
  old.close();
  const db = dbMod.open(f);
  assert.deepEqual({ ...db.prepare('SELECT hours, price, seller_limit, window_start FROM plans').get() }, { hours: 720, price: 500, seller_limit: null, window_start: null });
  assert.equal(db.prepare('SELECT balance FROM resellers').get().balance, 700);
  assert.deepEqual({ ...db.prepare('SELECT delta, balance_after FROM credit_ledger').get() }, { delta: 700, balance_after: 700 });
  db.close(); dbMod.open(f).close();                                   // 2e ouverture : rien ne casse
  require('fs').rmSync(f, { force: true });
});
