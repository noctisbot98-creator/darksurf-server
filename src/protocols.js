// Registre des protocoles VPN servis par le VPS.
//
// Chaque protocole décrit :
//   - son moteur (xray ou sing-box) et son entrée (inbound) réelle ;
//   - ses paramètres modifiables depuis le panel (port, transport, TLS/REALITY, SNI, chemin) ;
//   - la construction du lien d'import au format accepté par V2Box ;
//   - les prérequis (port UDP, certificat, etc.).
//
// Les formats de lien suivent les spécifications publiques :
//   VLESS   vless://uuid@host:port?params#nom
//   VMess   vmess://base64(json)
//   Trojan  trojan://password@host:port?params#nom
//   SS      ss://base64url(method:password)@host:port#nom   (SIP002)
//   Hy2     hysteria2://password@host:port?params#nom
//   TUIC    tuic://uuid:password@host:port?params#nom
//   WG      wireguard://clé@host:port?params#nom
//   SOCKS   socks://base64(user:pass)@host:port#nom
//   HTTP    http://user:pass@host:port#nom
const crypto = require('crypto');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const b64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
const tag = (s) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40) || 'ds';

// Mot de passe stable et propre à (appareil, protocole) : aucune colonne en base, aucun secret stocké en clair.
function deviceSecret(master, deviceId, proto) {
  return crypto.createHmac('sha256', String(master || 'darksurf')).update(`${deviceId}:${proto}`).digest('base64url').slice(0, 24);
}

/**
 * Clé Shadowsocks 2022 : le chiffrement AEAD 2022 exige une clé de longueur exacte
 * (16 octets pour aes-128-gcm, 32 pour aes-256-gcm), encodée en base64.
 * Une chaîne arbitraire est refusée par Xray (« bad key »). On dérive donc la clé
 * par HMAC, ce qui garantit la bonne longueur et reste déterministe.
 */
function ssKey(method, master) {
  const len = /aes-256/.test(method) ? 32 : /aes-128/.test(method) ? 16 : 0;
  if (!len) return String(master || '');          // chiffrements historiques : mot de passe libre
  return crypto.createHmac('sha256', String(master || 'darksurf')).update('shadowsocks').digest().subarray(0, len).toString('base64');
}

// ------------------------------------------------------------------ définitions

