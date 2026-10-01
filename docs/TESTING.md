# Tests

```bash
bun run test        # tests unitaires (Bun)
bun run typecheck   # TypeScript strict : application, tests, scripts
bun run lint        # règles du projet + Prettier
bun run test:e2e    # build + tests de bout en bout (Playwright / Chromium)
```

Outils optionnels utilisés par certains tests lorsqu’ils sont présents (sinon la vérification
correspondante est ignorée, jamais simulée) : `qpdf`, `pdfinfo`, `pdftotext` (poppler-utils),
`unzip`, `python3` + OpenCV (comparaison de précision). Les tests de bout en bout nécessitent
`ffmpeg` (conversion du flux caméra simulé en Y4M) et Chromium (`npx playwright install chromium`).

## Tests unitaires (127)

| Fichier | Couverture |
|---|---|
| `geometry.test.ts` | classement des 4 coins (24 permutations, rotation 40°, trapèze), enveloppe convexe, angles, convexité, intersections, ajustement de droite, rotations ; homographie (4 correspondances exactes, alignement projectif, inverse, cas dégénéré), taille de sortie et aimantation A4 |
| `detect.test.ts` | détection sur les 11 scènes de la section 31 (+ scène vide) avec vérité terrain ; précision ≤ 0,6 % de la diagonale ; **comparaison avec la chaîne OpenCV** de référence |
| `detect-random.test.ts` | **81 scènes aléatoires** (angles, perspective, contraste 45–150 niveaux, textures, flou, bruit) : 0 échec, erreur médiane 0,74 px ; performance |
| `warp-quality.test.ts` | redressement d’un damier projeté (vérification case par case), différence avec un recadrage de boîte englobante, chaîne détection → redressement réelle ; netteté/flou, faible luminosité, reflet (et non-reflet d’une page surexposée) |
| `stabilizer.test.ts` | réduction du tremblement, rejet d’un saut isolé, suivi d’un déplacement confirmé, perte du document (pas de contour inventé), stabilité ; capture automatique (déclenchement, pas de double capture de la même page, blocage si flou/partiel, mode manuel) |
| `filters.test.ts` | suppression d’ombre (gradient mesuré avant/après), N&B binaire avec texte conservé, gris, chaque préréglage modifie réellement l’image, réglages manuels, réduction du bruit ; pages blanches, doublons (dHash), orientation du texte |
| `pdf.test.ts` | mise en page (A4, Letter, auto, orientation), estimation de taille, WinAnsi, en-têtes JPEG ; PDF multipage **validé par qpdf**, dimensions (pdfinfo), **couche OCR extraite par pdftotext** ; **AES-256** : mauvais mot de passe refusé, bon mot de passe accepté, déchiffrement et texte |
| `office.test.ts` | ZIP (aller-retour, CRC, interopérabilité `unzip`, traversée de chemins, bombe ZIP), XML (entités, CDATA, DOCTYPE ignoré), **DOCX / XLSX / PPTX / TXT** réels (générés par LibreOffice), coupure de lignes et pagination |
| `search.test.ts` | normalisation, requêtes, **« facture EDF » retrouve « Scan 27 » par son OCR**, accents, tags/dossier/notes/titre/type, dates, préfixes, fautes, ET logique, expressions exactes, filtres, extraits surlignés |
| `ocr-analysis.test.ts` | TSV Tesseract, montants FR/EN, dates (4 formats), classification (dont faux positif évité), extraction facture et reçu, titre et étiquettes suggérés |
| `ocr-engine.test.ts` | **OCR réel** avec le WASM et les modèles embarqués : facture française (texte, positions, confiance, classification, montant TTC), allemand/italien/espagnol, erreurs |
| `model-security.test.ts` | opérations de pages (ajout, suppression, déplacement, duplication, remplacement, rotation, filtres), fusion avec OCR concurrent, annuler/rétablir, dossiers ; validation des imports (octets magiques, extension mensongère, formats refusés, limites, OOXML), noms de fichiers dangereux |
| `vault.test.ts` | AES-GCM (aller-retour, mauvais mot de passe, mauvais document, altération, IV aléatoire), verrouillage : **plus aucun octet du secret dans le stockage**, recherche masquée, mauvais mot de passe sans effet, déverrouillage complet (images, signature, fichier original, types MIME), persistance, écritures concurrentes neutralisées, ouverture temporaire, sauvegarde chiffrée |
| `library.test.ts` | persistance (fermer/rouvrir), recherche OCR, renommage/étiquettes/notes/favoris/historique, corbeille et purge des blobs, purge à 30 jours, duplication, dossiers (cycle, suppression récursive, restauration), ramasse-miettes, **sauvegarde/restauration ZIP**, **écritures concurrentes sans perte**, paramètres |

