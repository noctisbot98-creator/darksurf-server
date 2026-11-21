#!/usr/bin/env bash
# =============================================================================
# DARK_SURF : installation complète du serveur sur un VPS Ubuntu 22.04/24.04 ou Debian 12.
#
#   sudo ./deploy/install.sh --domain vpn.mondomaine.com --email moi@mail.com [--admin patron]
#   sans domaine :  --domain auto   (utilise IP-du-VPS.sslip.io, gratuit)
#
# À lancer en root, depuis le dossier décompressé du serveur. Le script est RELANÇABLE :
# pour mettre à jour le serveur, décompresse la nouvelle version et relance-le (la base de données,
# les utilisateurs et la configuration sont conservés).
#
# Ce qu'il met en place :
#   - Xray-core (VLESS + WebSocket, SHA-256 vérifié) : le trafic VPN passe en HTTPS sur le port 443
#   - Node.js 22 (vérifié par SHA-256) + le serveur DARK_SURF (service systemd durci, démarrage auto)
#   - Nginx + certbot : HTTPS (Let's Encrypt) devant l'API et les portails vendeur/admin
#   - Réglages réseau (BBR + fq, tampons TCP, TCP Fast Open), synchronisation de l'heure
#   - Sauvegardes de la base toutes les 6 h, commandes darksurf-admin / darksurf-doctor
# =============================================================================
set -euo pipefail

# ------------------------------------------------------------------ options
DOMAIN="" EMAIL="" ADMIN_LOGIN="" SKIP_DNS=0 TCP_PORT=0 REALITY_PORT=0 KCP_PORT=0
usage() { sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --admin) ADMIN_LOGIN="${2:-}"; shift 2 ;;
    --skip-dns-check) SKIP_DNS=1; shift ;;
    --reality) REALITY_PORT="${REALITY_PORT:-0}"; [ "$REALITY_PORT" -gt 0 ] || REALITY_PORT=8443; shift ;;   # camouflage REALITY (port 8443 par défaut)
    --reality-port) REALITY_PORT="${2:-8443}"; shift 2 ;;
    --udp) KCP_PORT=4443; shift ;;                 # mode UDP (mKCP) sur le port 4443/udp
    --tcp-test) TCP_PORT=10050; shift ;;       # ajoute un accès VLESS TCP direct (sans TLS) sur 10050, pour tester un autre chemin réseau
    -h|--help) usage 0 ;;
    *) echo "Option inconnue : $1" >&2; usage 1 ;;
  esac
done

C_OK=$'\033[32m' C_WARN=$'\033[33m' C_BAD=$'\033[31m' C_OFF=$'\033[0m'
[ -t 1 ] || { C_OK="" C_WARN="" C_BAD="" C_OFF=""; }
step() { echo; echo "${C_OK}==>${C_OFF} $*"; }
warn() { echo "${C_WARN}!! $*${C_OFF}" >&2; }
die()  { echo "${C_BAD}ERREUR : $*${C_OFF}" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "lance ce script en root (sudo)."
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$SRC/src/server.js" ] || die "lance-le depuis le dossier du serveur (src/server.js introuvable)."

# ------------------------------------------------------- configuration retenue
CONF=/etc/darksurf/install.conf
mkdir -p /etc/darksurf
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"
DOMAIN="${DOMAIN:-${SAVED_DOMAIN:-}}"; EMAIL="${EMAIL:-${SAVED_EMAIL:-}}"
ADMIN_LOGIN="${ADMIN_LOGIN:-${SAVED_ADMIN:-admin}}"
VPN_PATH="${SAVED_VPN_PATH:-/ds-$(openssl rand -hex 10)}"       # chemin WebSocket secret (évite les scans)
SSH_SECRET="${SAVED_SSH_SECRET:-$(openssl rand -hex 32)}"

if [ "$DOMAIN" = "auto" ]; then        # pas de domaine : adresse gratuite basée sur l'IP (ex. 15-235-111-58.sslip.io)
  AUTO_IP="$(curl -4fsS --max-time 8 https://api.ipify.org 2>/dev/null || curl -4fsS --max-time 8 https://ifconfig.me 2>/dev/null || true)"
  [[ "$AUTO_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "impossible de déterminer l'IP publique pour --domain auto."
  DOMAIN="${AUTO_IP//./-}.sslip.io"
fi
[ -n "$DOMAIN" ] || die "--domain est obligatoire (ex. vpn.mondomaine.com, enregistrement DNS A vers l'IP du VPS)."
[ -n "$EMAIL" ]  || die "--email est obligatoire (pour le certificat HTTPS)."
[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$ ]] || die "nom de domaine invalide : $DOMAIN"
[[ "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "adresse e-mail invalide."
[[ "$ADMIN_LOGIN" =~ ^[a-z0-9._-]{3,32}$ ]] || die "--admin : a-z 0-9 . _ - (3 à 32 caractères)."

# ------------------------------------------------------------------ contrôles
step "Contrôles préalables"
[ -d /run/systemd/system ] || die "systemd est requis."
. /etc/os-release
case "${ID:-}:${VERSION_ID:-}" in
  ubuntu:22.04|ubuntu:24.04|ubuntu:25.*|debian:12|debian:13) ;;
  *) warn "système non testé (${PRETTY_NAME:-inconnu}) : Ubuntu 22.04/24.04 ou Debian 12 recommandés." ;;
esac
case "$(uname -m)" in x86_64) NODE_ARCH=x64; XRAY_ARCH=64 ;; aarch64) NODE_ARCH=arm64; XRAY_ARCH=arm64-v8a ;; *) die "architecture non prise en charge : $(uname -m)" ;; esac
VIRT="$(systemd-detect-virt 2>/dev/null || true)"
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
[ "$MEM_MB" -ge 480 ] || warn "mémoire faible (${MEM_MB} Mo)."
echo "Système : ${PRETTY_NAME:-?} · virtualisation : ${VIRT:-aucune/inconnue} · RAM : ${MEM_MB} Mo"

for p in 80 443; do
  if ss -ltn "sport = :$p" 2>/dev/null | grep -q LISTEN && ! ss -ltnp "sport = :$p" 2>/dev/null | grep -q nginx; then
    die "le port $p est déjà utilisé par un autre service (apache, caddy, x-ui…). Arrête-le avant d'installer."
  fi
done

step "Paquets système"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg xz-utils unzip sqlite3 iproute2 openssl openssh-server sudo iptables >/dev/null
modprobe tcp_bbr 2>/dev/null && echo tcp_bbr >/etc/modules-load.d/darksurf.conf || warn "BBR indisponible sur ce noyau (le débit TCP sera un peu moins bon)."

