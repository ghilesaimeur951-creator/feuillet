/** Runtime configuration. Everything is served locally; no external service is contacted. */

/** Resolves a path relative to the application root (works under a sub-path, e.g. GitHub Pages). */
export function appUrl(path: string): string {
  const base = typeof document !== 'undefined' ? document.baseURI : ((globalThis as { location?: { href: string } }).location?.href ?? '/');
  return new URL(path, base).href;
}

export const APP_NAME = 'Feuillet';
export const APP_VERSION = '1.0.0';

export const OCR_LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'fra', label: 'Français' },
  { code: 'eng', label: 'Anglais' },
  { code: 'spa', label: 'Espagnol' },
  { code: 'deu', label: 'Allemand' },
  { code: 'ita', label: 'Italien' },
];
