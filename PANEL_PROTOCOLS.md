# DARK SURF — panneau de contrôle des protocoles

Après déploiement et connexion avec le compte administrateur, ouvrir **Protocoles VPN** dans la navigation Admin (`/admin/protocols`).

Le panneau permet de choisir le protocole distribué par l'API aux clients : VLESS, SSH-WS ou SSH-TCP, d'activer/désactiver SSH, et de régler le port TCP, le chemin WebSocket et la clé hôte.

**Le client n'a aucun réglage.** Le protocole choisi ici est essayé en premier ; si la connexion échoue, l'appli passe toute seule aux suivants (VLESS/WS, REALITY, SSH-WS, SSH-TCP), dans l'ordre donné par le serveur (champ `attempts` de la réponse `/session`).

Les paramètres sont conservés dans SQLite (`app_settings`) et appliqués au démarrage du serveur. Après toute modification, redémarrer le service :

```bash
sudo systemctl restart darksurf darksurf-sshd
```

Prérequis SSH : l'installation VPS configure `darksurf-sshd`, le compte système restreint et `SSH_PASSWORD_SECRET` dans `/root/darksurf-server/.env`. Les protocoles SSH ne doivent être activés qu'après ouverture des ports choisis dans le pare-feu et vérification de leur disponibilité. VLESS reste le mode par défaut à la première installation.

Le choix du protocole est centralisé : l'application ne présente pas de réglage utilisateur. Elle reçoit le profil attribué par l'API lors de la session.