# DNS : le domaine doit pointer vers CE serveur, sinon le certificat HTTPS ne sera pas délivré.
if [ "$SKIP_DNS" = 0 ]; then
  step "Vérification DNS de $DOMAIN"
  PUB_IP="$(curl -4fsS --max-time 8 https://api.ipify.org 2>/dev/null || curl -4fsS --max-time 8 https://ifconfig.me 2>/dev/null || true)"
  DNS_IP="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}')"
  [ -n "$DNS_IP" ] || die "$DOMAIN ne se résout pas. Crée l'enregistrement DNS A vers ${PUB_IP:-IP-du-VPS} (sans proxy Cloudflare), attends quelques minutes puis relance."
  if [ -n "$PUB_IP" ] && [ "$DNS_IP" != "$PUB_IP" ]; then
    die "$DOMAIN pointe vers $DNS_IP mais ce serveur a l'adresse $PUB_IP. Corrige l'enregistrement A (DNS seulement, sans proxy) puis relance, ou utilise --skip-dns-check."
  fi
  echo "$DOMAIN → $DNS_IP ✔"
fi

# ------------------------------------------------------------------ Node.js 22
install_node() {
  local need=0
  if [ -x /usr/local/bin/node ]; then
    /usr/local/bin/node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' || need=1
  else need=1; fi
  [ "$need" = 0 ] && { echo "Node.js $(/usr/local/bin/node -v) déjà installé ✔"; return; }
  local tmp base file; tmp="$(mktemp -d)"; base="https://nodejs.org/dist/latest-v22.x"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file="$(grep -oE "node-v22\.[0-9]+\.[0-9]+-linux-$NODE_ARCH\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)"
  [ -n "$file" ] || die "archive Node.js 22 introuvable."
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c - >/dev/null) || die "somme SHA-256 de Node.js incorrecte : téléchargement refusé."
  local dir="/opt/${file%.tar.xz}"
  rm -rf "$dir"; tar -xJf "$tmp/$file" -C /opt
  ln -sf "$dir/bin/node" /usr/local/bin/node
  rm -rf "$tmp"
  echo "Node.js $(/usr/local/bin/node -v) installé ✔"
}
step "Node.js 22"
install_node

# ------------------------------------------------------------------ Nginx + certbot (comme le guide X-Net)
step "Nginx + certbot (HTTPS)"
systemctl disable --now caddy >/dev/null 2>&1 || true
apt-get install -y -qq nginx certbot >/dev/null
# réparation : si /etc/nginx a été effacé, on restaure les fichiers de base
[ -f /etc/nginx/nginx.conf ] || apt-get install -y -qq --reinstall -o Dpkg::Options::="--force-confmiss" nginx nginx-common >/dev/null
mkdir -p /etc/nginx/conf.d
echo "$(nginx -v 2>&1 | head -1) ✔"

# ------------------------------------------------------------------ réglages noyau
step "Réglages réseau (BBR, tampons TCP)"
cat >/etc/sysctl.d/99-darksurf.conf <<'EOF'
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.core.rmem_max = 33554432
net.core.wmem_max = 33554432
net.ipv4.tcp_rmem = 4096 131072 33554432
net.ipv4.tcp_wmem = 4096 131072 33554432
net.core.somaxconn = 4096
net.core.netdev_max_backlog = 5000
net.ipv4.tcp_fastopen = 3
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.tcp_mtu_probing = 1
net.ipv4.tcp_notsent_lowat = 131072
EOF
sysctl -q --system 2>/dev/null || warn "certains réglages noyau n'ont pas pu être appliqués (sans gravité)."
# L'expiration des forfaits dépend de l'horloge : elle doit être synchronisée.
timedatectl set-ntp true 2>/dev/null || true

# ------------------------------------------------------------------ Xray-core
step "Xray-core"
install_xray() {
  if [ -x /usr/local/bin/xray ] && [ -f /usr/local/share/xray/geoip.dat ]; then
    echo "Xray $(/usr/local/bin/xray version | head -1 | awk '{print $2}') déjà installé ✔"; return
  fi
  local tmp base; tmp="$(mktemp -d)"; base="https://github.com/XTLS/Xray-core/releases/latest/download"
  curl -fsSL "$base/Xray-linux-$XRAY_ARCH.zip" -o "$tmp/xray.zip" || die "téléchargement d'Xray impossible (GitHub inaccessible ?)."
  curl -fsSL "$base/Xray-linux-$XRAY_ARCH.zip.dgst" -o "$tmp/xray.dgst" || die "somme de contrôle d'Xray introuvable."
  local want have
  want="$(grep -i 'SHA2-256' "$tmp/xray.dgst" | head -1 | awk -F'= ' '{print $2}' | tr -d ' \r\n')"
  have="$(sha256sum "$tmp/xray.zip" | awk '{print $1}')"
  [ -n "$want" ] && [ "$want" = "$have" ] || die "somme SHA-256 d'Xray incorrecte : téléchargement refusé."
  unzip -qo "$tmp/xray.zip" xray geoip.dat geosite.dat -d "$tmp"
  install -m 755 "$tmp/xray" /usr/local/bin/xray
  mkdir -p /usr/local/share/xray; install -m 644 "$tmp/geoip.dat" "$tmp/geosite.dat" /usr/local/share/xray/
  rm -rf "$tmp"
  echo "Xray $(/usr/local/bin/xray version | head -1 | awk '{print $2}') installé ✔"
}
install_xray
id -u xray >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin xray

