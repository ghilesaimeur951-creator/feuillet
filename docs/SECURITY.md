# Sécurité et confidentialité

## Modèle de menace

Feuillet manipule des documents potentiellement sensibles (identité, factures, contrats, fiches
de paie). Les risques principaux :

1. fuite de documents vers un tiers ;
2. fichiers importés malveillants (bombes ZIP, XML piégé, SVG avec script, PDF malformé) ;
3. perte de données (éviction du stockage, crash pendant un scan) ;
4. partage d’un PDF lisible par n’importe qui.

## Mesures

| Risque | Mesure |
|---|---|
| Fuite vers un tiers | Traitement **100 % local** (vision, filtres, OCR, PDF). Aucune API distante, aucun traceur, aucun compte. Les moteurs et modèles de langue sont servis par l’application. |
| Fuite silencieuse | **CSP** stricte : `default-src 'self'`, `connect-src 'self' blob: data:`, `script-src 'self' 'wasm-unsafe-eval'`, `object-src 'self' blob:`, `form-action 'none'`, `base-uri 'self'`. Le navigateur bloque toute requête vers un autre domaine. `Referrer-Policy: no-referrer`. |
| Fichiers malveillants | Type détecté par **octets magiques**, jamais par l’extension ; extension incohérente → refus. SVG, HTML, JS refusés. Limites : images 40 Mo / 60 Mpx, PDF 150 Mo, Office 60 Mo, texte 10 Mo. |
| Bombes ZIP | Taille décompressée **déclarée et réelle** vérifiées par entrée (256 Mo) et au total (512 Mo), nombre d’entrées (10 000), CRC contrôlé, archives chiffrées refusées. |
| Traversée de chemins | Noms `..`, absolus ou avec lecteur refusés à la restauration et à l’écriture ZIP. |
| XML piégé (XXE, *billion laughs*) | Parseur maison : DTD ignorées, seules les 5 entités standard et les références numériques sont décodées. |
| PDF malveillant | pdf.js récent (4.10) avec `isEvalSupported: false` (pas d’exécution de code des polices, cf. CVE-2024-4367), XFA désactivé, rendu dans un worker. |
| Noms de fichiers dangereux | `sanitizeFileName` : chemins retirés, caractères de contrôle et réservés, noms de périphériques Windows (`CON`, `NUL`…), points initiaux, longueur ≤ 120. |
| Injection dans l’interface | Rendu Preact (échappement systématique), aucun `innerHTML` avec des données utilisateur. |
| Partage d’un PDF | Chiffrement **AES-256** (PDF 2.0, révision 6) avec mot de passe à l’export. |
| Perte de données | IndexedDB + `navigator.storage.persist()` (demandé dès le premier document), session de scan sauvegardée à chaque capture et proposée à la reprise, corbeille de 30 jours, **sauvegarde/restauration ZIP**. |
| Secrets | Aucun secret n’existe ; la règle de lint `no-secrets` refuse les motifs de clés (AWS, GitHub, Google, clés privées). `.env` est ignoré par Git. |

## Données stockées

Uniquement dans le navigateur de l’appareil (IndexedDB de l’origine de l’application) :
documents (images, texte reconnu, métadonnées), dossiers, historique des actions, signatures
enregistrées, paramètres (`localStorage`). Effacer les données du site dans le navigateur
supprime tout.

## Limites

- Seuls les documents **verrouillés** sont chiffrés au repos ; les autres reposent sur la sécurité du
  système et du navigateur (session, chiffrement du disque, verrouillage de l’appareil).
- Document verrouillé (`src/core/security/vault.ts`) : PBKDF2-HMAC-SHA-256 (sel aléatoire de
  16 octets, 600 000 itérations) → AES-256-GCM, IV aléatoire de 96 bits par élément, identifiant du
  document en données authentifiées. Chiffrés : pages, OCR, notes, étiquettes, analyse, fichier
  original et toutes les images. En clair : titre, dossier, dates, favori, nombre de pages. Le mot
  de passe n’est jamais stocké ; pendant une ouverture temporaire il reste en mémoire jusqu’au
  reverrouillage. Les blobs chiffrés sont écrits avant la suppression des blobs en clair (aucune
  perte en cas d’interruption) ; l’effacement physique des anciens octets par le navigateur
  n’est pas garanti.
- L’en-tête `Permissions-Policy` et les en-têtes HTTP de sécurité dépendent de l’hébergeur (voir
  [DEPLOYMENT.md](DEPLOYMENT.md)) ; la CSP est déjà imposée par la balise `<meta>`.

## Signaler une vulnérabilité

Ouvrez une *issue* privée (*Security advisory*) sur le dépôt GitHub.
