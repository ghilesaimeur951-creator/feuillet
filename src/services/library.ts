import type { DocumentRecord, Folder, HistoryAction, HistoryEntry, LockedContent, Page } from '../core/docs/model';
import { contentBlobIds, documentFormatLabel, documentText, folderPath, isDescendantFolder, newId, remapBlobIds } from '../core/docs/model';
import {
  checkVaultPassword,
  deriveVaultKey,
  fromBase64,
  seal,
  sealJson,
  toBase64,
  unseal,
  unsealJson,
  VAULT_ITERATIONS,
} from '../core/security/vault';
import { toArrayBuffer } from '../core/util/bytes';
import { KIND_LABELS } from '../core/ocr/analysis';
import { SearchIndex } from '../core/search/index';
import type { SearchFilters, SearchHit } from '../core/search/index';
import { createZip, isSafeZipPath, ZipArchive } from '../core/zip/zip';
import { textEncoder } from '../core/util/bytes';
import type { StorageAdapter } from './storage/adapter';

export type LibraryAdapter = StorageAdapter<DocumentRecord, Folder, HistoryEntry>;

export const TRASH_RETENTION_DAYS = 30;
const HISTORY_LIMIT = 500;

export interface NewDocumentInput {
  title: string;
  pages: Page[];
  source: DocumentRecord['source'];
  folderId?: string | null;
  tags?: string[];
  notes?: string;
  originalFile?: DocumentRecord['originalFile'];
  kind?: DocumentRecord['kind'];
  invoice?: DocumentRecord['invoice'];
}

type Listener = () => void;

/**
 * Application repository: documents, folders, trash, history, search index and backups.
 * Keeps an in-memory cache of metadata (small) and reads blobs lazily.
 */
export class Library {
  private docs = new Map<string, DocumentRecord>();
  private folderMap = new Map<string, Folder>();
  private historyEntries: HistoryEntry[] = [];
  private index = new SearchIndex();
  private listeners = new Set<Listener>();
  private blobSizes = new Map<string, number>();
  ready = false;
  /** PBKDF2 iterations for new locks (lowered only by tests). */
  vaultIterations = VAULT_ITERATIONS;

  constructor(readonly adapter: LibraryAdapter) {}

