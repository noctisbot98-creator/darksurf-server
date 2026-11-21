// Démarre le panel avec des données de démonstration et capture la page Protocoles.
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-shot-'));
process.env.DB_PATH = path.join(tmp, 'demo.db');
process.env.CORE_MODE = 'dry';
process.env.VPN_HOST = '15.235.111.58';
process.env.SERVER_IP = '15.235.111.58';
process.env.SSH_PASSWORD_SECRET = 'demo-secret';
process.env.COOKIE_SECURE = 'false';
process.env.DS_QUIET = '1';
process.env.PORT = '8099';

const { createApp } = require('../src/server');
const P = require('../src/protocols');

(async () => {
  const app = createApp();
  await app.start();
  app.service.createAdmin('patron', 'Mot-de-passe-demo', 'Administrateur');
  const seller = app.service.createSeller({ login: 'vendeur', name: 'Vendeur Douala', password: 'Mot-de-passe-demo', credits: 50000 });
  app.service.createPlan({ name: 'Pass Flash 1 Go', hours: 24, quotaGb: 1, credits: 100, devices: 1 });
  const plan = app.service.allPlans()[0];
  const gen = app.service.generateCodes(app.service.getSeller(seller), plan.id, 1, 'demo');
  const code = gen.codes[0];

  // Active un appareil comme le ferait l'appli.
  const crypto = require('crypto');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const sign = (m) => crypto.sign('sha256', Buffer.from(m), privateKey).toString('base64');
  const r = await fetch('http://127.0.0.1:8099/api/v1/enroll', {
    method: 'POST', body: JSON.stringify({ code, signing_key: spki, label: 'Téléphone du client', signature: sign(`Tunnel/activate/v2\n${code}\n${spki}`) }),
  });
  const en = await r.json();
  console.log('enroll', r.status, en.device_id ? 'ok' : JSON.stringify(en));

  // Connexion admin -> cookie.
  const login = await fetch('http://127.0.0.1:8099/login', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'login=patron&password=Mot-de-passe-demo', redirect: 'manual',
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  fs.writeFileSync('/tmp/ds-shot-cookie.txt', cookie);

  // Active quelques protocoles via le VRAI formulaire (comme le ferait l'administrateur).
  const page = await (await fetch('http://127.0.0.1:8099/admin/protocols', { headers: { cookie } })).text();
  const csrf = (page.match(/name="csrf" value="([^"]+)"/) || [])[1];
  const form = new URLSearchParams();
  form.set('csrf', csrf);
  const on = ['vless-ws', 'vless-reality', 'vmess-ws', 'trojan-ws', 'hysteria2', 'shadowsocks'];
  for (const p of P.PROTOCOLS) {
    const d = P.defaults(p.id);
    form.set(`p_${p.id}_port`, String(d.port));
    if (p.params.includes('path')) form.set(`p_${p.id}_path`, d.path);
    if (p.params.includes('sni')) form.set(`p_${p.id}_sni`, d.sni);
    if (p.params.includes('seed')) form.set(`p_${p.id}_seed`, d.seed);
    if (p.params.includes('method')) form.set(`p_${p.id}_method`, d.method);
    if (on.includes(p.id)) form.set(`p_${p.id}_enabled`, '1');
  }
  const post = await fetch('http://127.0.0.1:8099/admin/protocols', {
    method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(), redirect: 'manual',
  });
  console.log('post', post.status, post.headers.get('location'));
  console.log('cookie', cookie.slice(0, 20));
  console.log('READY');
  // Reste en vie pour la capture.
  setInterval(() => {}, 1000);
})();
