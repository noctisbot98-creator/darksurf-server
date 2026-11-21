// Moteurs VPN : génération, validation, application et supervision.
//
// Deux moteurs cohabitent sur le VPS :
//   - Xray-core  : VLESS (WS/REALITY/mKCP/TCP), VMess, Trojan, Shadowsocks, SOCKS, HTTP
//   - sing-box   : Hysteria2, TUIC, WireGuard
//
// Règle d'or : on ne touche JAMAIS au service en cours avant que la nouvelle
// configuration ait été validée par le binaire lui-même (`xray run -test`,
// `sing-box check`). En cas d'échec, l'ancien fichier est restauré.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const P = require('./protocols');

const XRAY_CFG = '/etc/darksurf/xray.json';
const SB_CFG = '/etc/darksurf/singbox.json';
const STATE = '/etc/darksurf/protocols.json';

const run = (bin, args, opts = {}) => new Promise((resolve) => {
  execFile(bin, args, { timeout: opts.timeout || 15000, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => {
    resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, out: String(out || ''), err: String(errOut || '') });
  });
});

// ------------------------------------------------------------------ Xray

/**
 * Construit la configuration Xray complète.
 * settings : { [protocolId]: { enabled, port, path, sni, seed, method } }
 * ctx      : { host, reality:{priv,pbk,sid,sni}, ssPassword, serverIp }
 */
function buildXray(settings, ctx) {
  const inbounds = [
    { tag: 'api', listen: '127.0.0.1', port: 10085, protocol: 'dokodemo-door', settings: { address: '127.0.0.1' } },
  ];
  const enabled = [];
  for (const p of P.PROTOCOLS) {
    if (p.engine !== 'xray') continue;
    const s = { ...P.defaults(p.id), ...(settings[p.id] || {}) };
    if (!s.enabled) continue;
    const ib = P.xrayInbound(p.id, s, ctx);
    if (!ib) continue;
    inbounds.push(ib);
    enabled.push(p.id);
  }
  // Une seule entrée VLESS/WS est indispensable : c'est le socle historique de DARK_SURF.
  if (!enabled.includes('vless-ws')) {
    const s = { ...P.defaults('vless-ws'), ...(settings['vless-ws'] || {}), enabled: true };
    inbounds.push(P.xrayInbound('vless-ws', s, ctx));
    enabled.push('vless-ws');
  }

  const selfRule = /^\d+\.\d+\.\d+\.\d+$/.test(ctx.serverIp || '')
    ? [{ type: 'field', ip: [`${ctx.serverIp}/32`], outboundTag: 'block' }] : [];

  return {
    log: { loglevel: 'warning' },
    stats: {},
    api: { tag: 'api', services: ['HandlerService', 'StatsService'] },
    policy: {
      levels: { 0: { statsUserUplink: true, statsUserDownlink: true, handshake: 6, connIdle: 600, uplinkOnly: 5, downlinkOnly: 10, bufferSize: 1024 } },
      system: { statsInboundUplink: true, statsInboundDownlink: true },
    },
    inbounds,
    outbounds: [
      { tag: 'direct', protocol: 'freedom', settings: { domainStrategy: 'UseIPv4' }, streamSettings: { sockopt: { tcpNoDelay: true, tcpFastOpen: true, tcpKeepAliveIdle: 30, tcpKeepAliveInterval: 15 } } },
      { tag: 'block', protocol: 'blackhole' },
    ],
    routing: {
      domainStrategy: 'IPIfNonMatch',
      rules: [
        { type: 'field', inboundTag: ['api'], outboundTag: 'api' },
        ...selfRule,
        { type: 'field', ip: ['geoip:private'], outboundTag: 'block' },
        { type: 'field', port: '25', outboundTag: 'block' },
        { type: 'field', protocol: ['bittorrent'], outboundTag: 'block' },
      ],
    },
  };
}

// ------------------------------------------------------------------ sing-box

function buildSingbox(settings, ctx) {
  const inbounds = [];
  const endpoints = [];
  const enabled = [];
  for (const p of P.PROTOCOLS) {
    if (p.engine !== 'singbox') continue;
    const s = { ...P.defaults(p.id), ...(settings[p.id] || {}) };
    if (!s.enabled) continue;
    const ep = P.singboxEndpoint(p.id, s, ctx);
    if (ep) { endpoints.push(ep); enabled.push(p.id); continue; }
    const ib = P.singboxInbound(p.id, s, ctx);
    if (!ib) continue;
    inbounds.push(ib);
    enabled.push(p.id);
  }
  if (!inbounds.length && !endpoints.length) return null;
  const cfg = {
    log: { level: 'warn', timestamp: true },
    inbounds,
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: { rules: [{ ip_is_private: true, outbound: 'direct' }], final: 'direct' },
  };
  if (endpoints.length) cfg.endpoints = endpoints;
  return cfg;
}