const PROTOCOLS = [
  {
    id: 'vless-ws', label: 'VLESS · WebSocket · TLS', engine: 'xray', family: 'VLESS',
    transport: 'ws', security: 'tls', defaultPort: 443, viaProxy: true,
    summary: 'Le mode historique de DARK_SURF. Trafic HTTPS standard relayé par Caddy vers Xray.',
    params: ['path'],
    note: 'Passe par Caddy sur 443 : aucun port supplémentaire à ouvrir.',
  },
  {
    id: 'vless-reality', label: 'VLESS · REALITY · Vision', engine: 'xray', family: 'VLESS',
    transport: 'tcp', security: 'reality', defaultPort: 8443, viaProxy: false,
    summary: 'Camouflage REALITY : le serveur imite le TLS d\'un grand site, sans certificat à gérer.',
    params: ['sni'],
    note: 'Port TCP à ouvrir côté OVH et ufw. Aucun certificat nécessaire.',
  },
  {
    id: 'vless-kcp', label: 'VLESS · mKCP (UDP)', engine: 'xray', family: 'VLESS',
    transport: 'kcp', security: 'none', defaultPort: 8444, viaProxy: false, udp: true,
    summary: 'Transport UDP : meilleur sur les réseaux à forte perte de paquets.',
    params: ['seed'],
    note: 'Port UDP à ouvrir. Certains opérateurs bloquent l\'UDP.',
  },
  {
    id: 'vless-tcp', label: 'VLESS · TCP direct', engine: 'xray', family: 'VLESS',
    transport: 'tcp', security: 'none', defaultPort: 8445, viaProxy: false,
    summary: 'Sans TLS : le plus rapide, mais visible par un filtrage profond.',
    params: [],
    note: 'Port TCP à ouvrir. À réserver aux réseaux non filtrés.',
  },
  {
    id: 'vmess-ws', label: 'VMess · WebSocket · TLS', engine: 'xray', family: 'VMess',
    transport: 'ws', security: 'tls', defaultPort: 443, viaProxy: true,
    summary: 'Compatibilité maximale : accepté par tous les clients V2Ray, y compris anciens.',
    params: ['path'],
    note: 'Passe par Caddy sur 443.',
  },
  {
    id: 'trojan-ws', label: 'Trojan · WebSocket · TLS', engine: 'xray', family: 'Trojan',
    transport: 'ws', security: 'tls', defaultPort: 443, viaProxy: true,
    summary: 'Se fait passer pour du HTTPS légitime ; très bien toléré par les filtrages.',
    params: ['path'],
    note: 'Passe par Caddy sur 443.',
  },
  {
    id: 'shadowsocks', label: 'Shadowsocks · AEAD', engine: 'xray', family: 'Shadowsocks',
    transport: 'tcp', security: 'none', defaultPort: 8388, viaProxy: false,
    summary: 'Léger et rapide, très largement supporté. Chiffrement AEAD 2022.',
    params: ['method'],
    note: 'Port TCP à ouvrir.',
  },
  {
    id: 'hysteria2', label: 'Hysteria2 · QUIC (UDP)', engine: 'singbox', family: 'Hysteria2',
    transport: 'quic', security: 'tls', defaultPort: 8446, viaProxy: false, udp: true,
    summary: 'Très rapide sur les connexions mobiles dégradées. Nécessite un certificat TLS.',
    params: ['sni'],
    note: 'Port UDP à ouvrir. Certificat TLS obligatoire (Let\'s Encrypt ou auto-signé).',
  },
  {
    id: 'tuic', label: 'TUIC v5 · QUIC (UDP)', engine: 'singbox', family: 'TUIC',
    transport: 'quic', security: 'tls', defaultPort: 8447, viaProxy: false, udp: true,
    v2box: false,
    summary: 'QUIC natif, faible latence, bonne résistance à la censure.',
    params: ['sni'],
    note: 'Port UDP à ouvrir. Certificat TLS obligatoire. NON importable dans V2Box (absent de sa liste officielle) : à réserver aux clients sing-box, Hiddify ou NekoBox.',
  },
  {
    id: 'wireguard', label: 'WireGuard · UDP', engine: 'singbox', family: 'WireGuard',
    transport: 'udp', security: 'none', defaultPort: 51820, viaProxy: false, udp: true,
    summary: 'Le plus économe en batterie. Excellent débit, mais signature réseau reconnaissable.',
    params: [],
    note: 'Port UDP à ouvrir.',
  },
  {
    id: 'socks5', label: 'SOCKS5', engine: 'xray', family: 'SOCKS',
    transport: 'tcp', security: 'none', defaultPort: 1080, viaProxy: false,
    summary: 'Proxy simple, sans chiffrement propre : à utiliser au-dessus d\'un réseau de confiance.',
    params: [],
    note: 'Port TCP à ouvrir. Non chiffré : ne protège pas le contenu. V2Box accepte socks://.',
  },
  {
    id: 'http-proxy', label: 'HTTP CONNECT', engine: 'xray', family: 'HTTP',
    transport: 'tcp', security: 'none', defaultPort: 8081, viaProxy: false,
    summary: 'Proxy HTTP classique, utile pour les navigateurs et les outils qui ne parlent pas V2Ray.',
    params: [],
    note: 'Port TCP à ouvrir. Non chiffré.',
  },
];

const BY_ID = new Map(PROTOCOLS.map((p) => [p.id, p]));
const get = (id) => BY_ID.get(String(id || '')) || null;

// Paramètres par défaut d'un protocole (fusionnés avec ce qui est en base).
// Chemin imposé par l'installation (Caddy ne transmet à Xray que ce chemin secret) : sert de défaut au VLESS-WS.
const PATH_DEFAULT = {};
function setDefaultPath(id, path) { if (path) PATH_DEFAULT[id] = String(path); }

function defaults(id) {
  const p = get(id);
  if (!p) return null;
  const base = { enabled: false, port: p.defaultPort };
  if (p.params.includes('path')) base.path = PATH_DEFAULT[id] || `/ds-${id.replace(/[^a-z0-9]/g, '')}`;
  if (p.params.includes('sni')) base.sni = 'www.microsoft.com';
  if (p.params.includes('seed')) base.seed = crypto.randomBytes(8).toString('hex');
  if (p.params.includes('method')) base.method = '2022-blake3-aes-128-gcm';
  return base;
}

// ------------------------------------------------------------------ liens d'import

/**
 * Construit le lien d'import V2Box pour un appareil.
 * ctx = { host, uuid, secret, settings, reality:{pbk,sid,sni}, tls:bool }
 */
