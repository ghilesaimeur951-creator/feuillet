/** Validation of imported files: real content sniffing, size limits and safe file names. */

export type SniffedType = 'jpeg' | 'png' | 'webp' | 'gif' | 'bmp' | 'heic' | 'tiff' | 'pdf' | 'zip' | 'ole' | 'svg' | 'text' | 'unknown';

export function sniffType(bytes: Uint8Array): SniffedType {
  const b = (i: number) => bytes[i] ?? -1;
  const ascii = (start: number, s: string) => [...s].every((c, i) => b(start + i) === c.charCodeAt(0));
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'jpeg';
  if (b(0) === 0x89 && ascii(1, 'PNG')) return 'png';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'webp';
  if (ascii(0, 'GIF8')) return 'gif';
  if (ascii(0, 'BM') && bytes.length > 26) return 'bmp';
  if (ascii(4, 'ftyp') && (ascii(8, 'heic') || ascii(8, 'heix') || ascii(8, 'mif1') || ascii(8, 'heif'))) return 'heic';
  if ((ascii(0, 'II') && b(2) === 42 && b(3) === 0) || (ascii(0, 'MM') && b(2) === 0 && b(3) === 42)) return 'tiff';
  // PDF header may be preceded by up to 1024 bytes of junk (allowed by the spec).
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  if (head.includes('%PDF-')) return 'pdf';
  if (b(0) === 0x50 && b(1) === 0x4b && (b(2) === 3 || b(2) === 5) && (b(3) === 4 || b(3) === 6)) return 'zip';
  if (b(0) === 0xd0 && b(1) === 0xcf && b(2) === 0x11 && b(3) === 0xe0) return 'ole';
  if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg';
  if (looksLikeText(bytes.subarray(0, 4096))) return 'text';
  return 'unknown';
}

function looksLikeText(sample: Uint8Array): boolean {
  if (sample.length === 0) return true;
  let control = 0;
  for (const c of sample) {
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32 && c !== 27)) control++;
  }
  return control / sample.length < 0.02;
}

export type ImportKind = 'image' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'txt';

export interface ImportLimits {
  maxImageBytes: number;
  maxPdfBytes: number;
  maxOfficeBytes: number;
  maxTextBytes: number;
  maxImagePixels: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxImageBytes: 40 * 1024 * 1024,
  maxPdfBytes: 150 * 1024 * 1024,
  maxOfficeBytes: 60 * 1024 * 1024,
  maxTextBytes: 10 * 1024 * 1024,
  maxImagePixels: 60_000_000,
};

export class ImportError extends Error {
  constructor(
    message: string,
    readonly code: 'too-large' | 'unsupported' | 'mismatch' | 'legacy-office' | 'empty' | 'dangerous',
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

function ext(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

const MB = (n: number) => `${Math.round(n / 1024 / 1024)} Mo`;

/**
 * Decides how a file must be imported from its actual bytes (never from the extension alone),
 * checks the size limits and rejects dangerous or unsupported formats with a clear message.
 * `zipKind` must be supplied for ZIP containers after inspecting [Content_Types].xml.
 */
export function classifyImport(name: string, bytes: Uint8Array, zipKind?: 'docx' | 'xlsx' | 'pptx' | null, limits: ImportLimits = DEFAULT_IMPORT_LIMITS): ImportKind {
  if (bytes.length === 0) throw new ImportError(`« ${name} » est vide.`, 'empty');
  const sniffed = sniffType(bytes);
  const e = ext(name);
  switch (sniffed) {
    case 'jpeg':
    case 'png':
    case 'webp':
    case 'gif':
    case 'bmp':
      if (bytes.length > limits.maxImageBytes) throw new ImportError(`Image trop volumineuse (max ${MB(limits.maxImageBytes)}).`, 'too-large');
      return 'image';
    case 'heic':
      throw new ImportError('Les photos HEIC ne sont pas décodables par ce navigateur. Exportez-la en JPEG depuis la galerie, ou utilisez le scanner de l’application.', 'unsupported');
    case 'tiff':
      throw new ImportError('Le format TIFF n’est pas pris en charge par les navigateurs. Convertissez-le en PNG ou JPEG.', 'unsupported');
    case 'svg':
      throw new ImportError('Les fichiers SVG ne sont pas acceptés (ils peuvent contenir du code exécutable).', 'dangerous');
    case 'pdf':
      if (bytes.length > limits.maxPdfBytes) throw new ImportError(`PDF trop volumineux (max ${MB(limits.maxPdfBytes)}).`, 'too-large');
      return 'pdf';
    case 'zip':
      if (bytes.length > limits.maxOfficeBytes) throw new ImportError(`Fichier trop volumineux (max ${MB(limits.maxOfficeBytes)}).`, 'too-large');
      if (zipKind) return zipKind;
      throw new ImportError(`« ${name} » est une archive ZIP qui n’est ni un DOCX, ni un XLSX, ni un PPTX.`, 'unsupported');
    case 'ole':
      throw new ImportError(
        `« ${name} » est un ancien format binaire Microsoft Office (${e ? e.toUpperCase() : 'DOC/XLS/PPT'}). Sa conversion nécessite un serveur (LibreOffice) ; enregistrez-le en ${e === 'xls' ? 'XLSX' : e === 'ppt' ? 'PPTX' : 'DOCX'} puis réimportez-le.`,
        'legacy-office',
      );
    case 'text':
      if (['txt', 'text', 'md', 'csv', 'log', ''].includes(e)) {
        if (bytes.length > limits.maxTextBytes) throw new ImportError(`Fichier texte trop volumineux (max ${MB(limits.maxTextBytes)}).`, 'too-large');
        return 'txt';
      }
      if (['html', 'htm', 'js', 'xml', 'svg'].includes(e)) throw new ImportError(`Le type « .${e} » n’est pas pris en charge.`, 'dangerous');
      throw new ImportError(`Le contenu de « ${name} » ne correspond pas à son extension.`, 'mismatch');
    default:
      throw new ImportError(`Format de « ${name} » non reconnu.`, 'unsupported');
  }
}

/** Reads [Content_Types].xml of an OOXML package to know if it is a DOCX, XLSX or PPTX. */
export function ooxmlKindFromContentTypes(xml: string): 'docx' | 'xlsx' | 'pptx' | null {
  if (/wordprocessingml\.document\.main\+xml/.test(xml)) return 'docx';
  if (/spreadsheetml\.sheet\.main\+xml/.test(xml)) return 'xlsx';
  if (/presentationml\.presentation\.main\+xml/.test(xml)) return 'pptx';
  if (/macroEnabled/i.test(xml)) return null;
  return null;
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Makes a string safe to use as a downloaded file name on every OS: removes paths, control
 * and reserved characters, reserved device names, leading dots and limits the length.
 */
export function sanitizeFileName(input: string, fallback = 'document'): string {
  let s = input.normalize('NFC');
  s = s.split(/[\\/]/).pop() ?? '';
  s = s.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, '').replace(/[. ]+$/, '');
  const dot = s.lastIndexOf('.');
  const base = dot > 0 ? s.slice(0, dot) : s;
  if (RESERVED.test(base)) s = `_${s}`;
  if ([...s].length > 120) s = [...s].slice(0, 120).join('');
  return s || fallback;
}

/** Builds "<title>.<ext>" safely. */
export function exportFileName(title: string, extension: string): string {
  const base = sanitizeFileName(title).replace(/\.(pdf|jpe?g|png|txt|docx|zip)$/i, '');
  return `${base}.${extension}`;
}
