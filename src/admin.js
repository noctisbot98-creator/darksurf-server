#!/usr/bin/env node
// Administration en ligne de commande (sur le serveur). Le plus courant se fait aussi depuis le portail /admin.
//   node src/admin.js add-admin patron --password "..."            (premier compte administrateur)
//   node src/admin.js seed-plans                                   (charge les 12 forfaits Geny ; ceux qui existent sont gardés)
//   node src/admin.js add-plan "Pass Journée" --hours 24 --quota-gb 2.5 --credits 2.5 [--window 00:00-06:00] [--limit 3]
//   node src/admin.js add-plan "Illimité 30 jours" --days 30 --unlimited --credits 80
//   node src/admin.js add-seller marie --name "Marie" [--credits 50] [--password ...]
//   node src/admin.js add-credit marie 50 | set-password marie [--password ...] | disable-seller marie
//   node src/admin.js publish-release app-release.apk --version-code 2 --version-name 1.1.0 --notes "Correctifs" [--required] [--min-code 1]
//   node src/admin.js list-releases | deactivate-release 2
//   node src/admin.js list-plans | list-sellers | stats
const crypto = require('crypto');
const fs = require('fs');
const nodePath = require('path');
const cfgMod = require('./config');
const dbMod = require('./db');
const { Service } = require('./service');

function parse(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2); opt[k] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true; } else pos.push(argv[i]);
  }
  return { pos, opt };
}
const randomPassword = () => crypto.randomBytes(12).toString('base64url');
const int = (v, name) => { const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new Error(`${name} invalide`); return n; };

