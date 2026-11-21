const crypto = require('crypto');

// ---- mots de passe : scrypt + sel, comparaison à temps constant ----
const N = 16384;
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 32, { N });
  return `scrypt$${N}$${salt.toString('base64')}$${h.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [alg, n, salt, hash] = stored.split('$');
    if (alg !== 'scrypt') return false;
    const h = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), 32, { N: Number(n) });
    const want = Buffer.from(hash, 'base64');
    return h.length === want.length && crypto.timingSafeEqual(h, want);
  } catch { return false; }
}
// Empreinte factice pour garder un temps de réponse constant quand le login n'existe pas.
const DUMMY = hashPassword('dummy-password');

// ---- signature ECDSA P-256 des appareils (clé publique SPKI DER en base64, signature DER) ----
function verifySig(spkiB64, message, sigB64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(spkiB64, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails.namedCurve !== 'prime256v1') return false;
    return crypto.verify('sha256', Buffer.from(message), key, Buffer.from(sigB64, 'base64'));
  } catch { return false; }
}

const isWgKey = (k) => typeof k === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(k) && Buffer.from(k, 'base64').length === 32;
const randId = (n = 16) => crypto.randomBytes(n).toString('hex');
const newCode = (prefix) => prefix + crypto.randomBytes(24).toString('base64url');   // 32 car. [A-Za-z0-9_-]

// ---- limiteur de débit en mémoire (fenêtre glissante) ----
class RateLimiter {
  constructor(max, windowMs) { this.max = max; this.windowMs = windowMs; this.hits = new Map(); }
  allow(key, now = Date.now()) {
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) { this.hits.set(key, arr); return false; }
    arr.push(now); this.hits.set(key, arr);
    if (this.hits.size > 10_000) this.hits.clear();
    return true;
  }
}

module.exports = { hashPassword, verifyPassword, DUMMY, verifySig, isWgKey, randId, newCode, RateLimiter };
