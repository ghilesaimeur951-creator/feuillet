import type { FilterId } from '../core/imaging/filters';
import type { OrientationId, PageSizeId, QualityProfile } from '../core/pdf/layout';

/** User preferences (small, synchronous, stored in localStorage; documents live in IndexedDB). */
export interface Settings {
  theme: 'system' | 'light' | 'dark';
  scanResolution: 'standard' | 'high' | 'max';
  defaultFilter: FilterId;
  autoCapture: boolean;
  autoOcr: boolean;
  autoName: boolean;
  ocrLanguages: string[];
  exportPageSize: PageSizeId;
  exportOrientation: OrientationId;
  exportQuality: QualityProfile['id'];
  exportMargin: number;
  searchablePdf: boolean;
  pageNumbers: boolean;
  viewMode: 'grid' | 'list';
  sortBy: 'date' | 'name' | 'size' | 'type';
  importAutoCrop: boolean;
  haptics: boolean;
  shutterSound: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  scanResolution: 'high',
  defaultFilter: 'auto',
  autoCapture: true,
  autoOcr: true,
  autoName: true,
  ocrLanguages: ['fra', 'eng'],
  exportPageSize: 'A4',
  exportOrientation: 'auto',
  exportQuality: 'standard',
  exportMargin: 0,
  searchablePdf: true,
  pageNumbers: false,
  viewMode: 'grid',
  sortBy: 'date',
  importAutoCrop: true,
  haptics: true,
  shutterSound: false,
};

const KEY = 'feuillet.settings.v1';

class SettingsStore {
  private value: Settings;
  private listeners = new Set<() => void>();

  constructor() {
    this.value = { ...DEFAULT_SETTINGS };
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Settings>;
        for (const k of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
          if (parsed[k] !== undefined && typeof parsed[k] === typeof DEFAULT_SETTINGS[k])
            (this.value as unknown as Record<string, unknown>)[k] = parsed[k];
        }
      }
    } catch {
      /* private mode or corrupted value: defaults */
    }
  }

  get<K extends keyof Settings>(k: K): Settings[K] {
    return this.value[k];
  }

  all(): Settings {
    return this.value;
  }

  set<K extends keyof Settings>(k: K, v: Settings[K]): void {
    this.value = { ...this.value, [k]: v };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.value));
    } catch {
      /* ignore */
    }
    for (const l of this.listeners) l();
  }

  reset(): void {
    this.value = { ...DEFAULT_SETTINGS };
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    for (const l of this.listeners) l();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const settings = new SettingsStore();