  async init(now = Date.now()): Promise<void> {
    const [docs, folders, history] = await Promise.all([this.adapter.documents.all(), this.adapter.folders.all(), this.adapter.history.all()]);
    this.docs = new Map(docs.map((d) => [d.id, d]));
    this.folderMap = new Map(folders.map((f) => [f.id, f]));
    this.historyEntries = history.sort((a, b) => b.at - a.at);
    this.reindexAll();
    // Automatic purge of old trash items.
    const limit = now - TRASH_RETENTION_DAYS * 86400_000;
    const expired = docs.filter((d) => d.deletedAt !== undefined && d.deletedAt < limit).map((d) => d.id);
    if (expired.length) await this.purge(expired);
    const expiredFolders = folders.filter((f) => f.deletedAt !== undefined && f.deletedAt < limit);
    for (const f of expiredFolders) {
      this.folderMap.delete(f.id);
      await this.adapter.folders.delete(f.id);
    }
    this.ready = true;
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  // ---------- Queries ----------

  documents(): DocumentRecord[] {
    return [...this.docs.values()].filter((d) => d.deletedAt === undefined);
  }

  trash(): DocumentRecord[] {
    return [...this.docs.values()].filter((d) => d.deletedAt !== undefined).sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  }

  trashedFolders(): Folder[] {
    return [...this.folderMap.values()].filter((f) => f.deletedAt !== undefined);
  }

  get(id: string): DocumentRecord | undefined {
    return this.docs.get(id);
  }

  folders(): Folder[] {
    return [...this.folderMap.values()].filter((f) => f.deletedAt === undefined).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }

  folder(id: string): Folder | undefined {
    return this.folderMap.get(id);
  }

  folderPath(id: string | null): string {
    return folderPath(id, this.folderMap);
  }

  documentsInFolder(folderId: string | null): DocumentRecord[] {
    return this.documents().filter((d) => d.folderId === folderId);
  }

  subfolders(parentId: string | null): Folder[] {
    return this.folders().filter((f) => f.parentId === parentId);
  }

  recent(limit = 12): DocumentRecord[] {
    return this.documents()
      .sort((a, b) => Math.max(b.updatedAt, b.openedAt ?? 0) - Math.max(a.updatedAt, a.openedAt ?? 0))
      .slice(0, limit);
  }

  history(limit = 200): HistoryEntry[] {
    return this.historyEntries.slice(0, limit);
  }

  search(query: string, filters?: SearchFilters): Array<SearchHit & { doc: DocumentRecord }> {
    return this.index
      .search(query, filters)
      .map((h) => ({ ...h, doc: this.docs.get(h.id) as DocumentRecord }))
      .filter((h) => h.doc && h.doc.deletedAt === undefined);
  }

  allTags(): string[] {
    const s = new Set<string>();
    for (const d of this.documents()) for (const t of d.tags) s.add(t);
    return [...s].sort((a, b) => a.localeCompare(b, 'fr'));
  }

  // ---------- Blobs ----------

  async putBlob(blob: Blob, id = newId('b')): Promise<string> {
    await this.adapter.blobs.put(id, blob);
    this.blobSizes.set(id, blob.size);
    return id;
  }

  async getBlob(id: string): Promise<Blob | undefined> {
    return this.adapter.blobs.get(id);
  }

  async deleteBlob(id: string): Promise<void> {
    this.blobSizes.delete(id);
    await this.adapter.blobs.delete(id);
  }

  /** Blob ids referenced by a document (pages, thumbnails, annotations, original file). */
  static blobIds(d: DocumentRecord): string[] {
    return [...new Set([...contentBlobIds(d), ...(d.locked?.blobIds ?? [])])];
  }

  private async computeSize(d: DocumentRecord): Promise<number> {
    let total = 0;
    for (const id of Library.blobIds(d)) {
      let s = this.blobSizes.get(id);
      if (s === undefined) {
        s = (await this.adapter.blobs.get(id))?.size ?? 0;
        this.blobSizes.set(id, s);
      }
      total += s;
    }
    return total;
  }

  /** Deletes blobs referenced by no document (and not in `keep`). Returns the number removed. */
  async collectGarbage(keep: ReadonlySet<string> = new Set()): Promise<number> {
    const used = new Set<string>(keep);
    for (const d of this.docs.values()) for (const id of Library.blobIds(d)) used.add(id);
    let n = 0;
    for (const k of await this.adapter.blobs.keys()) {
      if (!used.has(k)) {
        await this.deleteBlob(k);
        n++;
      }
    }
    return n;
  }

  // ---------- Documents ----------

  async createDocument(input: NewDocumentInput, action: HistoryAction = 'created'): Promise<DocumentRecord> {
    const now = Date.now();
    const doc: DocumentRecord = {
      id: newId('d'),
      title: input.title.trim() || 'Sans titre',
      folderId: input.folderId ?? null,
      tags: input.tags ?? [],
      notes: input.notes ?? '',
      favorite: false,
      createdAt: now,
      updatedAt: now,
      pages: input.pages,
      source: input.source,
      sizeBytes: 0,
      revision: 1,
      ...(input.originalFile ? { originalFile: input.originalFile } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.invoice ? { invoice: input.invoice } : {}),
    };
    doc.sizeBytes = await this.computeSize(doc);
    await this.adapter.documents.put(doc);
    this.docs.set(doc.id, doc);
    this.indexDoc(doc);
    await this.log(action, doc);
    this.emit();
    return doc;
  }

  /** Per-document write queue: updates are applied one after the other on the latest version. */
  private writes = new Map<string, Promise<unknown>>();

  /**
   * Applies `fn` to the latest version of a document and persists the result. Writes to the same
   * document are serialised, so concurrent edits (e.g. background OCR while the user changes a
   * filter) never overwrite each other. On a locked document, only the public fields (title,
   * folder, favourite, dates, trash state) can change: the encrypted content is preserved as is.
   */
  updateDocument(
    id: string,
    fn: (latest: DocumentRecord) => DocumentRecord | Promise<DocumentRecord>,
    action: HistoryAction | null = 'modified',
    detail?: string,
    touch = true,
  ): Promise<DocumentRecord> {
    return this.enqueue(id, fn, action, detail, touch, false);
  }

  private enqueue(
    id: string,
    fn: (latest: DocumentRecord) => DocumentRecord | Promise<DocumentRecord>,
    action: HistoryAction | null,
    detail: string | undefined,
    touch: boolean,
    vault: boolean,
  ): Promise<DocumentRecord> {
    const prev = this.writes.get(id) ?? Promise.resolve();
    const run = async (): Promise<DocumentRecord> => {
      const latest = this.docs.get(id);
      if (!latest) throw new Error('Document introuvable');
      let changed = await fn(latest);
      if (!vault && latest.locked) {
        const { kind: _k, invoice: _i, originalFile: _o, relockPending: _r, ...pub } = changed;
        void [_k, _i, _o, _r];
        changed = { ...pub, pages: [], notes: '', tags: [], locked: latest.locked };
      }
      const next: DocumentRecord = touch
        ? { ...changed, id, updatedAt: Date.now(), revision: latest.revision + 1 }
        : { ...changed, id, revision: latest.revision + (vault ? 1 : 0) };
      next.sizeBytes = await this.computeSize(next);
      await this.adapter.documents.put(next);
      this.docs.set(id, next);
      this.indexDoc(next);
      if (action) await this.log(action, next, detail);
      this.emit();
      return next;
    };
    const p = prev.then(run, run);
    this.writes.set(
      id,
      p.catch(() => undefined),
    );
    return p;
  }

  // ---------- Locked documents ----------

  /**
   * Encrypts a document with a password: pages, OCR text, notes, tags, analysis and every blob.
   * Sealed blobs are written first and the plaintext ones deleted only once the locked record is
   * saved, so an interruption never loses data (orphans are removed by `collectGarbage`).
   * `quiet` = re-lock after a temporary opening (no new revision date, no history entry).
   */
  async lockDocument(id: string, password: string, quiet = false): Promise<DocumentRecord> {
    const invalid = checkVaultPassword(password);
    if (invalid) throw new Error(invalid);
    const vk = await deriveVaultKey(password, undefined, this.vaultIterations);
    let plaintext: string[] = [];
    const saved = await this.enqueue(
      id,
      async (latest) => {
        if (latest.locked) throw new Error('Ce document est déjà verrouillé');
        const blobs: LockedContent['blobs'] = {};
        const sealedIds: string[] = [];
        try {
          for (const bid of contentBlobIds(latest)) {
            const b = await this.getBlob(bid);
            if (!b) continue;
            const sealed = await seal(vk.key, new Uint8Array(await b.arrayBuffer()), latest.id);
            const sid = await this.putBlob(new Blob([toArrayBuffer(sealed)], { type: 'application/octet-stream' }));
            sealedIds.push(sid);
            blobs[bid] = { sealed: sid, type: b.type };
          }
        } catch (e) {
          for (const sid of sealedIds) await this.deleteBlob(sid);
          throw e;
        }
        const { kind, invoice, originalFile, relockPending: _r, ...pub } = latest;
        void _r;
        const content: LockedContent = {
          pages: latest.pages,
          notes: latest.notes,
          tags: latest.tags,
          blobs,
          ...(kind ? { kind } : {}),
          ...(invoice ? { invoice } : {}),
          ...(originalFile ? { originalFile } : {}),
        };
        plaintext = contentBlobIds(latest);
        return {
          ...pub,
          pages: [],
          notes: '',
          tags: [],
          locked: {
            v: 1,
            kdf: 'PBKDF2-SHA256',
            iterations: vk.iterations,
            salt: toBase64(vk.salt),
            payload: await sealJson(vk.key, content, latest.id),
            blobIds: sealedIds,
            pageCount: latest.pages.length,
            lockedAt: Date.now(),
          },
        };
      },
      quiet ? null : 'modified',
      'Document verrouillé',
      !quiet,
      true,
    );
    for (const b of plaintext) await this.deleteBlob(b);
    return saved;
  }

  /**
   * Decrypts a locked document. Throws `WrongPasswordError` for a wrong password (nothing is
   * changed). `temporary` marks it to be locked again when the user leaves it.
   */
  async unlockDocument(id: string, password: string, temporary = false): Promise<DocumentRecord> {
    let sealedIds: string[] = [];
    const saved = await this.enqueue(
      id,
      async (latest) => {
        const lock = latest.locked;
        if (!lock) return latest;
        const vk = await deriveVaultKey(password, fromBase64(lock.salt), lock.iterations);
        const content = await unsealJson<LockedContent>(vk.key, lock.payload, latest.id);
        const map = new Map<string, string>();
        try {
          for (const [plainId, { sealed, type }] of Object.entries(content.blobs)) {
            const b = await this.getBlob(sealed);
            if (!b) continue;
            const data = await unseal(vk.key, new Uint8Array(await b.arrayBuffer()), latest.id);
            map.set(plainId, await this.putBlob(new Blob([toArrayBuffer(data)], { type })));
          }
        } catch (e) {
          for (const nid of map.values()) await this.deleteBlob(nid);
          throw e;
        }
        sealedIds = lock.blobIds;
        const restored = remapBlobIds({ pages: content.pages, originalFile: content.originalFile }, map);
        const { locked: _l, ...pub } = latest;
        void _l;
        return {
          ...pub,
          pages: restored.pages,
          notes: content.notes,
          tags: content.tags,
          ...(content.kind ? { kind: content.kind } : {}),
          ...(content.invoice ? { invoice: content.invoice } : {}),
          ...(restored.originalFile ? { originalFile: restored.originalFile } : {}),
          ...(temporary ? { relockPending: true } : {}),
        };
      },
      temporary ? 'opened' : 'modified',
      temporary ? 'Déverrouillé temporairement' : 'Verrou retiré',
      !temporary,
      true,
    );
    for (const s of sealedIds) await this.deleteBlob(s);
    return saved;
  }

  /** Forgets that a temporarily opened document must be locked again (the user removed the lock). */
  async keepUnlocked(id: string): Promise<DocumentRecord> {
    return this.enqueue(
      id,
      (latest) => {
        const { relockPending: _r, ...rest } = latest;
        void _r;
        return rest;
      },
      'modified',
      'Verrou retiré',
      true,
      true,
    );
  }

  /** Replaces a document by the given version (prefer `updateDocument` for partial changes). */
  async saveDocument(doc: DocumentRecord, action: HistoryAction | null = 'modified', detail?: string): Promise<DocumentRecord> {
    return this.updateDocument(doc.id, () => doc, action, detail);
  }

  private async patch(id: string, fn: (d: DocumentRecord) => DocumentRecord, action: HistoryAction | null, detail?: string): Promise<DocumentRecord> {
    return this.updateDocument(id, fn, action, detail);
  }

  async markOpened(id: string): Promise<void> {
    if (!this.docs.has(id)) return;
    await this.updateDocument(id, (d) => ({ ...d, openedAt: Date.now() }), 'opened', undefined, false);
  }

  async rename(id: string, title: string): Promise<DocumentRecord> {
    const t = title.trim();
    if (!t) throw new Error('Le titre ne peut pas être vide');
    return this.patch(id, (d) => ({ ...d, title: t }), 'renamed', t);
  }

  setTags(id: string, tags: string[]) {
    const clean = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 30);
    return this.patch(id, (d) => ({ ...d, tags: clean }), null);
  }