# Configuration : un seul accès VLESS/WebSocket en local (Nginx le publie en HTTPS), API locale pour les statistiques.
# Les utilisateurs (appareils) ne sont PAS écrits ici : DARK_SURF les ajoute/retire à chaud selon forfait, données et expiration.
# Sont bloqués pour les clients : réseaux privés, l'IP publique de ce serveur (ses propres services), et le port 25 (spam).
SERVER_IP="${PUB_IP:-${DNS_IP:-${AUTO_IP:-}}}"
SELF_RULE=""; [[ "$SERVER_IP" =~ ^[0-9.]+$ ]] && SELF_RULE="{\"type\":\"field\",\"ip\":[\"$SERVER_IP/32\"],\"outboundTag\":\"block\"},"
# Camouflage REALITY : le serveur imite le HTTPS d'un grand site (aucun certificat à lui) ; clés conservées d'une installation à l'autre.
R_SNI="${DS_REALITY_SNI:-${SAVED_REALITY_SNI:-www.microsoft.com}}"
R_PRIV="${SAVED_REALITY_PRIV:-}" R_PBK="${SAVED_REALITY_PBK:-}" R_SID="${SAVED_REALITY_SID:-}"
REALITY_INBOUND=""
if [ "$REALITY_PORT" -gt 0 ]; then
  if [ -z "$R_PRIV" ] || [ -z "$R_PBK" ]; then
    KEYS="$(/usr/local/bin/xray x25519 2>&1)"
    R_PRIV="$(echo "$KEYS" | grep -iE '^ *private' | head -1 | awk '{print $NF}')"
    R_PBK="$(echo "$KEYS" | grep -iE '^ *(public|password)' | head -1 | awk '{print $NF}')"
    [ -n "$R_PRIV" ] && [ -n "$R_PBK" ] || die "génération des clés REALITY impossible : $KEYS"
  fi
  [ -n "$R_SID" ] || R_SID="$(openssl rand -hex 8)"
  REALITY_INBOUND=',
    { "tag": "vless-reality", "listen": "0.0.0.0", "port": '"$REALITY_PORT"', "protocol": "vless",
      "settings": { "clients": [], "decryption": "none" },
      "streamSettings": { "network": "tcp", "security": "reality",
        "realitySettings": { "show": false, "dest": "'"$R_SNI"':443", "xver": 0, "serverNames": ["'"$R_SNI"'"], "privateKey": "'"$R_PRIV"'", "shortIds": ["'"$R_SID"'"] },
        "sockopt": { "tcpNoDelay": true, "tcpKeepAliveIdle": 30, "tcpKeepAliveInterval": 15 } } }'
fi
K_SEED="${SAVED_KCP_SEED:-$(openssl rand -hex 8)}"
KCP_INBOUND=""
[ "$KCP_PORT" -gt 0 ] && KCP_INBOUND=',
    { "tag": "vless-kcp", "listen": "0.0.0.0", "port": '"$KCP_PORT"', "protocol": "vless",
      "settings": { "clients": [], "decryption": "none" },
      "streamSettings": { "network": "kcp", "kcpSettings": { "mtu": 1350, "tti": 20, "uplinkCapacity": 40, "downlinkCapacity": 100, "congestion": false, "readBufferSize": 2, "writeBufferSize": 2, "seed": "'"$K_SEED"'" } } }'
TCP_INBOUND=""
[ "$TCP_PORT" -gt 0 ] && TCP_INBOUND=',
    { "tag": "vless-tcp", "listen": "0.0.0.0", "port": '"$TCP_PORT"', "protocol": "vless",
      "settings": { "clients": [], "decryption": "none" },
      "streamSettings": { "network": "tcp", "sockopt": { "tcpNoDelay": true, "tcpKeepAliveIdle": 30, "tcpKeepAliveInterval": 15 } } }'
NEW_X="$(mktemp --suffix=.json)"
cat >"$NEW_X" <<EOF
{
  "log": { "loglevel": "warning" },
  "stats": {},
  "api": { "tag": "api", "services": ["HandlerService", "StatsService"] },
  "policy": {
    "levels": { "0": { "statsUserUplink": true, "statsUserDownlink": true, "handshake": 6, "connIdle": 600, "uplinkOnly": 5, "downlinkOnly": 10, "bufferSize": 1024 } },
    "system": { "statsInboundUplink": true, "statsInboundDownlink": true }
  },
  "inbounds": [
    { "tag": "api", "listen": "127.0.0.1", "port": 10085, "protocol": "dokodemo-door", "settings": { "address": "127.0.0.1" } },
    { "tag": "vless-ws", "listen": "127.0.0.1", "port": 10000, "protocol": "vless",
      "settings": { "clients": [], "decryption": "none" },
      "streamSettings": { "network": "ws", "wsSettings": { "path": "$VPN_PATH" } } }$TCP_INBOUND$REALITY_INBOUND$KCP_INBOUND
  ],
  "outbounds": [
    { "tag": "direct", "protocol": "freedom", "settings": { "domainStrategy": "UseIPv4" },
      "streamSettings": { "sockopt": { "tcpNoDelay": true, "tcpFastOpen": true, "tcpKeepAliveIdle": 30, "tcpKeepAliveInterval": 15 } } },
    { "tag": "block", "protocol": "blackhole" }
  ],
  "routing": {
    "domainStrategy": "IPIfNonMatch",
    "rules": [
      { "type": "field", "inboundTag": ["api"], "outboundTag": "api" },
      $SELF_RULE
      { "type": "field", "ip": ["geoip:private"], "outboundTag": "block" },
      { "type": "field", "port": "25", "outboundTag": "block" },
      { "type": "field", "protocol": ["bittorrent"], "outboundTag": "block" }
    ]
  }
}
EOF
/usr/local/bin/xray run -test -format json -config "$NEW_X" >/dev/null 2>&1 || { /usr/local/bin/xray run -test -format json -config "$NEW_X" || true; die "configuration Xray invalide."; }
if ! cmp -s "$NEW_X" /etc/darksurf/xray.json 2>/dev/null; then install -m 640 -o root -g xray "$NEW_X" /etc/darksurf/xray.json; XRAY_CHANGED=1; else XRAY_CHANGED=0; fi
rm -f "$NEW_X"

cat >/etc/systemd/system/xray.service <<'EOF'
[Unit]
Description=Xray (DARK_SURF) : VLESS sur WebSocket, derrière Nginx
After=network-online.target
Wants=network-online.target

[Service]
User=xray
Group=xray
Environment=XRAY_LOCATION_ASSET=/usr/local/share/xray
ExecStart=/usr/local/bin/xray run -format json -config /etc/darksurf/xray.json
Restart=always
RestartSec=2
LimitNOFILE=1048576
NoNewPrivileges=false
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectKernelModules=true
ProtectControlGroups=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable xray >/dev/null 2>&1
if systemctl is-active --quiet xray; then
  if [ "$XRAY_CHANGED" = 1 ]; then systemctl restart xray; echo "Xray reconfiguré ✔"; else echo "Xray inchangé ✔"; fi
else systemctl restart xray; echo "Xray démarré ✔"; fi

