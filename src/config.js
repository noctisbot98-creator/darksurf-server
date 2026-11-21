// Toute la configuration vient de l'environnement (voir deploy/darksurf.env.example).
const env = process.env;
const bool = (v, d) => (v === undefined ? d : !['0', 'false', 'no', ''].includes(String(v).toLowerCase()));

function load(overrides = {}) {
  const e = { ...env, ...overrides };
  return {
    port: Number(e.PORT || 8080),
    host: e.HOST || '127.0.0.1',                 // derrière Caddy/nginx : n'écoute qu'en local
    dbPath: e.DB_PATH || './data/darksurf.db',
    releasesDir: e.RELEASES_DIR || './data/releases',   // APK publiés (commande publish-release)
    publicUrl: (e.PUBLIC_URL || '').replace(/\/+$/, ''),   // ex. https://api.example.com (sinon déduit de la requête)
    trustProxy: bool(e.TRUST_PROXY, false),      // lire X-Forwarded-For / -Proto (uniquement derrière TON proxy)
    cookieSecure: bool(e.COOKIE_SECURE, true),
    wg: {                                        // couche réseau Xray (nom de clé conservé : cfg.wg lu par server.js)
      mode: e.CORE_MODE || 'dry',                // "real" sur le VPS, "dry" pour développer
      bin: e.XRAY_BIN || '/usr/local/bin/xray',
      api: e.XRAY_API || '127.0.0.1:10085',
      tag: e.XRAY_INBOUND_TAG || 'vless-ws',
      host: e.VPN_HOST || 'vpn.example.com',     // nom public (celui du certificat HTTPS)
      port: Number(e.VPN_PORT || 443),
      realityPort: Number(e.VPN_REALITY_PORT || 0),   // 0 = désactivé ; sinon camouflage REALITY (VLESS + Vision) sur ce port
      realityPbk: e.VPN_REALITY_PBK || '',            // clé publique REALITY (donnée aux clients)
      realitySid: e.VPN_REALITY_SID || '',            // identifiant court
      realitySni: e.VPN_REALITY_SNI || 'www.microsoft.com',
      kcpPort: Number(e.VPN_KCP_PORT || 0),           // 0 = désactivé ; sinon mode UDP (mKCP) sur ce port UDP
      kcpSeed: e.VPN_KCP_SEED || '',
      tcpPort: Number(e.VPN_TCP_PORT || 0),      // 0 = désactivé ; sinon VLESS TCP direct (sans TLS) sur ce port
      path: e.VPN_PATH || '/ds-example',         // chemin WebSocket secret (Caddy le transmet à Xray)
      dns: e.VPN_DNS || '1.1.1.1',
      serverIp: e.SERVER_IP || '',               // IP publique du VPS (règle de blocage anti-boucle)
      realityPriv: e.VPN_REALITY_PRIV || '',     // clé privée REALITY (serveur)
      ssPassword: e.VPN_SS_PASSWORD || '',       // mot de passe Shadowsocks global
      wgPriv: e.VPN_WG_PRIV || '',               // clé privée WireGuard (sing-box)
      wgPub: e.VPN_WG_PUB || '',
      certPath: e.TLS_CERT || '/etc/darksurf/tls/fullchain.pem',
      keyPath: e.TLS_KEY || '/etc/darksurf/tls/privkey.pem',
    },
    singboxBin: e.SINGBOX_BIN || '/usr/local/bin/sing-box',
    ssh: { enabled: bool(e.SSH_ENABLED, false), secret: e.SSH_PASSWORD_SECRET || '', hostKey: e.SSH_HOST_KEY || '', tcpPort: Number(e.SSH_TCP_PORT || 2250), wsPath: e.SSH_WS_PATH || '/ws-ssh', wsPort: Number(e.SSH_WS_PORT || 2084), wsBind: e.SSH_WS_BIND || '0.0.0.0', wsHost: e.SSH_WS_HOST || 'd2m44uilhgzazi.cloudfront.net', wsTls: bool(e.SSH_WS_TLS, false), payload: e.SSH_WS_PAYLOAD || '' },
    enforceIntervalMs: Number(e.ENFORCE_INTERVAL_MS || 5_000),
    tzOffsetS: Number(e.TZ_OFFSET_S || 3600),        // fuseau pour les plages horaires (Cameroun = UTC+1, sans heure d'été)
    supportPhone: e.SUPPORT_PHONE || '+237 621 86 21 34',   // affiché dans le portail vendeur pour demander des crédits
    profileTtlS: Number(e.PROFILE_TTL_S || 3600),
    codePrefix: 'TUN-',                           // doit correspondre à ActivationCode côté appli
    ...overrides.top,
  };
}
module.exports = { load };
