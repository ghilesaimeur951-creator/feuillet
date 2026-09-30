# Analyse de la spécification — Feuillet

Ce document répond à la section 1 de la spécification : analyse, difficultés, améliorations,
priorisation et choix d'architecture. Il a été rédigé **avant** l'implémentation et mis à jour à la fin.

## 1. Lecture critique

La spécification décrit trois produits imbriqués :

1. **Un scanner temps réel** (caméra → détection de quadrilatère → stabilisation → capture →
   homographie). C'est le cœur ; il conditionne toute l'expérience.
2. **Une chaîne documentaire** (filtres, multipage, PDF, OCR, conversions, export).
3. **Une GED personnelle** (bibliothèque, dossiers, tags, recherche plein texte, corbeille,
   historique, sauvegarde).

Le tout doit être local-first, installable (PWA), accessible, sans fausses fonctions.

## 2. Difficultés techniques identifiées

| Difficulté | Pourquoi c'est dur | Réponse retenue |
|---|---|---|
| Détection temps réel sur mobile | Le thread UI ne doit jamais bloquer ; OpenCV.js pèse 8–10 Mo (WASM) et met plusieurs secondes à s'initialiser sur un téléphone moyen. | Pipeline CV **écrit en TypeScript** (flou gaussien séparable, Canny, suivi de composantes, enveloppe convexe, ajustement de quadrilatère, score multi-critères) exécuté dans un **Web Worker** sur une image réduite (~360 px). ~15 Ko, démarre instantanément, testable de façon déterministe. |
| Faux positifs (tables, écrans, plusieurs rectangles) | Le plus grand contour n'est pas toujours la feuille. | Deux générateurs de candidats (contours Canny + segmentation par seuillage d'Otsu), score combinant aire, angles, rectangularité, **support d'arêtes** le long des 4 côtés, contraste intérieur/extérieur, centrage ; seuil minimal sinon « aucun document ». |
| Tremblement | Les coins varient de quelques pixels à chaque frame. | Stabilisateur temporel : association de coins, filtre exponentiel adaptatif (lissage fort si mouvement faible), hystérésis de confiance, mesure de stabilité exploitée par la capture auto. |
| Homographie | Ce n'est pas un recadrage de boîte englobante. | Résolution DLT 8×8 (élimination de Gauss avec pivot partiel), échantillonnage inverse bilinéaire, estimation du ratio réel de la feuille à partir des longueurs d'arêtes. |
| PDF conformes, recherchables, chiffrés | Les bibliothèques PDF du navigateur ne gèrent pas toutes le chiffrement. | **Writer PDF maison** (PDF 1.7) : JPEG embarqués en DCTDecode (pas de ré-encodage), couche texte OCR invisible (mode de rendu 3), chiffrement **AES-256 (R6)** via WebCrypto. Validé par `qpdf --check` et `pdftotext` dans les tests. |
| OCR hors ligne | Tesseract est lourd ; les CDN font fuiter des métadonnées. | Tesseract 5 (WASM, moteur LSTM) + modèles `tessdata_fast` **auto-hébergés** (fra, eng, spa, deu, ita). Aucun document ne quitte l'appareil. |
| Formats Office | Pas de LibreOffice dans un navigateur. | Lecteur ZIP natif (`DecompressionStream`) + `DOMParser` : DOCX, XLSX, PPTX convertis en pages réelles (texte mis en page, tableaux) avec texte indexé. Les formats binaires historiques DOC/XLS/PPT sont **refusés explicitement** (voir limitations). |
| Stockage volumineux et durable | `localStorage` est limité à ~5 Mo. | IndexedDB (métadonnées + blobs séparés), `navigator.storage.persist()`, sauvegarde/restauration ZIP. |
| iOS Safari | Pas de `OffscreenCanvas` avant 16.4, contraintes caméra, pas d'installation PWA automatique. | Détection de capacités + repli sur canvas principal ; documenté. |

## 3. Fonctionnalités manquantes / améliorations proposées

- Indicateurs qualité en direct : **flou** (variance du Laplacien), **sous-exposition**, **reflet** (pixels saturés dans le document).
- Capture auto avec anneau de progression et vibration.
- Estimation automatique du **ratio réel** de la page redressée.
- Loupe pendant le déplacement d'un coin + déplacement fin au clavier (flèches).
- **Nom automatique** à partir de l'OCR, **classification** (facture, reçu, contrat, relevé, identité…), **tags suggérés**.
- **Extraction structurée** facture/reçu (entreprise, n°, date, HT, TVA, TTC, devise).
- Détection de **pages blanches** et de **doublons** (empreinte perceptuelle dHash).
- Recherche **insensible aux accents** avec extraits surlignés.
- Undo/Redo dans l'éditeur de pages, autosave et **récupération de session de scan** après crash.
- Sauvegarde/restauration complète de la bibliothèque (ZIP).
- Raccourcis clavier desktop.