# SSH DARK_SURF : comptes dédiés sans shell, uniquement pour le transfert TCP local (-D/SOCKS).
install -d -m 751 /etc/darksurf      # traversable : Xray et le service lisent leurs fichiers (chacun protégé à 640)
ssh-keygen -q -t ecdsa -b 256 -N '' -f /etc/ssh/ssh_host_ecdsa_key 2>/dev/null || true
cat >/etc/darksurf/sshd_config <<'EOF'
Port 2250
ListenAddress 0.0.0.0
HostKey /etc/ssh/ssh_host_ecdsa_key
PidFile /run/sshd-darksurf.pid
UsePAM no
PasswordAuthentication yes
KbdInteractiveAuthentication no
PubkeyAuthentication no
PermitRootLogin no
AllowGroups dsssh
AllowTcpForwarding local
PermitOpen any
GatewayPorts no
X11Forwarding no
AllowAgentForwarding no
PermitTunnel no
PermitTTY no
MaxSessions 0
ForceCommand /usr/sbin/nologin
LoginGraceTime 20
ClientAliveInterval 30
ClientAliveCountMax 3
EOF
/usr/sbin/sshd -t -f /etc/darksurf/sshd_config || die "configuration SSH DARK_SURF invalide."
groupadd -f dsssh
cat >/usr/local/sbin/darksurf-ssh-firewall <<'EOF'
#!/usr/bin/env bash
# Pare-feu des comptes SSH clients : ils ne peuvent atteindre NI le réseau interne du serveur (API Xray, portail, sshd),
# NI les réseaux privés, NI le port 25 ; et chaque octet qu'ils font passer est compté (consommation du forfait).
set -euo pipefail
GID="$(getent group dsssh | cut -d: -f3)"
SELF="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oE 'src [0-9.]+' | awk '{print $2}' | head -1 || true)"
ipt() { iptables -w "$@"; }
ipt -N DSSSH_ACC 2>/dev/null || true
ipt -N DSSSH_FW 2>/dev/null || true
ipt -F DSSSH_FW
# UDPGW (module optionnel) : les comptes SSH peuvent joindre SON port local, et seulement lui.
UDPGW_PORT="$(cat /etc/darksurf/modules/udpgw.port 2>/dev/null || true)"
if [[ "$UDPGW_PORT" =~ ^[0-9]{4,5}$ ]]; then ipt -A DSSSH_FW -p tcp -m owner --gid-owner "$GID" -d 127.0.0.1 --dport "$UDPGW_PORT" -j RETURN; fi
for NET in 127.0.0.0/8 0.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 ${SELF:+$SELF/32}; do
  ipt -A DSSSH_FW -p tcp -m owner --gid-owner "$GID" -d "$NET" -j REJECT
done
ipt -A DSSSH_FW -p tcp -m owner --gid-owner "$GID" --dport 25 -j REJECT
ipt -C OUTPUT -j DSSSH_FW 2>/dev/null || ipt -I OUTPUT 1 -j DSSSH_FW
ipt -C OUTPUT -j DSSSH_ACC 2>/dev/null || ipt -A OUTPUT -j DSSSH_ACC
ipt -C INPUT -j DSSSH_ACC 2>/dev/null || ipt -I INPUT 1 -j DSSSH_ACC
# Autorise explicitement les sorties Internet des comptes SSH (TCP/UDP), après les protections privées et le comptage.
ipt -C OUTPUT -m owner --gid-owner "$GID" -j ACCEPT 2>/dev/null || ipt -A OUTPUT -m owner --gid-owner "$GID" -j ACCEPT
if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -w -N DSSSH_FW6 2>/dev/null || true
  ip6tables -w -F DSSSH_FW6
  for NET in ::1/128 fc00::/7 fe80::/10; do ip6tables -w -A DSSSH_FW6 -p tcp -m owner --gid-owner "$GID" -d "$NET" -j REJECT; done
  ip6tables -w -A DSSSH_FW6 -p tcp -m owner --gid-owner "$GID" --dport 25 -j REJECT
  ip6tables -w -C OUTPUT -j DSSSH_FW6 2>/dev/null || ip6tables -w -I OUTPUT 1 -j DSSSH_FW6
  ip6tables -w -C OUTPUT -m owner --gid-owner "$GID" -j ACCEPT 2>/dev/null || ip6tables -w -A OUTPUT -m owner --gid-owner "$GID" -j ACCEPT
fi
EOF
chmod 750 /usr/local/sbin/darksurf-ssh-firewall
cat >/etc/systemd/system/darksurf-ssh-firewall.service <<'EOF'
[Unit]
Description=DARK_SURF pare-feu des comptes SSH
After=network-online.target
Before=darksurf-sshd.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/darksurf-ssh-firewall
[Install]
WantedBy=multi-user.target
EOF
cat >/usr/local/sbin/darksurf-ssh-user <<'EOF'
#!/usr/bin/env bash
# Usage : darksurf-ssh-user ensure|disable|delete <ds+20 hex>   (le mot de passe est lu sur l'entrée standard pour « ensure »)
#         darksurf-ssh-user usage            -> « nom octets » par compte (trafic transféré, dans les deux sens)
#         darksurf-ssh-user sessions         -> « nom nombre » de connexions SSH ouvertes par compte
#         darksurf-ssh-user drop <nom>       -> coupe les connexions ouvertes du compte
set -euo pipefail
ACTION="${1:-}" USERNAME="${2:-}"
# Le service du panel est cloisonné (useradd ne peut pas verrouiller /etc/passwd) : on relance l'action hors de ce cloisonnement.
if [ -z "${DS_UNSANDBOXED:-}" ] && [[ "$ACTION" =~ ^(ensure|disable|delete|drop)$ ]]; then
  exec /usr/bin/systemd-run --quiet --wait --collect --pipe -E DS_UNSANDBOXED=1 /usr/local/sbin/darksurf-ssh-user "$@"
fi
FW=/usr/local/sbin/darksurf-ssh-firewall
iptables -w -nL DSSSH_ACC >/dev/null 2>&1 || "$FW"
if [ "$ACTION" = usage ]; then
  iptables -w -nvx -L DSSSH_ACC 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^dsu:/) { sub(/^dsu:/, "", $i); print $i, $2 } }'
  exit 0
fi
if [ "$ACTION" = sessions ]; then
  ps -eo args= | sed -n 's/^sshd: \(d[sk][0-9a-f]\{20\}\)@.*/\1/p' | sort | uniq -c | awk '{ print $2, $1 }'
  exit 0
