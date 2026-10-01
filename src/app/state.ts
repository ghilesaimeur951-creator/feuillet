import { useEffect, useState } from 'preact/hooks';
import type { DocumentRecord, Folder, HistoryEntry } from '../core/docs/model';
import { Library } from '../services/library';
import { VaultSession } from '../services/vault-session';
import { createMemoryAdapter } from '../services/storage/adapter';
import { createIndexedDbAdapter } from '../services/storage/indexeddb';
import { settings } from '../services/settings';
import type { Settings } from '../services/settings';

/** Application-wide singletons and small reactive stores. */

let libraryInstance: Library | null = null;
let libraryPromise: Promise<Library> | null = null;
export let storageWarning: string | null = null;

export function initLibrary(): Promise<Library> {
  if (!libraryPromise) {
    libraryPromise = (async () => {
      let lib: Library;
      try {
        lib = new Library(await createIndexedDbAdapter<DocumentRecord, Folder, HistoryEntry>());
      } catch (e) {
        storageWarning = `Stockage persistant indisponible (${e instanceof Error ? e.message : 'IndexedDB'}). Les documents seront perdus à la fermeture.`;
        lib = new Library(createMemoryAdapter<DocumentRecord, Folder, HistoryEntry>());
      }
      await lib.init();
      libraryInstance = lib;
      return lib;
    })();
  }
  return libraryPromise;
}

export function library(): Library {
  if (!libraryInstance) throw new Error('Bibliothèque non initialisée');
  return libraryInstance;
}

let vaultInstance: VaultSession | null = null;

/** Temporary openings of locked documents (passwords in memory only). */
export function vault(): VaultSession {
  if (!vaultInstance) vaultInstance = new VaultSession(library());
  return vaultInstance;
}

/** Re-renders the component whenever the library changes; returns the library. */
export function useLibrary(): Library {
  const [, setVersion] = useState(0);
  const lib = library();
  useEffect(() => lib.subscribe(() => setVersion((v) => v + 1)), [lib]);
  return lib;
}

export function useSettings(): Settings {
  const [value, setValue] = useState(settings.all());
  useEffect(() => settings.subscribe(() => setValue(settings.all())), []);
  return value;
}

// ---------- Toasts ----------

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'success' | 'error';
  action?: { label: string; run: () => void };
}

let toastSeq = 0;
let toasts: Toast[] = [];
const toastListeners = new Set<() => void>();

export function toast(message: string, kind: Toast['kind'] = 'info', action?: Toast['action'], ms = kind === 'error' ? 6000 : 3500): void {
  const t: Toast = { id: ++toastSeq, message, kind, ...(action ? { action } : {}) };
  toasts = [...toasts.slice(-3), t];
  toastListeners.forEach((l) => l());
  setTimeout(() => dismissToast(t.id), action ? ms + 2500 : ms);
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  toastListeners.forEach((l) => l());
}

export function useToasts(): Toast[] {
  const [v, set] = useState(toasts);
  useEffect(() => {
    const l = () => set(toasts);
    toastListeners.add(l);
    return () => void toastListeners.delete(l);
  }, []);
  return v;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------- Dialogs (confirm / prompt / choose), promise-based ----------

export type DialogRequest =
  | { kind: 'confirm'; title: string; message?: string; confirmLabel?: string; danger?: boolean; resolve: (ok: boolean) => void }
  | {
      kind: 'prompt';
      title: string;
      message?: string;
      value?: string;
      placeholder?: string;
      confirmLabel?: string;
      inputType?: 'text' | 'password';
      resolve: (v: string | null) => void;
    }
  | {
      kind: 'choose';
      title: string;
      message?: string;
      options: Array<{ value: string; label: string; hint?: string }>;
      resolve: (v: string | null) => void;
    };

let dialog: DialogRequest | null = null;
const dialogListeners = new Set<() => void>();

function openDialog(d: DialogRequest) {
  dialog = d;
  dialogListeners.forEach((l) => l());
}

export function closeDialog(): void {
  dialog = null;
  dialogListeners.forEach((l) => l());
}

export function useDialog(): DialogRequest | null {
  const [v, set] = useState(dialog);
  useEffect(() => {
    const l = () => set(dialog);
    dialogListeners.add(l);
    return () => void dialogListeners.delete(l);
  }, []);
  return v;
}

export function confirmDialog(title: string, message?: string, opts: { confirmLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => openDialog({ kind: 'confirm', title, ...(message ? { message } : {}), ...opts, resolve }));
}

export function promptDialog(
  title: string,
  opts: { message?: string; value?: string; placeholder?: string; confirmLabel?: string; inputType?: 'text' | 'password' } = {},
): Promise<string | null> {
  return new Promise((resolve) => openDialog({ kind: 'prompt', title, ...opts, resolve }));
}

export function chooseDialog(
  title: string,
  options: Array<{ value: string; label: string; hint?: string }>,
  message?: string,
): Promise<string | null> {
  return new Promise((resolve) => openDialog({ kind: 'choose', title, options, ...(message ? { message } : {}), resolve }));
}

// ---------- Busy overlay (long operations with progress) ----------

export interface BusyState {
  label: string;
  progress?: number;
}

let busy: BusyState | null = null;
const busyListeners = new Set<() => void>();

export function setBusy(b: BusyState | null): void {
  busy = b;
  busyListeners.forEach((l) => l());
}

export function useBusy(): BusyState | null {
  const [v, set] = useState(busy);
  useEffect(() => {
    const l = () => set(busy);
    busyListeners.add(l);
    return () => void busyListeners.delete(l);
  }, []);
  return v;
}

/** Runs a task with a blocking progress overlay and reports errors as toasts. */
export async function withBusy<T>(label: string, task: (progress: (v: number, label?: string) => void) => Promise<T>): Promise<T | undefined> {
  setBusy({ label, progress: 0 });
  try {
    return await task((v, l) => setBusy({ label: l ?? label, progress: v }));
  } catch (e) {
    toast(errorMessage(e), 'error');
    return undefined;
  } finally {
    setBusy(null);
  }
}

export function haptic(pattern: number | number[] = 15): void {
  if (!settings.get('haptics')) return;
  // Browsers block vibration before the first user gesture.
  if ((navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive === false) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}
