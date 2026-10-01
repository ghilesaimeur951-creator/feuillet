import type { Quad } from '../geometry/geometry';
import type { Adjustments, FilterId } from '../imaging/filters';
import type { InvoiceData, DocumentKind, OcrResult } from '../ocr/analysis';

/** Persistent data model. Blobs (images, original files) are stored separately and referenced by id. */

export type DocumentSource = 'scan' | 'image' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'txt' | 'merge' | 'split';

export interface Page {
  id: string;
  /** Unprocessed capture/import (full resolution). */
  originalBlobId: string;
  originalWidth: number;
  originalHeight: number;
  /** Corners in original image pixels; null = full image (no perspective correction). */
  quad: Quad | null;
  /** Clockwise quarter turns applied after rectification. */
  rotation: 0 | 1 | 2 | 3;
  filter: FilterId;
  adjustments: Adjustments;
  /** Rendered result (rectified + filtered + rotated), JPEG. */
  processedBlobId: string;
  width: number;
  height: number;
  thumbBlobId: string;
  /** Vector annotations and signatures burned into the processed image at export time. */
  annotations: Annotation[];
  ocr?: OcrResult;
  /** Text known without OCR (imported PDF text layer, Office conversion). */
  text?: string;
  /** Word boxes for text known without OCR, in processed-image pixels. */
  textWords?: Array<{ text: string; x: number; y: number; width: number; height: number }>;
  /** Perceptual hash for duplicate detection. */
  hash?: string;
  blank?: boolean;
}

/**
 * Annotation geometry is normalised to the processed page (0..1 on both axes; stroke widths and
 * text sizes are fractions of the page width), so annotations survive re-rendering at any size.
 */
export type Annotation =
  | { id: string; type: 'ink'; color: string; width: number; opacity: number; points: Array<{ x: number; y: number }> }
  | { id: string; type: 'highlight'; color: string; x: number; y: number; w: number; h: number }
  | { id: string; type: 'rect' | 'ellipse'; color: string; width: number; x: number; y: number; w: number; h: number }
  | { id: string; type: 'arrow'; color: string; width: number; x1: number; y1: number; x2: number; y2: number }
  | { id: string; type: 'text'; color: string; size: number; x: number; y: number; text: string }
  | { id: string; type: 'image'; blobId: string; x: number; y: number; w: number; h: number; signature?: boolean };

export interface DocumentRecord {
  id: string;
  title: string;
  folderId: string | null;
  tags: string[];
  notes: string;
  favorite: boolean;
  createdAt: number;
  updatedAt: number;
  openedAt?: number;
  /** Set when in the trash. */
  deletedAt?: number;
  pages: Page[];
  source: DocumentSource;
  /** Original imported file (PDF/Office/TXT), kept for "download original". */
  originalFile?: { blobId: string; name: string; mime: string; size: number };
  /** Total size of the stored blobs (processed pages + original file). */
  sizeBytes: number;
  kind?: DocumentKind;
  invoice?: InvoiceData;
  /** Monotonic revision for future sync/conflict resolution. */
  revision: number;
  /**
   * Present when the document is locked: pages, notes, tags, analysis and original file are
   * encrypted (see `core/security/vault.ts`); `pages` is then empty and only the title, folder,
   * dates and favourite flag stay readable.
   */
  locked?: DocumentLock;
  /** The document was opened temporarily and must be locked again (set while it is unlocked). */
  relockPending?: boolean;
}

export interface DocumentLock {
  v: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  /** Base64 salt. */
  salt: string;
  /** Base64 sealed JSON of `LockedContent`. */
  payload: string;
  /** Sealed blobs (same ids as stored), so storage, backup and garbage collection keep them. */
  blobIds: string[];
  pageCount: number;
  lockedAt: number;
}

/** What a lock hides. */
export interface LockedContent {
  pages: Page[];
  notes: string;
  tags: string[];
  kind?: DocumentKind;
  invoice?: InvoiceData;
  originalFile?: DocumentRecord['originalFile'];
  /** Plaintext blob id → { sealed blob id, original MIME type }. */
  blobs: Record<string, { sealed: string; type: string }>;
}