// ------------------------------------------------------------------ application

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeAtomic(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o640 });
  fs.renameSync(tmp, file);
}

/** Valide une configuration Xray avec le binaire lui-même. */
async function validateXray(cfg, bin = '/usr/local/bin/xray') {
  const tmp = `/tmp/ds-xray-test-${process.pid}.json`;
  fs.writeFileSync(tmp, JSON.stringify(cfg), { mode: 0o600 });
  try {
    const r = await run(bin, ['run', '-test', '-format', 'json', '-config', tmp]);
    return { ok: r.ok, detail: (r.err || r.out).trim().split('\n').slice(-3).join(' | ') };
  } finally { fs.rmSync(tmp, { force: true }); }
}

async function validateSingbox(cfg, bin = '/usr/local/bin/sing-box') {
  const tmp = `/tmp/ds-sb-test-${process.pid}.json`;
  fs.writeFileSync(tmp, JSON.stringify(cfg), { mode: 0o600 });
  try {
    const r = await run(bin, ['check', '-c', tmp]);
    return { ok: r.ok, detail: (r.err || r.out).trim().split('\n').slice(-3).join(' | ') };
  } finally { fs.rmSync(tmp, { force: true }); }
}

/**
 * Applique une configuration complète.
 * Retourne { ok, steps:[{name, ok, detail}], rolledBack }
 */
async function apply(settings, ctx, opts = {}) {
  const steps = [];
  const xrayCfg = buildXray(settings, ctx);
  const sbCfg = buildSingbox(settings, ctx);

  // 1. Validation AVANT toute écriture.
  const vx = await validateXray(xrayCfg, opts.xrayBin);
  steps.push({ name: 'Configuration Xray valide', ok: vx.ok, detail: vx.detail });
  if (!vx.ok) return { ok: false, steps, rolledBack: false };

  let vs = { ok: true, detail: 'aucun protocole sing-box activé' };
  if (sbCfg) {
    vs = await validateSingbox(sbCfg, opts.sbBin);
    steps.push({ name: 'Configuration sing-box valide', ok: vs.ok, detail: vs.detail });
    if (!vs.ok) return { ok: false, steps, rolledBack: false };
  }

  // 1bis. Sans droits root (service du panel) : on dépose les fichiers dans un dossier d'échange et un assistant sudo
  // (darksurf-svc apply) fait la sauvegarde, l'installation, le redémarrage et, au besoin, le retour arrière.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if ((!isRoot || opts.useHelper) && !opts.dryRun) {
    const stage = process.env.DS_STAGE_DIR || '/var/lib/darksurf/protocol-stage';
    try {
      fs.mkdirSync(stage, { recursive: true });
      const put = (name, obj) => fs.writeFileSync(path.join(stage, name), JSON.stringify(obj, null, 2), { mode: 0o640 });
      put('xray.json', xrayCfg);
      put('protocols.json', { settings, updated_at: Math.floor(Date.now() / 1000) });
      if (sbCfg) put('singbox.json', sbCfg); else fs.rmSync(path.join(stage, 'singbox.json'), { force: true });
    } catch (e) {
      steps.push({ name: 'Préparation des fichiers', ok: false, detail: e.message });
      return { ok: false, steps, rolledBack: false };
    }
    steps.push({ name: 'Préparation des fichiers', ok: true, detail: stage });
    const r = await run('sudo', ['-n', '/usr/local/sbin/darksurf-svc', 'apply'], { timeout: 90000 });
    const out = (r.out + r.err).trim().split('\n').slice(-3).join(' | ');
    if (!r.ok) {
      const rolled = /ROLLBACK/.test(out);
      steps.push({ name: 'Application sur le VPS', ok: false, detail: out || `code ${r.code}` });
      if (rolled) steps.push({ name: 'Restauration des configurations précédentes', ok: true, detail: 'rollback effectué' });
      return { ok: false, steps, rolledBack: rolled };
    }
    steps.push({ name: 'Application sur le VPS', ok: true, detail: out });
    return { ok: true, steps };
  }

  // 2. Sauvegarde des fichiers actuels.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // Le service tourne sans droits root : les sauvegardes vont dans son dossier d'état.
  const backup = path.join(process.env.DS_BACKUP_DIR || '/var/lib/darksurf/protocol-backups', stamp);
  if (!opts.dryRun) {
    fs.mkdirSync(backup, { recursive: true });
    for (const f of [XRAY_CFG, SB_CFG, STATE]) {
      if (fs.existsSync(f)) fs.copyFileSync(f, path.join(backup, path.basename(f)));
    }
  }
  steps.push({ name: 'Sauvegarde des configurations', ok: true, detail: backup });

  if (opts.dryRun) return { ok: true, steps, backup, dryRun: true };

  // 3. Écriture atomique.
  try {
    writeAtomic(XRAY_CFG, xrayCfg);
    if (sbCfg) writeAtomic(SB_CFG, sbCfg);
    writeAtomic(STATE, { settings, updated_at: Math.floor(Date.now() / 1000) });
    steps.push({ name: 'Écriture des fichiers', ok: true, detail: `${XRAY_CFG}${sbCfg ? ' + ' + SB_CFG : ''}` });
  } catch (e) {
    steps.push({ name: 'Écriture des fichiers', ok: false, detail: e.message });
    return { ok: false, steps, rolledBack: false, backup };
  }

  // 4. Redémarrage contrôlé.
  // Sans droits root, le redémarrage passe par l'aide sudo « darksurf-svc » (limitée à xray et sing-box).
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const svcRestart = (svc) => asRoot
    ? run('systemctl', ['restart', svc], { timeout: 30000 })
    : run('sudo', ['-n', '/usr/local/sbin/darksurf-svc', 'restart', svc], { timeout: 30000 });
  const restart = async (svc) => {
    const r = await svcRestart(svc);
    if (!r.ok) return { ok: false, detail: (r.err || r.out).trim() };
    await new Promise((res) => setTimeout(res, 1200));
    const a = await run('systemctl', ['is-active', svc]);
    return { ok: a.out.trim() === 'active', detail: a.out.trim() };
  };

  const rx = await restart('xray');
  steps.push({ name: 'Service Xray redémarré', ok: rx.ok, detail: rx.detail });
  let rs = { ok: true, detail: 'non requis' };
  if (sbCfg) {
    rs = await restart('darksurf-singbox');
    steps.push({ name: 'Service sing-box redémarré', ok: rs.ok, detail: rs.detail });
  }

  if (!rx.ok || !rs.ok) {
    // 5. Rollback.
    for (const f of [XRAY_CFG, SB_CFG]) {
      const b = path.join(backup, path.basename(f));
      if (fs.existsSync(b)) fs.copyFileSync(b, f);
    }
    await svcRestart('xray');
    if (sbCfg) await svcRestart('darksurf-singbox');
    steps.push({ name: 'Restauration des configurations précédentes', ok: true, detail: 'rollback effectué' });
    return { ok: false, steps, rolledBack: true, backup };
  }

  return { ok: true, steps, backup };
}

