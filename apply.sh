#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
TARGET=/opt/darksurf
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/root/darksurf-global-config-backup-$STAMP"

if [[ "${EUID}" -ne 0 ]]; then echo "Lance ce script avec sudo/root." >&2; exit 1; fi
[[ -d "$TARGET/src" ]] || { echo "Installation DARK SURF introuvable dans $TARGET" >&2; exit 1; }
[[ -f /etc/systemd/system/darksurf.service ]] || { echo "Service darksurf.service introuvable" >&2; exit 1; }

mkdir -p "$BACKUP/src" "$BACKUP/deploy"
for f in config.js portal.js server.js service.js ssh-transport.js; do cp -a "$TARGET/src/$f" "$BACKUP/src/$f"; done
cp -a "$TARGET/deploy/install.sh" "$BACKUP/deploy/install.sh" 2>/dev/null || true
cp -a "$TARGET/deploy/darksurf-ssh-config" "$BACKUP/deploy/darksurf-ssh-config" 2>/dev/null || true

rollback() {
  echo "Échec : restauration des fichiers précédents..." >&2
  for f in config.js portal.js server.js service.js ssh-transport.js; do cp -a "$BACKUP/src/$f" "$TARGET/src/$f"; done
  systemctl restart darksurf || true
}

install -o root -g root -m 750 "$ROOT/deploy/darksurf-ssh-config" /usr/local/sbin/darksurf-ssh-config
install -o root -g root -m 644 "$ROOT/deploy/install.sh" "$TARGET/deploy/install.sh"
install -o root -g root -m 750 "$ROOT/deploy/darksurf-ssh-config" "$TARGET/deploy/darksurf-ssh-config"
for f in config.js portal.js server.js service.js ssh-transport.js; do install -o darksurf -g darksurf -m 640 "$ROOT/src/$f" "$TARGET/src/$f"; done

SUDOERS=/etc/sudoers.d/darksurf-ssh
[[ -f "$SUDOERS" ]] || { echo "Règle sudo DARK SURF absente ; arrêt sans toucher à la base." >&2; rollback; exit 1; }
grep -Fq '/usr/local/sbin/darksurf-ssh-config *' "$SUDOERS" || echo 'darksurf ALL=(root) NOPASSWD: /usr/local/sbin/darksurf-ssh-config *' >> "$SUDOERS"
chmod 440 "$SUDOERS"
visudo -cf "$SUDOERS" >/dev/null

# Le service est sandboxé : autoriser sudo uniquement pour les helpers déclarés et les fichiers strictement nécessaires.
mkdir -p /etc/systemd/system/darksurf.service.d
cat >/etc/systemd/system/darksurf.service.d/20-ssh-admin.conf <<'EOF'
[Service]
NoNewPrivileges=false
ReadWritePaths=
ReadWritePaths=/var/lib/darksurf /etc/darksurf /etc/passwd /etc/shadow /etc/group /etc/gshadow -/etc/subuid -/etc/subgid -/etc/ufw -/var/lib/ufw -/run/lock -/run/sshd -/run/sudo -/var/log/lastlog -/var/log/faillog
EOF
systemctl daemon-reload

if ! node --check "$TARGET/src/config.js" || ! node --check "$TARGET/src/portal.js" || ! node --check "$TARGET/src/server.js" || ! node --check "$TARGET/src/service.js" || ! node --check "$TARGET/src/ssh-transport.js"; then rollback; exit 1; fi
if ! /usr/sbin/sshd -t -f /etc/darksurf/sshd_config; then rollback; exit 1; fi

if ! systemctl restart darksurf; then rollback; exit 1; fi
sleep 2
if ! systemctl is-active --quiet darksurf; then rollback; exit 1; fi
if ! curl -fsS --max-time 5 http://127.0.0.1:8080/healthz >/dev/null; then rollback; exit 1; fi

echo "DARK SURF global config installée."
echo "Backup : $BACKUP"
echo "Service : $(systemctl is-active darksurf)"
echo "La configuration SSH se modifie ensuite dans Admin > Protocoles VPN."
