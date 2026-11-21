const crypto = require('crypto');
const dbMod = require('../src/db');
const { createApp } = require('../src/server');
const { hashPassword } = require('../src/security');

let current = null;      // test en cours : sert à retrouver l'identifiant Xray (UUID) attribué à un appareil

async function boot(extra = {}) {
  const state = { now: Date.now() };
  const app = createApp({ port: 0, cookieSecure: false, db: dbMod.open(':memory:'), clock: () => state.now, enforceIntervalMs: 3600_000, ...extra });
  const port = await app.start();
  const base = `http://127.0.0.1:${port}`;
  const q = (s) => app.db.prepare(s);
  const nowS = () => Math.floor(state.now / 1000);
  // `credits` en crédits (peut être décimal) ; stocké en FCFA. `days` ou `hours` pour la durée.
  const addPlan = (o = {}) => Number(q('INSERT INTO plans (name, hours, quota_bytes, price, max_devices, window_start, window_end, seller_limit) VALUES (?,?,?,?,?,?,?,?)')
    .run(o.name || 'Test', o.hours ?? (o.days ?? 30) * 24, o.quota === undefined ? 1000 : o.quota, Math.round((o.credits ?? 1) * 100), o.devices ?? 1,
      o.ws ?? null, o.we ?? null, o.limit ?? null).lastInsertRowid);
  // Renvoie l'objet compte {id, role} attendu par le service.
  const addReseller = (login, credit = 100, pw = 'Mot-de-passe-test', role = 'seller') => {
    const id = Number(q('INSERT INTO resellers (login, name, password_hash, role, balance, created_at) VALUES (?,?,?,?,?,?)').run(login, login.toUpperCase(), hashPassword(pw), role, credit * 100, nowS()).lastInsertRowid);
    return { id, role, login };
  };
  const addAdmin = (login = 'patron') => addReseller(login, 0, 'Mot-de-passe-test', 'admin');
  const t = { app, base, state, q, nowS, addPlan, addReseller, addAdmin, close: () => { if (current === t) current = null; return app.close(); } };
  current = t;
  return t;
}

/** Simule l'appli Android : clé EC P-256 (SPKI DER), signatures DER. `wg` = identifiant Xray (UUID), rempli après l'enregistrement. */
function fakeDevice() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    sign: (m) => crypto.sign('sha256', Buffer.from(m), privateKey).toString('base64'),
    wg: null,
  };
}

const post = async (base, path, body) => {
  const r = await fetch(base + '/api/v1/' + path, { method: 'POST', body: JSON.stringify(body) });
  return [r.status, await r.json()];
};

async function enroll(base, code, dev, label = 'Test phone') {
  const r = await post(base, 'enroll', { code, signing_key: dev.spki, label, signature: dev.sign(`Tunnel/activate/v2\n${code}\n${dev.spki}`) });
  if (r[0] === 200 && current) dev.wg = current.q('SELECT wg_key FROM devices WHERE id = ?').get(r[1].device_id).wg_key;
  return r;
}
async function status(base, deviceId, dev, since = 0) {
  const [, ch] = await post(base, 'challenge', { device_id: deviceId });
  return post(base, 'status', { device_id: deviceId, challenge: ch.challenge, signature: dev.sign(ch.message), since_notice: since });
}
async function session(base, deviceId, dev) {
  const [, ch] = await post(base, 'challenge', { device_id: deviceId });
  return post(base, 'session', { device_id: deviceId, challenge: ch.challenge, signature: dev.sign(ch.message), network: 'wifi' });
}

module.exports = { boot, fakeDevice, post, enroll, session, status };
