# Architecture

## Vue d’ensemble

```
┌──────────────────────────── Navigateur (PWA) ─────────────────────────────┐
│                                                                           │
│  UI (Preact)  src/ui, src/app                                             │
│   écrans ─ composants ─ routeur (hash) ─ état (stores + hooks)            │
│        │                                                                  │
│        ▼                                                                  │
│  Services  src/services            (glue navigateur, sans logique métier) │
│   Library ─ StorageAdapter(IndexedDB)   Camera   importer / exporter      │
│   pages (rendu)   ocr-runner   pdfjs   signatures   settings              │
│        │                 │                  │                             │
│        ▼                 ▼                  ▼                             │
│  Workers  src/workers                                                     │
│   cv.worker ─ détection temps réel       processing.worker ─ redressement │
│   ocr.worker ─ Tesseract WASM            filtres, encodage, analyse       │
│        │                                                                  │
│        ▼                                                                  │
│  Cœur  src/core     (TypeScript pur, sans DOM, entièrement testé)         │
│   cv  geometry  imaging  pdf  office  ocr  search  docs  security  zip    │
└───────────────────────────────────────────────────────────────────────────┘
          IndexedDB (documents, dossiers, historique, paramètres, blobs)
```

Principes :

- **Le cœur est pur** : aucune dépendance au DOM, aux canvas ou à IndexedDB. Toute la logique
  (vision, géométrie, PDF, Office, recherche, OCR post-traitement, validation) est testée sous Bun.
- **Les services font la glue** (canvas, workers, IndexedDB, caméra) et exposent des fonctions
  simples aux écrans.
- **Les écrans ne contiennent pas de logique métier** : ils appellent `app/actions.ts` ou les
  services.
- **Rien de lourd sur le thread principal** : vision et traitement d’image dans des workers ;
  pdf.js et Tesseract chargés à la demande.

## Chaîne de vision (temps réel)

Fichiers : `src/core/cv/*`, `src/workers/cv.worker.ts`, `src/ui/screens/ScannerScreen.tsx`.

```
vidéo caméra (jusqu’à 4K)
 └─ image d’analyse réduite (côté long 360 px, ~15 i/s, une image en vol à la fois)
     └─ worker : niveaux de gris → flou gaussien σ=1,3
         ├─ Canny adaptatif (seuils par quantile du gradient ; 2ᵉ passage plus sensible si besoin)
         │   └─ fermeture 3×3 → composantes 8-connexes → contours (extrêmes ligne/colonne)
         ├─ Otsu → régions claires (papier sur fond sombre) et sombres (carte sur fond clair)
         └─ pour chaque candidat : enveloppe convexe → réduction à 4 sommets (Visvalingam)
             → raffinement des côtés par droites ajustées → score :
                 aire · angles · support d’arêtes (min/moyenne des 4 côtés)
                 · contraste intérieur/extérieur · remplissage · centrage · (partiel ?)
             → meilleur candidat ≥ seuil → raffinement sous-pixel (maxima du gradient le long
               des normales, interpolation parabolique, droite robuste, intersections)
     └─ qualité : variance du laplacien (netteté), luminance, reflets (saturation / papier)
 └─ thread principal : stabilisateur temporel (filtre exponentiel adaptatif, rejet des sauts
    isolés, perte après 450 ms) → contrôleur de capture automatique (stable ≥ 900 ms, net,
    non partiel ; attend un changement de scène après une capture) → overlay SVG interpolé à
    60 i/s (viewBox = image d’analyse, `preserveAspectRatio="slice"` = `object-fit: cover`)
```

À la capture : photo pleine résolution (`ImageCapture.takePhoto()` si disponible et de même
cadrage, sinon image vidéo pleine résolution), coins remis à l’échelle puis **re-détectés** sur
une version 640 px de la photo (acceptés s’ils concordent à 3 % près).

Mesures (tests) : erreur médiane **0,74 px**, 90ᵉ centile **0,88 px**, maximum **1,43 px** sur
81 scènes aléatoires 360×270 ; aucune scène manquée ; ≈ **25 ms** par image sur un poste de
développement. Sur les 11 scènes de référence, erreur moyenne inférieure à celle de la chaîne
OpenCV classique (`scripts/opencv_baseline.py`).

## Redressement et filtres

`src/services/processing/handlers.ts` (worker) :

1. décodage (orientation EXIF appliquée, plafonné à 4096 px) ;
2. homographie **DLT** (système 8×8, pivot partiel) des 4 coins vers le rectangle cible, taille
   estimée par les arêtes opposées et aimantée aux formats A4 / Letter / carte ;
3. échantillonnage **inverse bilinéaire** (évaluation incrémentale le long des lignes) ;
4. filtre (`src/core/imaging/filters.ts`) : estimation de l’éclairage (réduction, filtre max,
   flou, sur-échantillonnage) → division (ombres supprimées, fond blanchi) → courbe de tons,
   niveaux automatiques, balance des blancs, Sauvola, masque flou, filtre de Lee ;
