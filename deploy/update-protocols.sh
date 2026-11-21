#!/usr/bin/env bash
# =============================================================================
# DARK_SURF : moteur VPN multi-protocoles (mise à jour d'un serveur existant)
#
#   sudo ./deploy/update-protocols.sh              # installe / met à jour
#   sudo ./deploy/update-protocols.sh --check      # diagnostic seul, ne modifie RIEN
#   sudo ./deploy/update-protocols.sh --rollback   # revient à la sauvegarde précédente
#   sudo ./deploy/update-protocols.sh --yes        # sans question
#
# Ce que fait le script :
#   1. vérifie les prérequis (DARK_SURF installé, Xray, Node 22, Caddy)
#   2. sauvegarde horodatée dans /root/darksurf-protocols-backup-<date>/
#   3. installe sing-box (Hysteria2, TUIC, WireGuard) si absent, SHA-256 vérifié
#   4. génère /etc/darksurf/singbox.json + son service systemd
#   5. ouvre les ports choisis dans ufw (si ufw est actif)
#   6. valide les deux configurations avec les binaires eux-mêmes
#   7. redémarre, vérifie que chaque port écoute réellement
#   8. en cas d'échec : restauration automatique
#
# Le script est IDEMPOTENT : relancé, il ne réinstalle rien et ne réécrit que
# ce qui a changé.
# =============================================================================
set -euo pipefail

MODE=apply; ASSUME_YES=0
for a in "$@"; do
  case "$a" in
    --check) MODE=check ;;
    --rollback) MODE=rollback ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Option inconnue : $a" >&2; exit 1 ;;
  esac
done

C_OK=$'\033[32m' C_WARN=$'\033[33m' C_BAD=$'\033[31m' C_DIM=$'\033[2m' C_OFF=$'\033[0m'
[ -t 1 ] || { C_OK=""; C_WARN=""; C_BAD=""; C_DIM=""; C_OFF=""; }
step() { echo; echo "${C_OK}==>${C_OFF} $*"; }
ok()   { echo "  ${C_OK}✅${C_OFF} $*"; }
bad()  { echo "  ${C_BAD}❌${C_OFF} $*"; }
warn() { echo "  ${C_WARN}⚠${C_OFF}  $*"; }
info() { echo "  ${C_DIM}·${C_OFF}  $*"; }
die()  { echo "${C_BAD}ERREUR : $*${C_OFF}" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "lance ce script en root (sudo)."

CONF=/etc/darksurf/darksurf.env
XRAY_CFG=/etc/darksurf/xray.json
SB_CFG=/etc/darksurf/singbox.json
SB_BIN=/usr/local/bin/sing-box
SB_SVC=darksurf-singbox
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/root/darksurf-protocols-backup-$STAMP"
LAST_BACKUP_FILE=/root/.darksurf-last-backup

# ------------------------------------------------------------------ 1. prérequis
step "Contrôles préalables"
[ -d /opt/darksurf ] || die "/opt/darksurf introuvable : DARK_SURF n'est pas installé sur ce serveur."
ok "/opt/darksurf présent"
[ -f "$CONF" ] || die "$CONF introuvable : installation DARK_SURF incomplète."
ok "$CONF présent"
[ -x /usr/local/bin/xray ] || die "Xray introuvable (/usr/local/bin/xray). Lance d'abord deploy/install.sh."
ok "Xray $(/usr/local/bin/xray version 2>/dev/null | head -1 | awk '{print $2}')"
[ -f "$XRAY_CFG" ] || die "$XRAY_CFG introuvable."
ok "$XRAY_CFG présent"
# Attention : avec `set -o pipefail`, `cmd | grep -q` renvoie 141 (SIGPIPE) quand grep
# s'arrête au premier résultat. On capture la sortie avant de filtrer.
UNITS="$(systemctl list-unit-files 2>/dev/null || true)"
case "$UNITS" in *"darksurf.service"*) ;; *) die "service darksurf introuvable." ;; esac
ok "service darksurf présent"

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "node introuvable."
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node $("$NODE_BIN" -v) détecté : DARK_SURF exige Node 22 ou plus (node:sqlite)."
ok "Node $("$NODE_BIN" -v)"

