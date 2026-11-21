#!/usr/bin/env bash
# Diagnostic complet du serveur DARK_SURF. Code de sortie 1 s'il y a au moins un échec.
#   sudo darksurf-doctor
set -uo pipefail
[ "$(id -u)" = 0 ] || exec sudo "$0" "$@"
G=$'\033[32m' Y=$'\033[33m' R=$'\033[31m' O=$'\033[0m'; [ -t 1 ] || { G="" Y="" R="" O=""; }
FAIL=0 WARN=0
ok()   { echo "  ${G}OK${O}    $*"; }
warn() { echo "  ${Y}ATTN${O}  $*"; WARN=$((WARN+1)); }
bad()  { echo "  ${R}ECHEC${O} $*"; FAIL=$((FAIL+1)); }

set -a; . /etc/darksurf/darksurf.env 2>/dev/null; set +a
DOMAIN="${PUBLIC_URL#https://}"; API="${XRAY_API:-127.0.0.1:10085}"; XBIN="${XRAY_BIN:-/usr/local/bin/xray}"
echo "DARK_SURF · $(date '+%F %T %Z') · $DOMAIN"

echo "Services"
for u in darksurf nginx xray darksurf-backup.timer; do
  systemctl is-active --quiet "$u" && ok "$u actif" || bad "$u arrêté (journalctl -u $u -n 50)"
done

echo "Xray (tunnel VLESS + WebSocket + TLS)"
if up=$("$XBIN" api statssys --server="$API" 2>/dev/null | grep -i uptime | head -1); then
  ok "API Xray joignable ($API) ${up:+· $(echo $up | tr -s ' ')}"
else bad "API Xray muette (systemctl status xray)"; fi
ss -ltn 2>/dev/null | grep -q "127.0.0.1:10000 " && ok "entrée VLESS locale 127.0.0.1:10000 en écoute" || bad "Xray n'écoute pas sur 127.0.0.1:10000"
ss -ltn 2>/dev/null | grep -q "0.0.0.0:10000 \|\*:10000 " && bad "port 10000 exposé publiquement (doit rester local)"
if [ "${SSH_ENABLED:-0}" = 1 ]; then
  systemctl is-active --quiet darksurf-sshd && ok "SSH clients (darksurf-sshd) actif" || bad "darksurf-sshd inactif"
  iptables -w -nL DSSSH_FW >/dev/null 2>&1 && ok "pare-feu des comptes SSH en place (réseau interne interdit, données comptées)" || bad "pare-feu SSH absent : systemctl restart darksurf-ssh-firewall"
fi
if [ "${VPN_KCP_PORT:-0}" -gt 0 ]; then
  ss -lun 2>/dev/null | grep -qE "[:*]${VPN_KCP_PORT} " && ok "mode UDP (mKCP) en écoute (port ${VPN_KCP_PORT}/udp)" || bad "mKCP n'écoute pas sur le port ${VPN_KCP_PORT}/udp"
fi
if [ "${VPN_REALITY_PORT:-0}" -gt 0 ]; then
  ss -ltn 2>/dev/null | grep -qE "[:*]${VPN_REALITY_PORT} " && ok "camouflage REALITY en écoute (port ${VPN_REALITY_PORT})" || bad "REALITY n'écoute pas sur le port ${VPN_REALITY_PORT}"
fi
if [ -n "${VPN_PATH:-}" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://$DOMAIN$VPN_PATH" 2>/dev/null)
  case "$code" in 400|426|101|200) ok "chemin VPN atteint via Nginx (HTTP $code)";; 404) bad "chemin VPN introuvable côté Nginx (404)";; *) warn "chemin VPN : réponse $code";; esac
fi

echo "Réseau"
[ "$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null)" = bbr ] && ok "BBR actif" || warn "BBR inactif (la vitesse peut en souffrir)"
[ "$(sysctl -n net.core.default_qdisc 2>/dev/null)" = fq ] && ok "file d'attente fq" || warn "qdisc fq absent"
if curl -fsS --max-time 6 -o /dev/null https://1.1.1.1 2>/dev/null; then ok "sortie Internet du serveur"; else bad "le serveur n'atteint pas Internet"; fi

echo "API et HTTPS"
curl -fsS --max-time 4 http://127.0.0.1:8080/healthz >/dev/null 2>&1 && ok "API locale" || bad "API locale muette (journalctl -u darksurf -n 50)"
if curl -fsS --max-time 8 "https://$DOMAIN/healthz" >/dev/null 2>&1; then
  ok "HTTPS public"
  end=$(echo | openssl s_client -servername "$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  if [ -n "$end" ]; then
    days=$(( ( $(date -d "$end" +%s) - $(date +%s) ) / 86400 ))
    [ "$days" -ge 10 ] && ok "certificat valide encore $days jours (renouvelé automatiquement)" || warn "certificat : $days jours restants"
  fi
else bad "HTTPS public inaccessible (DNS, ports 80/443 du fournisseur ?)"; fi

echo "Système"
[ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ] && ok "horloge synchronisée (expirations fiables)" || bad "horloge non synchronisée : les dates d'expiration seraient fausses"
free=$(df -Pm /var/lib/darksurf | awk 'NR==2{print $4}'); [ "$free" -ge 1024 ] && ok "disque libre : ${free} Mo" || warn "disque presque plein : ${free} Mo"
mem=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo); [ "$mem" -ge 200 ] && ok "mémoire disponible : ${mem} Mo" || warn "mémoire faible : ${mem} Mo"

echo "Base de données et sauvegardes"
if [ -f "$DB_PATH" ]; then
  r=$(runuser -u darksurf -- sqlite3 -readonly "$DB_PATH" "PRAGMA integrity_check" 2>&1 | head -1)
  [ "$r" = ok ] && ok "intégrité de la base" || bad "base de données : $r"
  last=$(ls -1t /var/backups/darksurf/darksurf-*.db.gz 2>/dev/null | head -1)
  if [ -n "$last" ]; then
    age=$(( ( $(date +%s) - $(stat -c %Y "$last") ) / 3600 ))
    [ "$age" -le 8 ] && ok "dernière sauvegarde il y a ${age} h" || warn "dernière sauvegarde il y a ${age} h"
  else warn "aucune sauvegarde pour l'instant (darksurf-backup)"; fi
else bad "base introuvable : $DB_PATH"; fi

echo
if [ "$FAIL" = 0 ]; then echo "${G}Tout est en ordre${O} ($WARN avertissement(s))."; else echo "${R}$FAIL problème(s) à corriger${O} ($WARN avertissement(s))."; fi
echo "Test de vitesse conseillé : sur un téléphone connecté au VPN, lance un test (fast.com / speedtest) ; comparer avec et sans VPN."
[ "$FAIL" = 0 ]
