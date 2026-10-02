# À table — suivi alimentaire

Un repas, plusieurs photos, un commentaire, puis **Envoyer**. Site statique personnel en français, conçu pour téléphone et GitHub Pages. Photos et JSON sont envoyés directement dans Google Drive.

## Utilisation

Ouvrir le site, prendre ou choisir les photos, éventuellement décrire chaque plat, puis envoyer. Un repas avec seulement du texte est aussi accepté. La date peut être corrigée pour un repas noté après coup. Le type de repas est proposé selon l’heure.

Le client Google public de `delzenneloic/tickets-de-caisses` est repris dans `config.js`. Il ne s’agit pas d’un secret. Le site utilise la portée `drive.file`, jamais un accès global au Drive. Les jetons restent en mémoire. Les repas ne sont pas enregistrés dans le dépôt GitHub.

## Organisation

```text
suivi_alimentation/
└── 2026.10/
    ├── 2026.10.02.12.30.00.125.json
    ├── 2026.10.02.12.30.00.125_1.jpg
    └── 2026.10.02.12.30.00.125_2.jpg
```

Horodatage de l’heure locale du **repas**, au format `yyyy.MM.dd.HH.mm.ss.fff`, en 24 heures. Le JSON contient l’identifiant unique du repas, le type, la date avec décalage UTC, le fuseau IANA, les dates de saisie et d’envoi demandé, le commentaire et les photos ordonnées (nom, ID Drive, description, format, taille). Les quantités restent en texte libre. Deux repas peuvent exceptionnellement avoir le même nom temporel ; leurs UUID et identifiants Drive les distinguent sans écrasement.

Le JSON est envoyé **en dernier**, lorsque toutes les photos sont confirmées. Son existence matérialise un repas complet. Les métadonnées sont figées au premier envoi ; les reprises réutilisent les identifiants préalloués. Le transport par blocs de 1 Mo reprend une session Drive encore valide. Un repas en cours d’envoi est lié au compte Google initial.

## Hébergement

1. Déposer ces fichiers dans un dépôt `suivi_alimentation`.
2. Dans **Settings → Pages**, choisir **Deploy from a branch**, branche `main`, dossier `/ (root)`.
3. Ouvrir `https://delzenneloic.github.io/suivi_alimentation/`.
4. Autoriser l’origine `https://delzenneloic.github.io` dans le client Google existant si nécessaire. Le chemin du dépôt ne fait pas partie de l’origine.

Aucune dépendance, compilation, clé API ou secret à installer. Ne jamais ajouter de photos personnelles ni d’accès Google au dépôt. Guide utilisateur : [installation.html](./installation.html).

## Vérifications locales

Node.js 20+ : `npm test`, puis `npm start` pour servir le site à `http://localhost:4173`. Les tests simulent Drive : classement, horodatage, ordre des photos/JSON, reprise après réponse perdue, absence de doublon, mauvais compte, expiration de connexion. Ils ne remplacent pas un premier envoi réel depuis l’origine Google autorisée.

Le stockage IndexedDB et le cache hors ligne sont isolés par chemin d’application. Une transaction atomique déplace le brouillon vers la file d’attente. Un verrou de navigateur évite l’écriture concurrente de deux onglets sur les navigateurs récents. Les brouillons ne survivent pas nécessairement à la suppression des données du navigateur. Garder l’application ouverte pendant les transferts.

Les dossiers de même nom sont réutilisés lorsqu’ils sont visibles à l’application. Deux appareils qui créent simultanément leur tout premier dossier peuvent produire deux dossiers de même nom, Drive n’imposant pas leur unicité. Effectuer le premier envoi sur un appareil avant de configurer le second.

À chaque mise à jour du site, augmenter la version `CACHE` dans `sw.js`. Fermer tous les onglets du journal puis rouvrir pour activer la nouvelle version. Les caches des autres applications ne sont pas modifiés.

## Références

- [Application de tickets d’origine](https://github.com/delzenneloic/tickets-de-caisses) : configuration Google et transport avec reprise adaptés dans `drive.js`.
- [Connexion Google](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
- [Portée drive.file](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Identifiants Drive préalloués](https://developers.google.com/workspace/drive/api/guides/create-file)
- [Envois avec reprise](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