  setNotes(id: string, notes: string) {
    return this.patch(id, (d) => ({ ...d, notes: notes.slice(0, 20000) }), null);
  }

  toggleFavorite(id: string) {
    return this.patch(id, (d) => ({ ...d, favorite: !d.favorite }), null);
  }

  async moveDocuments(ids: readonly string[], folderId: string | null): Promise<void> {
    if (folderId && !this.folderMap.has(folderId)) throw new Error('Dossier introuvable');
    for (const id of ids) await this.patch(id, (d) => ({ ...d, folderId }), 'moved', folderId ? this.folderPath(folderId) : 'Racine');
  }

  /** Full copy, blobs included (documents never share blobs). */
  async duplicate(id: string): Promise<DocumentRecord> {
    const d = this.docs.get(id);
    if (!d) throw new Error('Document introuvable');
    if (d.locked) throw new Error('Déverrouillez le document avant de le dupliquer');
    const map = new Map<string, string>();
    const copyBlob = async (bid: string) => {
      if (!bid) return bid;
      const existing = map.get(bid);
      if (existing) return existing;
      const blob = await this.getBlob(bid);
      const nid = blob ? await this.putBlob(blob) : bid;
      map.set(bid, nid);
      return nid;
    };
    const pages: Page[] = [];
    for (const p of d.pages) {
      pages.push({
        ...structuredClone(p),
        id: newId('p'),
        originalBlobId: await copyBlob(p.originalBlobId),
        processedBlobId: await copyBlob(p.processedBlobId),
        thumbBlobId: await copyBlob(p.thumbBlobId),
        annotations: await Promise.all(p.annotations.map(async (a) => (a.type === 'image' ? { ...a, blobId: await copyBlob(a.blobId) } : { ...a }))),
      });
    }
    return this.createDocument({
      title: `${d.title} (copie)`,
      pages,
      source: d.source,
      folderId: d.folderId,
      tags: [...d.tags],
      notes: d.notes,
      ...(d.originalFile ? { originalFile: { ...d.originalFile, blobId: await copyBlob(d.originalFile.blobId) } } : {}),
      ...(d.kind ? { kind: d.kind } : {}),
      ...(d.invoice ? { invoice: { ...d.invoice } } : {}),
    });
  }