fi
[[ "$USERNAME" =~ ^d[sk][0-9a-f]{20}$ ]] || exit 64
count_rules() {   # $1 = ajouter|retirer
  local uid="$2"
  if [ "$1" = add ]; then
    iptables -w -t mangle -C OUTPUT -m owner --uid-owner "$uid" -j CONNMARK --set-mark "$uid" 2>/dev/null || iptables -w -t mangle -A OUTPUT -m owner --uid-owner "$uid" -j CONNMARK --set-mark "$uid"
    iptables -w -C DSSSH_ACC -m connmark --mark "$uid" -m comment --comment "dsu:$USERNAME" 2>/dev/null || iptables -w -A DSSSH_ACC -m connmark --mark "$uid" -m comment --comment "dsu:$USERNAME"
  else
    iptables -w -t mangle -D OUTPUT -m owner --uid-owner "$uid" -j CONNMARK --set-mark "$uid" 2>/dev/null || true
    iptables -w -D DSSSH_ACC -m connmark --mark "$uid" -m comment --comment "dsu:$USERNAME" 2>/dev/null || true
  fi
}
case "$ACTION" in
  ensure)
    IFS= read -r PASSWORD
    [[ "$PASSWORD" =~ ^[A-Za-z0-9_-]{24,40}$ ]] || exit 64
    if ! id "$USERNAME" >/dev/null 2>&1; then
      useradd -g dsssh --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$USERNAME"
      printf '%s:%s\n' "$USERNAME" "$PASSWORD" | chpasswd
    else
      passwd -u "$USERNAME" >/dev/null 2>&1 || true
    fi
    count_rules add "$(id -u "$USERNAME")"
    ;;
  disable)
    if id "$USERNAME" >/dev/null 2>&1; then passwd -l "$USERNAME" >/dev/null 2>&1 || true; pkill -KILL -u "$USERNAME" >/dev/null 2>&1 || true; fi
    ;;
  drop)
    if id "$USERNAME" >/dev/null 2>&1; then pkill -KILL -u "$USERNAME" >/dev/null 2>&1 || true; fi
    ;;
  delete)
    if id "$USERNAME" >/dev/null 2>&1; then
      pkill -KILL -u "$USERNAME" >/dev/null 2>&1 || true
      count_rules remove "$(id -u "$USERNAME")"
      userdel "$USERNAME" >/dev/null 2>&1 || true
    fi
    ;;
  *) exit 64 ;;
