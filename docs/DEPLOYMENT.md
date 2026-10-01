# Déploiement

`bun run build` produit `dist/`, un site statique autonome :

```
dist/
  index.html            coquille (CSP incluse)
  sw.js                 service worker (hors ligne)
  manifest.webmanifest  PWA
  assets/               application (hachée) + workers (cv, processing, ocr)
  icons/
  vendor/               pdf.js, Tesseract WASM, modèles de langue (≈ 25 Mo, chargés à la demande)
```

Tous les chemins sont **relatifs** : le site fonctionne à la racine d’un domaine comme dans un
sous-dossier (ex. `https://utilisateur.github.io/feuillet/`). Le routage utilise le fragment
(`#/…`) : aucune règle de réécriture n’est nécessaire.

**HTTPS est obligatoire** pour la caméra, le service worker et WebCrypto (sauf `localhost`).

## GitHub Pages

Le workflow `.github/workflows/deploy.yml` construit et publie `dist/` à chaque push sur `main`.

1. *Settings → Pages → Build and deployment → Source* : **GitHub Actions**.
2. Poussez sur `main` ; l’URL apparaît dans l’onglet *Actions* (job *deploy*).

(GitHub Pages sur un dépôt privé nécessite un compte payant ; sinon rendez le dépôt public ou
utilisez Netlify / Cloudflare Pages.)

## Application Android (APK)

`.github/workflows/android.yml` : `bun run build:android` (build web copié dans
`android/app/src/main/assets/www`, sans `sw.js`), `gradle -p android assembleRelease
assembleDebug`, vérification `apksigner`, test sur émulateur, puis publication de
`feuillet-X.Y.Z.apk` dans la release `vX.Y.Z` (version de `package.json`) à chaque push sur `main`. Signature : voir la section
*Application Android* du README (clé publique par défaut, secrets `ANDROID_*` pour une clé
privée).

## Netlify, Cloudflare Pages, Vercel

- Commande de build : `bun run build` (Bun est disponible sur ces plateformes ; sinon
  `npm i -g bun && bun install && bun run build`).
- Dossier publié : `dist`.

En-têtes recommandés (Netlify `_headers` / Cloudflare) :

```
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(self), microphone=(), geolocation=()
/sw.js
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
/assets/*
  Cache-Control: public, max-age=31536000, immutable
```

## Nginx

```nginx
server {
  listen 443 ssl http2;
  server_name scan.example.org;
  root /var/www/feuillet/dist;

  types { application/wasm wasm; application/manifest+json webmanifest; text/javascript mjs; }
  location ~* \.traineddata$ { default_type application/octet-stream; }

  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy no-referrer always;
  add_header Permissions-Policy "camera=(self), microphone=(), geolocation=()" always;

  location = /sw.js      { add_header Cache-Control "no-cache"; }
  location = /index.html { add_header Cache-Control "no-cache"; }
  location /assets/      { add_header Cache-Control "public, max-age=31536000, immutable"; }

  gzip on;
  gzip_types text/javascript application/javascript text/css application/json application/wasm application/octet-stream;
}
```

## Mise à jour

Chaque build a un identifiant (empreinte des fichiers de la coquille) : le nouveau service worker
remplace l’ancien cache à l’activation. Les moteurs `vendor/` gardent leur propre cache (changez le
nom du cache dans `src/sw.template.js` si vous mettez à jour pdf.js ou Tesseract).

## Mettre à jour les moteurs embarqués

- **pdf.js** : télécharger `pdfjs-<version>-dist.zip` depuis
  <https://github.com/mozilla/pdf.js/releases>, copier `build/pdf.mjs`, `build/pdf.worker.mjs`,
  `web/cmaps/`, `web/standard_fonts/` dans `public/vendor/pdfjs/`.
- **Tesseract** : copier `tesseract-core-simd-lstm.wasm.js` et `tesseract-core-lstm.wasm.js`
  depuis <https://github.com/naptha/tesseract.js-core> dans `public/vendor/tesseract/`.
- **Langues** : ajouter `<code>.traineddata` depuis <https://github.com/tesseract-ocr/tessdata_fast>
  dans `public/vendor/tessdata/` et déclarer la langue dans `src/services/config.ts`.
