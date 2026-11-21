// Vérifie la transformation faite par l'application Android (XrayVpnService.configForOutbound)
// en la reproduisant fidèlement en JS, puis en soumettant le résultat au binaire Xray réel.
//
// Ce que fait l'app : prend l'outbound de /protocols, remplace l'adresse par l'IP résolue
// hors tunnel, l'entoure d'une entrée TUN et d'une sortie directe. Si cette enveloppe est
// mal formée, le noyau refuse de démarrer sur le téléphone — on le détecte ici.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../src/protocols');
const C = require('../src/client-config');

const XRAY = process.env.XRAY_BIN || '/opt/tools/xray/xray';

/** Réplique exacte de XrayVpnService.configForOutbound (Kotlin). */
function configForOutbound(outbound, ip) {
  const out = JSON.parse(JSON.stringify(outbound));
  const s = out.settings || {};
  if (s.vnext?.[0]) s.vnext[0].address = ip;
  if (s.servers?.[0]) s.servers[0].address = ip;
  return {
    log: { loglevel: 'warning' },
    inbounds: [{
      tag: 'tun', protocol: 'tun', settings: { mtu: 1400 },
      sniffing: { enabled: true, destOverride: ['http', 'tls'] },
    }],
    routing: { domainStrategy: 'AsIs' },
    outbounds: [out, { tag: 'direct', protocol: 'freedom' }],
  };
}

let pass = 0, fail = 0;
const ok = (c, n, d = '') => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${d ? ' — ' + d : ''}`); } };

const ctx = {
  host: '15-235-111-58.sslip.io',
  uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  secret: 'secret-per-device-123456',
  ssKey: P.ssKey('2022-blake3-aes-128-gcm', 'master-password'),
  reality: { pbk: 'jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0', sid: '0123abcd', sni: 'www.microsoft.com' },
  tls: true,
};

const ids = ['vless-ws', 'vless-reality', 'vmess-ws', 'trojan-ws', 'shadowsocks', 'socks5', 'http-proxy'];

for (const id of ids) {
  const s = { ...P.defaults(id), enabled: true };
  const cc = C.clientConfig(id, { ...ctx, settings: s });
  if (!cc?.outbound) { ok(false, `${id} : outbound disponible`); continue; }

  const cfg = configForOutbound(cc.outbound, '15.235.111.58');
  const tmp = path.join(os.tmpdir(), `ds-app-${id}.json`);
  fs.writeFileSync(tmp, JSON.stringify(cfg));
  let good = false, detail = '';
  try {
    execFileSync(XRAY, ['run', '-test', '-format', 'json', '-config', tmp], { stdio: 'pipe' });
    good = true;
  } catch (e) {
    detail = String(e.stderr || e.stdout || e.message).trim().split('\n').slice(-2).join(' | ');
  } finally { fs.rmSync(tmp, { force: true }); }

  ok(good, `${id} : configuration de l'app acceptée par Xray`, detail);
  // L'adresse doit bien être remplacée par l'IP (le noyau ne doit pas faire de DNS avant le tunnel).
  const srv = cfg.outbounds[0].settings.vnext?.[0] || cfg.outbounds[0].settings.servers?.[0];
  ok(srv.address === '15.235.111.58', `${id} : adresse remplacée par l'IP résolue`);
  ok(cfg.inbounds[0].protocol === 'tun', `${id} : entrée TUN présente`);
  ok(cfg.outbounds.length === 2, `${id} : sortie directe de secours présente`);
}

console.log(`\n${pass} réussis, ${fail} échoués`);
process.exit(fail ? 1 : 0);