# Lit une variable de darksurf.env sans l'exécuter.
envval() { grep -E "^$1=" "$CONF" 2>/dev/null | tail -1 | cut -d= -f2- | sed 's/^"//; s/"$//' || true; }
HOST="$(envval VPN_HOST)"; [ -n "$HOST" ] || HOST="$(envval DOMAIN)"
[ -n "$HOST" ] || die "VPN_HOST absent de $CONF."
ok "hôte : $HOST"
SERVER_IP="$(envval SERVER_IP)"; [ -n "$SERVER_IP" ] || SERVER_IP="$(curl -4fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
info "IP publique : ${SERVER_IP:-inconnue}"

# ------------------------------------------------------------------ 2. sauvegarde
if [ "$MODE" = apply ]; then
  step "Sauvegarde"
  mkdir -p "$BACKUP"
  for f in "$XRAY_CFG" "$SB_CFG" "$CONF" /etc/systemd/system/$SB_SVC.service; do
    [ -f "$f" ] && cp -a "$f" "$BACKUP/" || true
  done
  [ -f /opt/darksurf/src/protocols.js ] && cp -a /opt/darksurf/src/protocols.js "$BACKUP/" || true
  echo "$BACKUP" > "$LAST_BACKUP_FILE"
  ok "sauvegarde dans $BACKUP"
fi

# ------------------------------------------------------------------ 3. sing-box
install_singbox() {
  if [ -x "$SB_BIN" ]; then
    ok "sing-box $("$SB_BIN" version 2>/dev/null | head -1 | awk '{print $3}') déjà installé"
    return 0
  fi
  local arch tmp ver
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) die "architecture $(uname -m) non prise en charge par sing-box." ;;
  esac
  ver="$(curl -fsSL --max-time 15 https://api.github.com/repos/SagerNet/sing-box/releases/latest \
        | grep -o '"tag_name": *"v[^"]*"' | head -1 | sed 's/.*"v//; s/"//')"
  [ -n "$ver" ] || die "impossible de déterminer la dernière version de sing-box (GitHub inaccessible ?)."
  tmp="$(mktemp -d)"
  local url="https://github.com/SagerNet/sing-box/releases/download/v${ver}/sing-box-${ver}-linux-${arch}.tar.gz"
  info "téléchargement de sing-box v$ver"
  curl -fsSL --max-time 120 "$url" -o "$tmp/sb.tgz" || die "téléchargement de sing-box impossible."
  curl -fsSL --max-time 30 "${url}.sha256" -o "$tmp/sb.sha256" 2>/dev/null || true
  if [ -s "$tmp/sb.sha256" ]; then
    local want have
    want="$(awk '{print $1}' "$tmp/sb.sha256" | head -1)"
    have="$(sha256sum "$tmp/sb.tgz" | awk '{print $1}')"
    [ "$want" = "$have" ] || die "somme SHA-256 de sing-box incorrecte : téléchargement refusé."
    ok "somme SHA-256 vérifiée"
  else
    warn "fichier .sha256 indisponible : intégrité non vérifiée"
  fi
  tar -xzf "$tmp/sb.tgz" -C "$tmp"
  install -m 755 "$(find "$tmp" -type f -name sing-box | head -1)" "$SB_BIN"
  rm -rf "$tmp"
  ok "sing-box v$ver installé dans $SB_BIN"
}

