// Configuration client : ce que l'application DARK_SURF doit monter pour chaque protocole.
//
// Le panel (page Protocoles) produit des LIENS d'import (vless://, vmess://, ...) destinés
// aux clients tiers comme V2Box. L'application, elle, n'importe pas de lien : elle embarque
// le noyau Xray (libv2ray / AndroidLibXrayLite) et a besoin d'un OBJET OUTBOUND Xray complet.
//
// Ce module est la seule source de vérité pour cette traduction : il réutilise les mêmes
// réglages (port, chemin, SNI, seed, méthode) que protocols.js, donc le lien du panel et la
// configuration de l'app ne peuvent pas diverger.
//
// Règle honnête : un protocole n'est marqué `app: true` que si le moteur embarqué dans
// l'application sait réellement le monter. L'app embarque Xray-core uniquement — pas
// sing-box. Hysteria2, TUIC et WireGuard sont donc servis par le VPS mais NON montables
// par l'application : ils restent listés, avec `app: false` et une raison explicite, pour
// que l'interface puisse le dire à l'utilisateur au lieu de le laisser échouer.

const P = require('./protocols');

/** Moteur embarqué dans l'application Android (libv2ray = Xray-core). */
const APP_ENGINE = 'xray';

/**
 * Construit l'outbound Xray d'un protocole pour un appareil donné.
 * ctx = { host, uuid, secret, settings, reality:{pbk,sid,sni}, ssKey, tls }
 * Retourne { outbound, meta } ou null si le protocole n'est pas montable par l'app.
 */