// ------------------------------------------------------------------ supervision

/** Ports réellement en écoute, d'après `ss`. */
async function listening() {
  const r = await run('ss', ['-tulpnH']);
  const map = new Map();   // "tcp:443" -> { proc, addr }
  for (const line of r.out.split('\n')) {
    const m = /^(tcp|udp)\s+\S+\s+\S+\s+(\S+)\s+\S+\s+.*?users:\(\("([^"]+)"/.exec(line.trim());
    if (!m) continue;
    const [, proto, local, proc] = m;
    const port = Number(String(local).split(':').pop());
    if (!port) continue;
    map.set(`${proto}:${port}`, { proc, addr: local });
  }
  return map;
}

/** État réel de chaque protocole : activé en config + port en écoute. */
async function status(settings, ctx) {
  const ls = await listening();
  const out = [];
  for (const p of P.PROTOCOLS) {
    const s = { ...P.defaults(p.id), ...(settings[p.id] || {}) };
    const port = Number(s.port) || p.defaultPort;
    const proto = p.udp ? 'udp' : 'tcp';
    const hit = ls.get(`${proto}:${port}`);
    out.push({
      id: p.id, label: p.label, engine: p.engine, family: p.family,
      enabled: !!s.enabled, port, transport: p.transport, security: p.security,
      listening: !!hit, process: hit ? hit.proc : null,
      // VLESS/WS et VMess/Trojan passent par Caddy : c'est Caddy qui écoute 443.
      viaProxy: !!p.viaProxy,
      ok: !!s.enabled && (hit || p.viaProxy),
    });
  }
  return out;
}

module.exports = {
  XRAY_CFG, SB_CFG, STATE, buildXray, buildSingbox, validateXray, validateSingbox,
  apply, status, listening, readJson, writeAtomic, run,
};
