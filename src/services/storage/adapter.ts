/**
 * Storage abstraction. The app talks to `StorageAdapter`; today it is backed by IndexedDB
 * (local-first), and a future sync/cloud adapter can implement the same interface.
 */

export interface RecordStore<T extends { id: string }> {
  get(id: string): Promise<T | undefined>;
  put(value: T): Promise<void>;
  putMany(values: readonly T[]): Promise<void>;
  delete(id: string): Promise<void>;
  all(): Promise<T[]>;
  clear(): Promise<void>;
}

export interface BlobStore {
  get(id: string): Promise<Blob | undefined>;
  put(id: string, blob: Blob): Promise<void>;
  delete(id: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

export interface SettingRecord {
  id: string;
  value: unknown;
}

export interface StorageAdapter<Doc extends { id: string }, Fold extends { id: string }, Hist extends { id: string }> {
  readonly kind: 'indexeddb' | 'memory';
  documents: RecordStore<Doc>;
  folders: RecordStore<Fold>;
  history: RecordStore<Hist>;
  settings: RecordStore<SettingRecord>;
  blobs: BlobStore;
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

export class MemoryRecordStore<T extends { id: string }> implements RecordStore<T> {
  private map = new Map<string, T>();
  async get(id: string) {
    const v = this.map.get(id);
    return v === undefined ? undefined : clone(v);
  }
  async put(value: T) {
    this.map.set(value.id, clone(value));
  }
  async putMany(values: readonly T[]) {
    for (const v of values) this.map.set(v.id, clone(v));
  }
  async delete(id: string) {
    this.map.delete(id);
  }
  async all() {
    return [...this.map.values()].map(clone);
  }
  async clear() {
    this.map.clear();
  }
}

export class MemoryBlobStore implements BlobStore {
  private map = new Map<string, Blob>();
  async get(id: string) {
    return this.map.get(id);
  }
  async put(id: string, blob: Blob) {
    this.map.set(id, blob);
  }
  async delete(id: string) {
    this.map.delete(id);
  }
  async keys() {
    return [...this.map.keys()];
  }
  async clear() {
    this.map.clear();
  }
}

export function createMemoryAdapter<D extends { id: string }, F extends { id: string }, H extends { id: string }>(): StorageAdapter<D, F, H> {
  return {
    kind: 'memory',
    documents: new MemoryRecordStore<D>(),
    folders: new MemoryRecordStore<F>(),
    history: new MemoryRecordStore<H>(),
    settings: new MemoryRecordStore<SettingRecord>(),
    blobs: new MemoryBlobStore(),
  };
}
