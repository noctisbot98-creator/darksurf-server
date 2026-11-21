// Portail : traduction FR → EN appliquée à la page déjà générée (textes, placeholder, title) + thème clair/sombre.
// Le français reste la langue de rédaction ; l'anglais est choisi par le cookie « ds_lang » (voir /lang).

const EN = {
  // activation vendeur / appareils par clé / plafond 24 h
  'Activation vendeur': 'Seller activation', "Activation de l'appli vendeur": 'Seller app activation',
  "Le vendeur ouvre l'appli PRO : elle affiche l'identifiant de son téléphone (AAAA-BBBB-CCCC-DDDD-EEEE). Colle-le ici pour lui donner la permission d'utiliser l'appli.": 'The seller opens the PRO app: it shows the phone ID (AAAA-BBBB-CCCC-DDDD-EEEE). Paste it here to allow that phone to use the app.',
  'Donner la permission': 'Grant permission', 'Identifiant du téléphone': 'Phone ID', 'Nom du vendeur': 'Seller name',
  'Validité (jours, 0 = sans expiration)': 'Validity (days, 0 = never expires)', 'Générer le code': 'Generate code', "Code d'activation prêt ✔": 'Activation code ready ✔',
  'Installer la clé': 'Install key', "Clé privée vendeur installée ✔": 'Seller private key installed ✔',
  'Appareils pour cette clé (max 3)': 'Devices for this key (max 3)', '1 appareil': '1 device', '2 appareils': '2 devices', '3 appareils': '3 devices',
  'illimité (30 Go/24 h)': 'unlimited (30 GB/24 h)', "jusqu'à 3 appareils": 'up to 3 devices',
  // navigation / en-tête
  'Quitter': 'Log out', 'Tableau de bord': 'Dashboard', 'Clients': 'Clients', 'Forfaits': 'Plans', 'Demandes': 'Requests', 'Annonces': 'Notices',
  'Versions': 'Releases', 'Protocoles VPN': 'VPN protocols', 'Journal': 'Audit log', 'Vendre': 'Sell', 'Mes clés': 'My keys', 'Appareils': 'Devices', 'Crédits': 'Credits',
  'Retour': 'Back', 'Thème / Theme': 'Theme', 'Copier': 'Copy', 'Copié': 'Copied',
  // connexion
  'Connexion': 'Sign in', 'Espace vendeur': 'Seller area', 'Identifiant': 'Login', 'Mot de passe': 'Password', 'Se connecter': 'Sign in',
  'Identifiant ou mot de passe incorrect.': 'Wrong login or password.', 'Trop de tentatives. Patientez quelques minutes.': 'Too many attempts. Please wait a few minutes.',
  'Introuvable': 'Not found', 'Cette page n\'existe pas.': 'This page does not exist.', 'Refusé': 'Refused', 'Origine invalide.': 'Invalid origin.',
  'Accès refusé': 'Access denied', 'Cette page est réservée à l\'administrateur.': 'This page is reserved for the administrator.',
  'Jeton de sécurité invalide. Recharge la page.': 'Invalid security token. Reload the page.',
  'Vendeur créé': 'Seller created', 'Nouveau mot de passe': 'New password',
  // direct
  'En direct : mise à jour automatique toutes les 5 secondes · dernière lecture': 'Live: refreshes automatically every 5 seconds · last read', 'à l\'ouverture': 'on open',
  // vendre
  'Générer une clé': 'Generate a key', 'Choisis le forfait : la clé est créée et son coût est retiré de tes crédits.': 'Pick a plan: the key is created and its cost is taken from your credits.',
  '1 · Forfait': '1 · Plan', '2 · Quantité': '2 · Quantity', 'Nom du client (affiché dans son appli)': 'Client name (shown in their app)', 'facultatif': 'optional',
  'Coût total :': 'Total cost:', 'crédit(s) · tes crédits :': 'credit(s) · your credits:', 'Générer': 'Generate',
  'Aucun forfait n\'est proposé pour le moment.': 'No plan is offered right now.', 'Envoyer par WhatsApp': 'Send via WhatsApp', 'Crédits restants :': 'Credits left:',
  '. Le forfait démarre quand le client active la clé dans son application.': '. The plan starts when the client activates the key in their app.', 'Générer une autre clé': 'Generate another key',
  // mes clés
  'Fiche SSH': 'SSH sheet', 'Recharger': 'Recharge', 'Clés': 'Keys', 'Non activées': 'Not activated', 'Actives': 'Active', 'Mes clés (200 dernières)': 'My keys (last 200)',
  'Exporter CSV': 'Export CSV', 'Clé': 'Key', 'Forfait': 'Plan', 'État': 'Status', 'Données': 'Data', 'Aucune clé pour le moment.': 'No keys yet.',
  'Le transport SSH est désactivé sur ce serveur (page « Protocoles VPN » de l\'administrateur).': 'SSH transport is disabled on this server (administrator\'s "VPN protocols" page).',
  'Cette fiche sert aux applis tierces (HTTP Custom, NPV Tunnel…). Elle active aussi le forfait de la clé s\'il n\'a pas encore démarré.': 'This sheet is for third-party apps (HTTP Custom, NPV Tunnel…). It also starts the key\'s plan if it has not started yet.',
  'Activer la fiche SSH': 'Enable the SSH sheet',
  'Un seul appareil à la fois : si plusieurs connexions sont ouvertes avec ce compte, elles sont toutes coupées. Le trafic est compté dans le forfait de la clé.': 'One device at a time: if several connections are open with this account, they are all cut. Traffic counts toward the key\'s plan.',
  'Recharger une clé': 'Recharge a key', 'Cette clé est encore active : le nouveau forfait la remplace et démarre maintenant (durée et données repartent de zéro).': 'This key is still active: the new plan replaces it and starts now (duration and data restart from zero).',
  'Recharger la clé': 'Recharge the key',
  // appareils / crédits
  'Appareils de mes clients': 'My clients\' devices', 'Appareil': 'Device', 'Dernière connexion': 'Last connection', 'Aucun appareil activé.': 'No device activated.',
  '« Libérer » enlève l\'appareil de la clé : le client peut alors l\'activer sur un autre téléphone.': '"Release" removes the device from the key: the client can then activate it on another phone.',
  'Aucun mouvement.': 'No movements.', 'Date': 'Date', 'Opération': 'Operation', 'Solde': 'Balance', 'Mes crédits': 'My credits',
  '1 crédit = 100 FCFA. Quand tes crédits sont épuisés, tu ne peux plus vendre de forfait.': '1 credit = 100 FCFA. When your credits run out, you can no longer sell plans.',
  'Demander une recharge': 'Request a top-up', 'Nombre de crédits souhaités': 'Credits wanted', 'ex. 50': 'e.g. 50',
  '1 crédit = 100 FCFA. Contacte l\'administrateur :': '1 credit = 100 FCFA. Contact the administrator:', 'Envoyer la demande': 'Send the request', 'Demande': 'Request', 'Historique': 'History',
  // admin tableau de bord
  'Serveur': 'Server', '· connectés :': '· connected:', '· RAM :': '· RAM:', 'Vendeurs': 'Sellers', 'Nouveau vendeur': 'New seller', 'Vendeur': 'Seller',
  'Clés actives / total': 'Active keys / total', 'Connectés': 'Connected', 'Crédits utilisés': 'Credits used', 'Aucun vendeur. Crée le premier.': 'No sellers. Create the first one.',
  'Recherche (clé, vendeur, forfait, appareil)': 'Search (key, seller, plan, device)', 'ex. TUN-ab12, marie, Pixel': 'e.g. TUN-ab12, marie, Pixel', 'Tous': 'All', 'Filtrer': 'Filter',
  'Dernière activité': 'Last activity', 'Aucun client pour ce filtre.': 'No client for this filter.', 'bloqué': 'blocked', 'Données utilisées': 'Data used', 'Expire': 'Expires', 'Activé le': 'Activated on',
  'Conso': 'Usage', 'Aucun appareil : la clé n\'a jamais été utilisée.': 'No device: the key has never been used.', 'Total': 'Total',
  '« Libérer » supprime l\'appareil : la clé pourra être activée sur un autre téléphone. « Bloquer » coupe l\'accès sans rien supprimer.': '"Release" deletes the device: the key can be activated on another phone. "Block" cuts access without deleting anything.',
  'Libérer': 'Release', 'Bloquer': 'Block', 'Débloquer': 'Unblock', 'Révoquer': 'Revoke', 'Accepter': 'Accept', 'Refuser': 'Refuse', 'Supprimer': 'Delete', 'Désactiver': 'Disable', 'Activer': 'Enable',
  'Nom affiché': 'Display name', 'Crédits de départ': 'Starting credits', 'Mot de passe (vide = généré automatiquement)': 'Password (empty = generated automatically)', 'Créer le vendeur': 'Create the seller',
  'Identifiant :': 'Login:', 'Mot de passe (affiché une seule fois)': 'Password (shown only once)', 'Fiche du vendeur': 'Seller profile',
  'Clés actives': 'Active keys', 'Crédits achetés / utilisés': 'Credits bought / used', 'Données consommées': 'Data used', 'Recharger / corriger les crédits': 'Top up / correct credits',
  'Montant (crédits)': 'Amount (credits)', 'ex. 50 ou 2,5': 'e.g. 50 or 2.5', 'Ajouter': 'Add', 'Retirer (correction)': 'Remove (correction)',
  'Note / justification (obligatoire pour un retrait)': 'Note / reason (required for a removal)', 'Valider': 'Confirm', 'Clés du vendeur (200 dernières)': 'Seller\'s keys (last 200)',
  'Aucune clé.': 'No keys.', 'Mouvements de crédit': 'Credit movements',
  // forfaits
  'Prix': 'Price', 'Grille des forfaits (1 crédit = 100 FCFA)': 'Plan grid (1 credit = 100 FCFA)', 'Prix vendeur (crédits)': 'Seller price (credits)',
  'Aucun forfait : clique « Charger les forfaits Geny ».': 'No plan: click "Load the Geny plans".', 'Charger les forfaits Geny': 'Load the Geny plans',
  'Retirer un forfait ne coupe pas les clés déjà vendues. La durée et les données d\'un forfait ne se modifient pas : crées-en un nouveau.': 'Removing a plan does not cut keys already sold. A plan\'s duration and data cannot be edited: create a new one.',
  'Nouveau forfait': 'New plan', 'Nom': 'Name', 'Durée': 'Duration', 'Unité': 'Unit', 'jours': 'days', 'heures': 'hours', 'Données (Go)': 'Data (GB)', 'vide si illimité': 'empty if unlimited',
  'Prix vendeur (crédits, 0 = gratuit)': 'Seller price (credits, 0 = free)', 'ex. 2,5': 'e.g. 2.5', 'Plage horaire (facultatif)': 'Time window (optional)', 'Clés max par vendeur (essai)': 'Max keys per seller (trial)',
  'illimité': 'unlimited', 'Données illimitées': 'Unlimited data', 'Créer le forfait': 'Create the plan', 'ex. Pass Mensuel Standard': 'e.g. Standard Monthly Pass', 'Retirer': 'Remove',
  // demandes / journal / annonces / versions
  'Demandes de recharge des vendeurs': 'Sellers\' top-up requests', 'Aucune demande.': 'No requests.', 'Accepter ajoute les crédits au vendeur tout de suite (écriture dans son historique).': 'Accepting adds the credits to the seller immediately (recorded in their history).',
  'Journal des actions sensibles': 'Sensitive actions log', 'Qui': 'Who', 'Action': 'Action', 'Détail': 'Detail', 'Rien pour le moment.': 'Nothing yet.',
  'Nouvelle annonce': 'New notice', 'Destinataires': 'Recipients', 'Clients (notification dans l\'appli VPN)': 'Clients (notification in the VPN app)', 'Vendeurs (bandeau du portail)': 'Sellers (portal banner)',
  'Tout le monde': 'Everyone', 'Titre': 'Title', 'Message': 'Message', 'Visible pendant (jours, vide = jusqu\'à retrait)': 'Visible for (days, empty = until removed)', 'Publier': 'Publish',
  'Annonce': 'Notice', 'Pour': 'For', 'Aucune annonce.': 'No notices.', 'Versions de l\'application VPN': 'VPN app releases', 'Code': 'Code', 'Version': 'Version', 'Notes': 'Notes', 'Taille': 'Size',
  'Aucune version publiée.': 'No release published.', 'Pour publier :': 'To publish:', 'sur le serveur.': 'on the server.',
  // protocoles
  'Transport SSH (héritage)': 'SSH transport (legacy)', 'Ces paramètres sont appliqués au VPS et distribués automatiquement aux clients lors de leur prochaine connexion. Les vendeurs ne peuvent pas les modifier.': 'These settings are applied to the VPS and automatically distributed to clients at their next connection. Sellers cannot change them.',
  'Protocole essayé en premier (le client n\'a aucun choix)': 'Protocol tried first (the client has no choice)', 'Appliquer au VPS': 'Apply to the VPS',
  'Modules SSH': 'SSH modules', 'SSH sur TLS · Dropbear · UDPGW': 'SSH over TLS · Dropbear · UDPGW',
  'Chaque module s\'installe et se démarre sur le VPS quand tu l\'actives, et s\'arrête quand tu le coupes. Ils apparaissent ensuite dans la fiche SSH de chaque clé. Pense à ouvrir ces ports chez l\'hébergeur.': 'Each module is installed and started on the VPS when you enable it, and stopped when you turn it off. They then appear in each key\'s SSH sheet. Remember to open these ports at your host.',
  'CloudFront (optionnel)': 'CloudFront (optional)', 'Mettre ton serveur derrière un CDN': 'Put your server behind a CDN', 'À faire dans la console AWS, une seule fois. Dans « Create distribution » :': 'Do this once in the AWS console, under "Create distribution":',
  'HTTP and HTTPS (pas de redirection)': 'HTTP and HTTPS (no redirect)',
  'Quand la distribution est « Enabled », son nom (dxxxxxxxx.cloudfront.net) sert d\'hôte devant ce serveur, pour le trafic WebSocket (VLESS ou SSH-WS).': 'When the distribution is "Enabled", its name (dxxxxxxxx.cloudfront.net) serves as the host in front of this server, for WebSocket traffic (VLESS or SSH-WS).',
  'Actif': 'Active', 'Erreur': 'Error', 'Inactif': 'Inactive', 'Absent de la liste officielle de V2Box': 'Not in V2Box\'s official list', 'Importable dans V2Box': 'Importable in V2Box',
  'Chemin WebSocket': 'WebSocket path', 'SNI / domaine imité': 'SNI / mimicked domain', 'Graine mKCP': 'mKCP seed', 'Chiffrement': 'Encryption', 'Activer ce protocole': 'Enable this protocol',
  'Port': 'Port', 'Famille': 'Family', 'Lien prêt': 'Link ready', 'Copier le lien': 'Copy link',
  'Configuration appliquée et validée par les moteurs.': 'Configuration applied and validated by the engines.',
  'Application refusée : la configuration a été rejetée par le moteur. Les fichiers précédents ont été restaurés.': 'Refused: the configuration was rejected by the engine. The previous files were restored.',
  'Paramètres invalides : vérifie les ports (1024–65535, tous différents) et les champs.': 'Invalid settings: check the ports (1024–65535, all different) and the fields.',
  'ADMIN VPS': 'VPS ADMIN', 'protocoles actifs': 'active protocols', 'en écoute réelle': 'actually listening', 'appareils': 'devices',
  'Configuration centrale — administrateur uniquement': 'Central configuration — administrator only',
  'Chaque protocole activé est écrit dans la configuration du moteur, validé par le binaire lui-même, puis appliqué. En cas de rejet, les fichiers précédents sont restaurés automatiquement. Les vendeurs ne voient jamais ces réglages.': 'Each enabled protocol is written into the engine configuration, validated by the binary itself, then applied. If rejected, the previous files are restored automatically. Sellers never see these settings.',
  'Valider et appliquer au VPS': 'Validate and apply to the VPS', 'Liens d\'import V2Box': 'V2Box import links',
  'Choisis un appareil : chaque protocole actif produit un lien et un QR code à scanner dans V2Box (ou à coller dans « Importer depuis le presse-papiers »).': 'Pick a device: each active protocol produces a link and a QR code to scan in V2Box (or paste into "Import from clipboard").',
  'Aucun appareil activé': 'No device activated', 'Afficher': 'Show', 'Aucun protocole actif pour cet appareil.': 'No active protocol for this device.',

  'Connectés': 'Connected', 'Expirés': 'Expired', 'Non activés': 'Not activated', 'Révoqués': 'Revoked', 'aucun écouteur': 'no listener', 'clé': 'key', 'dernière connexion': 'last connection',
  'Clients connectés maintenant': 'Clients connected now', 'Clients (clés)': 'Clients (keys)', 'Clés expirées': 'Expired keys', 'Clés révoquées': 'Revoked keys', 'Crédits chez les vendeurs': 'Credits held by sellers',
  'Crédits distribués': 'Credits distributed', 'Crédits consommés': 'Credits spent', 'Données totales': 'Total data', '(dry) · appareils autorisés :': '(dry) · authorized devices:', 'allumé depuis': 'up for',
  'Le mode historique de DARK_SURF. Trafic HTTPS standard relayé par Caddy vers Xray.': 'DARK_SURF\'s historical mode. Standard HTTPS traffic relayed by Caddy to Xray.',
  'Passe par Caddy sur 443 : aucun port supplémentaire à ouvrir.': 'Goes through Caddy on 443: no extra port to open.',
  'Camouflage REALITY : le serveur imite le TLS d\'un grand site, sans certificat à gérer.': 'REALITY camouflage: the server mimics a large site\'s TLS, with no certificate to manage.',
  'Port TCP à ouvrir côté OVH et ufw. Aucun certificat nécessaire.': 'TCP port to open at the host and ufw. No certificate needed.',
  'Transport UDP : meilleur sur les réseaux à forte perte de paquets.': 'UDP transport: better on networks with heavy packet loss.',
  'Port UDP à ouvrir. Certains opérateurs bloquent l\'UDP.': 'UDP port to open. Some operators block UDP.',
  'Sans TLS : le plus rapide, mais visible par un filtrage profond.': 'No TLS: the fastest, but visible to deep filtering.',
  'Port TCP à ouvrir. À réserver aux réseaux non filtrés.': 'TCP port to open. Reserve for unfiltered networks.',
  'Compatibilité maximale : accepté par tous les clients V2Ray, y compris anciens.': 'Maximum compatibility: accepted by all V2Ray clients, including old ones.',
  'Se fait passer pour du HTTPS légitime ; très bien toléré par les filtrages.': 'Passes as legitimate HTTPS; well tolerated by filters.',
  'Léger et rapide, très largement supporté. Chiffrement AEAD 2022.': 'Light and fast, very widely supported. AEAD 2022 encryption.',
  'Port TCP à ouvrir.': 'TCP port to open.', 'Très rapide sur les connexions mobiles dégradées. Nécessite un certificat TLS.': 'Very fast on degraded mobile connections. Requires a TLS certificate.',
  'Port UDP à ouvrir. Certificat TLS obligatoire (Let\'s Encrypt ou auto-signé).': 'UDP port to open. TLS certificate required (Let\'s Encrypt or self-signed).',
  'QUIC natif, faible latence, bonne résistance à la censure.': 'Native QUIC, low latency, good censorship resistance.',
  'Port UDP à ouvrir. Certificat TLS obligatoire. NON importable dans V2Box (absent de sa liste officielle) : à réserver aux clients sing-box, Hiddify ou NekoBox.': 'UDP port to open. TLS certificate required. NOT importable in V2Box (not in its official list): reserve for sing-box, Hiddify or NekoBox clients.',
  'Le plus économe en batterie. Excellent débit, mais signature réseau reconnaissable.': 'The most battery-friendly. Excellent throughput, but a recognizable network signature.',
  'Port UDP à ouvrir.': 'UDP port to open.', 'Proxy simple, sans chiffrement propre : à utiliser au-dessus d\'un réseau de confiance.': 'Simple proxy with no encryption of its own: use over a trusted network.',
  'Port TCP à ouvrir. Non chiffré : ne protège pas le contenu. V2Box accepte socks://.': 'TCP port to open. Unencrypted: does not protect content. V2Box accepts socks://.',
  'Proxy HTTP classique, utile pour les navigateurs et les outils qui ne parlent pas V2Ray.': 'Classic HTTP proxy, useful for browsers and tools that do not speak V2Ray.',
  'Port TCP à ouvrir. Non chiffré.': 'TCP port to open. Unencrypted.', 'Port du serveur SSH': 'SSH server port', 'Port réel du démon SSH DARK SURF.': 'Actual port of the DARK SURF SSH daemon.',
  'TCP, certificat auto-signé.': 'TCP, self-signed certificate.', 'TCP, deuxième serveur SSH léger.': 'TCP, second lightweight SSH server.', 'Port local uniquement, joint à travers le tunnel SSH.': 'Local port only, reached through the SSH tunnel.',
  // états
  'Active': 'Active', 'Expirée': 'Expired', 'Données épuisées': 'Data exhausted', 'Non activée': 'Not activated', 'Révoquée': 'Revoked', 'connecté': 'connected', 'hors ligne': 'offline', 'Gratuit': 'Free',
  'à l\'instant': 'just now', 'Tout': 'All',
  // messages flash
  'Crédits insuffisants. Demande une recharge à l\'administrateur.': 'Not enough credits. Ask the administrator for a top-up.', 'Forfait invalide.': 'Invalid plan.', 'Quantité invalide (1 à 50).': 'Invalid quantity (1 to 50).',
  'Cette clé est révoquée : elle ne peut plus être rechargée.': 'This key is revoked: it can no longer be recharged.', 'Cette clé n\'a jamais été activée : envoie-la simplement au client.': 'This key was never activated: just send it to the client.',
  'Identifiant invalide (a-z, 0-9, . _ - ; 3 à 32 caractères).': 'Invalid login (a-z, 0-9, . _ - ; 3 to 32 characters).', 'Mot de passe trop court (10 caractères minimum).': 'Password too short (10 characters minimum).',
  'Montant invalide.': 'Invalid amount.', 'Cet identifiant existe déjà.': 'This login already exists.', 'Un forfait porte déjà ce nom.': 'A plan already has this name.', 'Annonce invalide (titre et message requis).': 'Invalid notice (title and message required).',
  'Élément introuvable.': 'Item not found.', 'Trop de demandes. Patiente un instant.': 'Too many requests. Please wait a moment.', 'Limite atteinte : ce forfait d\'essai ne peut plus être généré sur ton compte.': 'Limit reached: this trial plan can no longer be generated on your account.',
  'Un forfait d\'essai ne peut pas recharger une clé.': 'A trial plan cannot recharge a key.', 'Indique une justification pour retirer des crédits.': 'Give a reason to remove credits.', 'Tu as déjà 3 demandes en attente.': 'You already have 3 pending requests.',
  'Ce vendeur a des clés : désactive-le plutôt (l\'historique est conservé).': 'This seller has keys: disable them instead (history is kept).', 'Demande envoyée à l\'administrateur.': 'Request sent to the administrator.',
  'Demande acceptée : crédits ajoutés.': 'Request accepted: credits added.', 'Demande refusée.': 'Request refused.', 'Vendeur supprimé.': 'Seller deleted.', 'Forfaits Geny chargés.': 'Geny plans loaded.', 'Action impossible.': 'Action not possible.',
  'Clé révoquée : les appareils liés seront coupés.': 'Key revoked: linked devices will be cut.', 'Appareil mis à jour.': 'Device updated.', 'Enregistré.': 'Saved.', 'Crédits mis à jour.': 'Credits updated.',
  'Clé rechargée : le nouveau forfait démarre maintenant.': 'Key recharged: the new plan starts now.',
};