export function isLocked(d: DocumentRecord): boolean {
  return d.locked !== undefined;
}

/** Number of pages, also for a locked document. */
export function pageCount(d: DocumentRecord): number {
  return d.locked ? d.locked.pageCount : d.pages.length;
}

/** Blob ids referenced by pages (images, thumbnails, image annotations) and the original file. */
export function contentBlobIds(c: { pages: readonly Page[]; originalFile?: DocumentRecord['originalFile'] | undefined }): string[] {
  const ids: string[] = [];
  for (const p of c.pages) {
    ids.push(p.originalBlobId, p.processedBlobId, p.thumbBlobId);
    for (const a of p.annotations) if (a.type === 'image') ids.push(a.blobId);
  }
  if (c.originalFile) ids.push(c.originalFile.blobId);
  return [...new Set(ids.filter(Boolean))];
}

/** Returns copies of pages / original file with every blob id replaced through `map` (unknown ids kept). */
export function remapBlobIds<T extends { pages: Page[]; originalFile?: DocumentRecord['originalFile'] | undefined }>(
  c: T,
  map: ReadonlyMap<string, string>,
): T {
  const m = (id: string) => map.get(id) ?? id;
  return {
    ...c,
    pages: c.pages.map((p) => ({
      ...p,
      originalBlobId: m(p.originalBlobId),
      processedBlobId: m(p.processedBlobId),
      thumbBlobId: m(p.thumbBlobId),
      annotations: p.annotations.map((a) => (a.type === 'image' ? { ...a, blobId: m(a.blobId) } : a)),
    })),
    ...(c.originalFile ? { originalFile: { ...c.originalFile, blobId: m(c.originalFile.blobId) } } : {}),
  };
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  color?: string;
}

export type HistoryAction = 'created' | 'opened' | 'modified' | 'imported' | 'exported' | 'deleted' | 'restored' | 'ocr' | 'moved' | 'renamed';

export interface HistoryEntry {
  id: string;
  at: number;
  action: HistoryAction;
  docId: string;
  title: string;
  detail?: string;
}

export function newId(prefix = ''): string {
  const b = new Uint8Array(10);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += x.toString(36).padStart(2, '0');
  return `${prefix}${Date.now().toString(36)}${s}`.slice(0, 28);
}

export function documentFormatLabel(d: DocumentRecord): string {
  switch (d.source) {
    case 'pdf':
      return 'PDF';
    case 'docx':
      return 'Word';
    case 'xlsx':
      return 'Excel';
    case 'pptx':
      return 'PowerPoint';
    case 'txt':
      return 'Texte';
    case 'image':
      return 'Image';
    default:
      return 'Scan';
  }
}

/** Full text of a document: OCR (or edited OCR) text, else known text, page by page. */
export function documentText(d: DocumentRecord): string {
  return d.pages
    .map((p) => p.ocr?.text ?? p.text ?? '')
    .filter(Boolean)
    .join('\n\n');
}

/** Path of a folder from the root, e.g. "Administratif / Impôts". */
export function folderPath(folderId: string | null, folders: ReadonlyMap<string, Folder>): string {
  const names: string[] = [];
  let cur = folderId ? folders.get(folderId) : undefined;
  let guard = 0;
  while (cur && guard++ < 64) {
    names.unshift(cur.name);
    cur = cur.parentId ? folders.get(cur.parentId) : undefined;
  }
  return names.join(' / ');
}

/** True when `candidate` is `folderId` itself or one of its descendants (prevents cycles on move). */
export function isDescendantFolder(candidate: string, folderId: string, folders: ReadonlyMap<string, Folder>): boolean {
  let cur: Folder | undefined = folders.get(candidate);
  let guard = 0;
  while (cur && guard++ < 64) {
    if (cur.id === folderId) return true;
    cur = cur.parentId ? folders.get(cur.parentId) : undefined;
  }
  return false;
}
