const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

// Modèle économique : 1 crédit = 100 FCFA. Tout est STOCKÉ EN FCFA (entiers) : 250 F = 2,5 crédits.
// L'administrateur recharge les crédits des vendeurs ; chaque clé vendue (ou rechargée) débite le vendeur.
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  hours INTEGER NOT NULL,               -- durée à partir de l'activation (ou de la recharge)
  quota_bytes INTEGER,                  -- NULL = illimité
  price INTEGER NOT NULL DEFAULT 0,     -- coût pour le vendeur, en FCFA (100 F = 1 crédit ; 0 = gratuit)
  max_devices INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  window_start INTEGER, window_end INTEGER,   -- plage horaire d'utilisation (minutes depuis minuit, heure locale), NULL = 24 h/24
  seller_limit INTEGER,                 -- nombre maximal de clés de ce forfait par compte vendeur (NULL = illimité)
  position INTEGER NOT NULL DEFAULT 0   -- ordre d'affichage
);

-- Comptes du portail : vendeurs ('seller') et administrateur ('admin').
CREATE TABLE IF NOT EXISTS resellers (
  id INTEGER PRIMARY KEY, login TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'seller' CHECK (role IN ('seller','admin')),
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),   -- FCFA (100 = 1 crédit)
  active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_login INTEGER
);

-- Journal de tous les mouvements de crédit (recharge par l'admin, vente, recharge de clé, correction).
CREATE TABLE IF NOT EXISTS credit_ledger (
  id INTEGER PRIMARY KEY, reseller_id INTEGER NOT NULL REFERENCES resellers(id),
  delta INTEGER NOT NULL, balance_after INTEGER NOT NULL,      -- FCFA
  kind TEXT NOT NULL,                   -- recharge | adjust | sale | renew
  ref TEXT, note TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_reseller ON credit_ledger(reseller_id, id DESC);

CREATE TABLE IF NOT EXISTS codes (
  code TEXT PRIMARY KEY, plan_id INTEGER NOT NULL REFERENCES plans(id),
  reseller_id INTEGER NOT NULL REFERENCES resellers(id),
  note TEXT, created_at INTEGER NOT NULL,
  activated_at INTEGER, expires_at INTEGER,      -- fixés à la 1re activation, refixés à la recharge
  revoked INTEGER NOT NULL DEFAULT 0,
  bytes_offset INTEGER NOT NULL DEFAULT 0,       -- consommation déjà "soldée" au moment de la dernière recharge
  ssh_active INTEGER NOT NULL DEFAULT 0,         -- 1 = fiche SSH activée (applis tierces : HTTP Custom, NPV Tunnel...)
  ssh_used INTEGER NOT NULL DEFAULT 0,           -- trafic SSH de cette clé déjà compté dans le forfait
  ssh_last INTEGER NOT NULL DEFAULT 0,           -- dernier cumul lu pour le compte SSH de la clé
  max_devices INTEGER,                           -- appareils choisis par le vendeur (1 à 3) ; NULL = valeur du forfait
  day_start INTEGER, day_base INTEGER NOT NULL DEFAULT 0   -- fenêtre de 24 h glissante (forfaits illimités : 30 Go / 24 h)
);
CREATE INDEX IF NOT EXISTS codes_reseller ON codes(reseller_id, created_at DESC);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, code TEXT NOT NULL REFERENCES codes(code),
  signing_key TEXT NOT NULL,
  wg_key TEXT NOT NULL UNIQUE,   -- identifiant Xray (UUID) de l'appareil ; le nom de colonne est un héritage de la version WireGuard
  wg_ip TEXT NOT NULL UNIQUE,    -- étiquette unique (inutilisée avec Xray)
  label TEXT, created_at INTEGER NOT NULL, last_seen INTEGER,
  disabled INTEGER NOT NULL DEFAULT 0,
  used_bytes INTEGER NOT NULL DEFAULT 0, last_counter INTEGER NOT NULL DEFAULT 0,
  last_counter_ssh INTEGER NOT NULL DEFAULT 0     -- cumul du trafic SSH déjà compté
);
CREATE INDEX IF NOT EXISTS devices_code ON devices(code);

CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY, platform TEXT NOT NULL DEFAULT 'android',
  version_code INTEGER NOT NULL, version_name TEXT NOT NULL,
  file_name TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
  notes TEXT, required INTEGER NOT NULL DEFAULT 0,
  min_version_code INTEGER NOT NULL DEFAULT 0,      -- en dessous : mise à jour obligatoire
  active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
  UNIQUE(platform, version_code)
);

-- Annonces de l'administrateur : affichées en notification dans l'appli client et/ou dans le portail vendeur.
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY, audience TEXT NOT NULL CHECK (audience IN ('clients','sellers','all')),
  title TEXT NOT NULL, body TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER, active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS challenges (
  challenge TEXT PRIMARY KEY, device_id TEXT NOT NULL, message TEXT NOT NULL, expires_at INTEGER NOT NULL
);

-- Demandes de recharge de crédits faites par les vendeurs ; l'administrateur accepte ou refuse.
CREATE TABLE IF NOT EXISTS credit_requests (
  id INTEGER PRIMARY KEY, reseller_id INTEGER NOT NULL REFERENCES resellers(id),
  amount INTEGER NOT NULL,                      -- FCFA demandés
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','refused')),
  created_at INTEGER NOT NULL, decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS requests_status ON credit_requests(status, id DESC);

-- Journal des actions sensibles (connexions, crédits, forfaits, révocations, suppressions...).
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS portal_sessions (
  sid TEXT PRIMARY KEY, reseller_id INTEGER NOT NULL REFERENCES resellers(id),
  csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
);
`;

const cols = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));

/** Met à niveau une base créée par une version précédente (crédits entiers, durées en jours). */
function migrate(db) {
  const plans = cols(db, 'plans'), resellers = cols(db, 'resellers');
  const oldMoney = resellers.has('credit');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (plans.has('days')) { db.exec('ALTER TABLE plans RENAME COLUMN days TO hours; UPDATE plans SET hours = hours * 24'); }
    if (plans.has('credits')) { db.exec('ALTER TABLE plans RENAME COLUMN credits TO price; UPDATE plans SET price = price * 100'); }
    for (const [c, def] of [['window_start', 'INTEGER'], ['window_end', 'INTEGER'], ['seller_limit', 'INTEGER'], ['position', 'INTEGER NOT NULL DEFAULT 0']]) {
      if (!cols(db, 'plans').has(c)) db.exec(`ALTER TABLE plans ADD COLUMN ${c} ${def}`);
    }
    if (!cols(db, 'devices').has('last_counter_ssh')) db.exec('ALTER TABLE devices ADD COLUMN last_counter_ssh INTEGER NOT NULL DEFAULT 0');
    for (const [c, def] of [['max_devices', 'INTEGER'], ['day_start', 'INTEGER'], ['day_base', 'INTEGER NOT NULL DEFAULT 0']]) {
      if (!cols(db, 'codes').has(c)) db.exec(`ALTER TABLE codes ADD COLUMN ${c} ${def}`);
    }
    for (const c of ['ssh_active', 'ssh_used', 'ssh_last']) if (!cols(db, 'codes').has(c)) db.exec(`ALTER TABLE codes ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`);
    if (oldMoney) {
      db.exec('ALTER TABLE resellers RENAME COLUMN credit TO balance; UPDATE resellers SET balance = balance * 100');
      db.exec('UPDATE credit_ledger SET delta = delta * 100, balance_after = balance_after * 100');
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Transaction simple : BEGIN IMMEDIATE ... COMMIT / ROLLBACK.
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { open, tx };