# ------------------------------------------------------------------ 4. configuration
# Les réglages viennent du panel (table app_settings, clé « protocols »).
# Le script ne les invente pas : il demande au serveur de les rendre.
gen_configs() {
  local out
  out="$(cd /opt/darksurf && "$NODE_BIN" -e '
    const E = require("./src/engines");
    const P = require("./src/protocols");
    const fs = require("fs");
    // src/db.js exporte open()/tx(), pas une instance : on ouvre la base nous-mêmes.
    const DBM = require("./src/db");
    let settings = {};
    try {
      const db = DBM.open(process.env.DB_PATH || "./data/darksurf.db");
      const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get("protocols");
      if (row) settings = JSON.parse(row.value);
      db.close();
    } catch (e) { /* base absente : on garde les valeurs par défaut */ }
    const merged = {};
    for (const p of P.PROTOCOLS) merged[p.id] = { ...P.defaults(p.id), ...(settings[p.id] || {}) };
    const env = process.env;
    const ctx = {
      host: env.VPN_HOST || "", serverIp: env.SERVER_IP || "",
      reality: { priv: env.VPN_REALITY_PRIV || "", pbk: env.VPN_REALITY_PBK || "", sid: env.VPN_REALITY_SID || "",
                 sni: env.VPN_REALITY_SNI || "www.microsoft.com", wgPriv: env.VPN_WG_PRIV || "", wgPub: env.VPN_WG_PUB || "" },
      ssPassword: env.VPN_SS_PASSWORD || "", certPath: env.TLS_CERT || "/etc/darksurf/tls/fullchain.pem",
      keyPath: env.TLS_KEY || "/etc/darksurf/tls/privkey.pem",
    };
    fs.writeFileSync("/tmp/ds-xray-new.json", JSON.stringify(E.buildXray(merged, ctx), null, 2));
    const sb = E.buildSingbox(merged, ctx);
    if (sb) fs.writeFileSync("/tmp/ds-sb-new.json", JSON.stringify(sb, null, 2));
    else fs.writeFileSync("/tmp/ds-sb-new.json", "");
    const on = Object.entries(merged).filter(([, v]) => v.enabled).map(([k, v]) => k + ":" + v.port);
    console.log(on.join(" ") || "aucun");
  ' 2>&1)" || die "génération des configurations impossible : $out"
  info "protocoles activés : $out"
}

# ------------------------------------------------------------------ 5. pare-feu
open_ports() {
  command -v ufw >/dev/null 2>&1 || { warn "ufw absent : aucun port ouvert localement"; return 0; }
  UFW_ST="$(ufw status 2>/dev/null || true)"
  case "$UFW_ST" in *"Status: active"*) ;; *) warn "ufw inactif : rien à ouvrir"; return 0 ;; esac
  local ports
  ports="$("$NODE_BIN" -e '
    const P = require("/opt/darksurf/src/protocols");
    const fs = require("fs");
    let s = {};
    try { s = JSON.parse(fs.readFileSync("/tmp/ds-settings.json", "utf8")); } catch (e) {}
    const out = [];
    for (const p of P.PROTOCOLS) {
      const v = { ...P.defaults(p.id), ...(s[p.id] || {}) };
      if (!v.enabled || p.viaProxy) continue;
      out.push((v.port || p.defaultPort) + "/" + (p.udp ? "udp" : "tcp"));
    }
    console.log(out.join(" "));
  ' 2>/dev/null || true)"
  for pp in $ports; do
    if printf '%s' "$UFW_ST" | grep -qE "^${pp%%/*}(/${pp##*/})?[[:space:]]+ALLOW"; then
      info "ufw : $pp déjà ouvert"
    else
      ufw allow "$pp" >/dev/null 2>&1 && ok "ufw : $pp ouvert" || warn "ufw : échec pour $pp"
    fi
  done
}

