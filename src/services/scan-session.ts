import type { Quad } from '../core/geometry/geometry';
import { newId } from '../core/docs/model';
import type { Library } from './library';

/**
 * Scan session: captures waiting to be validated. Each capture is saved to IndexedDB immediately
 * and the session is persisted, so an interrupted scan (crash, closed tab) can be resumed.
 */

export type ScanMode = 'document' | 'multipage' | 'card' | 'book' | 'whiteboard' | 'photo' | 'receipt';

export const SCAN_MODES: ReadonlyArray<{
  id: ScanMode;
  label: string;
  icon: 'doc' | 'pages' | 'card' | 'book' | 'board' | 'photo' | 'receipt';
  hint: string;
}> = [
  { id: 'document', label: 'Document', icon: 'doc', hint: 'Une page, redressée et nettoyée' },
  { id: 'multipage', label: 'Multipage', icon: 'pages', hint: 'Enchaînez les pages sans quitter la caméra' },
  { id: 'card', label: 'Carte', icon: 'card', hint: 'Carte d’identité, carte de visite, petit document' },
  { id: 'book', label: 'Livre', icon: 'book', hint: 'Double page scindée en deux pages' },
  { id: 'whiteboard', label: 'Tableau', icon: 'board', hint: 'Tableau blanc, couleurs ravivées' },
  { id: 'photo', label: 'Photo', icon: 'photo', hint: 'Photo sans recadrage ni filtre' },
  { id: 'receipt', label: 'Reçu', icon: 'receipt', hint: 'Ticket ou facture : montants extraits' },
];

export interface Capture {
  id: string;
  blobId: string;
  width: number;
  height: number;
  /** Detected (or user-adjusted) corners in capture pixels; null = keep the whole image. */
  quad: Quad | null;
  autoQuad: Quad | null;
  rotation: 0 | 1 | 2 | 3;
}

export interface ScanTarget {
  /** Append pages to this document (otherwise a new document is created). */
  docId?: string;
  /** Replace this page (rescan). */
  replacePageId?: string;
  folderId?: string | null;
}

export interface ScanSession {
  mode: ScanMode;
  captures: Capture[];
  target: ScanTarget;
  startedAt: number;
}

const KEY = 'scanSession';
let current: ScanSession | null = null;
const listeners = new Set<() => void>();

export function getSession(): ScanSession | null {
  return current;
}

export function subscribeSession(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function persist(lib: Library): Promise<void> {
  await lib.setSetting(KEY, current);
  listeners.forEach((l) => l());
}

export async function startSession(lib: Library, mode: ScanMode, target: ScanTarget = {}): Promise<ScanSession> {
  if (!current || current.target.docId !== target.docId || current.target.replacePageId !== target.replacePageId) {
    if (current) await discardSession(lib);
    current = { mode, captures: [], target, startedAt: Date.now() };
  } else current = { ...current, mode };
  await persist(lib);
  return current;
}

export async function setMode(lib: Library, mode: ScanMode): Promise<void> {
  if (!current) return;
  current = { ...current, mode };
  await persist(lib);
}

export async function addCapture(lib: Library, blob: Blob, width: number, height: number, quad: Quad | null): Promise<Capture> {
  if (!current) throw new Error('Aucune session de scan');
  const c: Capture = { id: newId('c'), blobId: await lib.putBlob(blob), width, height, quad, autoQuad: quad, rotation: 0 };
  const replace = !!current.target.replacePageId;
  current = { ...current, captures: replace ? [c] : [...current.captures, c] };
  await persist(lib);
  return c;
}

export async function updateCapture(lib: Library, id: string, patch: Partial<Pick<Capture, 'quad' | 'rotation'>>): Promise<void> {
  if (!current) return;
  current = { ...current, captures: current.captures.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
  await persist(lib);
}

export async function removeCapture(lib: Library, id: string): Promise<void> {
  if (!current) return;
  const c = current.captures.find((x) => x.id === id);
  current = { ...current, captures: current.captures.filter((x) => x.id !== id) };
  if (c) await lib.deleteBlob(c.blobId);
  await persist(lib);
}

export async function moveCapture(lib: Library, from: number, to: number): Promise<void> {
  if (!current) return;
  const caps = current.captures.slice();
  const [c] = caps.splice(from, 1);
  if (!c) return;
  caps.splice(to, 0, c);
  current = { ...current, captures: caps };
  await persist(lib);
}

/** Clears the session. Capture blobs are deleted unless `keepBlobs` (they became document pages). */
export async function discardSession(lib: Library, keepBlobs = false): Promise<void> {
  if (current && !keepBlobs) for (const c of current.captures) await lib.deleteBlob(c.blobId);
  current = null;
  await persist(lib);
}

/** Restores an interrupted session at startup. Returns it when captures are waiting. */
export async function restoreSession(lib: Library): Promise<ScanSession | null> {
  const s = await lib.getSetting<ScanSession | null>(KEY, null);
  if (!s || !Array.isArray(s.captures)) return null;
  // Keep only captures whose image still exists.
  const valid: Capture[] = [];
  for (const c of s.captures) if (await lib.getBlob(c.blobId)) valid.push(c);
  current = { ...s, captures: valid };
  if (!valid.length) {
    current = null;
    await persist(lib);
    return null;
  }
  listeners.forEach((l) => l());
  return current;
}

export function sessionBlobIds(): Set<string> {
  return new Set(current?.captures.map((c) => c.blobId) ?? []);
}

/** Default processing for each mode. */
export function modeDefaults(
  mode: ScanMode,
  userDefault: import('../core/imaging/filters').FilterId,
): { filter: import('../core/imaging/filters').FilterId; crop: boolean; snap: boolean } {
  switch (mode) {
    case 'photo':
      return { filter: 'original', crop: false, snap: false };
    case 'whiteboard':
      return { filter: 'enhanced', crop: true, snap: false };
    case 'card':
      return { filter: 'enhanced', crop: true, snap: true };
    case 'receipt':
      return { filter: 'document', crop: true, snap: false };
    case 'book':
      return { filter: userDefault, crop: true, snap: false };
    default:
      return { filter: userDefault, crop: true, snap: true };
  }
}