function run(argv, db, cfg = cfgMod.load()) {
  const { pos: [cmd, ...a], opt } = parse(argv);
  const q = (s) => db.prepare(s);
  const svc = new Service({ db, cfg, core: null });
  const sellerId = (login) => { const r = q("SELECT id FROM resellers WHERE login = ? AND role = 'seller'").get(a[0]); if (!r) throw new Error('vendeur introuvable'); return r.id; };
  const pwOpt = () => { const pw = typeof opt.password === 'string' ? opt.password : randomPassword(); if (pw.length < 10) throw new Error('mot de passe trop court (10 minimum)'); return pw; };
  switch (cmd) {
    case 'add-admin': {
      const pw = pwOpt();
      svc.createAdmin(String(a[0] || ''), pw, typeof opt.name === 'string' ? opt.name : 'Administrateur');
      return `Administrateur « ${a[0]} » créé.\nMot de passe : ${pw}\n(notez-le maintenant, il ne sera plus affiché)`;
    }
    case 'add-plan': {
      const [name] = a; if (!name) throw new Error('nom requis');
      svc.createPlan({ name, days: opt.days, hours: opt.hours, quotaGb: opt['quota-gb'], unlimited: !!opt.unlimited, credits: opt.credits, devices: opt.devices ?? 1,
        window: typeof opt.window === 'string' ? opt.window : undefined, limit: opt.limit, position: Number(opt.position) || 100 });
      return `Forfait « ${name} » créé.`;
    }
    case 'seed-plans': { const n = svc.seedPlans(); return `${n} forfait(s) créé(s) (les autres existaient déjà).`; }
    case 'add-seller': {
      const pw = pwOpt();
      svc.createSeller({ login: a[0], name: typeof opt.name === 'string' ? opt.name : a[0], password: pw, credits: opt.credits ?? 0 });
      return `Vendeur « ${a[0]} » créé.\nMot de passe : ${pw}\n(notez-le maintenant, il ne sera plus affiché)`;
    }
    case 'set-password': {
      const pw = pwOpt(); svc.resetPassword(sellerId(a[0]), pw);
      return `Nouveau mot de passe : ${pw}`;
    }
    case 'set-admin-password': {
      const pw = pwOpt(); svc.resetAdminPassword(String(a[0] || ''), pw);
      return typeof opt.password === 'string' ? 'Mot de passe administrateur modifié.' : `Nouveau mot de passe : ${pw}`;
    }
    case 'add-credit': {
      const id = sellerId(a[0]); const bal = svc.addCredits(id, a[1], 'CLI');
      return `Crédits de ${a[0]} : ${bal / 100}`;
    }
    case 'disable-seller': { svc.setSellerActive(sellerId(a[0]), false); return `Vendeur ${a[0]} désactivé.`; }
    case 'enable-seller': { svc.setSellerActive(sellerId(a[0]), true); return `Vendeur ${a[0]} réactivé.`; }
    case 'publish-release': {
      const [apk] = a;
      const vc = int(opt['version-code'], '--version-code'), vn = opt['version-name'];
      if (!apk || !fs.existsSync(apk)) throw new Error('fichier APK introuvable');
      if (typeof vn !== 'string' || !/^[0-9A-Za-z.+_-]{1,30}$/.test(vn)) throw new Error('--version-name invalide');
      const buf = fs.readFileSync(apk);
      if (buf.length < 1000 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('ce fichier n\'est pas un APK (zip)');
      const file = `darksurf-${vc}.apk`, sha = crypto.createHash('sha256').update(buf).digest('hex');
      fs.mkdirSync(cfg.releasesDir, { recursive: true });
      fs.writeFileSync(nodePath.join(cfg.releasesDir, file), buf);
      q(`INSERT INTO releases (version_code, version_name, file_name, sha256, size, notes, required, min_version_code, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`).run(vc, vn, file, sha, buf.length, typeof opt.notes === 'string' ? opt.notes.slice(0, 500) : null,
        opt.required ? 1 : 0, int(opt['min-code'] ?? 0, '--min-code'), Math.floor(Date.now() / 1000));
      return `Version ${vn} (code ${vc}) publiée.\nSHA-256 : ${sha}\nTaille : ${buf.length} octets${opt.required ? '\nMise à jour OBLIGATOIRE' : ''}`;
    }
    case 'list-releases':
      return q('SELECT * FROM releases ORDER BY version_code DESC').all().map((r) =>
        `code ${r.version_code} — ${r.version_name} — ${r.size} o — ${r.sha256.slice(0, 12)}…${r.required ? ' [obligatoire]' : ''}${r.min_version_code ? ` [min ${r.min_version_code}]` : ''}${r.active ? '' : ' [retirée]'}`).join('\n') || '(aucune version)';
    case 'deactivate-release': {
      const r = q('UPDATE releases SET active = 0 WHERE version_code = ?').run(int(a[0], 'code'));
      if (!r.changes) throw new Error('version introuvable');
      return `Version ${a[0]} retirée (plus proposée ni téléchargeable).`;
    }
    case 'list-plans':
      return svc.allPlans().map((p) =>
        `#${p.id} ${p.name} — ${p.hours % 24 ? p.hours + ' h' : p.hours / 24 + ' j'}${p.window_start !== null ? ` (${p.window_start / 60}h-${p.window_end / 60}h)` : ''} — ${p.quota_bytes === null ? 'illimité' : (p.quota_bytes / 1e9) + ' Go'} — ${p.price / 100} crédit(s) (${p.price} F) — ${p.max_devices} appareil(s)${p.seller_limit ? ` — max ${p.seller_limit}/vendeur` : ''}${p.active ? '' : ' [retiré]'}`).join('\n') || '(aucun forfait)';
    case 'list-sellers':
      return svc.listSellers().map((r) => `${r.login} (${r.name}) — ${r.balance / 100} crédit(s) — ${r.keys_active} clé(s) active(s)/${r.keys_total}${r.active ? '' : ' [désactivé]'}`).join('\n') || '(aucun vendeur)';
    case 'admin-count':
      return String(q("SELECT COUNT(*) AS n FROM resellers WHERE role = 'admin'").get().n);
    case 'stats': {
      const s = svc.adminStats();
      return `Vendeurs : ${s.sellers} · Crédits chez les vendeurs : ${s.credits_in_wallets / 100} · Clés actives : ${s.keys_active} · Appareils : ${s.devices}`;
    }
    default:
      throw new Error('Commandes : add-admin | add-plan | seed-plans | set-admin-password | add-seller | set-password | add-credit | disable-seller | enable-seller | publish-release | list-releases | deactivate-release | list-plans | list-sellers | stats');
  }
}

module.exports = { run };

if (require.main === module) {
  const db = dbMod.open(cfgMod.load().dbPath);
  try { console.log(run(process.argv.slice(2), db)); } catch (e) { const FR = { login_taken: 'cet identifiant existe déjà', bad_login: 'identifiant invalide (a-z 0-9 . _ - ; 3 à 32)', bad_password: 'mot de passe trop court (10 minimum)',
      bad_amount: 'montant invalide', bad_plan: 'paramètres du forfait invalides (--hours ou --days, --quota-gb ou --unlimited, --credits, --window HH:MM-HH:MM)', plan_exists: 'un forfait porte déjà ce nom', not_found: 'introuvable', insufficient_credit: 'le solde ne peut pas devenir négatif' };
    console.error('Erreur :', /UNIQUE/.test(e.message) ? 'existe déjà' : FR[e.message] || e.message); process.exitCode = 1; }
  db.close();
}
