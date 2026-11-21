# Installer DARK_SURF sur un VPS

## Prérequis
- VPS **KVM** Ubuntu 22.04/24.04 (ou Debian 12), 1 vCPU / 1 Go suffisent pour quelques centaines de clients. Pas de LXC/OpenVZ.
- Un nom de domaine avec un enregistrement DNS **A** vers l'IP du VPS (DNS seulement, sans proxy Cloudflare).
- Ports ouverts chez le fournisseur : **TCP 80 et TCP 443** uniquement (le tunnel passe par 443, comme un site web).

## Installation
    scp -r darksurf-server.zip root@IP:/root/ ; ssh root@IP
    unzip darksurf-server.zip && cd darksurf-server
    sudo ./deploy/install.sh --domain vpn.mondomaine.com --email moi@mail.com --admin patron

Le script vérifie le système et le DNS, installe Xray (SHA-256 vérifié), Node.js (SHA-256 vérifié) et Caddy (HTTPS automatique), règle le noyau
(BBR, fq, tampons TCP), configure Xray (VLESS + WebSocket derrière Caddy, accès réseau privé bloqué), installe le service, crée le compte administrateur
(identifiants dans `/root/darksurf-identifiants.txt`) et termine par `darksurf-doctor`.

Sans domaine : remplace `--domain vpn.mondomaine.com` par `--domain auto` (adresse gratuite `15-235-111-58.sslip.io` déduite de l'IP).

## Ensuite
1. Portail `https://votre-domaine` : **Forfaits** (bouton « Charger les forfaits Geny »), **Nouveau vendeur**, **Recharger** ses crédits, **Annonces**.
2. Publier l'appli VPN : `darksurf-admin publish-release app.apk --version-code 1 --version-name 1.0.0 --notes "Première version"`.
3. Vérifier : `darksurf-doctor`.

## Au quotidien
- Mise à jour du serveur : décompresser la nouvelle version, relancer `sudo ./deploy/install.sh` (données, clés et config conservées).
- Mise à jour de l'appli : `darksurf-admin publish-release` (obligatoire avec `--required` ou `--min-code N`).
- Sauvegardes : toutes les 6 h dans `/var/backups/darksurf` (14 jours). Restaurer : arrêter `darksurf`, décompresser la copie vers `/var/lib/darksurf/darksurf.db` (propriétaire `darksurf`), relancer.
- Journaux : `journalctl -u darksurf -f`. CLI : `darksurf-admin help`.

## Performance et stabilité
- Xray (VLESS + WebSocket + TLS sur 443) passe sur tous les réseaux mobiles ; BBR + fq accélèrent le TCP. Aucune limitation de débit n'est appliquée.
- La vitesse réelle dépend surtout du VPS (bande passante, qualité de l'hébergeur vers l'Afrique centrale). Teste avec `darksurf-doctor` puis un test de vitesse téléphone avec/sans VPN avant de vendre.
- « Connecté » = trafic observé dans les 3 dernières minutes.