esac
EOF
chmod 750 /usr/local/sbin/darksurf-ssh-user
cat >/usr/local/sbin/darksurf-svc <<'EOF'
#!/bin/sh
# Redémarre uniquement les moteurs VPN (appelé par le panel via sudo). Usage : darksurf-svc restart xray|darksurf-singbox
case "$1 $2" in
  "apply "*|"apply")
    # Installe la configuration préparée par le panel (dossier d'échange), redémarre, et revient en arrière si Xray ne repart pas.
    ST=/var/lib/darksurf/protocol-stage; D=/etc/darksurf
    [ -s "$ST/xray.json" ] || { echo "rien à appliquer" >&2; exit 3; }
    B=/var/backups/darksurf/protocols-$(date +%Y%m%dT%H%M%S); mkdir -p "$B"
    for f in xray.json singbox.json protocols.json; do [ -f "$D/$f" ] && cp -p "$D/$f" "$B/$f"; done
    install -m 640 -o root -g xray "$ST/xray.json" "$D/xray.json"
    [ -s "$ST/protocols.json" ] && install -m 640 -o root -g darksurf "$ST/protocols.json" "$D/protocols.json"
    if [ -s "$ST/singbox.json" ]; then install -m 640 -o root -g root "$ST/singbox.json" "$D/singbox.json"; fi
    fail=0
    systemctl restart xray; sleep 2; systemctl is-active --quiet xray || fail=1
    if [ -s "$ST/singbox.json" ] && systemctl cat darksurf-singbox >/dev/null 2>&1; then
      systemctl restart darksurf-singbox; sleep 2; systemctl is-active --quiet darksurf-singbox || fail=1
    fi
    if [ "$fail" = 1 ]; then
      for f in xray.json singbox.json protocols.json; do [ -f "$B/$f" ] && cp -p "$B/$f" "$D/$f"; done
      chown root:xray "$D/xray.json"; systemctl restart xray
      echo "ROLLBACK : un moteur n'a pas redémarré ; configuration précédente restaurée ($B)" >&2; exit 1
    fi
    rm -f "$ST"/*.json
    echo "Xray redémarré, sauvegarde : $B"; exit 0 ;;
  "restart xray")
    # le panel écrit la configuration sous son propre compte : on rend la main à Xray avant de redémarrer
    [ -f /etc/darksurf/xray.json ] && chown root:xray /etc/darksurf/xray.json && chmod 640 /etc/darksurf/xray.json
    exec /usr/bin/systemctl restart xray ;;
  "restart darksurf-singbox") exec /usr/bin/systemctl restart darksurf-singbox ;;
  *) echo "usage refusé" >&2; exit 2 ;;
esac
EOF
chmod 750 /usr/local/sbin/darksurf-svc; chown root:root /usr/local/sbin/darksurf-svc
chown root:root /usr/local/sbin/darksurf-ssh-user
id -u darksurf >/dev/null 2>&1 || useradd --system --home-dir /var/lib/darksurf --shell /usr/sbin/nologin darksurf
cat >/etc/sudoers.d/darksurf-ssh <<'EOF'
darksurf ALL=(root) NOPASSWD: /usr/local/sbin/darksurf-ssh-user *
EOF
chmod 440 /etc/sudoers.d/darksurf-ssh
install -o root -g root -m 750 "$(dirname "$0")/darksurf-ssh-config" /usr/local/sbin/darksurf-ssh-config
printf '%s\n' 'darksurf ALL=(root) NOPASSWD: /usr/local/sbin/darksurf-ssh-config *' >>/etc/sudoers.d/darksurf-ssh
printf '%s\n' 'darksurf ALL=(root) NOPASSWD: /usr/local/sbin/darksurf-svc *' >>/etc/sudoers.d/darksurf-ssh
install -o root -g root -m 750 "$(dirname "$0")/darksurf-modules" /usr/local/sbin/darksurf-modules
install -o root -g root -m 750 "$(dirname "$0")/darksurf-modules-run" /usr/local/sbin/darksurf-modules-run
printf '%s\n' 'darksurf ALL=(root) NOPASSWD: /usr/local/sbin/darksurf-modules *' >>/etc/sudoers.d/darksurf-ssh
visudo -cf /etc/sudoers.d/darksurf-ssh >/dev/null || die "règle sudo DARK_SURF invalide."
cat >/etc/systemd/system/darksurf-sshd.service <<'EOF'
[Unit]
Description=DARK_SURF restricted SSH transport
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStartPre=/usr/bin/mkdir -p /run/sshd
ExecStart=/usr/sbin/sshd -D -e -f /etc/darksurf/sshd_config
Restart=always
RestartSec=2
LimitNOFILE=65535
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now darksurf-ssh-firewall >/dev/null 2>&1 || warn "pare-feu SSH : iptables indisponible, les comptes SSH ne seront pas isolés ni comptés."
systemctl enable --now darksurf-sshd >/dev/null

# Pare-feu hôte : si ufw est actif, on ouvre uniquement ce qui est nécessaire (le VPN passe par 443).
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ufw allow 2250/tcp >/dev/null
  [ "$TCP_PORT" -gt 0 ] && ufw allow "$TCP_PORT"/tcp >/dev/null
  [ "$REALITY_PORT" -gt 0 ] && ufw allow "$REALITY_PORT"/tcp >/dev/null
  [ "$KCP_PORT" -gt 0 ] && ufw allow "$KCP_PORT"/udp >/dev/null
  echo "ufw : ports 80/tcp, 443/tcp, 2250/tcp ouverts ✔"
fi

# ------------------------------------------------------------------ application
step "Serveur DARK_SURF"
id -u darksurf >/dev/null 2>&1 || useradd --system --home-dir /var/lib/darksurf --shell /usr/sbin/nologin darksurf
mkdir -p /opt/darksurf /var/lib/darksurf/releases /var/lib/darksurf/protocol-stage /var/backups/darksurf
chown -R darksurf:darksurf /var/lib/darksurf /var/backups/darksurf; chmod 750 /var/lib/darksurf; chmod 700 /var/backups/darksurf
rm -rf /opt/darksurf/src /opt/darksurf/deploy
cp -a "$SRC/src" "$SRC/deploy" "$SRC/package.json" /opt/darksurf/
[ -f "$SRC/README.md" ] && cp -a "$SRC/README.md" /opt/darksurf/
[ -d "$SRC/docs" ] && { rm -rf /opt/darksurf/docs; cp -a "$SRC/docs" /opt/darksurf/; }
chown -R root:root /opt/darksurf; chmod -R go-w /opt/darksurf

ENVF=/etc/darksurf/darksurf.env
if [ ! -f "$ENVF" ] || ! grep -q '^CORE_MODE=' "$ENVF"; then
  cat >"$ENVF" <<EOF
HOST=127.0.0.1
PORT=8080
DB_PATH=/var/lib/darksurf/darksurf.db
RELEASES_DIR=/var/lib/darksurf/releases
PUBLIC_URL=https://$DOMAIN
TRUST_PROXY=1
COOKIE_SECURE=1
CORE_MODE=real
XRAY_BIN=/usr/local/bin/xray
XRAY_API=127.0.0.1:10085
XRAY_INBOUND_TAG=vless-ws
VPN_HOST=$DOMAIN
VPN_PORT=443
VPN_TCP_PORT=$TCP_PORT
VPN_KCP_PORT=$KCP_PORT
VPN_KCP_SEED=$K_SEED
VPN_REALITY_PORT=$REALITY_PORT
VPN_REALITY_PBK=$R_PBK
VPN_REALITY_SID=$R_SID
VPN_REALITY_SNI=$R_SNI
VPN_PATH=$VPN_PATH
VPN_DNS=1.1.1.1
ENFORCE_INTERVAL_MS=5000
EOF
  echo "Configuration créée : $ENVF"
else
  # Mises à jour des seules valeurs liées à l'installation ; le reste est conservé.
  sed -i -e "s#^PUBLIC_URL=.*#PUBLIC_URL=https://$DOMAIN#" -e "s#^VPN_HOST=.*#VPN_HOST=$DOMAIN#" -e "s#^VPN_PATH=.*#VPN_PATH=$VPN_PATH#" "$ENVF"
  sed -i -e '/^VPN_TCP_PORT=/d' -e '/^VPN_REALITY_/d' -e '/^VPN_KCP_/d' "$ENVF"
  { echo "VPN_KCP_PORT=$KCP_PORT"; echo "VPN_KCP_SEED=$K_SEED"; echo "VPN_TCP_PORT=$TCP_PORT"; echo "VPN_REALITY_PORT=$REALITY_PORT"; echo "VPN_REALITY_PBK=$R_PBK"; echo "VPN_REALITY_SID=$R_SID"; echo "VPN_REALITY_SNI=$R_SNI"; } >>"$ENVF"
  echo "Configuration existante conservée : $ENVF"
fi
# Protocoles SSH : secret stable pour dériver un compte distinct par appareil.
grep -q '^SSH_ENABLED=' "$ENVF" || printf '\nSSH_ENABLED=1\n' >>"$ENVF"
grep -q '^SSH_PASSWORD_SECRET=' "$ENVF" || printf 'SSH_PASSWORD_SECRET=%s\n' "$SSH_SECRET" >>"$ENVF"
grep -q '^SSH_TCP_PORT=' "$ENVF" || printf 'SSH_TCP_PORT=2250\n' >>"$ENVF"
grep -q '^SSH_WS_PATH=' "$ENVF" || printf 'SSH_WS_PATH=/ws-ssh\n' >>"$ENVF"
grep -q '^SSH_WS_PORT=' "$ENVF" || printf 'SSH_WS_PORT=2084\n' >>"$ENVF"
grep -q '^SSH_WS_BIND=' "$ENVF" || printf 'SSH_WS_BIND=0.0.0.0\n' >>"$ENVF"
grep -q '^SSH_WS_HOST=' "$ENVF" || printf 'SSH_WS_HOST=d2m44uilhgzazi.cloudfront.net\n' >>"$ENVF"
grep -q '^SSH_WS_TLS=' "$ENVF" || printf 'SSH_WS_TLS=0\n' >>"$ENVF"
grep -q '^SERVER_IP=' "$ENVF" || printf 'SERVER_IP=%s\n' "$SERVER_IP" >>"$ENVF"
# Paramètres imposés pour le profil SSH-WS demandé (IP VPS + Host CloudFront).
sed -i -e 's#^SSH_WS_PATH=.*#SSH_WS_PATH=/ws-ssh#' -e 's#^SSH_WS_PORT=.*#SSH_WS_PORT=2084#' -e 's#^SSH_WS_BIND=.*#SSH_WS_BIND=0.0.0.0#' -e 's#^SSH_WS_HOST=.*#SSH_WS_HOST=d2m44uilhgzazi.cloudfront.net#' -e 's#^SSH_WS_TLS=.*#SSH_WS_TLS=0#' -e "s#^SERVER_IP=.*#SERVER_IP=$SERVER_IP#" "$ENVF"
# Remplace l'ancien passerelle NPV indépendante par le listener intégré à DARK_SURF.
systemctl disable --now darksurf-npv-ws.service >/dev/null 2>&1 || true
ufw allow 2084/tcp >/dev/null 2>&1 || true
SSH_PUB="$(awk '{print $1" "$2}' /etc/ssh/ssh_host_ecdsa_key.pub)"
if grep -q '^SSH_HOST_KEY=' "$ENVF"; then sed -i "s#^SSH_HOST_KEY=.*#SSH_HOST_KEY=\"$SSH_PUB\"#" "$ENVF"; else printf 'SSH_HOST_KEY="%s"\n' "$SSH_PUB" >>"$ENVF"; fi
chown root:darksurf "$ENVF"; chmod 640 "$ENVF"
# Migre les anciennes préférences persistées : SSH-WS devient le premier transport.
if [ -f /var/lib/darksurf/darksurf.db ]; then
  /usr/local/bin/node --disable-warning=ExperimentalWarning - <<'NODE' || { echo "Migration des préférences SSH-WS impossible" >&2; exit 1; }
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/var/lib/darksurf/darksurf.db');
const put = db.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`);
const now = Math.floor(Date.now()/1000);
for (const [k,v] of Object.entries({
  ssh_enabled: true, ssh_tcp_port: 2250, ssh_ws_path: '/ws-ssh', ssh_ws_port: 2084,
  ssh_ws_host: 'd2m44uilhgzazi.cloudfront.net', ssh_ws_tls: false, ssh_ws_payload: '',
  default_protocol: 'ssh-ws'
})) put.run(k, JSON.stringify(v), now);
db.close();
NODE
fi

cat >"$CONF" <<EOF
SAVED_DOMAIN="$DOMAIN"
SAVED_EMAIL="$EMAIL"
SAVED_ADMIN="$ADMIN_LOGIN"
SAVED_VPN_PATH="$VPN_PATH"
SAVED_REALITY_PRIV="$R_PRIV"
SAVED_REALITY_PBK="$R_PBK"
SAVED_REALITY_SID="$R_SID"
SAVED_REALITY_SNI="$R_SNI"
SAVED_KCP_SEED="$K_SEED"
SAVED_SSH_SECRET="$SSH_SECRET"
EOF
chmod 600 "$CONF"

cat >/etc/systemd/system/darksurf.service <<'EOF'
[Unit]
Description=DARK_SURF server (API client + portails vendeur/admin)
After=network-online.target xray.service
Wants=network-online.target xray.service

[Service]
User=darksurf
Group=darksurf
WorkingDirectory=/opt/darksurf
EnvironmentFile=/etc/darksurf/darksurf.env
ExecStart=/usr/local/bin/node --disable-warning=ExperimentalWarning src/server.js
Restart=always
RestartSec=2
LimitNOFILE=65536

# Le serveur pilote Xray par son API locale (127.0.0.1) : aucun privilège spécial n'est nécessaire.
NoNewPrivileges=false
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
RestrictNamespaces=true
LockPersonality=true
ReadWritePaths=/var/lib/darksurf /etc/darksurf /etc/passwd /etc/shadow /etc/group /etc/gshadow -/etc/subuid -/etc/subgid -/etc/ufw -/var/lib/ufw -/run/lock -/run/sshd -/run/sudo -/var/log/lastlog -/var/log/faillog

[Install]
WantedBy=multi-user.target
EOF

# Commandes d'administration
cat >/usr/local/bin/darksurf-admin <<'EOF'
#!/usr/bin/env bash
# Administration du serveur DARK_SURF (voir : darksurf-admin help)
set -euo pipefail
[ "$(id -u)" = 0 ] || exec sudo "$0" "$@"
args=("$@"); tmp=""
if [ "${1:-}" = "publish-release" ] && [ -n "${2:-}" ] && [ -f "$2" ]; then      # l'APK doit être lisible par l'utilisateur du service
  tmp="$(mktemp -d)"; chmod 755 "$tmp"; install -m 644 "$2" "$tmp/app.apk"; args[1]="$tmp/app.apk"
fi
set +e
runuser -u darksurf -- bash -c 'set -a; . /etc/darksurf/darksurf.env; set +a; cd /opt/darksurf && exec /usr/local/bin/node --disable-warning=ExperimentalWarning src/admin.js "$@"' _ "${args[@]}"
rc=$?
[ -n "$tmp" ] && rm -rf "$tmp"
exit $rc
EOF
cat >/usr/local/bin/darksurf-backup <<'EOF'
#!/usr/bin/env bash
# Sauvegarde cohérente de la base (à chaud), compressée, conservée 14 jours.
# Exécutée sous l'utilisateur du service pour ne jamais créer de fichiers appartenant à root dans la base.
set -euo pipefail
[ "$(id -u)" = 0 ] && exec runuser -u darksurf -- "$0" "$@"
set -a; . /etc/darksurf/darksurf.env; set +a
dest=/var/backups/darksurf
f="$dest/darksurf-$(date +%F-%H%M).db"
sqlite3 "$DB_PATH" ".backup '$f'"
gzip -f "$f"
find "$dest" -name 'darksurf-*.db.gz' -mtime +14 -delete
echo "Sauvegarde : $f.gz"
EOF
install -m 755 "$SRC/deploy/doctor.sh" /usr/local/bin/darksurf-doctor
chmod 755 /usr/local/bin/darksurf-admin /usr/local/bin/darksurf-backup

cat >/etc/systemd/system/darksurf-backup.service <<'EOF'
[Unit]
Description=Sauvegarde de la base DARK_SURF
[Service]
Type=oneshot
ExecStart=/usr/local/bin/darksurf-backup
EOF
cat >/etc/systemd/system/darksurf-backup.timer <<'EOF'
[Unit]
Description=Sauvegarde DARK_SURF toutes les 6 heures
[Timer]
OnCalendar=*-*-* 00/6:17:00
Persistent=true
[Install]
WantedBy=timers.target
EOF

step "Nginx : certificat et configuration HTTPS"
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
if [ ! -f "$CERT_DIR/fullchain.pem" ]; then
  systemctl stop nginx >/dev/null 2>&1 || true
  certbot certonly --standalone -d "$DOMAIN" --agree-tos -m "$EMAIL" --non-interactive \
    --pre-hook "systemctl stop nginx" --post-hook "systemctl start nginx" >/tmp/certbot.log 2>&1 \
    || { tail -8 /tmp/certbot.log; die "certificat HTTPS impossible : le DNS de $DOMAIN pointe-t-il vers ce serveur et les ports 80/443 sont-ils ouverts ?"; }
fi
echo "certificat ✔"
rm -f /etc/nginx/sites-enabled/default /etc/nginx/conf.d/default.conf
cat >/etc/nginx/conf.d/darksurf.conf <<EOF
# Géré par l'installateur DARK_SURF
map \$http_upgrade \$connection_upgrade { default upgrade; '' close; }
server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}
server {
    listen 443 ssl http2;
    server_name $DOMAIN;
    ssl_certificate $CERT_DIR/fullchain.pem;
    ssl_certificate_key $CERT_DIR/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    server_tokens off;
    client_max_body_size 2m;

    # Trafic VPN DARK_SURF : chemin WebSocket secret -> Xray (local)
    location = $VPN_PATH {
        proxy_pass http://127.0.0.1:10000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header Host \$host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
    # X-Net (sing-box) : inbound VLESS-WS local 10001, chemin /ws (comme le guide X-Net)
    location = /ws {
        proxy_pass http://127.0.0.1:10001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header Host \$host;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        proxy_buffering off;
    }
    # Portail, API et SSH-WS DARK_SURF
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 3600s;
        proxy_buffering off;
    }
}
EOF
nginx -t >/dev/null 2>&1 || { nginx -t; die "configuration Nginx invalide."; }

systemctl daemon-reload
systemctl enable --now darksurf-backup.timer >/dev/null 2>&1
systemctl enable darksurf nginx xray >/dev/null 2>&1
systemctl restart darksurf darksurf-sshd
systemctl restart nginx

# ------------------------------------------------------------------ vérifications finales
step "Démarrage"
ok=1
for i in $(seq 1 20); do curl -fsS --max-time 3 http://127.0.0.1:8080/healthz >/dev/null 2>&1 && break; sleep 1; [ "$i" = 20 ] && ok=0; done
[ "$ok" = 1 ] && echo "API locale ✔" || warn "l'API ne répond pas : journalctl -u darksurf -n 50"

# ------------------------------------------------------------------ compte administrateur
step "Compte administrateur"
CRED=/root/darksurf-identifiants.txt
HAS_ADMIN="$(darksurf-admin admin-count 2>/dev/null || echo 0)"
NEW_PW=""
if [ "${HAS_ADMIN:-0}" = "0" ]; then
  # Mot de passe choisi par toi : DS_ADMIN_PASSWORD='...' (10 caractères minimum) ; sinon un mot de passe aléatoire est généré.
  CHOSEN=0
  if [ -n "${DS_ADMIN_PASSWORD:-}" ]; then
    [ "${#DS_ADMIN_PASSWORD}" -ge 10 ] || die "DS_ADMIN_PASSWORD : 10 caractères minimum."
    NEW_PW="$DS_ADMIN_PASSWORD"; CHOSEN=1
  else
    NEW_PW="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
  fi
  darksurf-admin add-admin "$ADMIN_LOGIN" --password "$NEW_PW" >/dev/null
  umask 077
  cat >"$CRED" <<EOF
DARK_SURF - identifiants administrateur (à noter dans un gestionnaire de mots de passe, puis supprimer ce fichier)
Portail   : https://$DOMAIN
Identifiant : $ADMIN_LOGIN
Mot de passe : $([ "$CHOSEN" = 1 ] && echo "(celui que tu as choisi)" || echo "$NEW_PW")
EOF
  umask 022
  echo "Administrateur « $ADMIN_LOGIN » créé ✔ (identifiants dans $CRED)"
else
  echo "Un administrateur existe déjà : aucun compte créé ✔"
fi

step "Forfaits"
darksurf-admin seed-plans || true

step "Vérifications"
https_ok=0
for i in $(seq 1 45); do
  if curl -fsS --max-time 4 "https://$DOMAIN/healthz" >/dev/null 2>&1; then https_ok=1; break; fi; sleep 2
done
[ "$https_ok" = 1 ] && echo "HTTPS public + certificat ✔" || warn "HTTPS pas encore prêt (DNS/ports 80 et 443 ouverts ? journalctl -u nginx -n 50). Relance darksurf-doctor dans une minute."


# Liens de test pour une appli VLESS du commerce (V2Box, v2rayNG) : permet de séparer « problème du serveur » et « problème de l'appli DARK_SURF ».
cat >/usr/local/bin/darksurf-testlink <<'TL'
#!/usr/bin/env bash
set -euo pipefail
set -a; . /etc/darksurf/darksurf.env; set +a
UID_="${1:-$(/usr/local/bin/xray api inbounduser --server="${XRAY_API:-127.0.0.1:10085}" -tag=vless-ws | grep -o '"email": *"[^"]*"' | head -1 | cut -d'"' -f4)}"
[ -n "$UID_" ] || { echo "Aucun utilisateur Xray : active d'abord une clé dans l'appli, puis relance."; exit 1; }
Q="$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "$VPN_PATH")"
echo "== WebSocket + TLS (port 443) =="
echo "vless://$UID_@$VPN_HOST:443?encryption=none&security=tls&sni=$VPN_HOST&fp=chrome&alpn=http%2F1.1&type=ws&host=$VPN_HOST&path=$Q#ds-ws"
if [ "${VPN_KCP_PORT:-0}" -gt 0 ]; then
  IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo "$VPN_HOST")"
  echo "== UDP mKCP (port $VPN_KCP_PORT/udp) =="
  echo "vless://$UID_@$IP:$VPN_KCP_PORT?encryption=none&security=none&type=kcp&headerType=none&seed=$VPN_KCP_SEED#ds-kcp"
fi
if [ "${VPN_REALITY_PORT:-0}" -gt 0 ]; then
  IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo "$VPN_HOST")"
  echo "== REALITY, camouflage (port $VPN_REALITY_PORT) =="
  echo "vless://$UID_@$IP:$VPN_REALITY_PORT?encryption=none&security=reality&sni=$VPN_REALITY_SNI&fp=chrome&pbk=$VPN_REALITY_PBK&sid=$VPN_REALITY_SID&type=tcp&flow=xtls-rprx-vision#ds-reality"
fi
if [ "${VPN_TCP_PORT:-0}" -gt 0 ]; then
  IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo "$VPN_HOST")"
  echo "== TCP direct, sans TLS (port $VPN_TCP_PORT) =="
  echo "vless://$UID_@$IP:$VPN_TCP_PORT?encryption=none&security=none&type=tcp&headerType=none#ds-tcp"
fi
TL
chmod 0755 /usr/local/bin/darksurf-testlink

echo
darksurf-doctor || true

cat <<EOF

${C_OK}Installation terminée.${C_OFF}

  Portail administrateur : https://$DOMAIN   (identifiants : $CRED)
  Accès VPN : VLESS + WebSocket + TLS sur $DOMAIN:443 (chemin secret dans /etc/darksurf/darksurf.env)

À faire maintenant :
  1. Pare-feu du FOURNISSEUR (panneau du VPS), s'il y en a un : ouvre TCP 80 et TCP 443 (rien d'autre n'est nécessaire).
  2. Dans les applis Android, mets l'adresse de l'API : https://$DOMAIN/api/v1/ (et le portail : https://$DOMAIN).
  3. Connecte-toi au portail, crée tes forfaits (Forfaits) puis tes vendeurs (Tableau de bord > Nouveau vendeur).
  4. Publie l'APK du VPN :  darksurf-admin publish-release app.apk --version-code 1 --version-name 1.0.0
  5. Vérifie à tout moment :  darksurf-doctor        Sauvegardes : /var/backups/darksurf
  Liens de test (V2Box / v2rayNG) :  darksurf-testlink
  Mise à jour du serveur : décompresse la nouvelle version et relance  sudo ./deploy/install.sh
EOF
