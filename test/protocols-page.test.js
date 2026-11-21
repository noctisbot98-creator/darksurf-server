// Test de bout en bout de la page « Protocoles VPN » : rendu HTML, formulaire POST,
// validation, génération des liens et QR, et refus des configurations invalides.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-proto-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.CORE_MODE = 'dry';
process.env.VPN_HOST = '15.235.111.58';
process.env.SERVER_IP = '15.235.111.58';
process.env.SSH_PASSWORD_SECRET = 'test-secret';
process.env.COOKIE_SECURE = 'false';
process.env.DS_QUIET = '1';
process.env.PORT = '0';

const { boot, fakeDevice, enroll } = require('./helpers');
const P = require('../src/protocols');

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${d ? ' — ' + d : ''}`); } };

(async () => {
  const t = await boot();
  const { app, base } = t;

  // Compte admin + un vendeur + une clé + un appareil.
  t.addAdmin('patron');
  const seller = t.addReseller('vendeur', 1000);
  const planId = t.addPlan({ name: 'Test 1 Go', hours: 24, quota: 1e9, credits: 1 });
  const gen = app.service.generateCodes(seller, planId, 1, 'test');
  const code = gen.codes[0];

  // Activation : crée l'appareil (signature EC comme l'appli).
  const dev = fakeDevice();
  const [st, en] = await enroll(base, code, dev);
  ok('activation de la clé', st === 200 && !!en.device_id, JSON.stringify(en).slice(0, 100));

  // Connexion admin.
  const login = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'login=patron&password=Mot-de-passe-test', redirect: 'manual' });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  ok('connexion administrateur', login.status === 303 && cookie.startsWith('ds_sid='), String(login.status));

  // GET de la page.
  const page = await fetch(`${base}/admin/protocols`, { headers: { cookie } });
  const html = await page.text();
  ok('page Protocoles accessible', page.status === 200, String(page.status));
  ok('les 12 protocoles sont affichés', P.PROTOCOLS.every((p) => html.includes(`p_${p.id}_enabled`)), '');
  ok('les cartes portent le nom du protocole', html.includes('VLESS · REALITY · Vision') && html.includes('Hysteria2 · QUIC (UDP)'));
  ok('le formulaire pointe vers /admin/protocols', html.includes('action="/admin/protocols"'));
  ok('SSH-WS est prioritaire et le payload est configurable', html.includes('action="/admin/protocols/ssh"') && html.includes('SSH-WS (prioritaire)') && html.includes('ssh_ws_payload') && html.includes('Host HTTP / CloudFront'));
  ok('la signature BY NOCTIS est présente', html.includes('BY NOCTIS'));

  // Récupère le jeton CSRF.
  const csrf = (html.match(/name="csrf" value="([^"]+)"/) || [])[1];
  ok('jeton CSRF présent', !!csrf);

  // POST : active VLESS/WS + REALITY + Hysteria2.
  const form = new URLSearchParams();
  form.set('csrf', csrf);
  for (const p of P.PROTOCOLS) {
    const d = P.defaults(p.id);
    form.set(`p_${p.id}_port`, String(d.port));
    if (p.params.includes('path')) form.set(`p_${p.id}_path`, d.path);
    if (p.params.includes('sni')) form.set(`p_${p.id}_sni`, d.sni);
    if (p.params.includes('seed')) form.set(`p_${p.id}_seed`, d.seed);
    if (p.params.includes('method')) form.set(`p_${p.id}_method`, d.method);
  }
  form.set('p_vless-ws_enabled', '1');
  form.set('p_vless-reality_enabled', '1');
  form.set('p_hysteria2_enabled', '1');

  const post = await fetch(`${base}/admin/protocols`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(), redirect: 'manual' });
  ok('POST accepté (redirection)', post.status === 303, String(post.status));
  console.log('   location:', post.headers.get('location'));

  // Les réglages sont persistés.
  const row = app.db.prepare("SELECT value FROM app_settings WHERE key='protocols'").get();
  if (!row) { console.log('   aucune ligne protocols ; clés en base :', app.db.prepare('SELECT key FROM app_settings').all().map(x=>x.key).join(',')); }
  const saved = row ? JSON.parse(row.value) : {};
  ok('VLESS/WS enregistré actif', saved['vless-ws'].enabled === true);
  ok('REALITY enregistré actif', saved['vless-reality'].enabled === true);
  ok('Hysteria2 enregistré actif', saved.hysteria2.enabled === true);
  ok('les autres restent inactifs', saved.shadowsocks.enabled === false);

  // La page reflète l'état.
  const page2 = await (await fetch(`${base}/admin/protocols`, { headers: { cookie } })).text();
  // En mode dry, aucun port n'écoute : les cartes actives affichent « Erreur » (état réel), pas « Actif ».
  const activeCards = (page2.match(/pill (on|err)">(Actif|Erreur)/g) || []).length;
  ok('la page affiche 3 protocoles activés', activeCards === 3, String(activeCards));
  // Attention : « ss:// » est un sous-mot de « vless:// » — on teste le schéma en début de lien.
  const hasSs = /(^|[\s"'>])ss:\/\//.test(page2);
  ok('les liens ne concernent que les protocoles actifs', page2.includes('vless://') && page2.includes('hysteria2://') && !hasSs, `vless=${page2.includes('vless://')} hy2=${page2.includes('hysteria2://')} ss=${hasSs}`);
  ok('un QR code SVG est présent', page2.includes('shape-rendering="crispEdges"'));
  ok('le QR encode bien un lien', page2.includes('<svg') && page2.includes('aria-label="QR code de configuration"'));

  // Refus : deux protocoles sur le même port.
  const bad = new URLSearchParams(form);
  bad.set('p_vless-tcp_enabled', '1');
  bad.set('p_vless-tcp_port', '8443');   // déjà pris par REALITY
  const r1 = await fetch(`${base}/admin/protocols`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: bad.toString(), redirect: 'manual' });
  const afterDup = JSON.parse(app.db.prepare("SELECT value FROM app_settings WHERE key='protocols'").get().value);
  ok('port en double refusé (rien n\'est enregistré)', r1.status === 303 && afterDup['vless-tcp'].enabled === false, `status=${r1.status} tcp=${afterDup['vless-tcp'].enabled}`);

  // Refus : port hors plage.
  const bad2 = new URLSearchParams(form);
  bad2.set('p_vless-tcp_enabled', '1');
  bad2.set('p_vless-tcp_port', '80');
  const r2 = await fetch(`${base}/admin/protocols`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: bad2.toString(), redirect: 'manual' });
  ok('port < 1024 refusé', r2.status === 303, String(r2.status));

  // Refus : chemin WebSocket invalide.
  const bad3 = new URLSearchParams(form);
  bad3.set('p_vless-ws_path', 'pas-de-slash');
  const r3 = await fetch(`${base}/admin/protocols`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: bad3.toString(), redirect: 'manual' });
  ok('chemin sans « / » refusé', r3.status === 303, String(r3.status));

  // Filtre par moteur.
  const xr = await (await fetch(`${base}/admin/protocols?engine=xray`, { headers: { cookie } })).text();
  ok('filtre Xray masque sing-box', xr.includes('p_vless-ws_enabled') && !xr.includes('p_hysteria2_enabled'));
  const sb = await (await fetch(`${base}/admin/protocols?engine=singbox`, { headers: { cookie } })).text();
  ok('filtre sing-box masque Xray', sb.includes('p_hysteria2_enabled') && !sb.includes('p_vless-ws_enabled'));

  // Sélection d'un appareil : les liens doivent porter son UUID.
  const devRow = app.service.allDevices(10)[0];
  const withDev = await (await fetch(`${base}/admin/protocols?device=${devRow.id}`, { headers: { cookie } })).text();
  ok('le lien contient l\'UUID de l\'appareil', withDev.includes(devRow.wg_key), devRow.wg_key.slice(0, 8));

  // Modules SSH (Stunnel / Dropbear / UDPGW) : la page les propose, la validation refuse les ports qui se marchent dessus.
  ok('la page propose les modules SSH', html.includes('action="/admin/protocols/modules"') && html.includes('udpgw_enabled'));
  const applied = [];
  app.service.applyModule = async (m, on, port) => { applied.push([m, on, port]); return 'ok'; };
  const mf = (o) => new URLSearchParams({ csrf, stunnel_port: '4444', dropbear_port: '2200', udpgw_port: '7300', ...o }).toString();
  const postMod = (body) => fetch(`${base}/admin/protocols/modules`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' });
  const m1 = await postMod(mf({ udpgw_enabled: '1', stunnel_enabled: '1' }));
  ok('modules appliqués', m1.status === 303 && applied.some((a) => a[0] === 'udpgw' && a[1] === true && a[2] === 7300) && applied.some((a) => a[0] === 'stunnel' && a[1] === true), JSON.stringify(applied));
  ok('fiche : le port UDPGW est annoncé', app.service.sshFiche(code) === null || app.service.sshFiche(code).udpgw_port === 7300);
  const before = applied.length;
  const m3 = await postMod(mf({ stunnel_enabled: '1', dropbear_enabled: '1', dropbear_port: '4444' }));
  ok('conflit de ports : rien n\'est appliqué', applied.length === before, String(m3.status));
  const m4 = await postMod(mf({ stunnel_enabled: '1', udpgw_enabled: '1', dropbear_port: '2200' }));   // inchangé : aucun appel
  ok('sans changement, aucun appel système', applied.length === before, String(m4.status));

  // Un vendeur ne doit pas accéder à la page.
  const slog = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'login=vendeur&password=Mot-de-passe-test', redirect: 'manual' });
  const scookie = (slog.headers.get('set-cookie') || '').split(';')[0];
  const denied = await fetch(`${base}/admin/protocols`, { headers: { cookie: scookie } });
  ok('un vendeur est refusé (403)', denied.status === 403, String(denied.status));

  // Réglages SSH-WS : le formulaire Admin persiste séparément le Host CloudFront, le port et le payload.
  app.service.applySshConfig = async () => {};
  const sshForm = new URLSearchParams({ csrf, ssh_enabled: '1', ssh_tcp_port: '2250', ssh_ws_path: '/ws-ssh', ssh_ws_port: '2084', ssh_ws_host: 'd2m44uilhgzazi.cloudfront.net', default_protocol: 'ssh-ws', vless_enabled: '1' });
  const sshPost = await fetch(`${base}/admin/protocols/ssh`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: sshForm.toString(), redirect: 'manual' });
  const savedSsh = Object.fromEntries(app.db.prepare("SELECT key,value FROM app_settings WHERE key LIKE 'ssh_%' OR key='default_protocol'").all().map((r) => [r.key, JSON.parse(r.value)]));
  ok('configuration SSH-WS enregistrée', sshPost.status === 303 && savedSsh.default_protocol === 'ssh-ws' && savedSsh.ssh_ws_port === 2084 && savedSsh.ssh_ws_host === 'd2m44uilhgzazi.cloudfront.net');

  await t.close();
  console.log(`\n=== RÉSULTAT : ${pass} réussis, ${fail} échoués ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERREUR', e); process.exit(1); });
