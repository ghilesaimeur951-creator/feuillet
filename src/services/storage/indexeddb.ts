import type { BlobStore, RecordStore, SettingRecord, StorageAdapter } from './adapter';

const DB_NAME = 'feuillet';
const DB_VERSION = 1;
const STORES = ['documents', 'folders', 'history', 'settings', 'blobs'] as const;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('Erreur IndexedDB'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Transaction IndexedDB échouée'));
    tx.onabort = () => reject(tx.error ?? new Error('Transaction IndexedDB annulée (quota dépassé ?)'));
  });
}

export function openDatabase(name = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB indisponible'));
      return;
    }
    const open = indexedDB.open(name, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) {
          const store = s === 'blobs' ? db.createObjectStore(s) : db.createObjectStore(s, { keyPath: 'id' });
          if (s === 'documents') store.createIndex('updatedAt', 'updatedAt');
          if (s === 'history') store.createIndex('at', 'at');
        }
      }
    };
    open.onsuccess = () => {
      const db = open.result;
      // Another tab upgraded the schema: close so the upgrade can proceed.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    open.onerror = () => reject(open.error ?? new Error('Ouverture IndexedDB impossible'));
    open.onblocked = () => reject(new Error('Base de données bloquée par un autre onglet'));
  });
}

class IdbRecordStore<T extends { id: string }> implements RecordStore<T> {
  constructor(
    private readonly db: IDBDatabase,
    private readonly name: string,
  ) {}
  async get(id: string): Promise<T | undefined> {
    return req(this.db.transaction(this.name, 'readonly').objectStore(this.name).get(id) as IDBRequest<T | undefined>);
  }
  async put(value: T): Promise<void> {
    const tx = this.db.transaction(this.name, 'readwrite');
    tx.objectStore(this.name).put(value);
    await txDone(tx);
  }
  async putMany(values: readonly T[]): Promise<void> {
    const tx = this.db.transaction(this.name, 'readwrite');
    const s = tx.objectStore(this.name);
    for (const v of values) s.put(v);
    await txDone(tx);
  }
  async delete(id: string): Promise<void> {
    const tx = this.db.transaction(this.name, 'readwrite');
    tx.objectStore(this.name).delete(id);
    await txDone(tx);
  }
  async all(): Promise<T[]> {
    return req(this.db.transaction(this.name, 'readonly').objectStore(this.name).getAll() as IDBRequest<T[]>);
  }
  async clear(): Promise<void> {
    const tx = this.db.transaction(this.name, 'readwrite');
    tx.objectStore(this.name).clear();
    await txDone(tx);
  }
}

interface StoredBlob {
  type: string;
  data: ArrayBuffer;
}

/** Blobs are stored as ArrayBuffers: the most robust representation across browsers (Safari). */
class IdbBlobStore implements BlobStore {
  constructor(private readonly db: IDBDatabase) {}
  async get(id: string): Promise<Blob | undefined> {
    const v = await req(this.db.transaction('blobs', 'readonly').objectStore('blobs').get(id) as IDBRequest<StoredBlob | undefined>);
    return v ? new Blob([v.data], { type: v.type }) : undefined;
  }
  async put(id: string, blob: Blob): Promise<void> {
    const data = await blob.arrayBuffer();
    const tx = this.db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').put({ type: blob.type, data } satisfies StoredBlob, id);
    await txDone(tx);
  }
  async delete(id: string): Promise<void> {
    const tx = this.db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').delete(id);
    await txDone(tx);
  }
  async keys(): Promise<string[]> {
    return (await req(this.db.transaction('blobs', 'readonly').objectStore('blobs').getAllKeys())).map(String);
  }
  async clear(): Promise<void> {
    const tx = this.db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').clear();
    await txDone(tx);
  }
}

export async function createIndexedDbAdapter<D extends { id: string }, F extends { id: string }, H extends { id: string }>(
  name?: string,
): Promise<StorageAdapter<D, F, H>> {
  const db = await openDatabase(name);
  return {
    kind: 'indexeddb',
    documents: new IdbRecordStore<D>(db, 'documents'),
    folders: new IdbRecordStore<F>(db, 'folders'),
    history: new IdbRecordStore<H>(db, 'history'),
    settings: new IdbRecordStore<SettingRecord>(db, 'settings'),
    blobs: new IdbBlobStore(db),
  };
}
