// Test de bout en bout RÉEL : un serveur Xray avec les entrées du panel, un client Xray
// qui monte l'outbound produit par /protocols, et du trafic qui passe vraiment.
//
// Le trafic est vérifié avec `curl` à travers le proxy SOCKS du client : c'est la même
// chose que ce que fait le noyau Android quand il pousse les paquets du TUN.
const { spawn, execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const P = require('../src/protocols');
const C = require('../src/client-config');

const XRAY = process.env.XRAY_BIN || '/opt/tools/xray/xray';
const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SECRET = 'secret-per-device-123456';
const SS_KEY = P.ssKey('2022-blake3-aes-128-gcm', 'master-password');
const CERT = '/tmp/ds-e2e-cert.pem';
const KEY = '/tmp/ds-e2e-key.pem';

let pass = 0, fail = 0;
const ok = (c, n, d = '') => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${d ? ' — ' + d : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

function startTarget(port) {
  return new Promise((res) => {
    const srv = http.createServer((req, r) => { r.writeHead(200, { 'Content-Type': 'text/plain' }); r.end('DARK_SURF_TUNNEL_OK'); });
    srv.listen(port, '127.0.0.1', () => res(srv));
  });
}

/** Empreinte SHA-256 du certificat, au format attendu par pinnedPeerCertSha256. */
function certPin() {
  const der = execFileSync('openssl', ['x509', '-in', CERT, '-outform', 'der']);
  return require('crypto').createHash('sha256').update(der).digest('hex');
}

async function startXray(cfg, name) {
  const f = path.join(os.tmpdir(), `ds-e2e-${name}-${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify(cfg));
  const p = spawn(XRAY, ['run', '-format', 'json', '-config', f], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  p.stdout.on('data', (d) => { log += d; });
  p.stderr.on('data', (d) => { log += d; });
  await sleep(1200);
  return { proc: p, log: () => log, stop: () => { try { p.kill('SIGKILL'); } catch {} fs.rmSync(f, { force: true }); } };
}

/** Requête HTTP à travers le proxy SOCKS5 du client Xray.
 *  Asynchrone : un appel bloquant gèlerait la boucle d'événements Node et empêcherait
 *  le serveur HTTP de test (dans le même processus) de répondre. */
function viaSocks(socksPort, targetPort) {
  return new Promise((resolve) => {
    execFile('curl', [
      '-s', '--max-time', '8', '--noproxy', '', '--socks5-hostname', `127.0.0.1:${socksPort}`,
      `http://127.0.0.1:${targetPort}/`,
    ], { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, why: String(stderr || err.message).trim().slice(0, 120) });
      resolve({ ok: String(stdout).includes('DARK_SURF_TUNNEL_OK'), why: String(stdout).slice(0, 60) });
    });
  });
}

(async () => {
  console.log(`Binaire : ${XRAY}`);
  const pin = certPin();
  const targetPort = await freePort();
  const target = await startTarget(targetPort);

  const cases = [
    { id: 'vless-ws', settings: { enabled: true, path: '/ds-vlessws' }, tls: true },
    { id: 'vmess-ws', settings: { enabled: true, path: '/ds-vmessws' }, tls: true },
    { id: 'trojan-ws', settings: { enabled: true, path: '/ds-trojanws' }, tls: true },
    { id: 'shadowsocks', settings: { enabled: true, method: '2022-blake3-aes-128-gcm' }, tls: false },
    { id: 'socks5', settings: { enabled: true }, tls: false },
    { id: 'http-proxy', settings: { enabled: true }, tls: false },
  ];

  for (const c of cases) {
    const port = await freePort();
    const socksPort = await freePort();
    const s = { ...P.defaults(c.id), ...c.settings, port };

    const ctxSrv = {
      host: '127.0.0.1', serverIp: '',
      reality: { priv: '', pbk: '', sid: '', sni: 'www.microsoft.com' },
      ssPassword: 'master-password', certPath: CERT, keyPath: KEY,
    };
    const ib = P.xrayInbound(c.id, s, ctxSrv);
    if (!ib) { ok(false, `${c.id} : entrée serveur générée`); continue; }
    ib.listen = '127.0.0.1';
    ib.port = port;
    if (c.tls) {
      ib.streamSettings = { ...ib.streamSettings, security: 'tls', tlsSettings: { certificates: [{ certificateFile: CERT, keyFile: KEY }] } };
    }
    P.xrayAddUser(ib, c.id, { uuid: UUID, secret: SECRET });

    const srvCfg = { log: { loglevel: 'warning' }, inbounds: [ib], outbounds: [{ tag: 'direct', protocol: 'freedom' }] };
    const cc = C.clientConfig(c.id, {
      host: '127.0.0.1', uuid: UUID, secret: SECRET, ssKey: SS_KEY,
      reality: { pbk: '', sid: '', sni: 'www.microsoft.com' },
      settings: s, tls: c.tls,
    });
    if (!cc || !cc.outbound) { ok(false, `${c.id} : outbound client produit`, cc?.meta?.reason || ''); continue; }

    const ob = JSON.parse(JSON.stringify(cc.outbound));
    if (ob.settings.vnext) ob.settings.vnext[0].port = port;
    if (ob.settings.servers) ob.settings.servers[0].port = port;
    if (c.tls) {
      // Certificat auto-signé du test : on épingle son empreinte (allowInsecure a été
      // supprimé d'Xray 26). Le vrai serveur a un certificat Let's Encrypt valide.
      ob.streamSettings.tlsSettings = { ...ob.streamSettings.tlsSettings, serverName: '127.0.0.1', pinnedPeerCertSha256: pin };
    }

    const cliCfg = {
      log: { loglevel: 'warning' },
      inbounds: [{ tag: 'socks-in', listen: '127.0.0.1', port: socksPort, protocol: 'socks', settings: { udp: false } }],
      outbounds: [ob, { tag: 'direct', protocol: 'freedom' }],
      // Xray bloque par défaut les destinations privées (anti-SSRF). Le serveur de test
      // est sur 127.0.0.1 : on l'autorise explicitement. Le vrai serveur n'en a pas besoin.
      routing: { rules: [{ type: 'field', ip: ['geoip:private'], outboundTag: 'direct' }] },
    };

    const srv = await startXray(srvCfg, `srv-${c.id}`);
    const cli = await startXray(cliCfg, `cli-${c.id}`);
    const r = await viaSocks(socksPort, targetPort);
    ok(r.ok, `${c.id} : trafic réellement transmis à travers le tunnel`, r.why || '');
    if (!r.ok) {
      console.log('     serveur:', srv.log().split('\n').filter(Boolean).slice(-2).join(' | '));
      console.log('     client :', cli.log().split('\n').filter(Boolean).slice(-2).join(' | '));
    }
    srv.stop(); cli.stop();
    await sleep(200);
  }

  target.close();
  console.log(`\n${pass} réussis, ${fail} échoués`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERREUR', e); process.exit(1); });
