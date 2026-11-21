# DARK_SURF — serveur

Serveur unique : API de l'appli VPN (Xray VLESS/WebSocket), portail vendeur et portail administrateur. Node 22, aucune dépendance npm.

## Modèle économique (crédits)
- **1 crédit = 100 FCFA.** Le prix d'un forfait pour le vendeur est un nombre de crédits (forfait à 500 F = 5 crédits).
- L'**administrateur** crée les vendeurs, fixe la grille des forfaits et **recharge les crédits** (l'argent se règle hors application).
- **L'administrateur ne vend jamais** : il crée les vendeurs, recharge leurs crédits et voit tout en direct (onglet Clients : état, conso par appareil, connecté / hors ligne, dernière activité ; fiche détaillée par clé). Rafraîchissement automatique toutes les 5 s.
- Mot de passe admin choisi à l'installation : `DS_ADMIN_PASSWORD='...' bash darksurf-install.sh ...` ; changement ultérieur : `darksurf-admin set-admin-password <login>`.
- Les prix sont stockés en FCFA : 250 F = 2,5 crédits. Durées en heures, plage horaire optionnelle (Nuit Blanche 00h–06h, heure du Cameroun), limite de clés par vendeur (Pass Test : 3).
- `seed-plans` (ou le bouton « Charger les forfaits Geny » du portail) crée la grille Geny de 12 forfaits. 1 appareil par clé, débit illimité.
- Le vendeur peut **demander une recharge** (page Crédits) ; l'admin accepte/refuse (page Demandes). Numéro affiché : variable `SUPPORT_PHONE`.
- Le **vendeur** génère une clé ou recharge une clé existante : le coût est retiré de ses crédits. Crédits à zéro = plus de clé possible.
- Le **client** ne voit jamais de prix : seulement son forfait (données, date de fin).
- Aucun paiement en ligne dans l'application.

## Règles du forfait
- La durée démarre à la première activation de la clé (ou à la recharge). À la seconde d'expiration, l'utilisateur Xray est retiré.
- Les données sont comptées par clé (tous ses appareils). Quota atteint : pair retiré dans les 5 secondes.
- Recharger une clé : le nouveau forfait démarre maintenant, jours et données repartent de zéro.

## Démarrage local
    npm test
    npm run admin -- add-admin patron --password "un-mot-de-passe-long"
    npm run admin -- seed-plans
    npm run admin -- add-plan "20 Go · 30 jours" --days 30 --quota-gb 20 --credits 5
    npm start        # CORE_MODE=dry par défaut : aucun vrai Xray

Production : voir `DEPLOY.md` (un seul script : `deploy/install.sh`). API : `docs/API.md`.


## Transports SSH DARK_SURF

L'installateur configure SSH-TCP sur 2250/tcp et un listener SSH-WS dédié sur 2084/tcp (`/ws-ssh`). Le profil distribué au client sépare l'IP du VPS (`SERVER_IP`), le Host HTTP (`SSH_WS_HOST`), le SNI et le payload. Par défaut, le client se connecte directement à l'IP du VPS et envoie le Host CloudFront demandé (`d2m44uilhgzazi.cloudfront.net`). Cela n'achemine pas le trafic par le réseau CDN CloudFront : pour cela, le client doit joindre le domaine de distribution et CloudFront doit relayer le WebSocket vers l'origine. Les comptes SSH sont propres à chaque appareil, provisionnés à la demande, sans shell ni TTY, limités au port-forwarding local et comptés dans le forfait. Le client Android établit un SOCKS dynamique JSch local et fait transiter le TUN par ce tunnel. SSH-WS est essayé en premier ; VLESS et WireGuard restent des solutions de secours si elles sont encore activées.
