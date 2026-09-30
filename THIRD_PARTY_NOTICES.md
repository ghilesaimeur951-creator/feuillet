# Composants tiers

Feuillet embarque les composants suivants, distribués sous leurs propres licences.

| Composant | Version | Emplacement | Licence | Source |
|---|---|---|---|---|
| pdf.js (Mozilla) | 4.10.38 | `public/vendor/pdfjs/` | Apache License 2.0 (`public/vendor/pdfjs/LICENSE`) | https://github.com/mozilla/pdf.js |
| tesseract.js-core (Tesseract OCR compilé en WebAssembly) | 7.0.0 | `public/vendor/tesseract/` | Apache License 2.0 (`public/vendor/tesseract/LICENSE`) | https://github.com/naptha/tesseract.js-core |
| Modèles tessdata_fast (fra, eng, spa, deu, ita) | 4.1 | `public/vendor/tessdata/` | Apache License 2.0 (`public/vendor/tessdata/LICENSE`) | https://github.com/tesseract-ocr/tessdata_fast |
| Preact | 10.29.8 | dépendance npm | MIT | https://github.com/preactjs/preact |

Les chasses de caractères Helvetica utilisées pour positionner la couche texte des PDF
(`src/core/pdf/helvetica-widths.ts`) ont été mesurées sur la police Liberation Sans
(SIL Open Font License), métriquement compatible ; la police elle-même n’est pas distribuée.

Le code de l’application de Tesseract (`src/services/ocr/engine.ts`) est une implémentation
originale qui s’inspire du fonctionnement documenté de tesseract.js (Apache 2.0).