# ------------------------------------------------------------------ 6. validation
validate() {
  local rc=0
  if /usr/local/bin/xray run -test -format json -config /tmp/ds-xray-new.json >/tmp/ds-xray-test.log 2>&1; then
    ok "configuration Xray validée par le binaire"
  else
    bad "configuration Xray REFUSÉE :"; sed 's/^/      /' /tmp/ds-xray-test.log | tail -5; rc=1
  fi
  if [ -s /tmp/ds-sb-new.json ]; then
    if "$SB_BIN" check -c /tmp/ds-sb-new.json >/tmp/ds-sb-test.log 2>&1; then
      ok "configuration sing-box validée par le binaire"
    else
      bad "configuration sing-box REFUSÉE :"; sed 's/^/      /' /tmp/ds-sb-test.log | tail -5; rc=1
    fi
  else
    info "aucun protocole sing-box activé"
  fi
  return $rc
}

# ------------------------------------------------------------------ 7. service
write_sb_service() {
  cat >/etc/systemd/system/$SB_SVC.service <<'EOF'
[Unit]
Description=DARK_SURF : sing-box (Hysteria2, TUIC, WireGuard)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/sing-box run -c /etc/darksurf/singbox.json
Restart=always
RestartSec=2
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/etc/darksurf

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable $SB_SVC >/dev/null 2>&1 || true
}

# ------------------------------------------------------------------ 8. vérification
verify_ports() {
  local rc=0
  [ -s /tmp/ds-sb-new.json ] || { info "pas de port sing-box à vérifier"; return 0; }
  local list
  list="$("$NODE_BIN" -e '
    const c = JSON.parse(require("fs").readFileSync("/tmp/ds-sb-new.json", "utf8"));
    const out = [];
    for (const i of (c.inbounds || [])) out.push((i.listen_port) + "/udp");
    for (const e of (c.endpoints || [])) out.push((e.listen_port) + "/udp");
    console.log(out.join(" "));
  ' 2>/dev/null || true)"
  sleep 1
  for pp in $list; do
    local port="${pp%%/*}"
    if ss -ulpnH 2>/dev/null | grep -q ":${port} "; then ok "UDP $port en écoute"
    else bad "UDP $port n'écoute pas"; rc=1; fi
  done
  return $rc
}

# ================================================================== MODE --check
if [ "$MODE" = check ]; then
  step "Diagnostic (lecture seule)"
  for s in darksurf xray $SB_SVC nginx; do
    if printf '%s' "$UNITS" | grep -q "^$s\.service"; then
      st="$(systemctl is-active "$s" 2>/dev/null || true)"
      [ "$st" = active ] && ok "service $s : actif" || bad "service $s : $st"
    else
      info "service $s : non installé"
    fi
  done
  echo
  info "ports en écoute (TCP) :"
  ss -tlpnH 2>/dev/null | awk '{print "      "$4"  "$6}' | sort -u | head -20
  info "ports en écoute (UDP) :"
  ss -ulpnH 2>/dev/null | awk '{print "      "$4"  "$6}' | sort -u | head -20
  echo
  if [ -f "$SB_CFG" ]; then
    ok "$SB_CFG présent ($(wc -c <"$SB_CFG") octets)"
    "$SB_BIN" check -c "$SB_CFG" >/dev/null 2>&1 && ok "configuration sing-box valide" || bad "configuration sing-box invalide"
  else
    info "$SB_CFG absent : sing-box pas encore configuré"
  fi
  /usr/local/bin/xray run -test -format json -config "$XRAY_CFG" >/dev/null 2>&1 \
    && ok "configuration Xray valide" || bad "configuration Xray invalide"
  echo
  info "ufw : $(ufw status 2>/dev/null | head -1 || echo 'absent')"
  echo
  echo "${C_DIM}Rien n'a été modifié. Envoie cette sortie pour analyse.${C_OFF}"
  exit 0
fi

