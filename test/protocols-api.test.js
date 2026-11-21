// Test réel de POST /protocols : on simule exactement l'appel de l'application Android
// (clé EC P-256, défi signé) contre un vrai serveur HTTP, et on vérifie que la réponse
// contient des configurations client réellement exploitables.
const { boot, fakeDevice, post, enroll } = require('./helpers');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};

(async () => {
  const t = await boot();
  const plan = t.addPlan({ name: 'Test', hours: 24, quota: 10_000_000, devices: 2 });
  const seller = t.addReseller('vendeur', 100);
  const code = 'TUN-' + require('crypto').randomBytes(24).toString('base64url').slice(0, 32);
  t.q('INSERT INTO codes (code, plan_id, reseller_id, created_at) VALUES (?,?,?,?)').run(code, plan, seller.id, t.nowS());

  // Active les protocoles comme le ferait la page Protocoles du panel.
  const settings = {
    'vless-ws': { enabled: true, port: 443, path: '/ds-vlessws' },
    'vless-reality': { enabled: true, port: 8443, sni: 'www.microsoft.com' },
    'vless-kcp': { enabled: true, port: 8444, seed: 'abc123def456' },
    'vless-tcp': { enabled: true, port: 8445 },
    'vmess-ws': { enabled: true, port: 443, path: '/ds-vmessws' },
    'trojan-ws': { enabled: true, port: 443, path: '/ds-trojanws' },
    shadowsocks: { enabled: true, port: 8388, method: '2022-blake3-aes-128-gcm' },
    hysteria2: { enabled: true, port: 8446, sni: 'www.microsoft.com' },
    tuic: { enabled: true, port: 8447, sni: 'www.microsoft.com' },
    wireguard: { enabled: true, port: 51820 },
    socks5: { enabled: true, port: 1080 },
    'http-proxy': { enabled: true, port: 8081 },
  };
  t.q("INSERT INTO app_settings (key,value,updated_at) VALUES ('protocols',?,?)").run(JSON.stringify(settings), t.nowS());

  const dev = fakeDevice();
  const [es, eb] = await enroll(t.base, code, dev);
  ok(es === 200, 'enrôlement de l\'appareil', JSON.stringify(eb));
  const deviceId = eb.device_id;

  // ---- l'appel exact de l'application
  const [, ch] = await post(t.base, 'challenge', { device_id: deviceId });
  const [ps, pb] = await post(t.base, 'protocols', {
    device_id: deviceId, challenge: ch.challenge, signature: dev.sign(ch.message),
  });
  ok(ps === 200, 'POST /protocols répond 200', JSON.stringify(pb).slice(0, 200));
  ok(pb.engine === 'xray', 'moteur annoncé = xray', String(pb.engine));
  ok(Array.isArray(pb.protocols) && pb.protocols.length === 12, '12 protocoles activés renvoyés', String(pb.protocols?.length));

  const byId = Object.fromEntries((pb.protocols || []).map((p) => [p.id, p]));

  // ---- ce que l'app SAIT monter (Xray-core embarqué)
  const supported = ['vless-ws', 'vless-reality', 'vmess-ws', 'trojan-ws', 'shadowsocks', 'socks5', 'http-proxy'];
  for (const id of supported) {
    const p = byId[id];
    ok(!!p, `${id} présent`);
    ok(p && p.app === true, `${id} marqué supporté par l'app`);
    ok(p && p.outbound && p.outbound.protocol, `${id} fournit un outbound Xray`, JSON.stringify(p?.outbound)?.slice(0, 120));
  }

  // ---- ce que l'app NE sait PAS monter : sing-box, et VLESS sans TLS (interdit par Xray)
  for (const id of ['hysteria2', 'tuic', 'wireguard', 'vless-kcp', 'vless-tcp']) {
    const p = byId[id];
    ok(!!p, `${id} présent (servi par le VPS)`);
    ok(p && p.app === false, `${id} marqué NON supporté par l'app`);
    ok(p && p.outbound === null, `${id} ne fournit aucun outbound`);
    ok(p && typeof p.reason === 'string' && p.reason.length > 20, `${id} explique pourquoi`);
  }

  // ---- cohérence des paramètres avec le panel
  ok(byId['vless-ws'].port === 443, 'vless-ws sur le port 443');
  ok(byId['vless-ws'].outbound.streamSettings.wsSettings.path === '/ds-vlessws', 'chemin WS identique au panel');
  ok(byId['vless-reality'].outbound.streamSettings.security === 'reality', 'REALITY configuré');
  ok(byId['vless-kcp'].port === 8444, 'vless-kcp sur le port 8444 (servi, mais non montable)');
  ok(byId['shadowsocks'].outbound.settings.servers[0].method === '2022-blake3-aes-128-gcm', 'méthode SS identique au panel');
  ok(byId['vless-ws'].outbound.settings.vnext[0].users[0].id === dev.wg, 'UUID = celui attribué à l\'appareil');

  // ---- le protocole par défaut
  ok(pb.default === 'vless-ws', 'défaut = vless-ws', String(pb.default));

  // ---- un protocole désactivé ne doit pas apparaître
  settings['vless-tcp'].enabled = false;
  t.q("UPDATE app_settings SET value=? WHERE key='protocols'").run(JSON.stringify(settings));
  const [, ch2] = await post(t.base, 'challenge', { device_id: deviceId });
  const [, pb2] = await post(t.base, 'protocols', { device_id: deviceId, challenge: ch2.challenge, signature: dev.sign(ch2.message) });
  ok(!pb2.protocols.some((p) => p.id === 'vless-tcp'), 'protocole désactivé absent de la liste');

  // ---- sécurité : sans signature valide, refus
  const [, ch3] = await post(t.base, 'challenge', { device_id: deviceId });
  const [bs] = await post(t.base, 'protocols', { device_id: deviceId, challenge: ch3.challenge, signature: 'faux' });
  ok(bs === 401, 'signature invalide refusée (401)', String(bs));

  await t.close();
  console.log(`\n${pass} réussis, ${fail} échoués`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERREUR', e); process.exit(1); });