const MONTHS = { 'janv.': 'Jan', 'févr.': 'Feb', 'mars': 'Mar', 'avr.': 'Apr', 'mai': 'May', 'juin': 'Jun', 'juil.': 'Jul', 'août': 'Aug', 'sept.': 'Sep', 'oct.': 'Oct', 'nov.': 'Nov', 'déc.': 'Dec' };
const decode = (s) => s.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// Fragments dynamiques (montants, durées, âges, tailles).
function rules(t) {
  return t
    .replace(/(\d)\s?(crédits?)\b/g, (m, n, w) => `${n} ${w === 'crédit' ? 'credit' : 'credits'}`)
    .replace(/(\d+) jours?\b/g, (m, n) => `${n} day${n === '1' ? '' : 's'}`)
    .replace(/(\d+) clés?\b/g, (m, n) => `${n} key${n === '1' || n === '0' ? '' : 's'}`)
    .replace(/allumé depuis (\d+) j/g, 'up for $1 d')
    .replace(/(\d+) heures\b/g, '$1 hours')
    .replace(/(\d+) appareils?\b/g, (m, n) => `${n} device${n === '1' ? '' : 's'}`)
    .replace(/(\d+) clés max par vendeur/g, '$1 keys max per seller')
    .replace(/il y a (\d+) min/g, '$1 min ago').replace(/il y a (\d+) h\b/g, '$1 h ago').replace(/il y a (\d+) j\b/g, '$1 d ago')
    .replace(/\b(\d+(?:[.,]\d+)?)\s(Go|Mo|ko)\b/g, (m, n, u) => `${n} ${u === 'Go' ? 'GB' : u === 'Mo' ? 'MB' : 'kB'}`)
    .replace(/\b(\d+(?:[.,]\d+)?)\so\b/g, '$1 B')
    .replace(/(\d{1,2}) (janv\.|févr\.|mars|avr\.|mai|juin|juil\.|août|sept\.|oct\.|nov\.|déc\.) (\d{4})/g, (m, d, mo, y) => `${MONTHS[mo]} ${d}, ${y}`)
    .replace(/(\d{2})\/(\d{2})\/(\d{4})/g, '$2/$1/$3')
    .replace(/\billimité\b/g, 'unlimited')
    .replace(/(\d+) heures? /g, '$1 h ');
}