## Cas de test de vision (section 31)

Scènes générées par `scripts/gen_cv_fixtures.py` (OpenCV : papier avec texte, table texturée,
perspective réelle, ombre portée, flou et bruit de capteur, puis réduction à 480×360).
Erreur = distance maximale d’un coin à la vérité terrain.

| Cas | Résultat Feuillet | Erreur Feuillet | Erreur OpenCV classique |
|---|---|---|---|
| Feuille blanche sur table sombre | détecté | 0,8 px | 1,4 px |
| Feuille sur table claire (faible contraste) | détecté | 1,3 px | 1,4 px |
| Document incliné | détecté | 0,7 px | 1,5 px |
| Forte perspective | détecté | 1,1 px | 3,2 px |
| Ombre sur la feuille | détecté | 0,8 px | 1,4 px |
| Document partiellement hors cadre | détecté **et signalé partiel** (pas de capture auto) | — | non détecté |
| Feuille A4 de face | détecté | 0,7 px | 1,4 px |
| Reçu étroit | détecté | 0,8 px | 1,5 px |
| Page de livre (crème, ombre de reliure) | détecté | 0,8 px | 1,4 px |
| Faible luminosité (gain × 0,38, bruit) | détecté | 0,9 px | 1,4 px |
| Plusieurs rectangles visibles | **document principal choisi** | 0,8 px | 1,4 px |
| Aucun document | aucun contour inventé | — | — |

Quand l’automatisme échoue (reflet massif, bords invisibles), l’écran de recadrage permet de
placer les quatre coins manuellement (souris, doigt avec loupe, ou clavier).

## Tests de bout en bout (8 scénarios)

`tests/e2e/app.spec.ts`, Chromium en émulation Pixel 7, **caméra simulée** : un flux vidéo
(`tests/fixtures/e2e/document.mjpeg`, généré par `scripts/gen_e2e_video.py`) montre une facture
fictive posée en perspective sur une table, avec un léger tremblement de la main.

1. **Definition of Done** — ouverture du scanner, autorisation caméra, *Document détecté*,
   quadrilatère de 4 points affiché, deux captures manuelles en mode multipage, recadrage
   (déplacement d’un coin au clavier), redressement, 2 pages, **réorganisation**, **filtre N&B**,
   **OCR automatique** (2/2 pages) et nommage « Facture… », **export PDF** téléchargé (2 pages,
   `%PDF-1.7`, texte extrait par `pdftotext`), **fermeture/réouverture** (persistance),
   **classement dans un nouveau dossier**, **recherche sur le contenu OCR** (« numero client 4471 »)
   et sur le nom du dossier.
2. **Capture automatique** en mode Document → écran de recadrage sans action de l’utilisateur.
3. **Import** PDF, DOCX, XLSX, PPTX, TXT (5 documents) et refus explicite d’un `.doc` binaire ;
   texte importé immédiatement recherchable.
4. **Glisser-déposer** de deux photos → un document multipage redressé.
5. Corbeille et restauration, favoris, **thème sombre**, **audit d’accessibilité** (chaque contrôle
   interactif a un nom accessible) sur 5 écrans.
6. **Signature dessinée** insérée sur une page (vignette régénérée), exports **Word**, **JPG** et
   **PDF chiffré AES-256**.
7. **Page importée à l’envers** : orientation corrigée automatiquement par l’OCR, contenu
   recherchable.
8. **Document verrouillé** : verrouillage par mot de passe (saisi deux fois), contenu absent de la
   recherche, persistance après rechargement, mauvais mot de passe refusé, ouverture temporaire,
   **reverrouillage automatique** en quittant, retrait définitif du verrou.

## Résultats (dernière exécution)

- Type-check : OK (0 erreur).
- Lint : OK (116 fichiers).
- Tests unitaires : **127 / 127**.
- Tests de bout en bout : **8 / 8**.
