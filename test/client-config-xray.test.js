// Validation RÉELLE : chaque outbound produit par /protocols est inséré dans une
// configuration Xray complète (TUN + outbound + direct) et soumis au binaire Xray lui-même
// (`xray run -test`). Un outbound mal formé est refusé ici, pas sur le téléphone.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../src/protocols');
const C = require('../src/client-config');

const XRAY = process.env.XRAY_BIN || '/opt/tools/xray/xray';

const settings = {
  'vless-ws': { enabled: true, port: 443, path: '/ds-vlessws' },
  'vless-reality': { enabled: true, port: 8443, sni: 'www.microsoft.com' },
  'vless-kcp': { enabled: true, port: 8444, seed: 'abc123def456' },
  'vless-tcp': { enabled: true, port: 8445 },
  'vmess-ws': { enabled: true, port: 443, path: '/ds-vmessws' },
  'trojan-ws': { enabled: true, port: 443, path: '/ds-trojanws' },
  shadowsocks: { enabled: true, port: 8388, method: '2022-blake3-aes-128-gcm' },
  socks5: { enabled: true, port: 1080 },
  'http-proxy': { enabled: true, port: 8081 },
  hysteria2: { enabled: true, port: 8446, sni: 'www.microsoft.com' },
  tuic: { enabled: true, port: 8447, sni: 'www.microsoft.com' },
  wireguard: { enabled: true, port: 51820 },
};

const ctx = {
  host: 'vpn.example.com',
  uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  secret: 'secret-per-device-123456',
  ssKey: P.ssKey('2022-blake3-aes-128-gcm', 'master-password'),
  reality: { pbk: 'jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0', sid: '0123abcd', sni: 'www.microsoft.com' },
  tls: true,
};

let pass = 0, fail = 0;
const ok = (c, n, d = '') => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${d ? ' — ' + d : ''}`); } };

console.log(`Binaire : ${XRAY}`);
console.log(execFileSync(XRAY, ['version'], { encoding: 'utf8' }).split('\n')[0]);

for (const p of P.PROTOCOLS) {
  const s = { ...P.defaults(p.id), ...(settings[p.id] || {}) };
  const c = C.clientConfig(p.id, { ...ctx, settings: s });
  if (!c) { ok(false, `${p.id} : configuration produite`); continue; }

  if (!c.meta.app) {
    ok(c.outbound === null, `${p.id} : non supporté par l'app, aucun outbound (${c.meta.engine})`);
    continue;
  }

  // Configuration client complète, telle que l'app la monterait.
  const cfg = {
    log: { loglevel: 'warning' },
    inbounds: [{ tag: 'tun', protocol: 'tun', settings: { mtu: 1400 } }],
    outbounds: [c.outbound, { tag: 'direct', protocol: 'freedom' }],
    routing: { domainStrategy: 'AsIs' },
  };
  const tmp = path.join(os.tmpdir(), `ds-client-${p.id}.json`);
  fs.writeFileSync(tmp, JSON.stringify(cfg));
  let good = false, detail = '';
  try {
    execFileSync(XRAY, ['run', '-test', '-format', 'json', '-config', tmp], { stdio: 'pipe' });
    good = true;
  } catch (e) {
    detail = String(e.stderr || e.stdout || e.message).trim().split('\n').slice(-2).join(' | ');
  } finally { fs.rmSync(tmp, { force: true }); }
  ok(good, `${p.id} : configuration client acceptée par Xray`, detail);
}

console.log(`\n${pass} réussis, ${fail} échoués`);
process.exit(fail ? 1 : 0);
