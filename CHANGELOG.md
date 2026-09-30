# Journal des modifications

## 1.0.0 — 2026-09-30

Première version.

- Scanner caméra : détection temps réel des quatre coins (pipeline de vision TypeScript en worker,
  raffinement sous-pixel), stabilisation, capture automatique, modes Document / Multipage / Carte /
  Livre / Tableau / Photo / Reçu, indicateurs de flou, d’obscurité, de reflet et de document hors
  cadre, lampe.
- Recadrage manuel avec loupe et clavier, correction de perspective par homographie.
- Filtres Original, Auto, Document, Couleur+, N&B, Gris et réglages manuels ; orientation
  automatique.
- Documents multipages : réorganisation par glisser-déposer, rotation, duplication, rescannage,
  remplacement, annuler/rétablir ; annotations et signature.
- PDF réels (recherchables, AES-256, filigrane, numérotation, profils de compression), exports
  JPG/PNG/TXT/DOCX, partage et impression.
- Import photos, PDF, DOCX, XLSX, PPTX, TXT.
- OCR Tesseract hors ligne (fr, en, es, de, it), classification, extraction de factures, nommage
  automatique, recherche plein texte.
- Bibliothèque, dossiers, étiquettes, favoris, corbeille, historique, sauvegarde/restauration.
- PWA hors ligne, thèmes clair/sombre, accessibilité.