function clientConfig(id, ctx) {
  const p = P.get(id);
  if (!p) return null;
  const s = { ...P.defaults(id), ...(ctx.settings || {}) };
  const host = ctx.host;
  const port = Number(s.port) || p.defaultPort;
  const uuid = ctx.uuid;
  const secret = ctx.secret;

  const meta = {
    id, label: p.label, family: p.family, engine: p.engine,
    transport: p.transport, security: p.security, port,
    host, udp: !!p.udp, viaProxy: !!p.viaProxy,
    app: p.engine === APP_ENGINE,
    reason: p.engine === APP_ENGINE ? null
      : `Ce protocole est servi par sing-box sur le VPS ; l'application embarque Xray-core et ne sait pas le monter. Utilise un client sing-box (Hiddify, NekoBox) ou choisis un autre protocole.`,
  };

  if (p.engine !== APP_ENGINE) return { outbound: null, meta };

  // Xray ≥ 24 refuse catégoriquement un VLESS sans TLS vers une adresse publique :
  //   « vless without TLS or other encryption is prohibited unless the server address
  //     is a private IP or domain »
  // Vérifié sur le binaire réel (26.11.9) : 10.0.0.1 et 127.0.0.1 passent, 15.235.111.58
  // et vpn.example.com sont refusés. Les protocoles VLESS sans TLS du panel (mKCP, TCP
  // direct) ne sont donc PAS montables par l'application — ni par aucun client Xray
  // moderne. On le dit au lieu de produire une configuration que le noyau rejettera.
  const isPrivate = (h) => /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd])/i.test(String(h || ''));
  if (p.family === 'VLESS' && p.security === 'none' && !isPrivate(host)) {
    return {
      outbound: null,
      meta: {
        ...meta, app: false,
        reason: `Xray refuse un VLESS sans TLS vers une adresse publique (« vless without TLS or other encryption is prohibited »). Ce protocole n'est montable par aucun client Xray moderne, y compris celui de l'application. Choisis VLESS/REALITY ou VLESS/WebSocket/TLS.`,
      },
    };
  }

  const tlsSettings = () => ({
    serverName: host,
    fingerprint: 'chrome',
    alpn: ['http/1.1'],
  });

  const wsSettings = () => ({ path: s.path, headers: { Host: host } });

  let outbound = null;

  switch (id) {
    case 'vless-ws':
      outbound = {
        tag: 'proxy', protocol: 'vless',
        settings: { vnext: [{ address: host, port, users: [{ id: uuid, encryption: 'none' }] }] },
        streamSettings: { network: 'ws', security: 'tls', tlsSettings: tlsSettings(), wsSettings: wsSettings() },
      };
      break;

    case 'vless-reality':
      outbound = {
        tag: 'proxy', protocol: 'vless',
        settings: { vnext: [{ address: host, port, users: [{ id: uuid, encryption: 'none', flow: 'xtls-rprx-vision' }] }] },
        streamSettings: {
          network: 'tcp', security: 'reality',
          realitySettings: {
            serverName: ctx.reality?.sni || s.sni,
            fingerprint: 'chrome',
            publicKey: ctx.reality?.pbk,
            shortId: ctx.reality?.sid,
            spiderX: '/',
          },
          sockopt: { tcpNoDelay: true },
        },
      };
      break;

    case 'vless-kcp':
      outbound = {
        tag: 'proxy', protocol: 'vless',
        settings: { vnext: [{ address: host, port, users: [{ id: uuid, encryption: 'none' }] }] },
        streamSettings: {
          network: 'kcp',
          kcpSettings: {
            mtu: 1350, tti: 20, uplinkCapacity: 40, downlinkCapacity: 100,
            congestion: false, readBufferSize: 2, writeBufferSize: 2, seed: s.seed,
          },
        },
      };
      break;

    case 'vless-tcp':
      outbound = {
        tag: 'proxy', protocol: 'vless',
        settings: { vnext: [{ address: host, port, users: [{ id: uuid, encryption: 'none' }] }] },
        streamSettings: { network: 'tcp', sockopt: { tcpNoDelay: true } },
      };
      break;

    case 'vmess-ws':
      outbound = {
        tag: 'proxy', protocol: 'vmess',
        settings: { vnext: [{ address: host, port, users: [{ id: uuid, alterId: 0, security: 'auto' }] }] },
        streamSettings: { network: 'ws', security: 'tls', tlsSettings: tlsSettings(), wsSettings: wsSettings() },
      };
      break;

    case 'trojan-ws':
      outbound = {
        tag: 'proxy', protocol: 'trojan',
        settings: { servers: [{ address: host, port, password: secret }] },
        streamSettings: { network: 'ws', security: 'tls', tlsSettings: tlsSettings(), wsSettings: wsSettings() },
      };
      break;

    case 'shadowsocks':
      outbound = {
        tag: 'proxy', protocol: 'shadowsocks',
        settings: { servers: [{ address: host, port, method: s.method, password: ctx.ssKey || secret }] },
      };
      break;

    case 'socks5':
      outbound = {
        tag: 'proxy', protocol: 'socks',
        settings: { servers: [{ address: host, port, users: [{ user: 'ds', pass: secret }] }] },
      };
      break;

    case 'http-proxy':
      outbound = {
        tag: 'proxy', protocol: 'http',
        settings: { servers: [{ address: host, port, users: [{ user: 'ds', pass: secret }] }] },
      };
      break;

    default:
      return { outbound: null, meta: { ...meta, app: false, reason: 'Protocole inconnu de cette version de l\'application.' } };
  }

  return { outbound, meta };
}

/**
 * Liste complète des protocoles activés sur le VPS, avec pour chacun sa configuration
 * client prête à l'emploi (ou la raison de son absence).
 */
function clientProtocols(settings, ctx) {
  const out = [];
  for (const p of P.PROTOCOLS) {
    const s = { ...P.defaults(p.id), ...(settings[p.id] || {}) };
    if (!s.enabled) continue;
    const c = clientConfig(p.id, { ...ctx, settings: s });
    if (!c) continue;
    out.push({ ...c.meta, outbound: c.outbound });
  }
  return out;
}

module.exports = { clientConfig, clientProtocols, APP_ENGINE };