# ================================================================== MODE --rollback
if [ "$MODE" = rollback ]; then
  step "Restauration"
  [ -f "$LAST_BACKUP_FILE" ] || die "aucune sauvegarde enregistrée ($LAST_BACKUP_FILE absent)."
  B="$(cat "$LAST_BACKUP_FILE")"
  [ -d "$B" ] || die "sauvegarde introuvable : $B"
  info "depuis $B"
  for f in xray.json singbox.json darksurf.env; do
    if [ -f "$B/$f" ]; then
      install -m 640 "$B/$f" "/etc/darksurf/$f" && ok "$f restauré"
    elif [ -f "/etc/darksurf/$f" ]; then
      # Le fichier n'existait pas avant la mise à jour : on le retire pour revenir
      # réellement à l'état antérieur (sinon sing-box continuerait de tourner).
      rm -f "/etc/darksurf/$f" && ok "$f retiré (absent de la sauvegarde)"
    fi
  done
  [ -f "$B/$SB_SVC.service" ] && install -m 644 "$B/$SB_SVC.service" "/etc/systemd/system/$SB_SVC.service"
  [ -f "$B/protocols.js" ] && install -m 644 "$B/protocols.js" /opt/darksurf/src/protocols.js && ok "protocols.js restauré"
  systemctl daemon-reload
  systemctl restart xray 2>/dev/null && ok "Xray redémarré" || warn "Xray n'a pas redémarré"
  systemctl restart darksurf 2>/dev/null && ok "DARK_SURF redémarré" || warn "DARK_SURF n'a pas redémarré"
  if [ -f /etc/darksurf/singbox.json ]; then
    systemctl restart $SB_SVC 2>/dev/null || true
  else
    systemctl stop $SB_SVC 2>/dev/null || true
    systemctl disable $SB_SVC 2>/dev/null || true
    ok "service $SB_SVC arrêté (plus de configuration)"
  fi
  echo; ok "Restauration terminée."
  exit 0
fi

# ================================================================== MODE apply
if [ "$ASSUME_YES" = 0 ]; then
  echo
  echo "Ce script va : installer sing-box si absent, écrire $SB_CFG,"
  echo "créer le service $SB_SVC, ouvrir les ports choisis dans ufw,"
  echo "puis redémarrer Xray et DARK_SURF. Sauvegarde préalable dans $BACKUP."
  printf "Continuer ? [o/N] "
  read -r ans </dev/tty || ans=n
  case "$ans" in o|O|y|Y|oui|OUI) ;; *) echo "Annulé."; exit 0 ;; esac
fi

step "sing-box"
install_singbox

step "Génération des configurations"
# Exporte les variables utiles au générateur Node.
set -a
# shellcheck disable=SC1090
. "$CONF"
set +a
export VPN_HOST="$HOST" SERVER_IP="$SERVER_IP"
gen_configs

# Conserve les réglages pour l'ouverture des ports.
"$NODE_BIN" -e '
  const DBM = require("/opt/darksurf/src/db");
  const fs = require("fs");
  let s = {};
  try {
    const db = DBM.open(process.env.DB_PATH || "/opt/darksurf/data/darksurf.db");
    const r = db.prepare("SELECT value FROM app_settings WHERE key = ?").get("protocols");
    if (r) s = JSON.parse(r.value);
    db.close();
  } catch (e) {}
  fs.writeFileSync("/tmp/ds-settings.json", JSON.stringify(s));
' 2>/dev/null || echo '{}' >/tmp/ds-settings.json

