// Test réel du moteur multi-protocoles : configurations validées par les binaires,
// services démarrés, ports en écoute, liens générés et QR décodés.
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const P = require('../src/protocols');
const E = require('../src/engines');
const QR = require('../src/qr');

const XRAY = process.env.XRAY_BIN || '/opt/tools/xray/xray';
const SB = process.env.SB_BIN || '/opt/tools/sing-box';
const HOST = '15.235.111.58';
const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};

const ctx = {
  host: HOST, serverIp: HOST,
  reality: { priv: process.env.TEST_REALITY_PRIV, pbk: process.env.TEST_REALITY_PBK, sid: 'abcd1234', sni: 'www.microsoft.com', wgPriv: process.env.TEST_WG_PRIV, wgPub: 'WGPUB' },
  ssPassword: 'ss-global-password',
  certPath: '/tmp/ds-test/fullchain.pem', keyPath: '/tmp/ds-test/privkey.pem',
};

// Tous les protocoles activés, ports distincts.
const settings = {};
for (const p of P.PROTOCOLS) settings[p.id] = { ...P.defaults(p.id), enabled: true };

(async () => {
  console.log('\n=== 1. Registre des protocoles ===');
  ok('12 protocoles déclarés', P.PROTOCOLS.length === 12, String(P.PROTOCOLS.length));
  const ids = new Set(P.PROTOCOLS.map((p) => p.id));
  ok('identifiants uniques', ids.size === P.PROTOCOLS.length);
  // 443 est partagé par les protocoles relayés par Caddy (VLESS/WS, VMess/WS, Trojan/WS) :
  // c'est Caddy qui écoute, et il route par chemin. Les autres doivent être distincts.
  const direct = P.PROTOCOLS.filter((p) => !p.viaProxy).map((p) => p.defaultPort);
  ok('ports directs distincts', new Set(direct).size === direct.length, direct.join(','));
  ok('443 réservé aux protocoles relayés par Caddy', P.PROTOCOLS.filter((p) => p.defaultPort === 443).every((p) => p.viaProxy));

  console.log('\n=== 2. Génération des liens V2Box ===');
  const links = {};
  for (const p of P.PROTOCOLS) {
    const l = P.link(p.id, { host: HOST, uuid: UUID, secret: P.deviceSecret('master', 'dev-1', p.id), ssKey: P.ssKey(settings.shadowsocks.method, ctx.ssPassword), settings: settings[p.id], name: `DARK_SURF ${p.family}`, reality: ctx.reality, tls: true });
    links[p.id] = l;
    const scheme = { 'vless-ws': 'vless://', 'vless-reality': 'vless://', 'vless-kcp': 'vless://', 'vless-tcp': 'vless://', 'vmess-ws': 'vmess://', 'trojan-ws': 'trojan://', shadowsocks: 'ss://', hysteria2: 'hysteria2://', tuic: 'tuic://', wireguard: 'wireguard://', socks5: 'socks://', 'http-proxy': 'http://' }[p.id];
    ok(`${p.id} → ${scheme}`, !!l && l.startsWith(scheme), l ? l.slice(0, 40) : 'null');
  }

  console.log('\n=== 3. Décodage des liens (round-trip) ===');
  // VMess : base64 -> JSON
  const vm = JSON.parse(Buffer.from(links['vmess-ws'].slice(8), 'base64').toString('utf8'));
  ok('VMess JSON décodable', vm.add === HOST && vm.id === UUID && vm.net === 'ws' && vm.tls === 'tls', JSON.stringify(vm).slice(0, 80));
  // Shadowsocks : base64url -> method:password
  const ss = Buffer.from(links.shadowsocks.slice(5).split('@')[0], 'base64').toString('utf8');
  ok('Shadowsocks method:password décodable', ss.startsWith('2022-blake3-aes-128-gcm:'), ss.slice(0, 40));
  // VLESS REALITY : paramètres obligatoires
  const ru = new URL(links['vless-reality']);
  ok('REALITY porte pbk + sid + flow', ru.searchParams.get('pbk') === process.env.TEST_REALITY_PBK && ru.searchParams.get('sid') === 'abcd1234' && ru.searchParams.get('flow') === 'xtls-rprx-vision');
  ok('REALITY security=reality', ru.searchParams.get('security') === 'reality');
  // TUIC : uuid:password
  const tu = new URL(links.tuic);
  ok('TUIC porte uuid et password', tu.username === UUID && tu.password.length > 0);

  console.log('\n=== 4. QR codes ===');
  for (const id of ['vless-ws', 'vmess-ws', 'hysteria2']) {
    const svg = QR.svg(links[id], { size: 200 });
    ok(`QR ${id} est un SVG valide`, svg.startsWith('<svg') && svg.includes('<path') && svg.length > 500, `${svg.length} o`);
  }
  // Vérifie qu'un QR est réellement scannable : rendu PNG puis décodage par zbar.
  fs.mkdirSync('/tmp/ds-test', { recursive: true });
  const svgFile = '/tmp/ds-test/qr.svg';
  fs.writeFileSync(svgFile, QR.svg(links['vless-ws'], { size: 400 }));
  try {
    execFileSync('rsvg-convert', ['-w', '400', '-h', '400', '-o', '/tmp/ds-test/qr.png', svgFile], { stdio: 'pipe' });
    const decoded = execFileSync('zbarimg', ['--quiet', '--raw', '/tmp/ds-test/qr.png'], { encoding: 'utf8' }).trim();
    ok('QR réellement scannable (zbar)', decoded === links['vless-ws'], decoded.slice(0, 50));
  } catch (e) {
    ok('QR réellement scannable (zbar)', false, e.message.slice(0, 80));
  }

  console.log('\n=== 5. Configuration Xray validée par le binaire ===');
  const xcfg = E.buildXray(settings, ctx);
  const tags = xcfg.inbounds.map((i) => i.tag);
  ok('entrées Xray attendues présentes', ['vless-ws', 'vless-reality', 'vless-kcp', 'vless-tcp', 'vmess-ws', 'trojan-ws', 'shadowsocks', 'socks5', 'http-proxy'].every((t) => tags.includes(t)), tags.join(','));
  const vx = await E.validateXray(xcfg, XRAY);
  ok('xray run -test accepte la configuration', vx.ok, vx.detail);

  console.log('\n=== 6. Configuration sing-box validée par le binaire ===');
  // Certificat auto-signé pour le test.
  if (!fs.existsSync('/tmp/ds-test/fullchain.pem')) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '/tmp/ds-test/privkey.pem', '-out', '/tmp/ds-test/fullchain.pem', '-days', '2', '-subj', `/CN=${HOST}`], { stdio: 'pipe' });
  }
  const scfg = E.buildSingbox(settings, ctx);
  const sbTags = scfg ? [...scfg.inbounds.map((i) => i.tag), ...((scfg.endpoints || []).map((e) => e.tag))] : [];
  ok('entrées sing-box attendues présentes', ['hysteria2', 'tuic', 'wireguard'].every((t) => sbTags.includes(t)), sbTags.join(','));
  const vs = await E.validateSingbox(scfg, SB);
  ok('sing-box check accepte la configuration', vs.ok, vs.detail);

  console.log('\n=== 7. Démarrage réel des moteurs et ports en écoute ===');
  fs.writeFileSync('/tmp/ds-test/xray.json', JSON.stringify(xcfg));
  fs.writeFileSync('/tmp/ds-test/singbox.json', JSON.stringify(scfg));
  const xp = spawn(XRAY, ['run', '-format', 'json', '-config', '/tmp/ds-test/xray.json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const sp = spawn(SB, ['run', '-c', '/tmp/ds-test/singbox.json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let xerr = '', serr = '';
  xp.stderr.on('data', (d) => { xerr += d; });
  sp.stderr.on('data', (d) => { serr += d; });
  await new Promise((r) => setTimeout(r, 2500));

  const probe = (port, proto = 'tcp') => new Promise((resolve) => {
    if (proto === 'udp') {
      // UDP : on vérifie la présence dans `ss`, pas de connexion possible.
      try {
        const out = execFileSync('ss', ['-ulpnH'], { encoding: 'utf8' });
        resolve(out.includes(`:${port} `));
      } catch { resolve(false); }
      return;
    }
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });

  const checks = [
    ['vless-ws', 10000, 'tcp'], ['vmess-ws', 10001, 'tcp'], ['trojan-ws', 10002, 'tcp'],
    ['vless-reality', 8443, 'tcp'], ['vless-tcp', 8445, 'tcp'], ['shadowsocks', 8388, 'tcp'],
    ['socks5', 1080, 'tcp'], ['http-proxy', 8081, 'tcp'],
    ['vless-kcp', 8444, 'udp'], ['hysteria2', 8446, 'udp'], ['tuic', 8447, 'udp'], ['wireguard', 51820, 'udp'],
  ];
  for (const [id, port, proto] of checks) {
    const up = await probe(port, proto);
    ok(`${id} écoute sur ${proto}:${port}`, up);
  }

  console.log('\n=== 8. Injection d\'un utilisateur à chaud (API Xray) ===');
  // Ajoute l'UUID dans l'entrée VLESS/WS via l'API, comme le fait DARK_SURF.
  const apiFile = '/tmp/ds-test/adu.json';
  fs.writeFileSync(apiFile, JSON.stringify({ inbounds: [{ tag: 'vless-ws', listen: '127.0.0.1', port: 10000, protocol: 'vless', settings: { decryption: 'none', clients: [{ id: UUID, email: UUID, level: 0 }] } }] }));
  try {
    const out = execFileSync(XRAY, ['api', 'adu', '--server=127.0.0.1:10085', apiFile], { encoding: 'utf8' });
    ok('xray api adu ajoute l\'utilisateur', /Added\s+1\s+user/i.test(out), out.trim().slice(0, 80));
    const list = execFileSync(XRAY, ['api', 'inbounduser', '--server=127.0.0.1:10085', '-tag=vless-ws'], { encoding: 'utf8' });
    ok('l\'UUID est bien présent dans l\'entrée', list.includes(UUID), list.trim().slice(0, 80));
  } catch (e) {
    ok('xray api adu ajoute l\'utilisateur', false, (e.stderr || e.message).toString().slice(0, 120));
  }

  console.log('\n=== 9. Trafic réel à travers le tunnel VLESS/WS ===');
  // Client Xray local : SOCKS 10899 -> VLESS/WS sur 127.0.0.1:10000
  const clientCfg = {
    log: { loglevel: 'warning' },
    inbounds: [{ tag: 'socks', listen: '127.0.0.1', port: 10899, protocol: 'socks', settings: { udp: false } }],
    outbounds: [{
      tag: 'proxy', protocol: 'vless',
      settings: { vnext: [{ address: '127.0.0.1', port: 10000, users: [{ id: UUID, encryption: 'none', level: 0 }] }] },
      streamSettings: { network: 'ws', wsSettings: { path: settings['vless-ws'].path, headers: { Host: HOST } } },
    }],
  };
  fs.writeFileSync('/tmp/ds-test/client.json', JSON.stringify(clientCfg));
  const cp = spawn(XRAY, ['run', '-format', 'json', '-config', '/tmp/ds-test/client.json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const ip = execFileSync('curl', ['-s', '--max-time', '20', '--socks5-hostname', '127.0.0.1:10899', 'https://api.ipify.org'], { encoding: 'utf8' }).trim();
    ok('curl via le tunnel renvoie une IP publique', /^\d+\.\d+\.\d+\.\d+$/.test(ip), ip);
  } catch (e) {
    ok('curl via le tunnel renvoie une IP publique', false, e.message.slice(0, 100));
  }
  // Statistiques Xray : le trafic doit être compté pour cet UUID.
  try {
    const st = execFileSync(XRAY, ['api', 'statsquery', '--server=127.0.0.1:10085', '-pattern=user>>>'], { encoding: 'utf8' });
    const j = JSON.parse(st);
    const up = (j.stat || []).find((s) => s.name === `user>>>${UUID}>>>traffic>>>uplink`);
    const down = (j.stat || []).find((s) => s.name === `user>>>${UUID}>>>traffic>>>downlink`);
    ok('trafic montant comptabilisé', up && Number(up.value) > 0, up ? `${up.value} o` : 'absent');
    ok('trafic descendant comptabilisé', down && Number(down.value) > 0, down ? `${down.value} o` : 'absent');
  } catch (e) {
    ok('statistiques Xray lisibles', false, e.message.slice(0, 100));
  }

  cp.kill('SIGKILL'); xp.kill('SIGKILL'); sp.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 500));

  console.log(`\n=== RÉSULTAT : ${pass} réussis, ${fail} échoués ===`);
  if (xerr.trim()) console.log('stderr xray:', xerr.trim().split('\n').slice(0, 3).join(' | '));
  if (serr.trim()) console.log('stderr sing-box:', serr.trim().split('\n').slice(0, 3).join(' | '));
  process.exit(fail ? 1 : 0);
})();
