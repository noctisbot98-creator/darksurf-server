const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const nodePath = require('path');
const cfgMod = require('./config');
const dbMod = require('./db');
const { makeBackend } = require('./core');
const { Service, HttpError } = require('./service');
const S = require('./security');
const P = require('./portal');
const I18N = require('./portal-i18n');
const ACT = require('./activation');
const Pproto = require('./protocols');
const engines = require('./engines');
const QR = require('./qr');
const { acceptWebSocket } = require('./ssh-transport');

const SID = 'ds_sid';

function createApp(overrides = {}) {
  const cfg = { ...cfgMod.load(), ...overrides };
  cfg.core = { ...cfgMod.load().wg, ...(overrides.core || {}) };
  cfg.ssh = { ...cfgMod.load().ssh, ...(overrides.ssh || {}) };
  const db = overrides.db || dbMod.open(cfg.dbPath);
  const readSettings = () => Object.fromEntries(db.prepare('SELECT key,value FROM app_settings').all().map(x => [x.key, JSON.parse(x.value)]));
  const persisted = readSettings();
  if (Object.keys(persisted).length) {
    cfg.ssh = { ...cfg.ssh, enabled: persisted.ssh_enabled ?? cfg.ssh.enabled, tcpPort: persisted.ssh_tcp_port ?? cfg.ssh.tcpPort, wsPath: persisted.ssh_ws_path ?? cfg.ssh.wsPath, hostKey: persisted.ssh_host_key ?? cfg.ssh.hostKey, wsPort: persisted.ssh_ws_port ?? cfg.ssh.wsPort, wsHost: persisted.ssh_ws_host ?? cfg.ssh.wsHost, wsTls: persisted.ssh_ws_tls ?? cfg.ssh.wsTls, payload: persisted.ssh_ws_payload ?? cfg.ssh.payload };
    cfg.modules = { ...(cfg.modules || {}), ...(persisted.modules || {}) };
    cfg.protocols = { vless: persisted.vless_enabled !== false, ssh: !!cfg.ssh.enabled, default: persisted.default_protocol === 'ssh-tcp-payload' ? 'ssh-ws' : (persisted.default_protocol || 'ssh-ws') };
  }
  cfg.protocols = { vless: true, ssh: !!cfg.ssh.enabled, default: 'ssh-ws', ...(cfg.protocols || {}) };
  cfg.modules = { stunnel: { enabled: false, port: 4444 }, dropbear: { enabled: false, port: 2200 }, udpgw: { enabled: false, port: 7300 }, ...(cfg.modules || {}) };
  const core = overrides.coreBackend || makeBackend(cfg.core);
  const service = new Service({ db, cfg, core, clock: overrides.clock });

  // ---- Moteur multi-protocoles : réglages persistés + contexte des moteurs.
  Pproto.setDefaultPath('vless-ws', cfg.core.path);   // doit rester celui que Caddy route vers Xray
  const readProtocolSettings = () => {
    const raw = persisted.protocols;
    const out = {};
    for (const p of Pproto.PROTOCOLS) out[p.id] = { ...Pproto.defaults(p.id), ...((raw && raw[p.id]) || {}) };
    return out;
  };
  const realityCtx = () => ({
    priv: cfg.core.realityPriv || '', pbk: cfg.core.realityPbk || '', sid: cfg.core.realitySid || '',
    sni: cfg.core.realitySni || 'www.microsoft.com', wgPriv: cfg.core.wgPriv || '', wgPub: cfg.core.wgPub || '',
  });
  const engineCtx = () => ({
    host: cfg.core.host, serverIp: cfg.core.serverIp || '',
    reality: realityCtx(),
    ssPassword: cfg.core.ssPassword || '',
    certPath: cfg.core.certPath || '/etc/darksurf/tls/fullchain.pem',
    keyPath: cfg.core.keyPath || '/etc/darksurf/tls/privkey.pem',
  });
  const enginesInfo = { xray: '', singbox: '' };
  (async () => {
    const vx = await engines.run(cfg.core.bin || '/usr/local/bin/xray', ['version']);
    if (vx.ok) enginesInfo.xray = (vx.out.split('\n')[0].match(/Xray\s+([\d.]+)/) || [, '?'])[1];
    const vs = await engines.run(cfg.singboxBin || '/usr/local/bin/sing-box', ['version']);
    if (vs.ok) enginesInfo.singbox = (vs.out.match(/([\d.]+)/) || [, '?'])[1];
  })().catch(() => {});

  const apiLimit = new S.RateLimiter(600, 60_000);         // 600 requêtes / minute / IP (réseaux mobiles : beaucoup d'abonnés derrière la même adresse)
  const loginLimit = new S.RateLimiter(8, 15 * 60_000);     // 8 tentatives / 15 min / IP
  const flashes = new Map();                                // sid -> clé de message (une seule lecture)

  const clientIp = (req) => (cfg.trustProxy && req.headers['x-forwarded-for']
    ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || '?';
  const isSecure = (req) => cfg.cookieSecure || (cfg.trustProxy && req.headers['x-forwarded-proto'] === 'https');

  function readBody(req, max = 16_384) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > max) { reject(new HttpError(413, 'too_large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));

  function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(obj));
  }

  function sendHtml(req, res, status, render, extra = {}) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const headers = {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      ...extra,
    };
    if (isSecure(req)) headers['Strict-Transport-Security'] = 'max-age=31536000';
    res.writeHead(status, headers);
    const out = render(nonce);
    res.end(I18N.langOf(req.headers.cookie) === 'en' ? I18N.translate(out) : out);
  }

  const redirect = (res, to, extra = {}) => { res.writeHead(303, { Location: to, 'Cache-Control': 'no-store', ...extra }); res.end(); };

  // Protection CSRF : cookie SameSite=Strict + vérification de l'origine + jeton lié à la session.
  function sameOrigin(req) {
    const site = req.headers['sec-fetch-site'];            // Fetch Metadata : fiable, posé par le navigateur
    if (site === 'same-origin') return true;
    if (site) return false;                                // cross-site, same-site, none sur un POST → refusé
    const o = req.headers.origin;
    if (!o) return true;                                   // clients sans navigateur (curl, tests)
    if (o === 'null') return false;
    try {
      const host = (cfg.trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
      return new URL(o).host === host;
    } catch { return false; }
  }
  const tokenOk = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

  // ------------------------------------------------------------------ API client
  const API = {
    enroll: (b) => service.enroll(b),
    challenge: (b) => service.challenge(b),
    session: (b) => service.session(b),
    protocols: (b) => service.protocols(b),
    status: (b) => service.status(b),
    'app/android': (b, req) => {
      const r = service.checkApp(b);
      if (r.update) { r.url = `${publicBase(req)}/downloads/${r.file}`; delete r.file; }
      return r;
    },
  };
  const publicBase = (req) => cfg.publicUrl || `${isSecure(req) ? 'https' : 'http'}://${req.headers.host}`;
  const dlLimit = new S.RateLimiter(30, 60_000);

  async function handleApi(req, res, name) {
    if (!apiLimit.allow(clientIp(req))) return sendJson(res, 429, { error: 'rate_limited' });
    if (req.method !== 'POST' || !API[name]) return sendJson(res, 404, { error: 'not_found' });
    let body;
    try { body = JSON.parse(await readBody(req, 8192)); } catch (e) {
      return sendJson(res, e instanceof HttpError ? e.status : 400, { error: e instanceof HttpError ? e.code : 'bad_json' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'bad_json' });
    try { sendJson(res, 200, await API[name](body, req)); } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.code });
      console.error('api error', e); sendJson(res, 500, { error: 'server_error' });
    }
  }

  // ------------------------------------------------------- téléchargement des APK publiés
  function handleDownload(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' });
    if (!dlLimit.allow(clientIp(req))) return sendJson(res, 429, { error: 'rate_limited' });
    const name = url.pathname.slice('/downloads/'.length);
    if (!/^darksurf-\d+\.apk$/.test(name)) return sendJson(res, 404, { error: 'not_found' });          // pas de traversée de chemin
    const rel = db.prepare('SELECT * FROM releases WHERE file_name = ? AND active = 1').get(name);
    const file = nodePath.join(nodePath.resolve(cfg.releasesDir), name);
    if (!rel || !fs.existsSync(file)) return sendJson(res, 404, { error: 'not_found' });
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': fs.statSync(file).size,
      'Content-Disposition': `attachment; filename="${name}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }

  // ---------------------------------------------------------------------- portail
  const randomPassword = () => crypto.randomBytes(12).toString('base64url');
  const csvCell = (v) => { const s = String(v ?? ''); return '"' + (/^[=+\-@\t\r]/.test(s) ? "'" + s : s).replace(/"/g, '""') + '"'; };
  const isoDate = (t) => (t ? new Date(t * 1000).toISOString() : '');
  const FLASHABLE = new Set(['insufficient_credit', 'bad_plan', 'bad_quantity', 'bad_devices', 'code_revoked', 'not_activated', 'bad_login', 'bad_password',
    'bad_amount', 'login_taken', 'plan_exists', 'bad_notice', 'not_found', 'rate_limited', 'limit_reached', 'trial_plan', 'note_required', 'too_many_requests', 'seller_has_keys', 'admin_cannot_sell']);

  // Où revenir après une erreur de formulaire.
  function backFor(path, form) {
    if (path === '/sell') return '/sell';
    if (path === '/recharge') return `/recharge?code=${encodeURIComponent(form.get('code') || '')}`;
    if (path === '/codes/ssh') return `/codes/ssh?code=${encodeURIComponent(form.get('code') || '')}`;
    if (path.startsWith('/devices') && String(form.get('back') || '').startsWith('/admin/clients/')) return form.get('back');
    if (path.startsWith('/devices')) return '/devices';
    if (path === '/credits/request') return '/credits';
    if (path === '/admin/sellers') return '/admin/sellers/new';
    const m = path.match(/^\/admin\/sellers\/(\d+)\//);
    if (m) return `/admin/sellers/${m[1]}`;
    if (path.startsWith('/admin/activation')) return '/admin/activation';
    if (path.startsWith('/admin/plans')) return '/admin/plans';
    if (path.startsWith('/admin/notices')) return '/admin/notices';
    if (path.startsWith('/admin/requests')) return '/admin/requests';
    if (path === '/codes/revoke' && String(form.get('back') || '').startsWith('/admin/')) return form.get('back');
    return '/codes';
  }

  async function handlePortal(req, res, url) {
    const path = url.pathname;
    const sid = cookies(req)[SID];
    const session = service.session_(sid);
    const now = service.now();
    const page = (status, render) => sendHtml(req, res, status, render);
    const notFound = () => page(404, (n) => P.messagePage({ nonce: n, title: 'Introuvable', text: 'Cette page n\'existe pas.' }));

    if (path === '/lang' && req.method === 'GET') {
      const l = url.searchParams.get('l') === 'en' ? 'en' : 'fr';
      let back = '/';
      try { const r = new URL(req.headers.referer || '/', 'http://x'); if (r.pathname.startsWith('/') && !r.pathname.startsWith('//')) back = r.pathname + r.search; } catch { /* retour accueil */ }
      return redirect(res, back, { 'Set-Cookie': `ds_lang=${l}; Path=/; Max-Age=31536000; SameSite=Lax${isSecure(req) ? '; Secure' : ''}` });
    }
    if (req.method === 'POST' && !sameOrigin(req)) return page(403, (n) => P.messagePage({ nonce: n, title: 'Refusé', text: 'Origine invalide.' }));

    if (path === '/login') {
      const home = (s) => (s.reseller.role === 'admin' ? '/admin' : '/sell');
      if (req.method === 'GET') return session ? redirect(res, home(session)) : page(200, (n) => P.loginPage({ nonce: n }));
      if (req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req));
        if (!loginLimit.allow(clientIp(req))) return page(429, (n) => P.loginPage({ nonce: n, error: 'Trop de tentatives. Patientez quelques minutes.' }));
        const s = service.login(form.get('login'), form.get('password'));
        if (s) { const who = service.session_(s.sid).reseller; if (who.role === 'admin') service.audit(who.login, 'Connexion administrateur', clientIp(req)); }
        if (!s) return page(401, (n) => P.loginPage({ nonce: n, error: 'Identifiant ou mot de passe incorrect.' }));
        const cookie = `${SID}=${s.sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${isSecure(req) ? '; Secure' : ''}`;
        return redirect(res, '/', { 'Set-Cookie': cookie });
      }
    }

    if (!session) return redirect(res, '/login');
    const me = session.reseller, admin = me.role === 'admin';
    if (path.startsWith('/admin') && !admin) return page(403, (n) => P.messagePage({ nonce: n, title: 'Accès refusé', text: 'Cette page est réservée à l\'administrateur.' }));
    const flashKey = flashes.get(sid); flashes.delete(sid);
    if (flashes.size > 5000) flashes.clear();
    const setFlash = (k) => flashes.set(sid, k);
    const sellerNotices = () => service.noticesFor('sellers');

    if (admin && /^\/(sell|codes|codes\.csv|recharge|devices|credits)$/.test(path)) return redirect(res, '/admin');   // l'administrateur ne vend pas
    if (req.method === 'GET') {
      if (path === '/') return redirect(res, admin ? '/admin' : '/sell');
      if (path === '/sell') return page(200, (n) => P.sellPage({ nonce: n, session, plans: service.plansFor(me), flashKey, notices: sellerNotices() }));
      if (path === '/codes') {
        return page(200, (n) => P.keysPage({ nonce: n, session, codes: service.listCodes(me.id), stats: service.stats(me.id), flashKey, now }));
      }
      if (path === '/codes/ssh') {
        const code = service.getCode(me, url.searchParams.get('code') || '');
        if (!code) return notFound();
        const fiche = code.ssh_active ? service.sshFiche(code.code) : null;
        return page(200, (n) => P.sshPage({ nonce: n, session, code, fiche, enabled: !!cfg.ssh.enabled, flashKey, now }));
      }
      if (path === '/recharge') {
        const code = service.getCode(me, url.searchParams.get('code') || '');
        if (!code) return notFound();
        return page(200, (n) => P.rechargePage({ nonce: n, session, code, plans: service.plansFor(me), flashKey, now }));
      }
      if (path === '/devices') return page(200, (n) => P.devicesPage({ nonce: n, session, devices: service.listDevices(me.id), flashKey, now }));
      if (path === '/credits') return page(200, (n) => P.creditsPage({ nonce: n, session, ledger: service.ledger(me.id), notices: sellerNotices(), requests: service.myRequests(me.id), phone: cfg.supportPhone, flashKey }));
      if (path === '/codes.csv') {
        const rows = [['code', 'forfait', 'note', 'cree', 'active', 'expire', 'revoque', 'appareils', 'donnees_utilisees_octets']].concat(
          service.listCodes(me.id, 5000).map((c) => [c.code, c.plan_name, c.note, isoDate(c.created_at), isoDate(c.activated_at), isoDate(c.expires_at), c.revoked ? 'oui' : 'non', c.devices, c.used]));
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="cles.csv"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
      }
      if (admin) {
        if (path === '/admin') {
          const [info, cl] = await Promise.all([service.serverInfo(), service.adminClients({ limit: 0 })]);
          return page(200, (n) => P.adminDashboard({ nonce: n, session, stats: service.adminStats(), sellers: service.listSellers(), flashKey, notices: [], info, bySeller: cl.bySeller, counts: cl.counts }));
        }
        if (path === '/admin/clients') {
          const f = { q: (url.searchParams.get('q') || '').slice(0, 60), state: ['all', 'online', 'active', 'expired', 'quota', 'unused', 'revoked'].includes(url.searchParams.get('state')) ? url.searchParams.get('state') : 'all', seller: Number(url.searchParams.get('seller')) || 0 };
          const data = await service.adminClients(f);
          return page(200, (n) => P.clientsPage({ nonce: n, session, data, sellers: service.listSellers(), f, now }));
        }
        const cm = path.match(/^\/admin\/clients\/([A-Za-z0-9_-]{8,80})$/);
        if (cm) {
          const c = await service.adminClient(cm[1]);
          return c ? page(200, (n) => P.clientPage({ nonce: n, session, c, flashKey, now })) : notFound();
        }
        if (path === '/admin/requests') return page(200, (n) => P.requestsPage({ nonce: n, session, requests: service.listRequests(), flashKey }));
        if (path === '/admin/audit') return page(200, (n) => P.auditPage({ nonce: n, session, rows: service.auditLog() }));
        if (path === '/admin/sellers/new') return page(200, (n) => P.sellerNewPage({ nonce: n, session, flashKey }));
        const sm = path.match(/^\/admin\/sellers\/(\d+)$/);
        if (sm) {
          const seller = service.getSeller(sm[1]);
          if (!seller) return notFound();
          return page(200, (n) => P.sellerPage({ nonce: n, session, seller, codes: service.listCodes(seller.id), ledger: service.ledger(seller.id), flashKey, now }));
        }
        if (path === '/admin/activation') {
          const pem = ACT.readKey(); let pub = '';
          try { pub = pem ? ACT.publicB64(pem) : ''; } catch { /* clé illisible */ }
          return page(200, (n) => P.activationPage({ nonce: n, session, hasKey: !!pub, pub, flashKey }));
        }
        if (path === '/admin/plans') return page(200, (n) => P.plansAdminPage({ nonce: n, session, plans: service.allPlans(), flashKey }));
        if (path === '/admin/notices') return page(200, (n) => P.noticesAdminPage({ nonce: n, session, notices: service.allNotices(), flashKey }));
        if (path === '/admin/releases') return page(200, (n) => P.releasesAdminPage({ nonce: n, session, releases: service.releases() }));
        if (path === '/admin/protocols') {
          const engine = ['all', 'xray', 'singbox'].includes(url.searchParams.get('engine')) ? url.searchParams.get('engine') : 'all';
          const protoSettings = readProtocolSettings();
          const statuses = await engines.status(protoSettings, engineCtx());
          const devices = service.allDevices(500).map((d) => ({ id: d.id, label: d.label, code: d.code }));
          const selectedDevice = String(url.searchParams.get('device') || (devices[0] && devices[0].id) || '');
          const links = [];
          if (selectedDevice) {
            const dev = service.deviceById(selectedDevice);
            if (dev) {
              for (const p of Pproto.PROTOCOLS) {
                const s = { ...Pproto.defaults(p.id), ...(protoSettings[p.id] || {}) };
                if (!s.enabled) continue;
                const l = Pproto.link(p.id, {
                  host: cfg.core.host, uuid: dev.wg_key, secret: Pproto.deviceSecret(cfg.ssh.secret || cfg.core.host, dev.id, p.id),
                  settings: s, name: `DARK_SURF ${p.family}`, reality: realityCtx(), tls: true,
                });
                if (l) links.push({ id: p.id, link: l, qr: QR.svg(l, { size: 190 }) });
              }
            }
          }
          return page(200, (n) => P.protocolsAdminPage({
            nonce: n, session, flashKey, engine, statuses, devices, selectedDevice, links,
            engines: { xray: enginesInfo.xray, singbox: enginesInfo.singbox },
            settings: {
              protocols: protoSettings,
              ssh_enabled: cfg.ssh.enabled, ssh_tcp_port: cfg.ssh.tcpPort, modules: cfg.modules, host: cfg.core.host,
              ssh_ws_path: cfg.ssh.wsPath, ssh_host_key: cfg.ssh.hostKey, ssh_ws_port: cfg.ssh.wsPort,
              ssh_ws_host: cfg.ssh.wsHost, ssh_ws_tls: cfg.ssh.wsTls, ssh_ws_payload: cfg.ssh.payload,
              vless_enabled: persisted.vless_enabled !== false,
              default_protocol: persisted.default_protocol || cfg.protocols.default || 'ssh-ws',
            },
          }));
        }
      }
      return notFound();
    }

    if (req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      if (!tokenOk(form.get('csrf'), session.csrf)) return page(403, (n) => P.messagePage({ nonce: n, title: 'Refusé', text: 'Jeton de sécurité invalide. Recharge la page.' }));
      try {
        if (path === '/logout') { service.logout(sid); return redirect(res, '/login', { 'Set-Cookie': `${SID}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` }); }
        if (path === '/credits/request') {
          service.requestRecharge(me, form.get('credits'));
          setFlash('requested'); return redirect(res, '/credits');
        }
        if (path === '/sell') {
          const created = service.generateCodes(me, form.get('plan'), form.get('qty'), form.get('note'), form.get('devices'));
          return page(200, (n) => P.createdPage({ nonce: n, session: service.session_(sid), created }));
        }
        if (path === '/recharge') {
          await service.rechargeCode(me, form.get('code'), form.get('plan'));
          setFlash('recharged'); return redirect(res, '/codes');
        }
        if (path === '/codes/ssh') {
          const fiche = await service.activateSshKey(me, form.get('code'));
          service.audit(me.login, 'Fiche SSH activée', String(form.get('code')).slice(0, 12) + '…');
          void fiche; return redirect(res, `/codes/ssh?code=${encodeURIComponent(String(form.get('code')))}`);
        }
        if (path === '/codes/revoke') {
          await service.revokeCode(me, form.get('code'));
          service.audit(me.login, 'Clé révoquée', String(form.get('code')).slice(0, 12) + '…');
          setFlash('revoked');
          const back = form.get('back');
          return redirect(res, admin && (/^\/admin\/sellers\/\d+$/.test(back || '') || /^\/admin\/clients\/[A-Za-z0-9_-]+$/.test(back || '')) ? back : '/codes');
        }
        const dm = path.match(/^\/devices\/([0-9a-f-]{36})\/(toggle|delete)$/);
        if (dm) { await service.setDevice(me, dm[1], dm[2]); service.audit(me.login, 'Appareil ' + dm[2], dm[1].slice(0, 8)); setFlash('device'); const b = form.get('back'); return redirect(res, admin && /^\/admin\/clients\/[A-Za-z0-9_-]+$/.test(b || '') ? b : '/devices'); }

        if (admin) {
          if (path === '/admin/activation/key') {
            try { ACT.saveKey(form.get('pem') || ''); service.audit(me.login, 'Clé privée vendeur installée', ''); setFlash('saved'); }
            catch { return page(400, (n) => P.activationPage({ nonce: n, session, hasKey: false, pub: '', error: 'Clé invalide : colle le fichier seller-private.pem complet (EC P-256).' })); }
            return redirect(res, '/admin/activation');
          }
          if (path === '/admin/activation/issue') {
            const pem = ACT.readKey(); let pub = '';
            try { pub = pem ? ACT.publicB64(pem) : ''; } catch { /* */ }
            const device = String(form.get('device') || '').trim().toUpperCase();
            const days = Math.max(0, Math.min(3650, Number(form.get('days') || 0) || 0));
            if (!pem || !ACT.DEVICE_RE.test(device)) return page(400, (n) => P.activationPage({ nonce: n, session, hasKey: !!pub, pub, error: 'Identifiant invalide (format AAAA-BBBB-CCCC-DDDD-EEEE).' }));
            const label = String(form.get('label') || 'vendeur').slice(0, 40) || 'vendeur';
            const code = ACT.issue({ privatePem: pem, device, days, label });
            const exp = days > 0 ? Math.floor(Date.now() / 1000) + Math.round(days * 86400) : 0;
            service.audit(me.login, 'Code vendeur émis', `${device} ${label} ${days} j`);
            return page(200, (n) => P.activationPage({ nonce: n, session, hasKey: true, pub, issued: { code, device, exp, label } }));
          }
          if (path === '/admin/protocols') {
            // ---- Moteur multi-protocoles : validation stricte, puis application réelle.
            const next = {};
            const usedPorts = new Set();
            for (const p of Pproto.PROTOCOLS) {
              const d = Pproto.defaults(p.id);
              const enabled = form.get(`p_${p.id}_enabled`) === '1';
              const port = Number(form.get(`p_${p.id}_port`) || d.port);
              // 443 est autorisé pour les protocoles relayés par Caddy (c'est Caddy qui écoute) ;
              // les ports directs restent dans la plage non privilégiée.
              const minPort = p.viaProxy ? 443 : 1024;
              if (!Number.isInteger(port) || port < minPort || port > 65535) { if (process.env.DS_DEBUG) console.error('port', p.id, port); throw new HttpError(400, 'bad_request'); }
              // Les protocoles relayés par Caddy (VLESS/WS, VMess/WS, Trojan/WS) partagent 443 :
              // c'est Caddy qui écoute et route par chemin. Seuls les ports directs doivent être uniques.
              if (enabled && !p.viaProxy) {
                if (usedPorts.has(port)) { if (process.env.DS_DEBUG) console.error('dup', p.id, port); throw new HttpError(400, 'bad_request'); }
                usedPorts.add(port);
              }
              const s = { enabled, port };
              if (p.params.includes('path')) {
                const v = String(form.get(`p_${p.id}_path`) || d.path);
                if (!/^\/[A-Za-z0-9/_-]{1,100}$/.test(v)) { if (process.env.DS_DEBUG) console.error('path', p.id, v); throw new HttpError(400, 'bad_request'); }
                s.path = v;
              }
              if (p.params.includes('sni')) {
                const v = String(form.get(`p_${p.id}_sni`) || d.sni);
                if (!/^[A-Za-z0-9.-]{1,253}$/.test(v)) { if (process.env.DS_DEBUG) console.error('sni', p.id, v); throw new HttpError(400, 'bad_request'); }
                s.sni = v;
              }
              if (p.params.includes('seed')) {
                const v = String(form.get(`p_${p.id}_seed`) || d.seed);
                if (!/^[A-Za-z0-9]{1,64}$/.test(v)) { if (process.env.DS_DEBUG) console.error('seed', p.id, v); throw new HttpError(400, 'bad_request'); }
                s.seed = v;
              }
              if (p.params.includes('method')) {
                const v = String(form.get(`p_${p.id}_method`) || d.method);
                if (!['2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', 'aes-256-gcm', 'chacha20-poly1305'].includes(v)) { if (process.env.DS_DEBUG) console.error('method', p.id, v); throw new HttpError(400, 'bad_request'); }
                s.method = v;
              }
              next[p.id] = s;
            }
            // En mode « dry » (développement, tests) aucun service n'est piloté : on persiste seulement.
            const res2 = cfg.core.mode === 'real'
              ? await engines.apply(next, engineCtx(), { xrayBin: cfg.core.bin, sbBin: cfg.singboxBin })
              : { ok: true, steps: [{ name: 'Mode dry : application simulée', ok: true, detail: '' }] };
            if (!res2.ok) {
              service.audit(me.login, 'Protocoles : application refusée', res2.steps.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`).join(' | ').slice(0, 300));
              setFlash('apply_failed'); return redirect(res, '/admin/protocols');
            }
            const put = db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at');
            put.run('protocols', JSON.stringify(next), Math.floor(Date.now() / 1000));
            persisted.protocols = next;
            service.audit(me.login, 'Protocoles VPN appliqués', Object.entries(next).filter(([, v]) => v.enabled).map(([k, v]) => `${k}:${v.port}`).join(', ').slice(0, 300));
            setFlash('applied'); return redirect(res, '/admin/protocols');
          }
          if (path === '/admin/protocols/modules') {
            const next = {};
            for (const m of ['stunnel', 'dropbear', 'udpgw']) {
              const port = Number(form.get(m + '_port')); const on = form.get(m + '_enabled') === '1';
              if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new HttpError(400, 'bad_request');
              next[m] = { enabled: on, port };
            }
            const ports = Object.values(next).filter((x) => x.enabled).map((x) => x.port);
            if (new Set(ports).size !== ports.length || ports.some((p) => [cfg.ssh.tcpPort, 80, 443, 8443, 4443, cfg.core.port].includes(p))) throw new HttpError(400, 'port_conflict');
            for (const m of ['stunnel', 'dropbear', 'udpgw']) {          // on n'applique que ce qui change, un par un
              const cur = cfg.modules[m] || { enabled: false, port: next[m].port };
              if (cur.enabled !== next[m].enabled || (next[m].enabled && cur.port !== next[m].port)) {
                if (cur.enabled && next[m].enabled && cur.port !== next[m].port) await service.applyModule(m, false, cur.port);
                await service.applyModule(m, next[m].enabled, next[m].enabled ? next[m].port : cur.port);
              }
              cfg.modules[m] = next[m];
            }
            db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run('modules', JSON.stringify(cfg.modules), Math.floor(Date.now() / 1000));
            persisted.modules = cfg.modules;
            service.audit(me.login, 'Modules SSH appliqués', JSON.stringify(cfg.modules));
            setFlash('applied'); return redirect(res, '/admin/protocols');
          }
          if (path === '/admin/protocols/ssh') {
            const enabled = form.get('ssh_enabled') === '1';
            const tcp = Number(form.get('ssh_tcp_port'));
            const wsPath = String(form.get('ssh_ws_path') || '/ws-ssh'); const hostKey = cfg.ssh.hostKey || '';
            const wsPort = Number(form.get('ssh_ws_port') || cfg.ssh.wsPort || 2084);
            const wsHost = String(form.get('ssh_ws_host') || cfg.ssh.wsHost || '').trim();
            const wsTls = form.get('ssh_ws_tls') === '1';
            const payload = String(form.get('ssh_ws_payload') || '').trim();
            const vlessEnabled = form.get('vless_enabled') === '1';
            const selected = String(form.get('default_protocol') || 'ssh-ws');
            if (!Number.isInteger(tcp) || tcp < 1024 || tcp > 65535 || !/^\/[A-Za-z0-9/_-]{1,100}$/.test(wsPath) || hostKey.length > 512 ||
                !Number.isInteger(wsPort) || wsPort < 1024 || wsPort > 65535 || !/^[A-Za-z0-9.-]{1,253}$/.test(wsHost) || payload.length > 2048) throw new HttpError(400, 'bad_request');
            if (!['vless','ssh-ws','ssh-tcp'].includes(selected) || (selected === 'vless' && !vlessEnabled) || (selected !== 'vless' && !enabled)) throw new HttpError(400, 'bad_request');
            // Appliquer d'abord le compte SSH ; le listener WS est ensuite redémarré avec les nouveaux paramètres.
            try { await service.applySshConfig({ enabled, tcpPort: tcp }); } catch { throw new HttpError(500, 'ssh_service_apply_failed'); }
            cfg.ssh.enabled = enabled; cfg.ssh.tcpPort = tcp; cfg.ssh.wsPath = wsPath; cfg.ssh.hostKey = hostKey;
            cfg.ssh.wsPort = wsPort; cfg.ssh.wsHost = wsHost; cfg.ssh.wsTls = wsTls; cfg.ssh.payload = payload;
            cfg.protocols = { ...(cfg.protocols || {}), ssh: enabled, vless: vlessEnabled, default: selected };
            if (wsDetach) { wsDetach(); wsDetach = null; }
            if (enabled) wsDetach = acceptWebSocket(server, { path: wsPath, targetPort: tcp });
            attachDedicatedSshWs();
            const values = { ssh_enabled: enabled, ssh_tcp_port: tcp, ssh_ws_path: wsPath, ssh_host_key: hostKey, ssh_ws_port: wsPort, ssh_ws_host: wsHost, ssh_ws_tls: wsTls, ssh_ws_payload: payload, vless_enabled: vlessEnabled, default_protocol: selected };
            const put = db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at');
            for (const [k,v] of Object.entries(values)) put.run(k, JSON.stringify(v), Math.floor(Date.now()/1000));
            Object.assign(persisted, values);
            service.audit(me.login, 'Configuration SSH-WS prioritaire appliquée', JSON.stringify({ ssh_enabled: enabled, tcp, wsPort, wsHost, wsTls, wsPath, vless_enabled: vlessEnabled, default_protocol: selected }));
            setFlash('applied'); return redirect(res, '/admin/protocols');
          }
          if (path === '/admin/sellers') {
            const password = (form.get('password') || '').trim() || randomPassword();
            const id = service.createSeller({ login: form.get('login'), name: form.get('name'), password, credits: form.get('credits') || 0 });
            const seller = service.getSeller(id);
            service.audit(me.login, 'Vendeur créé', seller.login);
            return page(200, (n) => P.secretPage({ nonce: n, session, title: 'Vendeur créé', login: seller.login, password, sellerId: id }));
          }
          const am = path.match(/^\/admin\/sellers\/(\d+)\/(credit|toggle|password|delete)$/);
          if (am) {
            const id = Number(am[1]);
            const seller = service.getSeller(id);
            if (!seller) throw new HttpError(404, 'not_found');
            if (am[2] === 'credit') {
              const remove = form.get('mode') === 'remove';
              if (remove && !String(form.get('note') || '').trim()) throw new HttpError(400, 'note_required');
              const raw = String(form.get('amount') || '').trim();
              if (raw.startsWith('-')) throw new HttpError(400, 'bad_amount');
              service.addCredits(id, remove ? '-' + raw : raw, form.get('note'));
              service.audit(me.login, remove ? 'Crédits retirés' : 'Crédits ajoutés', `${seller.login} : ${raw}${form.get('note') ? ' — ' + String(form.get('note')).slice(0, 80) : ''}`);
              setFlash('credited'); return redirect(res, `/admin/sellers/${id}`);
            }
            if (am[2] === 'delete') { service.deleteSeller(id); service.audit(me.login, 'Vendeur supprimé', seller.login); setFlash('deleted'); return redirect(res, '/admin'); }
            if (am[2] === 'toggle') { service.setSellerActive(id, !seller.active); service.audit(me.login, seller.active ? 'Vendeur suspendu' : 'Vendeur réactivé', seller.login); setFlash('saved'); return redirect(res, `/admin/sellers/${id}`); }
            const password = randomPassword();
            service.resetPassword(id, password);
            service.audit(me.login, 'Mot de passe réinitialisé', seller.login);
            return page(200, (n) => P.secretPage({ nonce: n, session, title: 'Nouveau mot de passe', login: seller.login, password, sellerId: id }));
          }
          if (path === '/admin/plans/seed') { const n = service.seedPlans(); service.audit(me.login, 'Forfaits Geny chargés', `${n} créés`); setFlash('seeded'); return redirect(res, '/admin/plans'); }
          if (path === '/admin/plans') {
            const hrs = form.get('unit') === 'hours';
            service.createPlan({ name: form.get('name'), hours: hrs ? form.get('duration') : undefined, days: hrs ? undefined : form.get('duration'),
              quotaGb: String(form.get('quota_gb') || '').replace(',', '.'), unlimited: form.get('unlimited') === '1' || !form.get('quota_gb'),
              credits: form.get('credits'), devices: 1, window: (form.get('window') || '').trim() || undefined, limit: form.get('limit') || undefined,
              position: 100 });
            service.audit(me.login, 'Forfait créé', String(form.get('name')).slice(0, 40));
            setFlash('saved'); return redirect(res, '/admin/plans');
          }
          const pm = path.match(/^\/admin\/plans\/(\d+)$/);
          if (pm) {
            service.audit(me.login, 'Forfait modifié', `#${pm[1]}`);
            service.updatePlan(pm[1], { credits: form.has('credits') ? form.get('credits') : undefined, active: form.has('active') ? form.get('active') === '1' : undefined });
            setFlash('saved'); return redirect(res, '/admin/plans');
          }
          const rq = path.match(/^\/admin\/requests\/(\d+)\/(accept|refuse)$/);
          if (rq) { const r = service.decideRequest(rq[1], rq[2] === 'accept'); service.audit(me.login, rq[2] === 'accept' ? 'Demande acceptée' : 'Demande refusée', `#${r.id} ${r.amount} F`); setFlash(rq[2] === 'accept' ? 'accepted' : 'refused'); return redirect(res, '/admin/requests'); }
          if (path === '/admin/notices') {
            service.createNotice({ audience: form.get('audience'), title: form.get('title'), body: form.get('body'), days: form.get('days') });
            setFlash('saved'); return redirect(res, '/admin/notices');
          }
          const nm = path.match(/^\/admin\/notices\/(\d+)\/remove$/);
          if (nm) { service.removeNotice(nm[1]); setFlash('saved'); return redirect(res, '/admin/notices'); }
        }
      } catch (e) {
        if (e instanceof HttpError) { if (process.env.DS_DEBUG) console.error('HttpError', path, e.code); setFlash(FLASHABLE.has(e.code) ? e.code : 'error'); return redirect(res, backFor(path, form)); }
        throw e;
      }
    }
    return notFound();
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/v1/')) {
        // Journal minimal des appels de l'appli (sans corps ni secrets) : permet de voir où une connexion s'arrête.
        res.on('finish', () => { if (!process.env.DS_QUIET) console.log(`api ${req.method} ${url.pathname} -> ${res.statusCode}`); });
        return await handleApi(req, res, url.pathname.slice(8));
      }
      if (url.pathname.startsWith('/downloads/')) return handleDownload(req, res, url);
      if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
      return await handlePortal(req, res, url);
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.code });
      console.error('erreur', e);
      if (!res.headersSent) sendJson(res, 500, { error: 'server_error' });
    }
  });
  server.headersTimeout = 15_000; server.requestTimeout = 20_000;

  let timer = null; let wsDetach = null; let sshWsServer = null; let sshWsDetach = null;
  const attachDedicatedSshWs = async () => {
    if (sshWsDetach) { sshWsDetach(); sshWsDetach = null; }
    if (sshWsServer) {
      const old = sshWsServer; sshWsServer = null;
      await new Promise((resolve) => old.listening ? old.close(resolve) : resolve());
    }
    if (!cfg.ssh?.enabled || !(cfg.ssh.wsPort > 0)) return;
    const notFound = (_req, res) => { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end('Not Found'); };
    if (cfg.ssh.wsTls) {
      const cert = fs.readFileSync(cfg.core.certPath); const key = fs.readFileSync(cfg.core.keyPath);
      sshWsServer = https.createServer({ cert, key }, notFound);
    } else sshWsServer = http.createServer(notFound);
    sshWsDetach = acceptWebSocket(sshWsServer, { path: cfg.ssh.wsPath, targetPort: cfg.ssh.tcpPort });
    await new Promise((resolve, reject) => {
      sshWsServer.once('error', reject);
      sshWsServer.listen(cfg.ssh.wsPort, cfg.ssh.wsBind || '0.0.0.0', () => { sshWsServer.removeListener('error', reject); resolve(); });
    });
  };
  const start = () => new Promise((resolve, reject) => {
    const listenMain = () => {
      service.enforce().catch(() => {});
      timer = setInterval(() => service.enforce().catch((e) => console.error('enforce', e)), cfg.enforceIntervalMs);
      timer.unref();
      server.listen(cfg.port, cfg.host, () => resolve(server.address().port));
      server.once('error', reject);
    };
    if (cfg.ssh?.enabled) {
      wsDetach = acceptWebSocket(server, { path: cfg.ssh.wsPath, targetPort: cfg.ssh.tcpPort });
      attachDedicatedSshWs().then(listenMain, reject);
    } else listenMain();
  });
  const close = () => new Promise((resolve) => { clearInterval(timer); wsDetach?.(); sshWsDetach?.(); const finish = () => { db.close(); resolve(); }; if (sshWsServer) sshWsServer.close(() => server.close(finish)); else server.close(finish); });

  return { server, service, cfg, db, core, start, close };
}

module.exports = { createApp };

if (require.main === module) {
  const app = createApp();
  app.start().then((port) => console.log(`DARK_SURF server : http://${app.cfg.host}:${port} (CORE_MODE=${app.cfg.core.mode})`));
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
