# Contrat d'API (v2 — Xray)

Base : `https://<ton-domaine>/api/v1/` — POST JSON, HTTPS obligatoire.

| Endpoint | Corps | Réponse |
|---|---|---|
| `enroll` | `code, signing_key` (SPKI DER b64), `label`, `signature` | `{device_id}` |
| `challenge` | `device_id` | `{challenge, message}` |
| `session` | `device_id, challenge, signature, network` | `{token, expires_at, profile}` |

- `enroll` : signature ECDSA (SHA-256, DER) de `"Tunnel/activate/v2\n<code>\n<signing_key>"`. Code à usage unique.
- `session` : signature du `message` reçu. Le challenge est à usage unique, valable 60 s.
- `plan` (optionnel) : `name, quota_bytes` (absent = illimité), `used_bytes, expires_at` (epoch s). Affiché sur l'accueil.
- `profile` : `protocol:"vless", address, port, uuid, network:"ws", path, tls:true, sni, dns`.
  Le serveur attribue l'UUID et l'ajoute à Xray à la session ; il est retiré à l'expiration.

Erreurs : 401 non reconnu · 403 interdit (`invalid_code`, `device_limit`, `plan_expired`, `quota_exceeded`, `outside_window`) · 429 rate limit · 5xx occupé · autre 4xx refusé.

## Mise à jour de l'appli
`POST app/android` `{version_code}` → `{update:false}` ou
`{update:true, version_code, version_name, url, sha256, size, notes, required}`.
`url` est un lien HTTPS `/downloads/darksurf-<code>.apk` sur le même hôte que l'API ; l'appli vérifie `sha256`, la taille
et la signature avant d'installer. `required` : mise à jour bloquante.

## POST /protocols
Corps : `{device_id, challenge, signature}` (même défi signé que /session ; n'ouvre jamais l'accès).
Réponse : `{now, engine:"xray", dns, default, protocols:[...]}`.

Chaque entrée de `protocols` décrit un protocole **réellement activé** sur le VPS :

| Champ | Sens |
|---|---|
| `id` | identifiant (`vless-ws`, `vless-reality`, `vless-kcp`, `vless-tcp`, `vmess-ws`, `trojan-ws`, `shadowsocks`, `socks5`, `http-proxy`, `hysteria2`, `tuic`, `wireguard`) |
| `label`, `family`, `transport`, `security` | libellé et caractéristiques, pour l'affichage |
| `host`, `port` | adresse et port à joindre |
| `app` | `true` si le moteur embarqué dans l'application (Xray-core) sait monter ce protocole |
| `reason` | si `app:false`, explication à afficher à l'utilisateur |
| `outbound` | si `app:true`, l'objet outbound Xray complet, prêt à être inséré dans la configuration du noyau |

`default` est l'identifiant à présélectionner. Les protocoles servis par sing-box
(`hysteria2`, `tuic`, `wireguard`) sont renvoyés avec `app:false` et `outbound:null` :
l'application les affiche comme non supportés au lieu d'échouer à la connexion.

## POST /status
Corps : `{device_id, challenge, signature, since_notice?}` (même défi signé que /session ; n'ouvre jamais l'accès).
Réponse : `{state: active|expired|quota_exceeded|revoked|disabled|outside_window, now, plan:{name, quota_bytes?, used_bytes, expires_at, window?:{start,end}}, notices:[{id,title,body,created_at}]}`.
Sert aux notifications de l'appli. Aucune information de prix n'est jamais renvoyée au client.


## POST /session — champ `attempts` (V11)
La réponse contient `attempts` : liste ordonnée des connexions que l'appli doit essayer, de la première à la dernière.
Chaque entrée : `{id, kind:"xray", outbound:{...}}` (outbound Xray prêt à monter) ou `{id:"ssh-ws"|"ssh-tcp", kind:"ssh"}` (identifiants dans `profile.ssh`).
Le premier élément est le protocole choisi par l'administrateur. L'utilisateur n'a aucun choix : `/protocols` reste disponible pour le panel mais l'appli ne l'utilise plus.