function link(id, ctx) {
  const p = get(id);
  if (!p) return null;
  const s = { ...defaults(id), ...(ctx.settings || {}) };
  const host = ctx.host;
  const port = Number(s.port) || p.defaultPort;
  const name = tag(ctx.name || `DARK_SURF ${p.family}`);
  const uuid = ctx.uuid;
  const secret = ctx.secret;

  switch (id) {
    case 'vless-ws':
      return `vless://${uuid}@${host}:${port}?${qs({ encryption: 'none', security: 'tls', sni: host, type: 'ws', host, path: s.path })}#${name}`;
    case 'vless-reality':
      return `vless://${uuid}@${host}:${port}?${qs({ encryption: 'none', security: 'reality', sni: ctx.reality?.sni || s.sni, fp: 'chrome', pbk: ctx.reality?.pbk, sid: ctx.reality?.sid, type: 'tcp', flow: 'xtls-rprx-vision' })}#${name}`;
    case 'vless-kcp':
      return `vless://${uuid}@${host}:${port}?${qs({ encryption: 'none', security: 'none', type: 'kcp', headerType: 'none', seed: s.seed })}#${name}`;
    case 'vless-tcp':
      return `vless://${uuid}@${host}:${port}?${qs({ encryption: 'none', security: 'none', type: 'tcp', headerType: 'none' })}#${name}`;
    case 'vmess-ws':
      return 'vmess://' + b64(JSON.stringify({
        v: '2', ps: name, add: host, port: String(port), id: uuid, aid: '0', scy: 'auto',
        net: 'ws', type: 'none', host, path: s.path, tls: 'tls', sni: host,
      }));
    case 'trojan-ws':
      return `trojan://${secret}@${host}:${port}?${qs({ security: 'tls', sni: host, type: 'ws', host, path: s.path })}#${name}`;
    case 'shadowsocks':
      // Une entrée Shadowsocks ne porte qu'un mot de passe : tous les appareils partagent
      // la clé globale du serveur (voir ssKey). Ce n'est pas un secret par appareil.
      return `ss://${b64url(`${s.method}:${ctx.ssKey || secret}`)}@${host}:${port}#${name}`;
    case 'hysteria2':
      return `hysteria2://${secret}@${host}:${port}?${qs({ sni: s.sni, insecure: ctx.tls === false ? 1 : 0 })}#${name}`;
    case 'tuic':
      return `tuic://${uuid}:${secret}@${host}:${port}?${qs({ congestion_control: 'bbr', alpn: 'h3', sni: s.sni, udp_relay_mode: 'native', allow_insecure: ctx.tls === false ? 1 : 0 })}#${name}`;
    case 'wireguard':
      return `wireguard://${secret}@${host}:${port}?${qs({ publickey: ctx.reality?.wgPub, address: '10.66.66.2/32', mtu: 1420 })}#${name}`;
    case 'socks5':
      return `socks://${b64url(`ds:${secret}`)}@${host}:${port}#${name}`;
    case 'http-proxy':
      return `http://ds:${secret}@${host}:${port}#${name}`;
    default:
      return null;
  }
}

// ------------------------------------------------------------------ configuration Xray

/** Entrée Xray correspondant à un protocole activé, ou null. */
function xrayInbound(id, s, ctx) {
  const p = get(id);
  if (!p || p.engine !== 'xray') return null;
  const port = Number(s.port) || p.defaultPort;
  const clients = (uuids) => uuids.map((u) => ({ id: u, email: u, level: 0 }));

  switch (id) {
    case 'vless-ws':
      return {
        tag: 'vless-ws', listen: '127.0.0.1', port: 10000, protocol: 'vless',
        settings: { clients: [], decryption: 'none' },
        streamSettings: { network: 'ws', wsSettings: { path: s.path } },
      };
    case 'vless-reality':
      return {
        tag: 'vless-reality', listen: '0.0.0.0', port, protocol: 'vless',
        settings: { clients: [], decryption: 'none' },
        streamSettings: {
          network: 'tcp', security: 'reality',
          realitySettings: {
            show: false, dest: `${s.sni}:443`, xver: 0, serverNames: [s.sni],
            privateKey: ctx.reality.priv, shortIds: [ctx.reality.sid],
          },
          sockopt: { tcpNoDelay: true, tcpKeepAliveIdle: 30, tcpKeepAliveInterval: 15 },
        },
      };
    case 'vless-kcp':
      return {
        tag: 'vless-kcp', listen: '0.0.0.0', port, protocol: 'vless',
        settings: { clients: [], decryption: 'none' },
        streamSettings: {
          network: 'kcp',
          kcpSettings: { mtu: 1350, tti: 20, uplinkCapacity: 40, downlinkCapacity: 100, congestion: false, readBufferSize: 2, writeBufferSize: 2, seed: s.seed },
        },
      };
    case 'vless-tcp':
      return {
        tag: 'vless-tcp', listen: '0.0.0.0', port, protocol: 'vless',
        settings: { clients: [], decryption: 'none' },
        streamSettings: { network: 'tcp', sockopt: { tcpNoDelay: true, tcpKeepAliveIdle: 30, tcpKeepAliveInterval: 15 } },
      };
    case 'vmess-ws':
      return {
        tag: 'vmess-ws', listen: '127.0.0.1', port: 10001, protocol: 'vmess',
        settings: { clients: [] },
        streamSettings: { network: 'ws', wsSettings: { path: s.path } },
      };
    case 'trojan-ws':
      return {
        tag: 'trojan-ws', listen: '127.0.0.1', port: 10002, protocol: 'trojan',
        settings: { clients: [] },
        streamSettings: { network: 'ws', wsSettings: { path: s.path } },
      };
    case 'shadowsocks':
      return {
        tag: 'shadowsocks', listen: '0.0.0.0', port, protocol: 'shadowsocks',
        settings: { method: s.method, password: ssKey(s.method, ctx.ssPassword), network: 'tcp,udp' },
      };
    case 'socks5':
      return {
        tag: 'socks5', listen: '0.0.0.0', port, protocol: 'socks',
        settings: { auth: 'password', accounts: [], udp: false },
      };
    case 'http-proxy':
      return {
        tag: 'http-proxy', listen: '0.0.0.0', port, protocol: 'http',
        settings: { accounts: [] },
      };
    default:
      return null;
  }
}