function trText(raw) {
  const m = raw.match(/^(\s*)([\s\S]*?)(\s*)$/);
  const core = decode(m[2]);
  if (!core) return raw;
  let hit = EN[core];
  if (hit === undefined) {
    const t = core.replace(/ · DARK_SURF$/, '');
    if (t !== core && EN[t] !== undefined) hit = EN[t] + ' · DARK_SURF';
    else {
      const sp = core.indexOf(' ');
      for (let i = core.length; hit === undefined && i > 0; i = core.lastIndexOf(' ', i - 1)) {   // plus long préfixe connu : « Connectés 0 »
        if (i > 0 && EN[core.slice(0, i)] !== undefined) hit = EN[core.slice(0, i)] + rules(core.slice(i));
        if (sp < 0) break;
      }
    }
  }
  return m[1] + (hit !== undefined ? hit : rules(core)).replace(/&/g, '&amp;').replace(/</g, '&lt;') + m[3];
}

function translate(html) {
  // On ne touche ni aux <script> ni aux <style>.
  return html.split(/(<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>)/).map((part, i) => {
    if (i % 2 === 1) return part;
    return part
      .replace(/(placeholder|title|aria-label)="([^"]*)"/g, (m, a, v) => `${a}="${(EN[decode(v)] ?? rules(decode(v))).replace(/"/g, '&quot;')}"`)
      .replace(/>([^<>]+)</g, (m, t) => `>${trText(t)}<`)
      .replace(/<html lang="fr"/, '<html lang="en"');
  }).join('');
}

const LIGHT_CSS = `
.appmode nav{display:none}
html[data-theme=light]{--bg:#f3f7f4;--s:#ffffff;--s2:#eaf1ec;--line:#cfdcd3;--g:#0a8f4e;--y:#b07a00;--t:#10201a;--m:#546a5d;--d:#c62828;--muted:#546a5d}
@media (prefers-color-scheme:light){html:not([data-theme]){--bg:#f3f7f4;--s:#ffffff;--s2:#eaf1ec;--line:#cfdcd3;--g:#0a8f4e;--y:#b07a00;--t:#10201a;--m:#546a5d;--d:#c62828;--muted:#546a5d}}
html[data-theme=light] .btn:not(.ghost):not(.danger){color:#fff}
@media (prefers-color-scheme:light){html:not([data-theme]) .btn:not(.ghost):not(.danger){color:#fff}}
.tools{display:flex;gap:6px;align-items:center}
.tools a,.tools button{font:700 11px ui-monospace,Menlo,monospace;letter-spacing:.1em;color:var(--m);background:transparent;border:1px solid var(--line);border-radius:10px;padding:5px 9px;cursor:pointer;text-decoration:none}
.tools .on{color:var(--g);border-color:var(--g)}
.toolsfix{position:fixed;top:8px;right:10px;z-index:5}
`;

// Lu avant l'affichage : applique le thème enregistré (sinon « auto » = celui du téléphone).
const THEME_BOOT = "if(/DarkSurfApp/.test(navigator.userAgent))document.documentElement.className+=' appmode';try{var t=localStorage.getItem('ds_theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}";
const THEME_JS = `document.addEventListener('click',function(e){var b=e.target.closest('[data-theme-btn]');if(!b)return;
var cur=document.documentElement.getAttribute('data-theme');var next=cur==='dark'?'light':cur==='light'?'auto':'dark';
if(next==='auto'){document.documentElement.removeAttribute('data-theme')}else{document.documentElement.setAttribute('data-theme',next)}
try{if(next==='auto')localStorage.removeItem('ds_theme');else localStorage.setItem('ds_theme',next)}catch(_){}
b.textContent=next==='auto'?'◐ AUTO':next==='dark'?'● DARK':'○ LIGHT'});
(function(){var b=document.querySelector('[data-theme-btn]');var c=document.documentElement.getAttribute('data-theme');if(b)b.textContent=c==='dark'?'● DARK':c==='light'?'○ LIGHT':'◐ AUTO'})();`;

/** Boutons thème + langue (la langue passe par /lang, qui pose un cookie et revient). */
const toolsHtml = (fixed = false) =>
  `<div class="tools${fixed ? ' toolsfix' : ''}"><button type="button" data-theme-btn title="Thème / Theme">◐ AUTO</button><a href="/lang?l=fr">FR</a><a href="/lang?l=en">EN</a></div>`;

const langOf = (cookieHeader) => (/(?:^|;\s*)ds_lang=en\b/.test(cookieHeader || '') ? 'en' : 'fr');

module.exports = { translate, langOf, LIGHT_CSS, THEME_BOOT, THEME_JS, toolsHtml, EN };