5. rotation par quarts de tour, encodage JPEG (`OffscreenCanvas.convertToBlob`), vignette,
   empreinte **dHash** (doublons), détection de page blanche.

Chaque page conserve son **original** : recadrage, filtre et rotation sont toujours recalculés à
partir de l’original (pas de perte cumulée), et les aperçus de filtre réutilisent l’image
redressée en cache.

## Modèle de données et stockage

`src/core/docs/model.ts`, `src/services/library.ts`, `src/services/storage/*`.

- `DocumentRecord` : id, titre, dossier, étiquettes, notes, favori, dates (création, modification,
  ouverture, suppression), pages, source, fichier original, taille, type détecté, données de
  facture, **révision**.
- `Page` : original (id de blob + taille), quadrilatère, rotation, filtre, réglages, image traitée,
  vignette, annotations vectorielles (coordonnées normalisées), OCR (texte, mots positionnés,
  confiance), texte importé, empreinte, page blanche.
- `Folder` (arborescence par `parentId`, corbeille), `HistoryEntry` (≤ 500 entrées).
- **IndexedDB** : magasins `documents`, `folders`, `history`, `settings`, `blobs` (stockés en
  `ArrayBuffer` + type, la représentation la plus robuste sous Safari).
- `StorageAdapter` abstrait le stockage : un adaptateur mémoire sert aux tests et de repli ; un
  futur adaptateur de synchronisation (serveur, WebDAV, cloud) peut s’y brancher. Les numéros de
  révision et les dates de modification permettent la résolution de conflits (déjà utilisés par
  la restauration de sauvegarde).
- **Écritures sérialisées par document** (`Library.updateDocument`) : les modifications
  concurrentes (OCR en arrière-plan pendant qu’on change un filtre) s’appliquent toujours sur la
  dernière version ; l’OCR obtenu entre-temps est conservé si la géométrie de la page n’a pas
  changé (`mergeConcurrentPage`).
- Ramasse-miettes des blobs orphelins au démarrage (jamais ceux d’un scan en cours ni des
  signatures enregistrées). Purge automatique de la corbeille après 30 jours.
- Index de recherche en mémoire reconstruit au chargement (quelques milliers de documents sans
  problème).

## PDF

`src/core/pdf/*` — writer PDF 1.7 :

- images **JPEG embarquées telles quelles** (`/DCTDecode`, gris/RVB/CMJN) ;
- flux de contenu compressés (Flate via `CompressionStream`) ;
- **couche OCR invisible** : chaque mot est placé avec `Tf`, `Tz` (échelle horizontale calculée
  avec les chasses Helvetica) et le mode de rendu `3 Tr` → sélection et recherche dans tout
  lecteur PDF ;
- filigrane (état graphique avec opacité), numéros de page ;
- chiffrement **AES-256, révision 6** (algorithme 2.B, `/Perms`, `/OE`, `/UE`) avec WebCrypto ;
- validé par `qpdf --check`, `pdfinfo`, `pdftotext` et le déchiffrement `qpdf --password`.

Import : **pdf.js** (worker dédié, `isEvalSupported: false`), rendu à ~200 dpi et extraction des
mots positionnés de la couche texte.

## OCR

`src/services/ocr/*`, `src/workers/ocr.worker.ts`, `src/services/ocr-runner.ts`.

- `OcrEngine` pilote directement l’API C++ de Tesseract compilée en WASM
  (`tesseract.js-core` 7, variante SIMD si disponible, moteur LSTM) : écriture des modèles et de
  l’image dans le système de fichiers Emscripten, `Init`, `Recognize`, sortie **TSV** analysée en
  mots positionnés. Le même code est testé sous Bun avec les vrais modèles.
- Worker classique (importScripts), file d’attente, modèles mis en cache (`Cache Storage`).
- Post-traitement : classification, extraction facture, nom et étiquettes suggérés,
  **orientation automatique** (si la confiance est faible : direction des lignes par profils de
  projection, puis rotations candidates comparées par Tesseract).

## Import Office

`src/core/zip`, `src/core/office` : lecteur ZIP (`DecompressionStream('deflate-raw')`, CRC,
limites anti-bombe), parseur XML minimal (sans DTD ni entités externes), extraction DOCX (styles
de titres, listes via `numbering.xml`, gras/italique, tableaux, images, sauts de page), XLSX
(chaînes partagées, dates via les styles, booléens), PPTX (ordre des diapositives, titres,
puces, tableaux, images). Le moteur de mise en page (`layout.ts`) pagine ce modèle en A4 à
150 dpi avec une fonction de mesure injectée (canvas dans le navigateur) et produit les mots
positionnés.

## Hors ligne

`src/sw.template.js` → `dist/sw.js` : coquille applicative précachée (versionnée par empreinte du
build), navigation réseau d’abord avec repli, moteurs `vendor/` en cache au premier usage,
aucune requête externe.

## Sécurité

Voir [SECURITY.md](SECURITY.md).