## 4. Priorisation

**Indispensables** (Definition of Done) : caméra, détection temps réel des 4 coins, overlay +
stabilisation, capture manuelle/auto, recadrage manuel, homographie, filtres, multipage + réordonnancement,
PDF réel, téléchargement/partage, bibliothèque persistante, dossiers, OCR, recherche plein texte.

**Importantes** : import images multiples/PDF/TXT, glisser-déposer, corbeille, favoris, tags, tri, vues
liste/grille, historique, thèmes, PWA hors ligne, export JPG/PNG/TXT, PDF recherchable, profils de compression.

**Avancées** : import DOCX/XLSX/PPTX, export DOCX, mot de passe PDF, signature, annotations, filigrane,
numérotation, fusion/séparation, extraction facture, classification, doublons, pages blanches, sauvegarde ZIP.

**Futures** : synchronisation cloud (l'abstraction est prête), mode livre double page avec correction de
courbure, OCR d'écriture manuscrite, formats binaires DOC/XLS/PPT (nécessite un service de conversion
côté serveur type LibreOffice headless), partage collaboratif.

## 5. Architecture retenue (résumé)

- **TypeScript strict** partout.
- **Preact 10** (API React, 4 Ko) : l'application doit se charger vite sur mobile, et la logique métier
  vit en dehors des composants.
- **Bun** : bundler, serveur de dev et runner de tests en un seul outil, rapide et sans configuration.
- `src/core/` : logique pure, sans DOM, testée unitairement (géométrie, CV, imagerie, PDF, ZIP,
  Office, recherche, OCR post-traitement, sécurité, modèle documentaire).
- `src/services/` : glue navigateur (IndexedDB, caméra, workers, pdf.js, partage, impression).
- `src/workers/` : vision temps réel, traitement d'image lourd, OCR.
- `src/ui/` : écrans et composants.

Détail dans [ARCHITECTURE.md](./ARCHITECTURE.md).

## 6. Bilan de réalisation

| Priorité | Fonctionnalité | État |
|---|---|---|
| Indispensable | Caméra, détection temps réel des 4 coins, overlay, stabilisation | ✅ |
| Indispensable | Capture manuelle et automatique | ✅ |
| Indispensable | Recadrage manuel (loupe, clavier, Auto, Réinitialiser, rotation) | ✅ |
| Indispensable | Homographie / correction de perspective | ✅ |
| Indispensable | Filtres et réglages | ✅ |
| Indispensable | Multipage, réordonnancement (glisser-déposer) | ✅ |
| Indispensable | PDF réel, téléchargement, partage | ✅ |
| Indispensable | Bibliothèque persistante, dossiers | ✅ |
| Indispensable | OCR, recherche plein texte sur le contenu | ✅ |
| Importante | Import images multiples, PDF, TXT, glisser-déposer | ✅ |
| Importante | Corbeille, favoris, étiquettes, tri, vues liste/grille, historique | ✅ |
| Importante | Thèmes, PWA hors ligne, exports JPG/PNG/TXT, PDF recherchable, profils | ✅ |
| Avancée | Import DOCX/XLSX/PPTX, export DOCX | ✅ |
| Avancée | Mot de passe PDF (AES-256), signature, annotations, filigrane, numérotation | ✅ |
| Avancée | Fusion, division, extraction, pages blanches, doublons | ✅ |
| Avancée | Classification, extraction facture/reçu, nom et étiquettes automatiques | ✅ |
| Avancée | Orientation automatique, sauvegarde/restauration, reprise après interruption | ✅ |
| Future | Synchronisation cloud / multi-appareils | ⏳ abstraction prête |
| Future | Correction de courbure (livres) | ⏳ |
| Future | Coffre chiffré dans l’application | ⏳ (protection au niveau du PDF) |
| Future | Formats binaires DOC/XLS/PPT, HEIC, TIFF | ⏳ nécessite un service de conversion ou des décodeurs dédiés |
| Future | Écriture manuscrite, « partager vers Feuillet » (Web Share Target) | ⏳ |

Écart assumé par rapport à la spécification : **OpenCV.js n’est pas utilisé**. Le pipeline de
vision a été écrit en TypeScript (≈ 15 Ko dans le worker, démarrage instantané) ; sa précision
est mesurée contre la chaîne OpenCV classique dans les tests et lui est supérieure sur nos scènes.