  async trashDocuments(ids: readonly string[]): Promise<void> {
    const now = Date.now();
    for (const id of ids) {
      const d = this.docs.get(id);
      if (!d || d.deletedAt !== undefined) continue;
      await this.updateDocument(id, (latest) => ({ ...latest, deletedAt: now }), 'deleted', undefined, false);
    }
    this.emit();
  }

  async restoreDocuments(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const d = this.docs.get(id);
      if (!d || d.deletedAt === undefined) continue;
      // If its folder no longer exists (or is in the trash), restore it too or fall back to the root.
      let folderId = d.folderId;
      if (folderId) {
        const f = this.folderMap.get(folderId);
        if (!f) folderId = null;
        else if (f.deletedAt !== undefined) await this.restoreFolder(f.id, false);
      }
      await this.updateDocument(
        id,
        (latest) => {
          const { deletedAt: _deleted, ...rest } = latest;
          void _deleted;
          return { ...rest, folderId };
        },
        'restored',
        undefined,
        false,
      );
    }
    this.emit();
  }

  /** Permanent deletion, blobs included. */
  async purge(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const d = this.docs.get(id);
      if (!d) continue;
      for (const b of Library.blobIds(d)) await this.deleteBlob(b);
      this.docs.delete(id);
      this.index.remove(id);
      await this.adapter.documents.delete(id);
    }
    this.emit();
  }

  async emptyTrash(): Promise<void> {
    await this.purge(this.trash().map((d) => d.id));
    for (const f of this.trashedFolders()) {
      this.folderMap.delete(f.id);
      await this.adapter.folders.delete(f.id);
    }
    this.emit();
  }

  // ---------- Folders ----------

  async createFolder(name: string, parentId: string | null = null): Promise<Folder> {
    const n = name.trim();
    if (!n) throw new Error('Le nom du dossier ne peut pas être vide');
    if (parentId && !this.folderMap.has(parentId)) throw new Error('Dossier parent introuvable');
    if (this.subfolders(parentId).some((f) => f.name.localeCompare(n, 'fr', { sensitivity: 'base' }) === 0)) {
      throw new Error(`Un dossier « ${n} » existe déjà ici`);
    }
    const now = Date.now();
    const f: Folder = { id: newId('f'), name: n, parentId, createdAt: now, updatedAt: now };
    await this.adapter.folders.put(f);
    this.folderMap.set(f.id, f);
    this.emit();
    return f;
  }

  async renameFolder(id: string, name: string): Promise<void> {
    const f = this.folderMap.get(id);
    const n = name.trim();
    if (!f || !n) throw new Error('Nom de dossier invalide');
    const next = { ...f, name: n, updatedAt: Date.now() };
    this.folderMap.set(id, next);
    await this.adapter.folders.put(next);
    this.reindexAll();
    this.emit();
  }

  async moveFolder(id: string, parentId: string | null): Promise<void> {
    const f = this.folderMap.get(id);
    if (!f) throw new Error('Dossier introuvable');
    if (parentId && isDescendantFolder(parentId, id, this.folderMap)) throw new Error('Impossible de déplacer un dossier dans lui-même');
    const next = { ...f, parentId, updatedAt: Date.now() };
    this.folderMap.set(id, next);
    await this.adapter.folders.put(next);
    this.reindexAll();
    this.emit();
  }

  private descendantsOf(id: string): Folder[] {
    return [...this.folderMap.values()].filter((f) => f.id !== id && isDescendantFolder(f.id, id, this.folderMap));
  }

  /** Moves a folder, its subfolders and their documents to the trash. */
  async trashFolder(id: string): Promise<void> {
    const f = this.folderMap.get(id);
    if (!f) return;
    const now = Date.now();
    const all = [f, ...this.descendantsOf(id)];
    const ids = new Set(all.map((x) => x.id));
    for (const x of all) {
      const next = { ...x, deletedAt: now };
      this.folderMap.set(x.id, next);
      await this.adapter.folders.put(next);
    }
    await this.trashDocuments(
      this.documents()
        .filter((d) => d.folderId && ids.has(d.folderId))
        .map((d) => d.id),
    );
    this.emit();
  }

  async restoreFolder(id: string, withDocuments = true): Promise<void> {
    const f = this.folderMap.get(id);
    if (!f) return;
    const all = [f, ...this.descendantsOf(id)].filter((x) => x.deletedAt !== undefined);
    const deletedAt = f.deletedAt;
    for (const x of all) {
      const { deletedAt: _d, ...rest } = x;
      void _d;
      const next: Folder = rest;
      this.folderMap.set(x.id, next);
      await this.adapter.folders.put(next);
    }
    // Restore the parent chain if needed.
    if (f.parentId && this.folderMap.get(f.parentId)?.deletedAt !== undefined) await this.restoreFolder(f.parentId, false);
    if (withDocuments) {
      const ids = new Set(all.map((x) => x.id));
      await this.restoreDocuments(
        this.trash()
          .filter((d) => d.folderId && ids.has(d.folderId) && d.deletedAt === deletedAt)
          .map((d) => d.id),
      );
    }
    this.emit();
  }

  // ---------- History ----------

  async log(action: HistoryAction, doc: DocumentRecord, detail?: string): Promise<void> {
    const e: HistoryEntry = { id: newId('h'), at: Date.now(), action, docId: doc.id, title: doc.title, ...(detail ? { detail } : {}) };
    this.historyEntries.unshift(e);
    await this.adapter.history.put(e);
    if (this.historyEntries.length > HISTORY_LIMIT) {
      const removed = this.historyEntries.splice(HISTORY_LIMIT);
      for (const r of removed) await this.adapter.history.delete(r.id);
    }
  }

  async clearHistory(): Promise<void> {
    this.historyEntries = [];
    await this.adapter.history.clear();
    this.emit();
  }

  // ---------- Settings ----------

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const r = await this.adapter.settings.get(key);
    return r === undefined ? fallback : (r.value as T);
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.adapter.settings.put({ id: key, value });
  }

  // ---------- Search index ----------

  private indexDoc(d: DocumentRecord): void {
    if (d.deletedAt !== undefined) {
      this.index.remove(d.id);
      return;
    }
    const kind = d.kind ? KIND_LABELS[d.kind] : '';
    this.index.upsert({
      id: d.id,
      title: d.title,
      folderPath: this.folderPath(d.folderId),
      tags: d.tags,
      notes: d.notes,
      content: documentText(d),
      type: `${documentFormatLabel(d)} ${d.source} ${kind} ${d.originalFile?.name.split('.').pop() ?? ''}`,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    });
  }

  private reindexAll(): void {
    this.index.clear();
    for (const d of this.docs.values()) this.indexDoc(d);
  }

  // ---------- Backup ----------

  /** Full backup as a ZIP: manifest.json (metadata) + blobs/<id>. */
  async exportBackup(): Promise<Uint8Array> {
    const docs = [...this.docs.values()];
    const manifest = {
      app: 'feuillet',
      version: 1,
      exportedAt: new Date().toISOString(),
      documents: docs,
      folders: [...this.folderMap.values()],
      history: this.historyEntries,
    };
    const files: Array<{ name: string; data: Uint8Array | string; compress?: boolean }> = [{ name: 'manifest.json', data: JSON.stringify(manifest) }];
    const types: Record<string, string> = {};
    for (const d of docs) {
      for (const id of Library.blobIds(d)) {
        const b = await this.getBlob(id);
        if (!b) continue;
        types[id] = b.type;
        files.push({ name: `blobs/${id}`, data: new Uint8Array(await b.arrayBuffer()), compress: !/^image\/(jpeg|png|webp)$/.test(b.type) });
      }
    }
    files.push({ name: 'blob-types.json', data: textEncoder.encode(JSON.stringify(types)) });
    return createZip(files);
  }

  /** Restores a backup. Existing items with the same id are kept unless the backup is newer. */
  async importBackup(bytes: Uint8Array): Promise<{ documents: number; folders: number }> {
    const zip = ZipArchive.open(bytes);
    if (!zip.has('manifest.json')) throw new Error('Sauvegarde invalide (manifest.json absent)');
    const manifest = JSON.parse(await zip.readText('manifest.json')) as {
      app?: string;
      documents?: DocumentRecord[];
      folders?: Folder[];
      history?: HistoryEntry[];
    };
    if (manifest.app !== 'feuillet' || !Array.isArray(manifest.documents)) throw new Error('Ce fichier n’est pas une sauvegarde Feuillet');
    const types = zip.has('blob-types.json') ? (JSON.parse(await zip.readText('blob-types.json')) as Record<string, string>) : {};
    let nd = 0;
    let nf = 0;
    for (const f of manifest.folders ?? []) {
      if (typeof f.id !== 'string' || typeof f.name !== 'string') continue;
      const cur = this.folderMap.get(f.id);
      if (cur && cur.updatedAt >= f.updatedAt) continue;
      this.folderMap.set(f.id, f);
      await this.adapter.folders.put(f);
      nf++;
    }
    for (const d of manifest.documents) {
      if (typeof d.id !== 'string' || !Array.isArray(d.pages)) continue;
      const cur = this.docs.get(d.id);
      if (cur && cur.revision >= d.revision) continue;
      for (const id of Library.blobIds(d)) {
        const name = `blobs/${id}`;
        if (!isSafeZipPath(name) || !zip.has(name)) continue;
        await this.putBlob(new Blob([new Uint8Array(await zip.read(name))], { type: types[id] ?? 'application/octet-stream' }), id);
      }
      this.docs.set(d.id, d);
      await this.adapter.documents.put(d);
      nd++;
    }
    for (const h of manifest.history ?? []) {
      if (!this.historyEntries.some((e) => e.id === h.id)) {
        this.historyEntries.push(h);
        await this.adapter.history.put(h);
      }
    }
    this.historyEntries.sort((a, b) => b.at - a.at);
    this.reindexAll();
    this.emit();
    return { documents: nd, folders: nf };
  }
}
