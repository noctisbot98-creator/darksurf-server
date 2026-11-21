const crypto = require('crypto');
const { tx } = require('./db');
const S = require('./security');
const { GENY_PLANS } = require('./seed-plans');
const Pproto = require('./protocols');
const Ccfg = require('./client-config');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

const DAY_CAP = 30 * 1e9;                 // forfaits illimités : 30 Go par fenêtre de 24 h
const MAX_DEVICES = 3;
const CODE_RE = /^TUN-[A-Za-z0-9_-]{32}$/;
const LOGIN_RE = /^[a-z0-9._-]{3,32}$/;
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);
const clean = (v, max) => (typeof v === 'string' ? v : '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
/** Crédits saisis par l'humain (« 2,5 ») -> FCFA entiers (250). null si invalide. 100 F = 1 crédit. */
const parseCredits = (v) => {
  const n = Number(String(v ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  const f = Math.round(n * 100);
  return Math.abs(n * 100 - f) < 1e-6 && Math.abs(f) <= 100_000_000 ? f : null;
};
const posInt = (v, max) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= max ? n : null; };

/** Accès aux données et règles métier. Aucune dépendance HTTP : testable seul. */
class Service {
  constructor({ db, cfg, core, clock = Date.now }) {
    Object.assign(this, { db, cfg, core, clock });
    this.enforcing = null;
    this.deviceLimit = new S.RateLimiter(30, 60_000);        // demandes de défi par appareil et par minute
    this.sshStates = new Map();
  }
  now() { return Math.floor(this.clock() / 1000); }
  q(sql) { return this.db.prepare(sql); }

  // ============================================================== API de l'appli client

  sshCredentials(deviceId) {
    if (!this.cfg.ssh?.enabled || !this.cfg.ssh.secret || !this.cfg.ssh.hostKey) return null;
    const digest = crypto.createHmac('sha256', this.cfg.ssh.secret).update(deviceId).digest('hex');
    return { username: 'ds' + digest.slice(0, 20), password: crypto.createHmac('sha256', this.cfg.ssh.secret).update('password:' + deviceId).digest('base64url').slice(0, 32) };
  }

  /** Compte SSH d'une clé (applis tierces). Identifiant et mot de passe se déduisent de la clé : rien n'est stocké en clair. */
  sshCodeCredentials(code) {
    if (!this.cfg.ssh?.enabled || !this.cfg.ssh.secret) return null;
    const username = 'dk' + crypto.createHmac('sha256', this.cfg.ssh.secret).update('code:' + code).digest('hex').slice(0, 20);
    const password = crypto.createHmac('sha256', this.cfg.ssh.secret).update('code-password:' + code).digest('base64url').slice(0, 32);
    return { username, password };
  }

  /** Active ou coupe le compte SSH d'une clé. */
  async setSshCode(code, enabled) {
    const c = this.sshCodeCredentials(code); if (!c) return;
    this.sshCodeStates = this.sshCodeStates || new Map();
    if (this.sshCodeStates.get(code) === enabled) return;
    try {
      await this._sudoSsh([enabled ? 'ensure' : 'disable', c.username], enabled ? c.password + '\n' : '');
      this.sshCodeStates.set(code, enabled);
    } catch (e) { throw new Error('ssh_code_' + (enabled ? 'provision' : 'disable') + '_failed: ' + String(e.stderr || e.message).slice(0, 160)); }
  }

  /** Connexions SSH ouvertes par compte : nom -> nombre. */
  async sshSessions() {
    const out = await this._sudoSsh(['sessions']);
    const m = new Map();
    for (const line of out.split('\n')) { const x = /^(d[sk][0-9a-f]{20})\s+(\d+)$/.exec(line.trim()); if (x) m.set(x[1], Number(x[2])); }
    return m;
  }

  /**
   * Fiche SSH d'une clé (applis tierces). La 1re fois, elle démarre la durée du forfait, comme une activation dans l'appli.
   * Renvoie tout ce que le client doit coller dans HTTP Custom / NPV Tunnel / etc.
   */
  async activateSshKey(me, code) {
    if (!this.cfg.ssh?.enabled) throw new HttpError(409, 'ssh_disabled');
    const now = this.now();
    const row = this.getCode(me, code);
    if (!row) throw new HttpError(404, 'not_found');
    const full = this.q('SELECT c.*, p.hours, p.window_start, p.window_end FROM codes c JOIN plans p ON p.id = c.plan_id WHERE c.code = ?').get(row.code);
    if (full.revoked) throw new HttpError(403, 'invalid_code');
    if (full.expires_at && now > full.expires_at) throw new HttpError(403, 'plan_expired');
    if (!full.activated_at) this.q('UPDATE codes SET activated_at = ?, expires_at = ? WHERE code = ?').run(now, this.expiryFor(full, now), full.code);
    this.q('UPDATE codes SET ssh_active = 1 WHERE code = ?').run(full.code);
    await this.setSshCode(full.code, true);
    return this.sshFiche(full.code);
  }

  /** Données de la fiche de connexion d'une clé (aucune écriture). */
  sshFiche(code) {
    const c = this.sshCodeCredentials(code); if (!c) return null;
    const w = this.cfg.core, s = this.cfg.ssh;
    return {
      host: w.host, username: c.username, password: c.password,
      tcp_port: s.tcpPort, tls_port: w.port, ws_path: s.wsPath, host_key: s.hostKey,
      udpgw_port: this.cfg.modules?.udpgw?.enabled ? this.cfg.modules.udpgw.port : null,
      tls_ssh_port: this.cfg.modules?.stunnel?.enabled ? this.cfg.modules.stunnel.port : null,
      dropbear_port: this.cfg.modules?.dropbear?.enabled ? this.cfg.modules.dropbear.port : null,
    };
  }

  /** Active ou coupe un module SSH (stunnel / dropbear / udpgw) sur le VPS, via l'aide système restreinte. */
  applyModule(mod, enabled, port) {
    if (!['stunnel', 'dropbear', 'udpgw'].includes(mod) || !Number.isInteger(port) || port < 1024 || port > 65535) return Promise.reject(new HttpError(400, 'bad_request'));
    return new Promise((resolve, reject) => {
      const child = execFile('/usr/bin/sudo', ['/usr/local/sbin/darksurf-modules', enabled ? 'enable' : 'disable', mod, String(port)], { timeout: 180000 }, (err, out, errOut) =>
        (err ? reject(new HttpError(500, 'module_apply_failed: ' + String(errOut || err.message).slice(0, 200))) : resolve(String(out))));
      child.stdin.on('error', () => {}); child.stdin.end();
    });
  }

  /** Lance l'aide système restreinte (sudo) ; le mot de passe passe par l'entrée standard, jamais par la ligne de commande. */
  _sudoSsh(args, input = '') {
    return new Promise((resolve, reject) => {
      const child = execFile('/usr/bin/sudo', ['/usr/local/sbin/darksurf-ssh-user', ...args], { timeout: 10000 }, (err, out, errOut) =>
        (err ? reject(Object.assign(err, { stderr: errOut })) : resolve(String(out))));
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }

  async applySshConfig({ enabled, tcpPort }) {
    return new Promise((resolve, reject) => {
      const child = execFile('/usr/bin/sudo', ['/usr/local/sbin/darksurf-ssh-config', enabled ? 'enable' : 'disable', String(tcpPort)], { timeout: 30000 }, (err, out, errOut) =>
        (err ? reject(new Error('ssh_config_apply_failed: ' + String(errOut || err.message).slice(0, 240))) : resolve(String(out))));
      child.stdin.on('error', () => {}); child.stdin.end();
    });
  }

  async setSshAccount(deviceId, enabled) {
    const c = this.sshCredentials(deviceId); if (!c) return;
    if (this.sshStates.get(deviceId) === enabled) return;
    try {
      await this._sudoSsh([enabled ? 'ensure' : 'disable', c.username], enabled ? c.password + '\n' : '');
      this.sshStates.set(deviceId, enabled);
    } catch (e) { throw new Error('ssh_account_' + (enabled ? 'provision' : 'disable') + '_failed: ' + String(e.stderr || e.message).slice(0, 160)); }
  }

  async deleteSshAccount(deviceId) {
    const c = this.sshCredentials(deviceId); if (!c) return;
    try {
      await this._sudoSsh(['delete', c.username]);
      this.sshStates.delete(deviceId);
    } catch (e) { this._warn('ssh delete ' + deviceId, e); }
  }

  /** Octets transférés par chaque compte SSH (dans les deux sens) : nom -> cumul depuis le dernier redémarrage du serveur. */
  async sshUsage() {
    const out = await this._sudoSsh(['usage']);
    const m = new Map();
    for (const line of out.split('\n')) {
      const x = /^(d[sk][0-9a-f]{20})\s+(\d+)$/.exec(line.trim());
      if (x) m.set(x[1], (m.get(x[1]) || 0) + Number(x[2]));
    }
    return m;
  }

  /** POST /enroll : active un code sur cet appareil (clé de signature) ; le serveur lui attribue son identifiant Xray (UUID). */
  async enroll(b) {
    const code = str(b.code, 64), signingKey = str(b.signing_key, 200);
    const signature = str(b.signature, 200), label = (str(b.label, 80) || 'appareil').slice(0, 60);
    if (!code || !CODE_RE.test(code) || !signingKey || !signature) throw new HttpError(400, 'bad_request');
    if (!S.verifySig(signingKey, `Tunnel/activate/v2\n${code}\n${signingKey}`, signature)) throw new HttpError(401, 'bad_signature');

    const now = this.now();
    const deviceId = crypto.randomUUID();
    const uid = crypto.randomUUID();            // identifiant Xray de l'appareil (colonne wg_key : nom historique)
    try {
      tx(this.db, () => {
        const row = this.q(`SELECT c.*, p.hours, COALESCE(c.max_devices, p.max_devices) AS max_devices, p.window_start, p.window_end FROM codes c JOIN plans p ON p.id = c.plan_id WHERE c.code = ?`).get(code);
        if (!row || row.revoked) throw new HttpError(403, 'invalid_code');
        if (row.expires_at && now > row.expires_at) throw new HttpError(403, 'plan_expired');
        const n = this.q('SELECT COUNT(*) AS n FROM devices WHERE code = ?').get(code).n;
        if (n >= row.max_devices) throw new HttpError(403, 'device_limit');
        if (!row.activated_at) {                      // 1re activation : la durée du forfait démarre ici
          this.q('UPDATE codes SET activated_at = ?, expires_at = ? WHERE code = ?').run(now, this.expiryFor(row, now), code);
        }
        this.q(`INSERT INTO devices (id, code, signing_key, wg_key, wg_ip, label, created_at) VALUES (?,?,?,?,?,?,?)`)
          .run(deviceId, code, signingKey, uid, 'x-' + deviceId, label, now);
      });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (/UNIQUE/i.test(String(e.message))) throw new HttpError(400, 'bad_request'); // clé WG déjà enregistrée
      throw e;
    }
    await this.core.addPeer(uid);
    return { device_id: deviceId };
  }

  /** POST /challenge */
  challenge(b) {
    const deviceId = str(b.device_id, 64);
    if (!deviceId || !this.q('SELECT 1 FROM devices WHERE id = ?').get(deviceId)) throw new HttpError(401, 'unknown_device');
    if (!this.deviceLimit.allow(deviceId)) throw new HttpError(429, 'rate_limited');
    const now = this.now();
    this.q('DELETE FROM challenges WHERE expires_at < ?').run(now);
    const challenge = S.randId(16);
    const message = `Tunnel/session/v1\n${deviceId}\n${challenge}\n${now}`;
    this.q('INSERT INTO challenges VALUES (?,?,?,?)').run(challenge, deviceId, message, now + 60);
    return { challenge, message };
  }

  /** Vérifie le défi signé (usage unique) et renvoie l'appareil avec l'état de son forfait. */
  _prove(b) {
    const deviceId = str(b.device_id, 64), challenge = str(b.challenge, 64), signature = str(b.signature, 200);
    if (!deviceId || !challenge || !signature) throw new HttpError(400, 'bad_request');
    const now = this.now();
    const ch = this.q('SELECT * FROM challenges WHERE challenge = ?').get(challenge);
    this.q('DELETE FROM challenges WHERE challenge = ?').run(challenge);
    if (!ch || ch.device_id !== deviceId || ch.expires_at < now) throw new HttpError(401, 'bad_challenge');
    const d = this.q(`SELECT d.*, c.note AS client_name, c.expires_at, c.revoked, c.bytes_offset, c.day_start, c.day_base, p.name AS plan_name, p.quota_bytes, p.window_start, p.window_end
                      FROM devices d JOIN codes c ON c.code = d.code JOIN plans p ON p.id = c.plan_id WHERE d.id = ?`).get(deviceId);
    if (!d || !S.verifySig(d.signing_key, ch.message, signature)) throw new HttpError(401, 'bad_signature');
    d.used = this.usage(d.code, d.bytes_offset);
    d.day_block_until = this.dayBlock(d, this.usage(d.code, 0), now);
    d.state = this.planState(d, d.used, now);
    return d;
  }

  /** Forfait illimité : instant de fin du blocage si 30 Go ont déjà été consommés dans la fenêtre de 24 h en cours, sinon 0. */
  dayBlock(c, totalRaw, now) {
    if (!c.day_start || now - c.day_start >= 86400) return 0;
    return totalRaw - (c.day_base || 0) >= DAY_CAP ? c.day_start + 86400 : 0;
  }

  /** Consommation du forfait en cours (tous les appareils du code, depuis la dernière recharge). */
  usage(code, offset = 0) {
    return Math.max(0, this.q('SELECT (SELECT COALESCE(SUM(used_bytes),0) FROM devices WHERE code = ?) + (SELECT COALESCE(ssh_used,0) FROM codes WHERE code = ?) AS u').get(code, code).u - offset);
  }

  planState(d, used, now) {
    if (d.revoked) return 'revoked';
    if (d.disabled) return 'disabled';
    if (d.expires_at && now > d.expires_at) return 'expired';
    if (d.quota_bytes !== null && used >= d.quota_bytes) return 'quota_exceeded';
    if (d.quota_bytes === null && d.day_block_until && now < d.day_block_until) return 'daily_limit';
    if (!this.inWindow(d, now)) return 'outside_window';
    return 'active';
  }

  // ---- plage horaire (ex. « Nuit Blanche » 00:00-06:00, heure locale du serveur : Cameroun = UTC+1) ----
  localMinutes(now) { return Math.floor((((now + this.cfg.tzOffsetS) % 86400) + 86400) % 86400 / 60); }

  inWindow(p, now) {
    if (p.window_start === null || p.window_start === undefined) return true;
    const m = this.localMinutes(now), a = p.window_start, b = p.window_end;
    return a < b ? m >= a && m < b : m >= a || m < b;
  }

  /** Fin du forfait : durée normale, ou fin de la plage horaire en cours / prochaine pour un forfait à plage. */
  expiryFor(p, now) {
    if (p.window_start === null || p.window_start === undefined) return now + p.hours * 3600;
    const off = this.cfg.tzOffsetS, t = now + off, dayStart = t - (((t % 86400) + 86400) % 86400);
    const len = ((p.window_end - p.window_start + 1440) % 1440 || 1440) * 60;
    for (let d = -1; d <= 2; d++) {
      const end = dayStart + d * 86400 + p.window_start * 60 + len;
      if (end > t) return end - off;
    }
    return now + p.hours * 3600;
  }

  planInfo(d) {
    const plan = { name: d.plan_name, used_bytes: d.used, expires_at: d.expires_at };
    if (d.window_start !== null && d.window_start !== undefined) plan.window = { start: d.window_start, end: d.window_end };
    if (d.quota_bytes !== null) plan.quota_bytes = d.quota_bytes;
    if (d.client_name) plan.client_name = d.client_name;      // nom saisi par le vendeur sur la clé : affiché dans l'appli du client
    return plan;
  }

  /** POST /session : renvoie le profil de connexion Xray (VLESS/WebSocket/TLS) si le forfait est valide. */
  async session(b) {
    const d = this._prove(b), now = this.now();
    const refuse = { revoked: 'invalid_code', disabled: 'device_disabled', expired: 'plan_expired', quota_exceeded: 'quota_exceeded', daily_limit: 'daily_limit', outside_window: 'outside_window' }[d.state];
    if (refuse) throw new HttpError(403, refuse);
    this.q('UPDATE devices SET last_seen = ? WHERE id = ?').run(now, d.id);
    const t0 = Date.now();
    await this.core.addPeer(d.wg_key);
    const t1 = Date.now();
    // Le compte SSH est un plan B : il ne doit jamais retarder ni faire échouer la connexion principale (l'appli n'attend que 15 s).
    let sshReady = false;
    if (this.cfg.ssh?.enabled) {
      try {
        await Promise.race([this.setSshAccount(d.id, true), new Promise((_, rej) => setTimeout(() => rej(new Error('ssh_account_slow')), 4000).unref())]);
        sshReady = true;
      } catch (e) { this._warn('ssh session ' + d.id, e); }
    }
    if (!process.env.DS_QUIET) console.log(`session ${d.id}: xray ${t1 - t0} ms, ssh ${Date.now() - t1} ms (${sshReady ? 'prêt' : 'indisponible'})`);
    const w = this.cfg.core;
    const ssh = sshReady ? this.sshCredentials(d.id) : null;
    const def = this._defaultProtocol();
    return {
      token: S.randId(24),
      expires_at: now + this.cfg.profileTtlS,
      plan: this.planInfo(d),
      profile: {
        protocol: def, address: w.host, port: def === 'ssh-tcp' ? this.cfg.ssh.tcpPort : w.port, uuid: d.wg_key, network: 'ws', path: w.path,
        tls: true, sni: w.host, dns: w.dns,
        ...(ssh ? { ssh: {
          host: w.serverIp || w.host, tcp_port: this.cfg.ssh.tcpPort, ws_port: this.cfg.ssh.wsPort,
          username: ssh.username, password: ssh.password,
          ws_path: this.cfg.ssh.wsPath, host_key: this.cfg.ssh.hostKey,
          ws_host: this.cfg.ssh.wsHost || w.host, ws_tls: !!this.cfg.ssh.wsTls,
          ws_sni: this.cfg.ssh.wsHost || w.host,
          payload: this.cfg.ssh.payload || `GET ${this.cfg.ssh.wsPath} HTTP/1.1[crlf]Host: ${this.cfg.ssh.wsHost || w.host}[crlf]Upgrade: websocket[crlf][crlf]`,
        } } : {}),
        ...(w.kcpPort > 0 && w.kcpSeed ? { kcp: { port: w.kcpPort, seed: w.kcpSeed } } : {}),
        ...(w.realityPort > 0 && w.realityPbk ? { reality: { port: w.realityPort, pbk: w.realityPbk, sid: w.realitySid, sni: w.realitySni, fp: 'chrome', flow: 'xtls-rprx-vision' } } : {}),
      },
      // Le serveur décide : liste ordonnée des façons de se connecter. L'appli essaie la première,
      // puis la suivante si elle échoue. Aucun choix n'est laissé à l'utilisateur.
      attempts: this._attempts(d, def, !!ssh),
    };
  }

  /** Protocole que l'administrateur veut essayer en premier (réglage « Protocoles VPN »). */
  _defaultProtocol() {
    const p = this.cfg.protocols?.default;
    if ((p === 'ssh-ws' || p === 'ssh-tcp') && !this.cfg.ssh?.enabled) return 'vless';
    return ['vless', 'ssh-ws', 'ssh-tcp'].includes(p) ? p : (this.cfg.ssh?.enabled ? 'ssh-ws' : 'vless');
  }

  /** Liste ordonnée des connexions possibles pour cet appareil : { id, kind: 'xray'|'ssh', outbound? }. */
  _attempts(d, def, sshReady) {
    const vlessOn = this.cfg.protocols?.vless !== false;
    const xray = new Map();
    for (const p of this._protocolList(d)) if (p.app && p.outbound) xray.set(p.id, p.outbound);
    const entry = (id) => {
      if (id === 'ssh-ws' || id === 'ssh-tcp') return sshReady ? { id, kind: 'ssh' } : null;
      if (id.startsWith('vless') && !vlessOn) return null;
      return xray.has(id) ? { id, kind: 'xray', outbound: xray.get(id) } : null;
    };
    const first = def === 'vless' ? 'vless-ws' : def;
    const order = [first, 'ssh-ws', 'vless-ws', 'vless-reality', 'ssh-tcp'];
    const seen = new Set(), out = [];
    for (const id of order) { if (seen.has(id)) continue; seen.add(id); const e = entry(id); if (e) out.push(e); }
    return out;
  }

  /**
   * POST /protocols : liste des protocoles réellement activés sur le VPS, avec pour chacun
   * la configuration client prête à monter (outbound Xray) ou la raison de son absence.
   *
   * L'application ne devine rien : elle affiche exactement ce que le serveur annonce, et
   * n'essaie de monter que ce que son moteur embarqué sait faire (`app: true`).
   */
  protocols(b) {
    const d = this._prove(b), now = this.now();
    const refuse = { revoked: 'invalid_code', disabled: 'device_disabled', expired: 'plan_expired', quota_exceeded: 'quota_exceeded', daily_limit: 'daily_limit', outside_window: 'outside_window' }[d.state];
    if (refuse) throw new HttpError(403, refuse);
    this.q('UPDATE devices SET last_seen = ? WHERE id = ?').run(now, d.id);
    const out = this._protocolList(d);
    const w = this.cfg.core;
    return {
      now,
      engine: Ccfg.APP_ENGINE,
      dns: w.dns,
      protocols: out,
      // Le protocole historique reste toujours disponible : c'est le socle de DARK_SURF.
      default: out.find((x) => x.id === 'vless-ws' && x.app)?.id || out.find((x) => x.app)?.id || null,
    };
  }

  /** Protocoles activés sur le VPS, avec l'outbound Xray prêt à monter pour chacun. */
  _protocolList(d) {
    // Réglages enregistrés par la page Protocoles du panel (mêmes valeurs que les liens d'import).
    const row = this.q("SELECT value FROM app_settings WHERE key = 'protocols'").get();
    let raw = {};
    try { raw = row ? JSON.parse(row.value) : {}; } catch { raw = {}; }
    const settings = {};
    for (const p of Pproto.PROTOCOLS) settings[p.id] = { ...Pproto.defaults(p.id), ...((raw && raw[p.id]) || {}) };

    const w = this.cfg.core;
    const ctx = {
      host: w.host,
      uuid: d.wg_key,
      reality: { pbk: w.realityPbk || '', sid: w.realitySid || '', sni: w.realitySni || 'www.microsoft.com' },
      ssKey: Pproto.ssKey(settings.shadowsocks?.method || '2022-blake3-aes-128-gcm', w.ssPassword || ''),
      tls: true,
    };

    // Le secret est propre à (appareil, protocole) : même dérivation que le lien du panel.
    const out = [];
    for (const p of Pproto.PROTOCOLS) {
      const s = settings[p.id];
      if (!s || (!s.enabled && p.id !== 'vless-ws')) continue;      // VLESS/WS est le socle : toujours servi par le VPS
      const c = Ccfg.clientConfig(p.id, {
        ...ctx, settings: s,
        secret: Pproto.deviceSecret(this.cfg.ssh?.secret || w.host, d.id, p.id),
      });
      if (!c) continue;
      out.push({ ...c.meta, outbound: c.outbound });
    }
    return out;
  }

  /**
   * POST /status : état du forfait + annonces, sans rien modifier côté Xray.
   * Sert aux notifications (expiration proche, données presque épuisées, forfait terminé).
   */
  status(b) {
    const d = this._prove(b), now = this.now();
    this.q('UPDATE devices SET last_seen = ? WHERE id = ?').run(now, d.id);
    const since = Number.isInteger(b.since_notice) && b.since_notice >= 0 ? b.since_notice : 0;
    return { state: d.state, now, plan: this.planInfo(d), notices: this.noticesFor('clients', since) };
  }

  noticesFor(audience, since = 0) {
    const now = this.now();
    return this.q(`SELECT id, title, body, created_at FROM notices
                   WHERE active = 1 AND id > ? AND audience IN (?, 'all') AND (expires_at IS NULL OR expires_at > ?)
                   ORDER BY id DESC LIMIT 20`).all(since, audience, now);
  }

  /** POST /app/android : y a-t-il une version plus récente que celle de l'appli ? */
  checkApp(b) {
    const vc = b.version_code;
    if (!Number.isInteger(vc) || vc < 0) throw new HttpError(400, 'bad_request');
    const r = this.q(`SELECT * FROM releases WHERE platform = 'android' AND active = 1 ORDER BY version_code DESC LIMIT 1`).get();
    if (!r || r.version_code <= vc) return { update: false };
    return {
      update: true, version_code: r.version_code, version_name: r.version_name, file: r.file_name,
      sha256: r.sha256, size: r.size, notes: r.notes || '', required: !!r.required || vc < r.min_version_code,
    };
  }

  // ============================================================ application des règles

  /** Compte la consommation et ajoute/retire les utilisateurs Xray selon l'état de chaque appareil. */
  enforce() {
    if (this.enforcing) return this.enforcing;                       // jamais deux passes en parallèle
    this.enforcing = this._enforce().finally(() => { this.enforcing = null; });
    return this.enforcing;
  }

  async _enforce() {
    const now = this.now();
    let counters = null, present = null;
    try { counters = await this.core.transfer(); present = await this.core.listPeers(); } catch (e) { this._warn('xray indisponible', e); }

    const devs = this.q(`SELECT d.*, c.expires_at, c.revoked, c.bytes_offset, c.day_start, c.day_base, p.quota_bytes, p.window_start, p.window_end
                         FROM devices d JOIN codes c ON c.code = d.code JOIN plans p ON p.id = c.plan_id`).all();
    if (counters) {
      for (const d of devs) {
        const cur = counters.get(d.wg_key);
        if (cur === undefined) continue;
        const delta = cur >= d.last_counter ? cur - d.last_counter : cur;   // compteur remis à zéro au redémarrage d'Xray
        if (delta === 0 && cur === d.last_counter) continue;
        d.used_bytes += delta; d.last_counter = cur;
        this.q('UPDATE devices SET used_bytes = ?, last_counter = ? WHERE id = ?').run(d.used_bytes, cur, d.id);
      }
    }
    // Trafic des comptes SSH (SSH-TCP / SSH-WS) : compté comme celui d'Xray, donc le quota du forfait s'applique aussi.
    if (this.cfg.ssh?.enabled) {
      let usage = null;
      try { usage = await this.sshUsage(); } catch (e) { this._warn('ssh usage', e); }
      if (usage) {
        for (const d of devs) {
          const c = this.sshCredentials(d.id); const cur = c ? usage.get(c.username) : undefined;
          if (cur === undefined) continue;
          const last = d.last_counter_ssh || 0;
          const delta = cur >= last ? cur - last : cur;
          if (delta === 0 && cur === last) continue;
          d.used_bytes += delta; d.last_counter_ssh = cur;
          this.q('UPDATE devices SET used_bytes = ?, last_counter_ssh = ? WHERE id = ?').run(d.used_bytes, cur, d.id);
        }
      }
    }
    // Comptes SSH des clés (applis tierces) : trafic compté dans le forfait, 1 appareil max, coupure à l'expiration.
    const sshCodes = this.cfg.ssh?.enabled
      ? this.q(`SELECT c.*, p.quota_bytes, COALESCE(c.max_devices, p.max_devices) AS max_devices, p.window_start, p.window_end FROM codes c JOIN plans p ON p.id = c.plan_id WHERE c.ssh_active = 1`).all() : [];
    if (sshCodes.length) {
      let usage = null, sessions = null;
      try { usage = await this.sshUsage(); sessions = await this.sshSessions(); } catch (e) { this._warn('ssh codes usage', e); }
      for (const c of sshCodes) {
        const cred = this.sshCodeCredentials(c.code); if (!cred) continue;
        const cur = usage ? usage.get(cred.username) : undefined;
        if (cur !== undefined) {
          const delta = cur >= c.ssh_last ? cur - c.ssh_last : cur;
          if (delta !== 0 || cur !== c.ssh_last) {
            c.ssh_used += delta; c.ssh_last = cur;
            this.q('UPDATE codes SET ssh_used = ?, ssh_last = ? WHERE code = ?').run(c.ssh_used, cur, c.code);
          }
        }
        // Plus de connexions ouvertes que d'appareils autorisés : on coupe tout, le client se reconnecte avec son seul appareil.
        if (sessions && (sessions.get(cred.username) || 0) > Math.max(1, c.max_devices)) {
          try { await this._sudoSsh(['drop', cred.username]); } catch (e) { this._warn('ssh drop ' + c.code, e); }
        }
      }
    }
    // Fenêtre glissante de 24 h (forfaits illimités) : on la (re)démarre dès qu'elle est échue.
    const rawByCode = new Map();
    for (const d of devs) rawByCode.set(d.code, (rawByCode.get(d.code) || 0) + d.used_bytes);
    for (const c of sshCodes) rawByCode.set(c.code, (rawByCode.get(c.code) || 0) + c.ssh_used);
    const dayRows = this.q('SELECT c.code, c.day_start, c.day_base FROM codes c JOIN plans p ON p.id = c.plan_id WHERE p.quota_bytes IS NULL AND c.activated_at IS NOT NULL').all();
    const dayBlock = new Map();
    for (const c of dayRows) {
      const raw = rawByCode.get(c.code) || 0;
      if (!c.day_start || now - c.day_start >= 86400) {
        this.q('UPDATE codes SET day_start = ?, day_base = ? WHERE code = ?').run(now, raw, c.code);
        c.day_start = now; c.day_base = raw;
      }
      dayBlock.set(c.code, this.dayBlock(c, raw, now));
    }
    for (const d of devs) d.day_block_until = dayBlock.get(d.code) || 0;
    for (const c of sshCodes) c.day_block_until = dayBlock.get(c.code) || 0;
    const usedByCode = new Map();
    for (const d of devs) usedByCode.set(d.code, (usedByCode.get(d.code) || 0) + d.used_bytes);
    for (const c of sshCodes) usedByCode.set(c.code, (usedByCode.get(c.code) || 0) + c.ssh_used);
    for (const c of sshCodes) {
      const allowedCode = this.planState(c, Math.max(0, (usedByCode.get(c.code) || 0) - c.bytes_offset), now) === 'active';
      try { await this.setSshCode(c.code, allowedCode); } catch (e) { this._warn('ssh code ' + c.code.slice(0, 8), e); }
    }

    for (const d of devs) {
      const used = Math.max(0, usedByCode.get(d.code) - d.bytes_offset);
      const allowed = this.planState(d, used, now) === 'active';
      const isPresent = present ? present.has(d.wg_key) : null;
      try {
        if (allowed && isPresent !== true) await this.core.addPeer(d.wg_key, d.wg_ip);
        else if (!allowed && isPresent !== false) await this.core.removePeer(d.wg_key);
      } catch (e) { this._warn('xray ' + (allowed ? 'add' : 'remove') + ' ' + d.id, e); }
      if (this.cfg.ssh?.enabled) {
        try { await this.setSshAccount(d.id, allowed); }
        catch (e) { this._warn('ssh ' + (allowed ? 'enable' : 'disable') + ' ' + d.id, e); }
      }   // on retentera au prochain passage
    }
  }

  /** Journalise une erreur répétitive une seule fois par minute et par clé (évite de noyer le journal). */
  _warn(key, e) {
    this._warned = this._warned || new Map();
    const t = Date.now();
    if (t - (this._warned.get(key) || 0) < 60000) return;
    this._warned.set(key, t);
    if (!process.env.DS_QUIET) console.error(`[warn] ${key}: ${String(e && e.message || e).slice(0, 300)}`);
  }

  // ======================================================================== portail

  login(login, password) {
    const r = typeof login === 'string' ? this.q('SELECT * FROM resellers WHERE login = ? AND active = 1').get(login.trim().toLowerCase()) : null;
    const ok = S.verifyPassword(typeof password === 'string' ? password : '', r ? r.password_hash : S.DUMMY);
    if (!r || !ok) return null;
    const sid = S.randId(32), csrf = S.randId(16), now = this.now();
    this.q('DELETE FROM portal_sessions WHERE expires_at < ?').run(now);
    this.q('INSERT INTO portal_sessions VALUES (?,?,?,?)').run(sid, r.id, csrf, now + 12 * 3600);
    this.q('UPDATE resellers SET last_login = ? WHERE id = ?').run(now, r.id);
    return { sid, csrf };
  }

  session_(sid) {
    if (typeof sid !== 'string' || !/^[0-9a-f]{64}$/.test(sid)) return null;
    const row = this.q(`SELECT s.csrf, r.* FROM portal_sessions s JOIN resellers r ON r.id = s.reseller_id
                        WHERE s.sid = ? AND s.expires_at > ? AND r.active = 1`).get(sid, this.now());
    return row ? { csrf: row.csrf, reseller: { id: row.id, login: row.login, name: row.name, balance: row.balance, role: row.role } } : null;
  }

  logout(sid) { this.q('DELETE FROM portal_sessions WHERE sid = ?').run(sid); }

  /** Forfaits proposés à la vente (triés par prix). */
  plans() { return this.q('SELECT * FROM plans WHERE active = 1 ORDER BY position, price, hours, id').all(); }

  /** Mouvement de crédit atomique (à appeler dans une transaction) : jamais de solde négatif, toujours journalisé. */
  _credit(resellerId, delta, kind, ref, note) {
    const r = this.q('SELECT balance FROM resellers WHERE id = ?').get(resellerId);
    if (!r) throw new HttpError(404, 'not_found');
    const balance = r.balance + delta;
    if (balance < 0) throw new HttpError(402, 'insufficient_credit');
    this.q('UPDATE resellers SET balance = ? WHERE id = ?').run(balance, resellerId);
    this.q('INSERT INTO credit_ledger (reseller_id, delta, balance_after, kind, ref, note, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(resellerId, delta, balance, kind, ref || null, note || null, this.now());
    return balance;
  }

  /** Vend des clés : débite le vendeur. L'administrateur ne vend pas (il crée les vendeurs et recharge leurs crédits). */
  generateCodes(acct, planId, qty, note, devices) {
    qty = posInt(qty, 50);
    const dev = devices === undefined || devices === null || devices === '' ? null : Number(devices);
    if (dev !== null && (!Number.isInteger(dev) || dev < 1 || dev > MAX_DEVICES)) throw new HttpError(400, 'bad_devices');
    if (!qty) throw new HttpError(400, 'bad_quantity');
    note = clean(note, 80) || null;
    return tx(this.db, () => {
      const plan = this.q('SELECT * FROM plans WHERE id = ? AND active = 1').get(Number(planId));
      if (!plan) throw new HttpError(400, 'bad_plan');
      const me = this.q('SELECT id, role FROM resellers WHERE id = ? AND active = 1').get(acct.id);
      if (me && me.role === 'admin') throw new HttpError(403, 'admin_cannot_sell');   // l'administrateur ne vend pas : tout passe par les vendeurs
      if (!me) throw new HttpError(403, 'forbidden');
      if (me.role !== 'admin' && plan.seller_limit !== null) {      // ex. Pass Test : 3 clés par compte vendeur, une fois épuisées c'est fini
        const made = this.q('SELECT COUNT(*) AS n FROM codes WHERE reseller_id = ? AND plan_id = ?').get(acct.id, plan.id).n;
        if (made + qty > plan.seller_limit) throw new HttpError(403, 'limit_reached');
      }
      const cost = plan.price * qty;
      const now = this.now(), out = [];
      for (let i = 0; i < qty; i++) {
        const code = S.newCode(this.cfg.codePrefix);
        this.q('INSERT INTO codes (code, plan_id, reseller_id, note, created_at, max_devices) VALUES (?,?,?,?,?,?)').run(code, plan.id, acct.id, note, now, dev === null ? Math.min(plan.max_devices, MAX_DEVICES) : dev);
        out.push(code);
      }
      const balance = cost ? this._credit(acct.id, -cost, 'sale', `${plan.name} ×${qty}`, note) : this.q('SELECT balance FROM resellers WHERE id = ?').get(acct.id).balance;
      return { codes: out, cost, balance, plan: plan.name };
    });
  }

  /**
   * Recharge une clé déjà activée avec un forfait : il démarre maintenant (durée + données repartent de zéro).
   * Les appareils de la clé retrouvent l'accès au prochain passage de contrôle (quelques secondes).
   */
  async rechargeCode(acct, code, planId) {
    const res = tx(this.db, () => {
      const plan = this.q('SELECT * FROM plans WHERE id = ? AND active = 1').get(Number(planId));
      if (!plan) throw new HttpError(400, 'bad_plan');
      const me = this.q('SELECT id, role FROM resellers WHERE id = ? AND active = 1').get(acct.id);
      if (me && me.role === 'admin') throw new HttpError(403, 'admin_cannot_sell');   // l'administrateur ne vend pas : tout passe par les vendeurs
      if (!me) throw new HttpError(403, 'forbidden');
      const c = this.q('SELECT * FROM codes WHERE code = ?').get(String(code));
      if (!c || (c.reseller_id !== acct.id && me.role !== 'admin')) throw new HttpError(404, 'not_found');
      if (c.revoked) throw new HttpError(409, 'code_revoked');
      if (!c.activated_at) throw new HttpError(409, 'not_activated');     // clé jamais utilisée : il suffit de l'envoyer au client
      const now = this.now();
      const used = this.q('SELECT (SELECT COALESCE(SUM(used_bytes),0) FROM devices WHERE code = ?) + (SELECT COALESCE(ssh_used,0) FROM codes WHERE code = ?) AS u').get(c.code, c.code).u;
      if (plan.seller_limit !== null && me.role !== 'admin') throw new HttpError(409, 'trial_plan');   // un forfait d'essai ne se recharge pas
      const cost = plan.price;
      const balance = cost ? this._credit(acct.id, -cost, 'renew', `${plan.name} → ${c.code.slice(0, 8)}…`, c.note)
        : this.q('SELECT balance FROM resellers WHERE id = ?').get(acct.id).balance;
      const expiresAt = this.expiryFor(plan, now);
      this.q('UPDATE codes SET plan_id = ?, expires_at = ?, bytes_offset = ?, day_start = NULL WHERE code = ?').run(plan.id, expiresAt, used, c.code);
      return { cost, balance, plan: plan.name, expiresAt };
    });
    await this.enforce();
    return res;
  }

  _codeSelect() {
    return `SELECT c.*, p.name AS plan_name, COALESCE(c.max_devices, p.max_devices) AS max_devices, p.quota_bytes, r.login AS seller,
              (SELECT COUNT(*) FROM devices d WHERE d.code = c.code) AS devices,
              MAX(0, (SELECT COALESCE(SUM(d.used_bytes),0) FROM devices d WHERE d.code = c.code) + c.ssh_used - c.bytes_offset) AS used
            FROM codes c JOIN plans p ON p.id = c.plan_id JOIN resellers r ON r.id = c.reseller_id`;
  }

  listCodes(resellerId, limit = 200) {
    return this.q(`${this._codeSelect()} WHERE c.reseller_id = ? ORDER BY c.created_at DESC, c.rowid DESC LIMIT ?`).all(resellerId, limit);
  }

  getCode(acct, code) {
    const c = this.q(`${this._codeSelect()} WHERE c.code = ?`).get(String(code));
    return c && (c.reseller_id === acct.id || acct.role === 'admin') ? c : null;
  }

  listDevices(resellerId) {
    return this.q(`SELECT d.id, d.label, d.wg_ip, d.created_at, d.last_seen, d.disabled, d.used_bytes, d.code,
                   p.name AS plan_name, p.quota_bytes, c.expires_at, c.revoked, c.bytes_offset
                   FROM devices d JOIN codes c ON c.code = d.code JOIN plans p ON p.id = c.plan_id
                   WHERE c.reseller_id = ? ORDER BY d.created_at DESC`).all(resellerId);
  }

  /** Tous les appareils, tous vendeurs confondus (panel administrateur). */
  allDevices(limit = 500) {
    return this.q(`SELECT d.id, d.label, d.code, d.wg_key, d.created_at, d.last_seen, d.disabled, d.used_bytes,
                          p.name AS plan_name, c.expires_at, c.revoked
                   FROM devices d JOIN codes c ON c.code = d.code JOIN plans p ON p.id = c.plan_id
                   ORDER BY d.created_at DESC LIMIT ?`).all(limit);
  }

  deviceById(id) {
    return this.q(`SELECT d.*, c.code, c.expires_at, c.revoked, p.name AS plan_name
                   FROM devices d JOIN codes c ON c.code = d.code JOIN plans p ON p.id = c.plan_id
                   WHERE d.id = ?`).get(String(id)) || null;
  }

  stats(resellerId) {
    const now = this.now();
    return this.q(`SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN activated_at IS NULL AND revoked = 0 THEN 1 ELSE 0 END),0) AS unused,
        COALESCE(SUM(CASE WHEN activated_at IS NOT NULL AND revoked = 0 AND expires_at >= ? THEN 1 ELSE 0 END),0) AS active
        FROM codes WHERE reseller_id = ?`).get(now, resellerId);
  }

  ledger(resellerId, limit = 100) {
    return this.q('SELECT * FROM credit_ledger WHERE reseller_id = ? ORDER BY id DESC LIMIT ?').all(resellerId, limit);
  }

  /** Libère / bloque / supprime un appareil (le vendeur ne voit que ceux de ses clés). */
  async setDevice(acct, deviceId, action) {
    const d = this.q(`SELECT d.id, d.wg_key, c.reseller_id FROM devices d JOIN codes c ON c.code = d.code WHERE d.id = ?`).get(deviceId);
    if (!d || (d.reseller_id !== acct.id && acct.role !== 'admin')) throw new HttpError(404, 'not_found');
    if (action === 'toggle') this.q('UPDATE devices SET disabled = 1 - disabled WHERE id = ?').run(deviceId);
    else if (action === 'delete') {
      await this.deleteSshAccount(deviceId);
      this.q('DELETE FROM devices WHERE id = ?').run(deviceId);
      try { await this.core.removePeer(d.wg_key); } catch { /* retiré au prochain passage */ }
    } else throw new HttpError(400, 'bad_request');
    await this.enforce();
  }

  async revokeCode(acct, code) {
    const r = acct.role === 'admin'
      ? this.q('UPDATE codes SET revoked = 1 WHERE code = ?').run(code)
      : this.q('UPDATE codes SET revoked = 1 WHERE code = ? AND reseller_id = ?').run(code, acct.id);
    if (!r.changes) throw new HttpError(404, 'not_found');
    await this.enforce();
  }

  // ================================================================ administrateur

  createSeller({ login, name, password, credits = 0 }) {
    login = clean(login, 32).toLowerCase();
    if (!LOGIN_RE.test(login)) throw new HttpError(400, 'bad_login');
    if (typeof password !== 'string' || password.length < 10) throw new HttpError(400, 'bad_password');
    const n = parseCredits(credits || 0);
    if (n === null || n < 0) throw new HttpError(400, 'bad_amount');
    try {
      return tx(this.db, () => {
        const id = Number(this.q('INSERT INTO resellers (login, name, password_hash, role, balance, created_at) VALUES (?,?,?,?,0,?)')
          .run(login, clean(name, 60) || login, S.hashPassword(password), 'seller', this.now()).lastInsertRowid);
        if (n) this._credit(id, n, 'recharge', null, 'Crédit initial');
        return id;
      });
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, 'login_taken');
      throw e;
    }
  }

  createAdmin(login, password, name) {
    if (!LOGIN_RE.test(login) || typeof password !== 'string' || password.length < 10) throw new HttpError(400, 'bad_request');
    this.q('INSERT INTO resellers (login, name, password_hash, role, balance, created_at) VALUES (?,?,?,?,0,?)')
      .run(login, name || login, S.hashPassword(password), 'admin', this.now());
  }

  /** Ajoute (amount > 0) ou retire (amount < 0) des crédits ; l'opération est toujours journalisée. */
  addCredits(sellerId, amount, note) {
    const n = parseCredits(amount);
    if (n === null || n === 0) throw new HttpError(400, 'bad_amount');
    return tx(this.db, () => {
      const s = this.q("SELECT id FROM resellers WHERE id = ? AND role = 'seller'").get(Number(sellerId));
      if (!s) throw new HttpError(404, 'not_found');
      return this._credit(s.id, n, n > 0 ? 'recharge' : 'adjust', null, clean(note, 80) || null);
    });
  }

  setSellerActive(sellerId, active) {
    const r = this.q("UPDATE resellers SET active = ? WHERE id = ? AND role = 'seller'").run(active ? 1 : 0, Number(sellerId));
    if (!r.changes) throw new HttpError(404, 'not_found');
    if (!active) this.q('DELETE FROM portal_sessions WHERE reseller_id = ?').run(Number(sellerId));
  }

  resetPassword(sellerId, password) {
    if (typeof password !== 'string' || password.length < 10) throw new HttpError(400, 'bad_password');
    const r = this.q("UPDATE resellers SET password_hash = ? WHERE id = ? AND role = 'seller'").run(S.hashPassword(password), Number(sellerId));
    if (!r.changes) throw new HttpError(404, 'not_found');
    this.q('DELETE FROM portal_sessions WHERE reseller_id = ?').run(Number(sellerId));
  }

  resetAdminPassword(login, password) {
    if (typeof password !== 'string' || password.length < 10) throw new HttpError(400, 'bad_password');
    const r = this.q("UPDATE resellers SET password_hash = ? WHERE login = ? AND role = 'admin'").run(S.hashPassword(password), String(login));
    if (!r.changes) throw new HttpError(404, 'not_found');
    this.q('DELETE FROM portal_sessions WHERE reseller_id IN (SELECT id FROM resellers WHERE login = ?)').run(String(login));
  }

  /** Tableau de tous les vendeurs : crédit, clés, consommation. */
  listSellers() {
    const now = this.now();
    return this.q(`SELECT r.id, r.login, r.name, r.balance, r.active, r.created_at, r.last_login,
        (SELECT COUNT(*) FROM codes c WHERE c.reseller_id = r.id) AS keys_total,
        (SELECT COUNT(*) FROM codes c WHERE c.reseller_id = r.id AND c.revoked = 0 AND c.activated_at IS NULL) AS keys_unused,
        (SELECT COUNT(*) FROM codes c WHERE c.reseller_id = r.id AND c.revoked = 0 AND c.activated_at IS NOT NULL AND c.expires_at >= ?) AS keys_active,
        (SELECT COALESCE(SUM(d.used_bytes),0) FROM devices d JOIN codes c ON c.code = d.code WHERE c.reseller_id = r.id) AS bytes_used,
        (SELECT COALESCE(SUM(delta),0) FROM credit_ledger l WHERE l.reseller_id = r.id AND l.kind = 'recharge') AS credits_bought,
        (SELECT COALESCE(-SUM(delta),0) FROM credit_ledger l WHERE l.reseller_id = r.id AND l.kind IN ('sale','renew')) AS credits_spent
      FROM resellers r WHERE r.role = 'seller' ORDER BY r.active DESC, r.login`).all(now);
  }

  getSeller(id) {
    return this.listSellers().find((s) => s.id === Number(id)) || null;
  }

  adminStats() {
    const now = this.now();
    const one = (s, ...a) => this.q(s).get(...a);
    return {
      sellers: one("SELECT COUNT(*) AS n FROM resellers WHERE role = 'seller' AND active = 1").n,
      credits_in_wallets: one("SELECT COALESCE(SUM(balance),0) AS n FROM resellers WHERE role = 'seller'").n,
      credits_sold: one("SELECT COALESCE(SUM(delta),0) AS n FROM credit_ledger WHERE kind = 'recharge'").n,
      credits_spent: one("SELECT COALESCE(-SUM(delta),0) AS n FROM credit_ledger WHERE kind IN ('sale','renew')").n,
      keys_active: one('SELECT COUNT(*) AS n FROM codes WHERE revoked = 0 AND activated_at IS NOT NULL AND expires_at >= ?', now).n,
      keys_unused: one('SELECT COUNT(*) AS n FROM codes WHERE revoked = 0 AND activated_at IS NULL').n,
      keys_total: one('SELECT COUNT(*) AS n FROM codes').n,
      keys_expired: one('SELECT COUNT(*) AS n FROM codes WHERE revoked = 0 AND activated_at IS NOT NULL AND expires_at < ?', now).n,
      keys_revoked: one('SELECT COUNT(*) AS n FROM codes WHERE revoked = 1').n,
      requests_pending: one("SELECT COUNT(*) AS n FROM credit_requests WHERE status = 'pending'").n,
      devices: one('SELECT COUNT(*) AS n FROM devices').n,
      online: one('SELECT COUNT(*) AS n FROM devices WHERE last_seen >= ?', now - 600).n,
      bytes_used: one('SELECT COALESCE(SUM(used_bytes),0) AS n FROM devices').n,
    };
  }

  // -- forfaits (la grille de prix est celle de l'administrateur) --
  allPlans() { return this.q('SELECT * FROM plans ORDER BY active DESC, position, price, hours, id').all(); }

  /**
   * Crée un forfait. Durée : `hours` ou `days`. Prix : `credits` (décimaux acceptés : 2,5 = 250 F ; 0 = gratuit).
   * `window` = « 00:00-06:00 » (plage horaire d'utilisation), `limit` = clés max par vendeur (forfait d'essai).
   */
  createPlan({ name, hours, days, quotaGb, unlimited, credits, devices = 1, window, limit, position = 0 }) {
    name = clean(name, 40);
    const h = hours ? posInt(hours, 24 * 3650) : (days ? (posInt(days, 3650) || 0) * 24 || null : null);
    const price = parseCredits(credits), dev = posInt(devices, 10);
    const quota = unlimited ? null : Math.round(Number(quotaGb) * 1e9);
    let ws = null, we = null;
    if (window) {
      const m = String(window).match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
      if (!m) throw new HttpError(400, 'bad_plan');
      ws = Number(m[1]) * 60 + Number(m[2]); we = Number(m[3]) * 60 + Number(m[4]);
      if (ws > 1439 || we > 1440 || ws === we) throw new HttpError(400, 'bad_plan');
    }
    const lim = limit ? posInt(limit, 1000) : null;
    if (limit && !lim) throw new HttpError(400, 'bad_plan');
    if (!name || !h || price === null || price < 0 || !dev || (quota !== null && !(quota > 0))) throw new HttpError(400, 'bad_plan');
    try {
      this.q('INSERT INTO plans (name, hours, quota_bytes, price, max_devices, window_start, window_end, seller_limit, position) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(name, h, quota, price, dev, ws, we, lim, Number(position) || 0);
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, 'plan_exists');
      throw e;
    }
  }

  /** Seuls le prix et la visibilité changent : durée et données d'un forfait ne sont jamais modifiées après coup. */
  updatePlan(id, { credits, active }) {
    const p = this.q('SELECT * FROM plans WHERE id = ?').get(Number(id));
    if (!p) throw new HttpError(404, 'not_found');
    const price = credits === undefined ? p.price : parseCredits(credits);
    if (price === null || price < 0) throw new HttpError(400, 'bad_plan');
    this.q('UPDATE plans SET price = ?, active = ? WHERE id = ?').run(price, active === undefined ? p.active : (active ? 1 : 0), p.id);
  }

  /** Forfaits en vente pour ce compte, avec ce qu'il lui reste pour les forfaits limités (Pass Test). */
  plansFor(acct) {
    return this.plans().map((p) => {
      if (p.seller_limit === null || acct.role === 'admin') return { ...p, remaining: null };
      const made = this.q('SELECT COUNT(*) AS n FROM codes WHERE reseller_id = ? AND plan_id = ?').get(acct.id, p.id).n;
      return { ...p, remaining: Math.max(0, p.seller_limit - made) };
    });
  }


  /** Crée les forfaits de la grille Geny qui n'existent pas encore (sans toucher à ceux qui existent). */
  seedPlans() {
    let n = 0;
    GENY_PLANS.forEach((p, i) => {
      try { this.createPlan({ ...p, devices: 1, position: i + 1 }); n++; } catch (e) { if (!(e instanceof HttpError) || e.code !== 'plan_exists') throw e; }
    });
    return n;
  }

  // -- demandes de recharge (vendeur -> administrateur) --
  requestRecharge(acct, credits) {
    const n = parseCredits(credits);
    if (n === null || n < 100 || n > 100_000_00) throw new HttpError(400, 'bad_amount');
    const pending = this.q("SELECT COUNT(*) AS c FROM credit_requests WHERE reseller_id = ? AND status = 'pending'").get(acct.id).c;
    if (pending >= 3) throw new HttpError(429, 'too_many_requests');
    this.q('INSERT INTO credit_requests (reseller_id, amount, created_at) VALUES (?,?,?)').run(acct.id, n, this.now());
  }
  myRequests(resellerId) { return this.q('SELECT * FROM credit_requests WHERE reseller_id = ? ORDER BY id DESC LIMIT 20').all(resellerId); }
  listRequests(limit = 100) {
    return this.q(`SELECT q.*, r.login, r.name FROM credit_requests q JOIN resellers r ON r.id = q.reseller_id
                   ORDER BY (q.status = 'pending') DESC, q.id DESC LIMIT ?`).all(limit);
  }
  decideRequest(id, accept) {
    return tx(this.db, () => {
      const q = this.q("SELECT * FROM credit_requests WHERE id = ? AND status = 'pending'").get(Number(id));
      if (!q) throw new HttpError(404, 'not_found');
      if (accept) this._credit(q.reseller_id, q.amount, 'recharge', `demande #${q.id}`, 'Demande acceptée');
      this.q('UPDATE credit_requests SET status = ?, decided_at = ? WHERE id = ?').run(accept ? 'accepted' : 'refused', this.now(), q.id);
      return q;
    });
  }

  /** Supprime un vendeur sans aucune clé (sinon : le désactiver, pour garder l'historique des clés vendues). */
  deleteSeller(id) {
    return tx(this.db, () => {
      const s = this.q("SELECT id, login FROM resellers WHERE id = ? AND role = 'seller'").get(Number(id));
      if (!s) throw new HttpError(404, 'not_found');
      if (this.q('SELECT COUNT(*) AS c FROM codes WHERE reseller_id = ?').get(s.id).c) throw new HttpError(409, 'seller_has_keys');
      for (const t of ['portal_sessions', 'credit_requests', 'credit_ledger']) this.q(`DELETE FROM ${t} WHERE reseller_id = ?`).run(s.id);
      this.q('DELETE FROM resellers WHERE id = ?').run(s.id);
      return s.login;
    });
  }

  audit(actor, action, detail) {
    this.q('INSERT INTO audit_log (actor, action, detail, created_at) VALUES (?,?,?,?)').run(String(actor), String(action), detail ? String(detail).slice(0, 300) : null, this.now());
  }
  auditLog(limit = 200) { return this.q('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit); }

  /** Vue d'ensemble de la machine : RAM, disque, utilisateurs Xray (chiffres réels, jamais fictifs). */
  async serverInfo() {
    const os = require('os'), fs = require('fs');
    let disk = null;
    try { const f = fs.statfsSync('/'); disk = { total: f.blocks * f.bsize, free: f.bavail * f.bsize }; } catch { /* indisponible */ }
    let peers = null;
    try { peers = this.core ? (await this.core.listPeers()).size : null; } catch { peers = null; }
    const hs = await this._handshakes(), now = this.now();
    const online = [...hs.values()].filter((t) => t > now - Service.ONLINE_S).length;
    return { online, ram: { total: os.totalmem(), free: os.freemem() }, disk, peers, iface: 'Xray', mode: this.cfg.core.mode, uptime: Math.floor(os.uptime()) };
  }


  // ------------------------------------------------ vue administrateur en temps réel

  /** Dernière activité de trafic de chaque appareil (uid -> date s). Vide si Xray ne répond pas. */
  async _handshakes() { try { return this.core.handshakes ? await this.core.handshakes() : new Map(); } catch { return new Map(); } }

  /** Un appareil est « en ligne » s'il a eu du trafic il y a moins de 3 minutes. */
  static get ONLINE_S() { return 180; }

  _decorate(codes, devices, hs, now) {
    const byCode = new Map();
    for (const d of devices) {
      const t = hs.get(d.wg_key) || 0;
      const x = { id: d.id, label: d.label, wg_ip: d.wg_ip, created_at: d.created_at, disabled: d.disabled, used_bytes: d.used_bytes,
        last_activity: Math.max(t, d.last_seen || 0) || null, online: t > now - Service.ONLINE_S && !d.disabled };
      (byCode.get(d.code) || byCode.set(d.code, []).get(d.code)).push(x);
    }
    return codes.map((c) => {
      const devs = (byCode.get(c.code) || []).sort((a, b) => a.created_at - b.created_at);
      const used = Math.max(0, devs.reduce((n, d) => n + d.used_bytes, 0) + (c.ssh_used || 0) - c.bytes_offset);
      const state = c.revoked ? 'revoked' : !c.activated_at ? 'unused' : c.expires_at && now > c.expires_at ? 'expired'
        : c.quota_bytes !== null && used >= c.quota_bytes ? 'quota' : 'active';
      const online = devs.some((d) => d.online);
      return { ...c, used, state, online, devices: devs, last_activity: devs.reduce((m, d) => Math.max(m, d.last_activity || 0), 0) || null };
    });
  }

  /** Tous les clients (clés) avec vendeur, forfait, consommation, appareils et présence en direct. Filtrable. */
  async adminClients({ q = '', state = 'all', seller = 0, limit = 300 } = {}) {
    const now = this.now(), hs = await this._handshakes();
    const term = String(q).trim().replace(/[%_\\]/g, '').slice(0, 60), like = `%${term}%`;
    const codes = this.q(`SELECT c.code, c.note, c.created_at, c.activated_at, c.expires_at, c.revoked, c.reseller_id, c.bytes_offset, c.ssh_used,
        p.name AS plan_name, p.quota_bytes, COALESCE(c.max_devices, p.max_devices) AS max_devices, r.login AS seller, r.name AS seller_name
      FROM codes c JOIN plans p ON p.id = c.plan_id JOIN resellers r ON r.id = c.reseller_id
      WHERE (? = 0 OR c.reseller_id = ?) AND (? = '' OR c.code LIKE ? OR r.login LIKE ? OR r.name LIKE ? OR p.name LIKE ? OR c.note LIKE ?
        OR EXISTS (SELECT 1 FROM devices d WHERE d.code = c.code AND d.label LIKE ?))
      ORDER BY c.created_at DESC, c.rowid DESC`).all(Number(seller) || 0, Number(seller) || 0, term, like, like, like, like, like, like);
    const devices = this.q('SELECT d.* FROM devices d').all();
    const all = this._decorate(codes, devices, hs, now);
    const counts = { all: all.length, online: 0, active: 0, expired: 0, quota: 0, unused: 0, revoked: 0 };
    for (const c of all) { counts[c.state]++; if (c.online) counts.online++; }
    const rows = all.filter((c) => state === 'all' || (state === 'online' ? c.online : c.state === state));
    return { rows: rows.slice(0, limit), shown: Math.min(rows.length, limit), total: rows.length, counts, bySeller: all.reduce((m, c) => (c.online && m.set(c.reseller_id, (m.get(c.reseller_id) || 0) + 1), m), new Map()) };
  }

  /** Fiche complète d'une clé : vendeur, forfait, dates, consommation par appareil, présence. */
  async adminClient(code) {
    const now = this.now(), hs = await this._handshakes();
    const c = this.q(`SELECT c.*, p.name AS plan_name, p.quota_bytes, COALESCE(c.max_devices, p.max_devices) AS max_devices, p.hours, p.price, p.window_start, p.window_end,
        r.login AS seller, r.name AS seller_name FROM codes c JOIN plans p ON p.id = c.plan_id JOIN resellers r ON r.id = c.reseller_id WHERE c.code = ?`).get(String(code));
    if (!c) return null;
    return this._decorate([c], this.q('SELECT * FROM devices WHERE code = ?').all(c.code), hs, now)[0];
  }

  // -- annonces --
  allNotices() { return this.q('SELECT * FROM notices ORDER BY id DESC LIMIT 50').all(); }

  createNotice({ audience, title, body, days }) {
    title = clean(title, 80); body = clean(body, 400);
    if (!['clients', 'sellers', 'all'].includes(audience) || !title || !body) throw new HttpError(400, 'bad_notice');
    const d = days ? posInt(days, 365) : null;
    if (days && !d) throw new HttpError(400, 'bad_notice');
    const now = this.now();
    this.q('INSERT INTO notices (audience, title, body, created_at, expires_at) VALUES (?,?,?,?,?)').run(audience, title, body, now, d ? now + d * 86400 : null);
  }

  removeNotice(id) { this.q('UPDATE notices SET active = 0 WHERE id = ?').run(Number(id)); }

  releases() { return this.q('SELECT * FROM releases ORDER BY version_code DESC').all(); }
}

module.exports = { Service, HttpError, CODE_RE, LOGIN_RE, parseCredits };
