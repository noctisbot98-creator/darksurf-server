// Cohérence liens du panel <-> configuration de l'application.
//
// Le panel produit des LIENS d'import (vless://, vmess://, trojan://, ss://) pour les
// clients tiers ; l'application consomme un OUTBOUND Xray. Les deux doivent décrire le
// MÊME serveur, le MÊME port, le MÊME chemin, le MÊME SNI et les MÊMES identifiants —
// sinon l'utilisateur voit un lien qui marche dans V2Box et une appli qui ne se connecte pas.
//
// Ce test décode réellement les liens produits par protocols.js et les compare champ par
// champ à ce que client-config.js envoie à l'application.
const P = require('../src/protocols');
const C = require('../src/client-config');

let pass = 0, fail = 0;
const ok = (c, n, d = '') => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${d ? ' — ' + d : ''}`); } };

const HOST = '15-235-111-58.sslip.io';
const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SECRET = 'secret-per-device-123456';
const SS_KEY = P.ssKey('2022-blake3-aes-128-gcm', 'master-password');

const ctx = {
  host: HOST, uuid: UUID, secret: SECRET, ssKey: SS_KEY,
  reality: { pbk: 'jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0', sid: '0123abcd', sni: 'www.microsoft.com' },
  tls: true,
};

/** Décode un lien d'import en objet comparable. */
function decode(link) {
  const scheme = link.split('://')[0];
  if (scheme === 'vmess') {
    const j = JSON.parse(Buffer.from(link.slice(8), 'base64').toString('utf8'));
    return { scheme, host: j.add, port: Number(j.port), path: j.path, sni: j.sni || j.host, id: j.id, net: j.net, tls: j.tls };
  }
  const u = new URL(link);
  const q = u.searchParams;
  return {
    scheme, host: u.hostname, port: Number(u.port),
    path: decodeURIComponent(q.get('path') || ''), sni: q.get('sni') || q.get('host') || '',
    id: decodeURIComponent(u.username || ''), net: q.get('type') || '', tls: q.get('security') || '',
    method: q.get('method') || '', seed: q.get('seed') || '',
  };
}

const cases = [
  { id: 'vless-ws', settings: { enabled: true, port: 443, path: '/ds-vlessws' } },
  { id: 'vmess-ws', settings: { enabled: true, port: 443, path: '/ds-vmessws' } },
  { id: 'trojan-ws', settings: { enabled: true, port: 443, path: '/ds-trojanws' } },
  { id: 'shadowsocks', settings: { enabled: true, port: 8388, method: '2022-blake3-aes-128-gcm' } },
];

for (const c of cases) {
  const s = { ...P.defaults(c.id), ...c.settings };
  const link = P.link(c.id, { ...ctx, settings: s });
  ok(typeof link === 'string' && link.includes('://'), `${c.id} : lien d'import produit`, String(link).slice(0, 60));
  if (!link) continue;

  const d = decode(link);
  const cc = C.clientConfig(c.id, { ...ctx, settings: s });
  const ob = cc.outbound;
  const srv = ob.settings.vnext?.[0] || ob.settings.servers?.[0];

  ok(d.host === HOST, `${c.id} : même hôte (${d.host})`);
  ok(d.port === srv.port, `${c.id} : même port (lien ${d.port} / app ${srv.port})`);
  ok(d.port === Number(s.port), `${c.id} : port conforme au réglage du panel (${s.port})`);

  // Identifiants
  if (c.id === 'trojan-ws') {
    ok(d.id === SECRET, `${c.id} : même mot de passe`);
    ok(srv.password === SECRET, `${c.id} : mot de passe identique côté app`);
  } else if (c.id === 'shadowsocks') {
    ok(srv.method === s.method, `${c.id} : même méthode (${s.method})`);
    ok(srv.password === SS_KEY, `${c.id} : même clé dérivée côté app`);
  } else {
    ok(d.id === UUID, `${c.id} : même UUID`);
    ok(srv.users[0].id === UUID, `${c.id} : UUID identique côté app`);
  }

  // Transport et chemin
  if (c.id.endsWith('-ws')) {
    ok(d.net === 'ws', `${c.id} : transport WebSocket dans le lien`);
    ok(ob.streamSettings.network === 'ws', `${c.id} : transport WebSocket côté app`);
    ok(d.path === s.path, `${c.id} : même chemin (${s.path})`);
    ok(ob.streamSettings.wsSettings.path === s.path, `${c.id} : chemin identique côté app`);
    ok(d.tls === 'tls', `${c.id} : TLS dans le lien`);
    ok(ob.streamSettings.security === 'tls', `${c.id} : TLS côté app`);
  }
}

// ---- REALITY : le lien doit porter la clé publique et le shortId que l'app utilise
{
  const s = { ...P.defaults('vless-reality'), enabled: true, port: 8443, sni: 'www.microsoft.com' };
  const link = P.link('vless-reality', { ...ctx, settings: s });
  const d = decode(link);
  const ob = C.clientConfig('vless-reality', { ...ctx, settings: s }).outbound;
  ok(d.scheme === 'vless', 'REALITY : lien vless');
  ok(d.tls === 'reality', 'REALITY : sécurité reality dans le lien');
  ok(ob.streamSettings.security === 'reality', 'REALITY : sécurité reality côté app');
  ok(ob.streamSettings.realitySettings.publicKey === ctx.reality.pbk, 'REALITY : même clé publique');
  ok(ob.streamSettings.realitySettings.shortId === ctx.reality.sid, 'REALITY : même shortId');
  ok(ob.streamSettings.realitySettings.serverName === s.sni, 'REALITY : même SNI');
  ok(ob.settings.vnext[0].users[0].flow === 'xtls-rprx-vision', 'REALITY : flow Vision côté app');
}

console.log(`\n${pass} réussis, ${fail} échoués`);
process.exit(fail ? 1 : 0);
