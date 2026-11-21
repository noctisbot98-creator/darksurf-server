// Codes d'activation de l'appli vendeur PRO : ECDSA P-256 signé avec seller-private.pem (même format que tools/activation.js).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEVICE_RE = /^[0-9A-F]{4}(-[0-9A-F]{4}){4}$/;

function keygen(dir = '.') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const priv = path.join(dir, 'seller-private.pem');
  fs.writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  fs.writeFileSync(path.join(dir, 'seller-public.b64'), spki + '\n');
  return { priv, spki };
}

function issue({ privatePem, device, days = 30, label = 'vendeur', exp }) {
  device = String(device).trim().toUpperCase();
  if (!DEVICE_RE.test(device)) throw new Error('identifiant invalide (attendu : AAAA-BBBB-CCCC-DDDD-EEEE)');
  if (exp === undefined) exp = days > 0 ? Math.floor(Date.now() / 1000) + Math.round(days * 86400) : 0;
  const clean = String(label).replace(/[|\r\n]/g, ' ').slice(0, 40);
  const payload = Buffer.from(['DSV1', device, exp, clean].join('|'));
  const sig = crypto.sign('sha256', payload, crypto.createPrivateKey(privatePem)); // DER
  return payload.toString('base64url') + '.' + sig.toString('base64url');
}

// Reflète exactement Activation.verify() côté Android.
function verify({ code, device, publicB64, nowSec = Math.floor(Date.now() / 1000) }) {
  try {
    const parts = code.trim().split('.');
    if (parts.length !== 2) return { ok: false, reason: 'format' };
    const payload = Buffer.from(parts[0], 'base64url');
    const sig = Buffer.from(parts[1], 'base64url');
    const key = crypto.createPublicKey({ key: Buffer.from(publicB64, 'base64'), format: 'der', type: 'spki' });
    if (!crypto.verify('sha256', payload, key, sig)) return { ok: false, reason: 'signature' };
    const f = payload.toString().split('|');
    if (f.length < 4 || f[0] !== 'DSV1') return { ok: false, reason: 'non reconnu' };
    const label = f.slice(3).join('|');
    if (f[1].toUpperCase() !== String(device).trim().toUpperCase()) return { ok: false, reason: 'autre téléphone' };
    const exp = Number(f[2]);
    if (!Number.isInteger(exp)) return { ok: false, reason: 'non reconnu' };
    if (exp !== 0 && nowSec > exp) return { ok: false, reason: 'expiré' };
    return { ok: true, exp, label };
  } catch { return { ok: false, reason: 'invalide' }; }
}




const keyPath = () => process.env.DS_SELLER_KEY || '/etc/darksurf/seller-private.pem';
const readKey = () => { try { return fs.readFileSync(keyPath(), 'utf8'); } catch { return null; } };
const publicB64 = (pem) => crypto.createPublicKey(crypto.createPrivateKey(pem)).export({ type: 'spki', format: 'der' }).toString('base64');

/** Enregistre la clé privée vendeur collée dans le panneau (vérifiée : doit être une clé EC P-256). */
function saveKey(pem) {
  const k = crypto.createPrivateKey(String(pem).trim() + '\n');
  if (k.asymmetricKeyType !== 'ec' || k.asymmetricKeyDetails.namedCurve !== 'prime256v1') throw new Error('curve');
  fs.writeFileSync(keyPath(), k.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return publicB64(k.export({ type: 'pkcs8', format: 'pem' }));
}

module.exports = { keygen, issue, verify, keyPath, readKey, publicB64, saveKey, DEVICE_RE };