/** Ajoute les utilisateurs d'un appareil à une entrée Xray (mutation). */
function xrayAddUser(inbound, id, { uuid, secret }) {
  const s = inbound.settings || (inbound.settings = {});
  switch (id) {
    case 'vless-ws': case 'vless-tcp': case 'vless-kcp':
      (s.clients = s.clients || []).push({ id: uuid, email: uuid, level: 0 }); break;
    case 'vless-reality':
      (s.clients = s.clients || []).push({ id: uuid, email: uuid, level: 0, flow: 'xtls-rprx-vision' }); break;
    case 'vmess-ws':
      (s.clients = s.clients || []).push({ id: uuid, email: uuid, level: 0 }); break;
    case 'trojan-ws':
      (s.clients = s.clients || []).push({ password: secret, email: uuid, level: 0 }); break;
    case 'socks5':
      (s.accounts = s.accounts || []).push({ user: 'ds', pass: secret }); break;
    case 'http-proxy':
      (s.accounts = s.accounts || []).push({ user: 'ds', pass: secret }); break;
    default: break;   // shadowsocks : un seul mot de passe par entrée, géré globalement
  }
}

// ------------------------------------------------------------------ configuration sing-box

function singboxInbound(id, s, ctx) {
  const p = get(id);
  if (!p || p.engine !== 'singbox') return null;
  const port = Number(s.port) || p.defaultPort;
  const tls = {
    enabled: true,
    server_name: s.sni || ctx.host,
    certificate_path: ctx.certPath,
    key_path: ctx.keyPath,
  };
  switch (id) {
    case 'hysteria2':
      return {
        type: 'hysteria2', tag: 'hysteria2', listen: '::', listen_port: port,
        users: [], tls, masquerade: 'https://' + (s.sni || ctx.host),
      };
    case 'tuic':
      return {
        type: 'tuic', tag: 'tuic', listen: '::', listen_port: port,
        users: [], congestion_control: 'bbr', tls,
      };
    default:
      return null;
  }
}

/**
 * WireGuard n'est pas une « inbound » dans sing-box ≥ 1.11 : c'est un *endpoint*.
 * Il est donc construit séparément et ajouté à la clé `endpoints`.
 */
function singboxEndpoint(id, s, ctx) {
  if (id !== 'wireguard') return null;
  const p = get(id);
  const port = Number(s.port) || p.defaultPort;
  return {
    type: 'wireguard', tag: 'wireguard',
    address: ['10.66.66.1/24'],
    private_key: ctx.reality?.wgPriv || '',
    listen_port: port,
    peers: [],
  };
}

function singboxAddUser(inbound, id, { uuid, secret }) {
  switch (id) {
    case 'hysteria2': (inbound.users = inbound.users || []).push({ name: uuid, password: secret }); break;
    case 'tuic': (inbound.users = inbound.users || []).push({ uuid, password: secret }); break;
    case 'wireguard':
      (inbound.peers = inbound.peers || []).push({ public_key: secret, allowed_ips: [] }); break;
    default: break;
  }
}

module.exports = {
  PROTOCOLS, BY_ID, get, defaults, setDefaultPath, link, deviceSecret, ssKey,
  xrayInbound, xrayAddUser, singboxInbound, singboxEndpoint, singboxAddUser,
  b64, b64url, qs,
};
