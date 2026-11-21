const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, fakeDevice, post, enroll, session, status } = require('./helpers');

const form = (o) => new URLSearchParams(o).toString();
const H = { 'Content-Type': 'application/x-www-form-urlencoded' };
async function login(t, user, pw = 'Mot-de-passe-test') {
  const r = await fetch(t.base + '/login', { method: 'POST', headers: H, body: form({ login: user, password: pw }), redirect: 'manual' });
  return { r, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const get = (t, path, cookie) => fetch(t.base + path, { headers: { cookie }, redirect: 'manual' });
const csrfOf = (html) => html.match(/name="csrf" value="([0-9a-f]+)"/)[1];
const postForm = (t, cookie, csrf, path, extra = {}) => fetch(t.base + path, { method: 'POST', headers: { ...H, cookie }, body: form({ csrf, ...extra }), redirect: 'manual' });
const balance = (t, login) => t.q('SELECT balance FROM resellers WHERE login = ?').get(login).balance / 100;

// ------------------------------------------------------------------ crédits (service)

test('vente : chaque clé débite le prix du forfait en crédits, tout est journalisé', async () => {
  const t = await boot();
  try {
    const plan = t.addPlan({ name: '1 Go', credits: 1 }), big = t.addPlan({ name: '20 Go', credits: 5 });
    const v = t.addReseller('marie', 8);
    const a = t.app.service.generateCodes(v, plan, 3, 'Paul');          // 3 × 1 = 3
    assert.equal(a.cost, 300); assert.equal(a.balance, 500); assert.equal(balance(t, 'marie'), 5);
    const b = t.app.service.generateCodes(v, big, 1, null);             // 5
    assert.equal(b.balance, 0);
    // solde épuisé : plus aucune clé, aucun débit, aucune ligne créée
    assert.throws(() => t.app.service.generateCodes(v, plan, 1, null), (e) => e.code === 'insufficient_credit' && e.status === 402);
    assert.equal(t.q('SELECT COUNT(*) n FROM codes').get().n, 4);
    assert.equal(balance(t, 'marie'), 0);
    const led = t.q('SELECT delta, balance_after, kind FROM credit_ledger ORDER BY id').all();
    assert.deepEqual(led.map((l) => [l.delta, l.balance_after, l.kind]), [[-300, 500, 'sale'], [-500, 0, 'sale']]);
    // quantité hors limites / forfait inconnu
    assert.throws(() => t.app.service.generateCodes(v, plan, 0, null), (e) => e.code === 'bad_quantity');
    assert.throws(() => t.app.service.generateCodes(v, plan, 51, null), (e) => e.code === 'bad_quantity');
    assert.throws(() => t.app.service.generateCodes(v, 999, 1, null), (e) => e.code === 'bad_plan');
  } finally { await t.close(); }
});

test('vente : un forfait refusé ne débite rien même si le solde suffit pour une partie', async () => {
  const t = await boot();
  try {
    const plan = t.addPlan({ credits: 4 }); const v = t.addReseller('marie', 10);
    assert.throws(() => t.app.service.generateCodes(v, plan, 3, null), (e) => e.code === 'insufficient_credit');   // 12 > 10
    assert.equal(balance(t, 'marie'), 10); assert.equal(t.q('SELECT COUNT(*) n FROM codes').get().n, 0);
    assert.equal(t.q('SELECT COUNT(*) n FROM credit_ledger').get().n, 0);
  } finally { await t.close(); }
});

test('administrateur : ne vend pas (ni clé, ni recharge) ; tout passe par les vendeurs', async () => {
  const t = await boot();
  try {
    const plan = t.addPlan({ credits: 50 }); const admin = t.addAdmin();
    assert.throws(() => t.app.service.generateCodes(admin, plan, 1, 'test'), (e) => e.code === 'admin_cannot_sell' && e.status === 403);
    assert.equal(t.q('SELECT COUNT(*) n FROM codes').get().n, 0);
  } finally { await t.close(); }
});

test('recharge de clé : nouveau forfait dès maintenant, données remises à zéro, accès rétabli', async () => {
  const t = await boot();
  try {
    const small = t.addPlan({ name: '1 Ko', days: 1, quota: 1000, credits: 1 });
    const big = t.addPlan({ name: '2 Ko', days: 30, quota: 2000, credits: 2 });
    const v = t.addReseller('marie', 10);
    const { codes } = t.app.service.generateCodes(v, small, 1, 'Paul');            // -1 → 9
    const dev = fakeDevice(); const [, e] = await enroll(t.base, codes[0], dev);

    // données épuisées puis forfait expiré : le pair est coupé
    t.app.core.counters.set(dev.wg, 1500); await t.app.service.enforce();
    assert.equal(t.app.core.peers.has(dev.wg), false);
    let [s, r] = await session(t.base, e.device_id, dev); assert.equal(r.error, 'quota_exceeded');
    t.state.now += 3 * 86400 * 1000; await t.app.service.enforce();
    [s, r] = await session(t.base, e.device_id, dev); assert.equal(r.error, 'plan_expired');

    // le vendeur recharge la clé avec le grand forfait : -2 crédits
    const out = await t.app.service.rechargeCode(v, codes[0], big);
    assert.equal(out.cost, 200); assert.equal(out.balance, 700); assert.equal(balance(t, 'marie'), 7);
    assert.ok(t.app.core.peers.has(dev.wg), 'le pair est rétabli sans que le client ait à faire quoi que ce soit');
    [s, r] = await session(t.base, e.device_id, dev);
    assert.equal(s, 200); assert.equal(r.plan.name, '2 Ko'); assert.equal(r.plan.quota_bytes, 2000);
    assert.equal(r.plan.used_bytes, 0);                                              // données repartent de zéro
    assert.equal(r.plan.expires_at, t.nowS() + 30 * 86400);                          // jours repartent d'aujourd'hui

    // la nouvelle consommation est comptée à partir de zéro, et le quota 2000 s'applique
    t.app.core.counters.set(dev.wg, 1500 + 1900); await t.app.service.enforce();
    assert.ok(t.app.core.peers.has(dev.wg));
    t.app.core.counters.set(dev.wg, 1500 + 2100); await t.app.service.enforce();
    assert.equal(t.app.core.peers.has(dev.wg), false);
    assert.equal(t.q('SELECT kind, delta FROM credit_ledger ORDER BY id DESC').get().kind, 'renew');
  } finally { await t.close(); }
});

test('recharge de clé : refus propres (jamais activée, révoquée, clé d\'un autre, solde insuffisant)', async () => {
  const t = await boot();
  try {
    const plan = t.addPlan({ credits: 3, quota: null });
    const v = t.addReseller('marie', 10), w = t.addReseller('paul', 10);
    const { codes } = t.app.service.generateCodes(v, plan, 2, null);                  // 10 - 6 = 4
    await assert.rejects(t.app.service.rechargeCode(v, codes[0], plan), (e) => e.code === 'not_activated');
    await enroll(t.base, codes[0], fakeDevice());
    await assert.rejects(t.app.service.rechargeCode(w, codes[0], plan), (e) => e.code === 'not_found');
    await t.app.service.revokeCode(v, codes[0]);
    await assert.rejects(t.app.service.rechargeCode(v, codes[0], plan), (e) => e.code === 'code_revoked');
    await enroll(t.base, codes[1], fakeDevice());
    await t.app.service.rechargeCode(v, codes[1], plan);                              // 4 → 1
    await assert.rejects(t.app.service.rechargeCode(v, codes[1], plan), (e) => e.code === 'insufficient_credit');
    assert.equal(balance(t, 'marie'), 1);
  } finally { await t.close(); }
});

// ------------------------------------------------------------------ appli client

test('/status : état du forfait sans effet sur WireGuard, jamais de prix', async () => {
  const t = await boot();
  try {
    const plan = t.addPlan({ days: 1, quota: 1000, credits: 7 }); const v = t.addReseller('marie');
    const { codes } = t.app.service.generateCodes(v, plan, 1, null);
    const dev = fakeDevice(); const [, e] = await enroll(t.base, codes[0], dev);

    let [s, r] = await status(t.base, e.device_id, dev);
    assert.equal(s, 200); assert.equal(r.state, 'active'); assert.equal(r.plan.quota_bytes, 1000);
    assert.doesNotMatch(JSON.stringify(r), /credit|price|prix/i);
    [, r] = await session(t.base, e.device_id, dev);
    assert.doesNotMatch(JSON.stringify(r), /credit|price|prix/i);

    t.app.core.counters.set(dev.wg, 1200); await t.app.service.enforce();
    [, r] = await status(t.base, e.device_id, dev); assert.equal(r.state, 'quota_exceeded');
    t.state.now += 2 * 86400 * 1000; await t.app.service.enforce();
    [, r] = await status(t.base, e.device_id, dev); assert.equal(r.state, 'expired');
    assert.equal(t.app.core.peers.has(dev.wg), false, 'status ne ré-ouvre jamais l\'accès');

    // challenge à usage unique, signature obligatoire
    const [, ch] = await post(t.base, 'challenge', { device_id: e.device_id });
    [s] = await post(t.base, 'status', { device_id: e.device_id, challenge: ch.challenge, signature: fakeDevice().sign(ch.message) });
    assert.equal(s, 401);
    await t.app.service.revokeCode(v, codes[0]);
    [, r] = await status(t.base, e.device_id, dev); assert.equal(r.state, 'revoked');
  } finally { await t.close(); }
});

test('annonces : le client ne reçoit que les siennes, une seule fois (since_notice), jamais celles retirées/expirées', async () => {
  const t = await boot();
  try {
    const plan = t.addPlan({ quota: null }); const v = t.addReseller('marie');
    const { codes } = t.app.service.generateCodes(v, plan, 1, null);
    const dev = fakeDevice(); const [, e] = await enroll(t.base, codes[0], dev);
    const svc = t.app.service;
    svc.createNotice({ audience: 'clients', title: 'Maintenance', body: 'Coupure ce soir', days: 1 });
    svc.createNotice({ audience: 'sellers', title: 'Vendeurs', body: 'Réservé' });
    svc.createNotice({ audience: 'all', title: 'Tous', body: 'Bonjour' });
    let [, r] = await status(t.base, e.device_id, dev);
    assert.deepEqual(r.notices.map((n) => n.title).sort(), ['Maintenance', 'Tous']);
    const last = Math.max(...r.notices.map((n) => n.id));
    [, r] = await status(t.base, e.device_id, dev, last); assert.equal(r.notices.length, 0);
    svc.removeNotice(r.notices[0]?.id ?? 3);
    [, r] = await status(t.base, e.device_id, dev); assert.ok(!r.notices.some((n) => n.title === 'Tous'));
    t.state.now += 2 * 86400 * 1000;
    [, r] = await status(t.base, e.device_id, dev); assert.equal(r.notices.length, 0);        // « Maintenance » a expiré
    assert.throws(() => svc.createNotice({ audience: 'x', title: 'a', body: 'b' }), (er) => er.code === 'bad_notice');
  } finally { await t.close(); }
});

// ------------------------------------------------------------------ portail administrateur

test('portail admin : accès réservé, création de vendeur, recharge de crédits, corrections', async () => {
  const t = await boot();
  try {
    t.addAdmin('patron'); t.addReseller('marie', 0);
    const plan = t.addPlan({ name: '20 Go', credits: 5, quota: 20e9 });

    // un vendeur n'accède à rien d'administrateur
    const m = await login(t, 'marie');
    assert.equal((await get(t, '/admin', m.cookie)).status, 403);
    assert.equal((await get(t, '/admin/plans', m.cookie)).status, 403);
    const mcsrf = csrfOf(await (await get(t, '/sell', m.cookie)).text());
    assert.equal((await postForm(t, m.cookie, mcsrf, '/admin/sellers/1/credit', { amount: 99 })).status, 403);
    assert.equal(balance(t, 'marie'), 0);

    const a = await login(t, 'patron');
    assert.equal(a.r.headers.get('location'), '/');
    assert.equal((await get(t, '/', a.cookie)).headers.get('location'), '/admin');
    const dash = await (await get(t, '/admin', a.cookie)).text();
    const csrf = csrfOf(dash);
    assert.match(dash, /marie/); assert.match(dash, /Nouveau vendeur/);

    // création d'un vendeur : mot de passe généré, affiché une fois, utilisable
    let r = await postForm(t, a.cookie, csrf, '/admin/sellers', { login: 'Paul', name: 'Paul K', credits: 20, password: '' });
    let html = await r.text(); assert.equal(r.status, 200);
    const pw = html.match(/<p class="big mono">([^<]+)<\/p>/)[1];
    assert.ok(pw.length >= 10);
    assert.equal(balance(t, 'paul'), 20);
    assert.equal((await login(t, 'paul', pw)).r.status, 303);
    r = await postForm(t, a.cookie, csrf, '/admin/sellers', { login: 'paul', name: 'x', credits: 0 });      // doublon
    assert.equal(r.status, 303); assert.match(await (await get(t, '/admin/sellers/new', a.cookie)).text(), /existe déjà/);
    await postForm(t, a.cookie, csrf, '/admin/sellers', { login: 'a!', name: 'x' });
    assert.match(await (await get(t, '/admin/sellers/new', a.cookie)).text(), /Identifiant invalide/);

    // recharge : 100 F = 1 crédit ; le vendeur peut ensuite générer
    const marieId = t.q("SELECT id FROM resellers WHERE login = 'marie'").get().id;
    r = await postForm(t, a.cookie, csrf, `/admin/sellers/${marieId}/credit`, { amount: 12, mode: 'add', note: 'Orange 1 200 F' });
    assert.equal(r.status, 303); assert.equal(balance(t, 'marie'), 12);
    const sheet = await (await get(t, `/admin/sellers/${marieId}`, a.cookie)).text();
    assert.match(sheet, /Orange 1 200 F/); assert.match(sheet, /Recharge/);
    r = await postForm(t, m.cookie, mcsrf, '/sell', { plan, qty: 2 }); assert.equal(r.status, 200);
    assert.equal(balance(t, 'marie'), 2);

    // retrait (correction) : ne peut jamais rendre le solde négatif
    await postForm(t, a.cookie, csrf, `/admin/sellers/${marieId}/credit`, { amount: 1, mode: 'remove' });     // sans justification : refusé
    assert.equal(balance(t, 'marie'), 2);
    assert.match(await (await get(t, `/admin/sellers/${marieId}`, a.cookie)).text(), /justification/);
    await postForm(t, a.cookie, csrf, `/admin/sellers/${marieId}/credit`, { amount: 50, mode: 'remove', note: 'test' });
    assert.equal(balance(t, 'marie'), 2);
    assert.match(await (await get(t, `/admin/sellers/${marieId}`, a.cookie)).text(), /Crédits insuffisants/);
    await postForm(t, a.cookie, csrf, `/admin/sellers/${marieId}/credit`, { amount: 2, mode: 'remove', note: 'erreur de saisie' });
    assert.equal(balance(t, 'marie'), 0);
    for (const bad of ['0', '-3', 'abc', '2000000']) {
      await postForm(t, a.cookie, csrf, `/admin/sellers/${marieId}/credit`, { amount: bad, mode: 'add' });
      assert.equal(balance(t, 'marie'), 0);
    }

    // le tableau de bord de l'admin voit les clés, la consommation et les crédits de chaque vendeur
    const dev = fakeDevice();
    const code = t.q('SELECT code FROM codes').get().code;
    const [, e] = await enroll(t.base, code, dev);
    t.app.core.counters.set(dev.wg, 5e9); await t.app.service.enforce();
    const detail = await (await get(t, `/admin/sellers/${marieId}`, a.cookie)).text();
    assert.match(detail, /5\.00 Go/); assert.match(detail, /20 Go/); assert.match(detail, /Active/);
    const dash2 = await (await get(t, '/admin', a.cookie)).text();
    assert.match(dash2, /5\.00 Go/);

    // désactivation : connexion refusée, session coupée
    await postForm(t, a.cookie, csrf, `/admin/sellers/${marieId}/toggle`);
    assert.equal((await login(t, 'marie')).r.status, 401);
    assert.equal((await get(t, '/sell', m.cookie)).status, 303);
    // l'admin révoque une clé depuis la fiche vendeur
    await postForm(t, a.cookie, csrf, '/codes/revoke', { code, back: `/admin/sellers/${marieId}` });
    assert.equal(t.q('SELECT revoked FROM codes WHERE code = ?').get(code).revoked, 1);
    assert.equal(t.app.core.peers.has(dev.wg), false);
    // redirection « back » limitée aux fiches vendeur (pas de redirection ouverte)
    const o = await postForm(t, a.cookie, csrf, '/codes/revoke', { code: 'TUN-' + 'B'.repeat(32), back: 'https://evil.example' });
    assert.equal(o.headers.get('location'), '/codes');
    // nouveau mot de passe
    r = await postForm(t, a.cookie, csrf, `/admin/sellers/${marieId}/password`);
    assert.equal(r.status, 200);
  } finally { await t.close(); }
});

test('portail admin : forfaits (1 crédit = 100 F), annonces, versions', async () => {
  const t = await boot();
  try {
    t.addAdmin('patron'); t.addReseller('marie', 10);
    const a = await login(t, 'patron');
    const csrf = csrfOf(await (await get(t, '/admin/plans', a.cookie)).text());

    await postForm(t, a.cookie, csrf, '/admin/plans', { name: '5 Go · 7 jours', duration: 7, unit: 'days', quota_gb: '5', credits: 2 });
    await postForm(t, a.cookie, csrf, '/admin/plans', { name: 'Illimité', duration: 30, unit: 'days', unlimited: '1', credits: 12 });
    const plans = t.q('SELECT * FROM plans ORDER BY id').all();
    assert.equal(plans.length, 2); assert.equal(plans[0].quota_bytes, 5e9); assert.equal(plans[1].quota_bytes, null);
    const page = await (await get(t, '/admin/plans', a.cookie)).text();
    assert.match(page, /200 FCFA/); assert.match(page, /1[\s\u202f\u00a0]?200 FCFA/);
    // paramètres invalides / doublons
    await postForm(t, a.cookie, csrf, '/admin/plans', { name: 'Illimité', duration: 30, unit: 'days', unlimited: '1', credits: 1 });
    assert.equal(t.q('SELECT COUNT(*) n FROM plans').get().n, 2);
    await postForm(t, a.cookie, csrf, '/admin/plans', { name: 'Prix invalide', duration: 30, unit: 'days', unlimited: '1', credits: 'abc' });
    assert.equal(t.q('SELECT COUNT(*) n FROM plans').get().n, 2);

    // changer le prix n'affecte que les ventes futures ; retirer un forfait ne coupe pas les clés vendues
    const v = { id: t.q("SELECT id FROM resellers WHERE login='marie'").get().id, role: 'seller' };
    const { codes } = t.app.service.generateCodes(v, plans[0].id, 1, null);                // -2
    const dev = fakeDevice(); await enroll(t.base, codes[0], dev);
    await postForm(t, a.cookie, csrf, `/admin/plans/${plans[0].id}`, { credits: 4 });
    assert.equal(t.q('SELECT price FROM plans WHERE id = ?').get(plans[0].id).price, 400);
    await postForm(t, a.cookie, csrf, `/admin/plans/${plans[0].id}`, { active: '0' });
    await t.app.service.enforce();
    assert.ok(t.app.core.peers.has(dev.wg));
    const m = await login(t, 'marie');
    const sell = await (await get(t, '/sell', m.cookie)).text();
    assert.doesNotMatch(sell, /5 Go · 7 jours/); assert.match(sell, /Illimité/); assert.match(sell, /12 crédits/);
    assert.match(sell, /FCFA/);                                              // crédits ET FCFA affichés

    // annonce vendeurs → visible dans le portail vendeur
    await postForm(t, a.cookie, csrf, '/admin/notices', { audience: 'sellers', title: 'Nouveaux tarifs', body: 'Voir la grille', days: '' });
    assert.match(await (await get(t, '/sell', m.cookie)).text(), /Nouveaux tarifs/);
    const nid = t.q('SELECT id FROM notices').get().id;
    await postForm(t, a.cookie, csrf, `/admin/notices/${nid}/remove`);
    assert.doesNotMatch(await (await get(t, '/sell', m.cookie)).text(), /Nouveaux tarifs/);
    assert.equal((await get(t, '/admin/releases', a.cookie)).status, 200);
  } finally { await t.close(); }
});

test('recharge de clé depuis le portail vendeur', async () => {
  const t = await boot();
  try {
    const small = t.addPlan({ name: 'Petit', quota: 100, credits: 1 }), big = t.addPlan({ name: 'Grand', quota: 5000, credits: 3 });
    const v = t.addReseller('marie', 10);
    const { codes } = t.app.service.generateCodes(v, small, 1, 'Paul');
    const dev = fakeDevice(); await enroll(t.base, codes[0], dev);
    t.app.core.counters.set(dev.wg, 500); await t.app.service.enforce();
    assert.equal(t.app.core.peers.has(dev.wg), false);

    const { cookie } = await login(t, 'marie');
    const list = await (await get(t, '/codes', cookie)).text();
    const csrf = csrfOf(list);
    assert.match(list, /Données épuisées/); assert.match(list, /Recharger/);
    const form1 = await (await get(t, `/recharge?code=${codes[0]}`, cookie)).text();
    assert.match(form1, /Grand/); assert.match(form1, /3 crédits/);
    const r = await postForm(t, cookie, csrf, '/recharge', { code: codes[0], plan: big });
    assert.equal(r.status, 303); assert.equal(balance(t, 'marie'), 6);
    assert.ok(t.app.core.peers.has(dev.wg));
    assert.match(await (await get(t, '/codes', cookie)).text(), /Grand/);
    assert.match(await (await get(t, '/credits', cookie)).text(), /Recharge de clé/);
    // une clé inconnue → 404
    assert.equal((await get(t, '/recharge?code=TUN-' + 'Z'.repeat(32), cookie)).status, 404);
  } finally { await t.close(); }
});

test('portail : forfaits Geny chargés depuis la page, demande de recharge, journal, toutes les pages répondent', async () => {
  const t = await boot();
  try {
    t.addAdmin('patron'); t.addReseller('marie', 3);
    const a = await login(t, 'patron');
    const csrf = csrfOf(await (await get(t, '/admin/plans', a.cookie)).text());
    assert.equal((await postForm(t, a.cookie, csrf, '/admin/plans/seed', {})).status, 303);
    assert.equal(t.q('SELECT COUNT(*) n FROM plans').get().n, 12);
    const plansHtml = await (await get(t, '/admin/plans', a.cookie)).text();
    assert.match(plansHtml, /Nuit Blanche/); assert.match(plansHtml, /00h–06h/); assert.match(plansHtml, /3 clés max par vendeur/);
    const m = await login(t, 'marie');
    const sell = await (await get(t, '/sell', m.cookie)).text();
    assert.match(sell, /Pass Test/); assert.match(sell, /Gratuit/); assert.match(sell, /2,5 crédits/); assert.match(sell, /Il te reste 3 clés/);
    const mcsrf = csrfOf(sell);
    let r = await postForm(t, m.cookie, mcsrf, '/credits/request', { credits: '20' }); assert.equal(r.status, 303);
    assert.match(await (await get(t, '/credits', m.cookie)).text(), /En attente/);
    assert.match(await (await get(t, '/credits', m.cookie)).text(), /621 86 21 34/);
    const reqs = await (await get(t, '/admin/requests', a.cookie)).text();
    assert.match(reqs, /marie/);
    const id = t.q('SELECT id FROM credit_requests').get().id;
    assert.equal((await postForm(t, m.cookie, mcsrf, `/admin/requests/${id}/accept`, {})).status, 403);   // un vendeur ne peut pas s'auto-créditer
    await postForm(t, a.cookie, csrf, `/admin/requests/${id}/accept`, {});
    assert.equal(balance(t, 'marie'), 23);
    for (const p of ['/admin', '/admin/audit', '/admin/plans', '/admin/requests', '/admin/notices', '/admin/releases']) assert.equal((await get(t, p, a.cookie)).status, 200, p);
    assert.match(await (await get(t, '/admin/audit', a.cookie)).text(), /Demande acceptée/);
    // Pass Test épuisé : désactivé dans la liste, refusé côté serveur
    const pt = t.q("SELECT id FROM plans WHERE name = 'Pass Test'").get().id;
    await postForm(t, m.cookie, mcsrf, '/sell', { plan: pt, qty: 3 });
    assert.match(await (await get(t, '/sell', m.cookie)).text(), /Épuisé/);
    await postForm(t, m.cookie, mcsrf, '/sell', { plan: pt, qty: 1 });
    assert.match(await (await get(t, '/sell', m.cookie)).text(), /Limite atteinte/);
    // suppression d'un vendeur sans clé, depuis le portail
    const pid = t.addReseller('paul', 0).id;
    await postForm(t, a.cookie, csrf, `/admin/sellers/${pid}/delete`, {});
    assert.equal(t.q("SELECT COUNT(*) n FROM resellers WHERE login = 'paul'").get().n, 0);
  } finally { await t.close(); }
});
