/**
 * Bridge to the Android shell (android/ — a WebView that serves the same build from the APK).
 * In a browser `nativeBridge()` is null and the Web APIs are used instead.
 */

export interface AndroidBridge {
  /** Saves into the public Downloads folder; returns a human-readable location. */
  saveFile(name: string, mime: string, base64: string): string;
  /** Opens the Android share sheet. */
  shareFile(name: string, mime: string, base64: string, title: string): void;
  /** Opens the Android print dialog for a PDF. */
  printPdf(name: string, base64: string): void;
  version(): string;
  /** Files shared to the app (JSON array of { url, name, type }), then forgotten. */
  takeShared(): string;
  setSystemBars(color: string, dark: boolean): void;
}

export function nativeBridge(): AndroidBridge | null {
  const b = (globalThis as { FeuilletAndroid?: AndroidBridge }).FeuilletAndroid;
  return b && typeof b.saveFile === 'function' ? b : null;
}

export function isAndroidApp(): boolean {
  return nativeBridge() !== null;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Android file names: no path separators or reserved characters. */
export function nativeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 120) || 'document';
}

/** Fetches the files shared to the Android app ("Share to Feuillet"), served by the APK itself. */
export async function takeSharedFiles(): Promise<File[]> {
  const android = nativeBridge();
  if (!android) return [];
  let list: Array<{ url: string; name: string; type: string }> = [];
  try {
    list = JSON.parse(android.takeShared()) as typeof list;
  } catch {
    return [];
  }
  const files: File[] = [];
  for (const f of list) {
    if (typeof f.url !== 'string' || !f.url.startsWith(`${location.origin}/__shared/`)) continue;
    const res = await fetch(f.url);
    if (!res.ok) continue;
    const blob = await res.blob();
    files.push(new File([blob], f.name || 'fichier', { type: f.type || blob.type }));
  }
  return files;
}