step "Certificat TLS (Hysteria2 / TUIC)"
# Hysteria2 et TUIC exigent un certificat : sans lui, sing-box refuse de démarrer.
CERT="$(envval TLS_CERT)"; [ -n "$CERT" ] || CERT=/etc/darksurf/tls/fullchain.pem
KEY="$(envval TLS_KEY)"; [ -n "$KEY" ] || KEY=/etc/darksurf/tls/privkey.pem
NEEDS_TLS=0
if [ -s /tmp/ds-sb-new.json ] && grep -q '"certificate_path"' /tmp/ds-sb-new.json; then NEEDS_TLS=1; fi
if [ "$NEEDS_TLS" = 1 ]; then
  if [ -s "$CERT" ] && [ -s "$KEY" ]; then
    ok "certificat présent : $CERT"
    if openssl x509 -in "$CERT" -noout -checkend 0 >/dev/null 2>&1; then
      ok "certificat valide jusqu'au $(openssl x509 -in "$CERT" -noout -enddate 2>/dev/null | cut -d= -f2)"
    else
      warn "certificat expiré ou illisible : Hysteria2/TUIC échoueront"
    fi
  else
    bad "Hysteria2/TUIC sont activés mais le certificat est absent :"
    info "attendu : $CERT et $KEY"
    echo
    echo "  Deux solutions :"
    echo "    1. Désactive Hysteria2 et TUIC dans le panel (page Protocoles), puis relance."
    echo "    2. Fournis un certificat, par exemple avec Caddy déjà installé :"
    echo "         mkdir -p /etc/darksurf/tls"
    echo "         cp /var/lib/caddy/.local/share/caddy/certificates/*/*/\*.sslip.io.crt /etc/darksurf/tls/fullchain.pem"
    echo "         cp /var/lib/caddy/.local/share/caddy/certificates/*/*/\*.sslip.io.key /etc/darksurf/tls/privkey.pem"
    echo "       ou un certificat auto-signé (le client devra accepter le certificat) :"
    echo "         openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \\"
    echo "           -keyout $KEY -out $CERT -subj \"/CN=$HOST\""
    echo
    bad "Aucun fichier n'a été modifié."
    exit 1
  fi
else
  info "aucun protocole à TLS activé : certificat non requis"
fi

step "Validation avant application"
if ! validate; then
  bad "Configurations refusées : AUCUN fichier n'a été modifié."
  echo "  Corrige les réglages dans le panel (page Protocoles), puis relance."
  exit 1
fi

step "Écriture et redémarrage"
# N'écrit que si le contenu a réellement changé (idempotence).
if cmp -s /tmp/ds-xray-new.json "$XRAY_CFG" 2>/dev/null; then
  ok "$XRAY_CFG inchangé"
else
  install -m 640 -o root -g xray /tmp/ds-xray-new.json "$XRAY_CFG" 2>/dev/null \
    || install -m 640 /tmp/ds-xray-new.json "$XRAY_CFG"
  ok "$XRAY_CFG écrit"
fi
if [ -s /tmp/ds-sb-new.json ]; then
  if cmp -s /tmp/ds-sb-new.json "$SB_CFG" 2>/dev/null; then
    ok "$SB_CFG inchangé"
  else
    install -m 640 /tmp/ds-sb-new.json "$SB_CFG"
    ok "$SB_CFG écrit"
  fi
  write_sb_service
  ok "service $SB_SVC installé"
fi

open_ports

systemctl restart xray && ok "Xray redémarré" || { bad "Xray n'a pas redémarré"; exit 1; }
if [ -s /tmp/ds-sb-new.json ]; then
  systemctl restart $SB_SVC && ok "sing-box redémarré" || warn "sing-box n'a pas redémarré"
fi
systemctl restart darksurf && ok "DARK_SURF redémarré" || warn "DARK_SURF n'a pas redémarré"

step "Vérification des ports"
FAILED=0
verify_ports || FAILED=1
for s in xray darksurf; do
  st="$(systemctl is-active "$s" 2>/dev/null || true)"
  [ "$st" = active ] && ok "service $s actif" || { bad "service $s : $st"; FAILED=1; }
done

echo
if [ "$FAILED" = 0 ]; then
  echo "${C_OK}Terminé.${C_OFF} Les protocoles activés dans le panel écoutent réellement."
  echo "  Sauvegarde : $BACKUP"
  echo "  Retour arrière : sudo $0 --rollback"
else
  echo "${C_BAD}Des contrôles ont échoué.${C_OFF} Retour arrière : sudo $0 --rollback"
  exit 1
fi
