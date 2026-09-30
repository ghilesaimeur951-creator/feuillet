import { beforeEach, describe, expect, test } from 'bun:test';
import { Library } from '../../src/services/library';
import type { LibraryAdapter } from '../../src/services/library';
import { createMemoryAdapter } from '../../src/services/storage/adapter';
import type { DocumentRecord, Folder, HistoryEntry, Page } from '../../src/core/docs/model';
import { newId } from '../../src/core/docs/model';
import { NEUTRAL_ADJUSTMENTS } from '../../src/core/imaging/filters';

let adapter: LibraryAdapter;
let lib: Library;

async function makePage(l: Library, text?: string): Promise<Page> {
  const blob = (s: string) => new Blob([s], { type: 'image/jpeg' });
  return {
    id: newId('p'),
    originalBlobId: await l.putBlob(blob('original-bytes')),
    originalWidth: 100,
    originalHeight: 140,
    quad: null,
    rotation: 0,
    filter: 'document',
    adjustments: NEUTRAL_ADJUSTMENTS,
    processedBlobId: await l.putBlob(blob('processed')),
    width: 100,
    height: 140,
    thumbBlobId: await l.putBlob(blob('t')),
    annotations: [],
    ...(text ? { ocr: { text, words: [], confidence: 90, language: 'fra', width: 100, height: 140, createdAt: Date.now() } } : {}),
  };
}

beforeEach(async () => {
  adapter = createMemoryAdapter<DocumentRecord, Folder, HistoryEntry>();
  lib = new Library(adapter);
  await lib.init();
});

describe('bibliothèque et stockage', () => {
  test('création, persistance et rechargement (fermer / rouvrir)', async () => {
    const doc = await lib.createDocument({ title: 'Scan 27', source: 'scan', pages: [await makePage(lib), await makePage(lib)] });
    expect(doc.sizeBytes).toBe(2 * ('original-bytes'.length + 'processed'.length + 1));
    const reopened = new Library(adapter);
    await reopened.init();
    const again = reopened.get(doc.id);
    expect(again?.title).toBe('Scan 27');
    expect(again?.pages).toHaveLength(2);
    expect(await (await reopened.getBlob(again?.pages[0]?.processedBlobId ?? ''))?.text()).toBe('processed');
  });

  test('recherche OCR : « facture EDF » trouve « Scan 27 »', async () => {
    await lib.createDocument({ title: 'Scan 27', source: 'scan', pages: [await makePage(lib, 'EDF\nFacture d’électricité\nTotal TTC 84,20 €')] });
    await lib.createDocument({ title: 'Autre', source: 'scan', pages: [await makePage(lib, 'Rien à voir')] });
    const hits = lib.search('facture EDF');
    expect(hits.map((h) => h.doc.title)).toEqual(['Scan 27']);
  });

  test('renommer, tags, notes, favoris, historique', async () => {
    const d = await lib.createDocument({ title: 'x', source: 'scan', pages: [await makePage(lib)] });
    await lib.rename(d.id, 'Contrat bail');
    await lib.setTags(d.id, [' Logement ', 'logement', 'Bail']);
    await lib.setNotes(d.id, 'signé en mars');
    await lib.toggleFavorite(d.id);
    const cur = lib.get(d.id) as DocumentRecord;
    expect(cur.title).toBe('Contrat bail');
    expect(cur.tags).toEqual(['logement', 'bail']);
    expect(cur.favorite).toBe(true);
    expect(cur.revision).toBeGreaterThan(d.revision);
    expect(lib.search('signé').length).toBe(1);
    expect(lib.search('logement').length).toBe(1);
    expect(lib.history().map((h) => h.action)).toEqual(['renamed', 'created']);
    await expect(lib.rename(d.id, '   ')).rejects.toThrow();
  });

  test('corbeille : suppression, restauration, purge avec les blobs', async () => {
    const d = await lib.createDocument({ title: 'À jeter', source: 'scan', pages: [await makePage(lib, 'contenu unique zebra')] });
    await lib.trashDocuments([d.id]);
    expect(lib.documents()).toHaveLength(0);
    expect(lib.trash()).toHaveLength(1);
    expect(lib.search('zebra')).toHaveLength(0);
    await lib.restoreDocuments([d.id]);
    expect(lib.documents()).toHaveLength(1);
    expect(lib.search('zebra')).toHaveLength(1);
    await lib.trashDocuments([d.id]);
    await lib.emptyTrash();
    expect(lib.trash()).toHaveLength(0);
    expect(await adapter.blobs.keys()).toHaveLength(0);
  });

  test('purge automatique après 30 jours', async () => {
    const d = await lib.createDocument({ title: 'Vieux', source: 'scan', pages: [await makePage(lib)] });
    await lib.trashDocuments([d.id]);
    const later = new Library(adapter);
    await later.init(Date.now() + 31 * 86400_000);
    expect(later.trash()).toHaveLength(0);
  });

  test('duplication : copie indépendante des blobs', async () => {
    const d = await lib.createDocument({ title: 'Orig', source: 'scan', pages: [await makePage(lib)] });
    const c = await lib.duplicate(d.id);
    expect(c.title).toBe('Orig (copie)');
    expect(c.pages[0]?.processedBlobId).not.toBe(d.pages[0]?.processedBlobId);
    await lib.trashDocuments([d.id]);
    await lib.emptyTrash();
    expect(await (await lib.getBlob(c.pages[0]?.processedBlobId ?? ''))?.text()).toBe('processed');
  });

  test('dossiers, sous-dossiers, déplacement, cycles, suppression récursive et restauration', async () => {
    const admin = await lib.createFolder('Administratif');
    const impots = await lib.createFolder('Impôts', admin.id);
    await expect(lib.createFolder('impôts', admin.id)).rejects.toThrow();
    const d = await lib.createDocument({ title: 'Avis 2024', source: 'scan', pages: [await makePage(lib)] });
    await lib.moveDocuments([d.id], impots.id);
    expect(lib.documentsInFolder(impots.id).map((x) => x.id)).toEqual([d.id]);
    expect(lib.search('impots').map((h) => h.id)).toEqual([d.id]);
    await expect(lib.moveFolder(admin.id, impots.id)).rejects.toThrow();
    await lib.renameFolder(admin.id, 'Papiers');
    expect(lib.folderPath(impots.id)).toBe('Papiers / Impôts');
    await lib.trashFolder(admin.id);
    expect(lib.folders()).toHaveLength(0);
    expect(lib.documents()).toHaveLength(0);
    await lib.restoreFolder(admin.id);
    expect(lib.folders()).toHaveLength(2);
    expect(lib.get(d.id)?.deletedAt).toBeUndefined();
    expect(lib.get(d.id)?.folderId).toBe(impots.id);
  });

  test('restaurer un document dont le dossier est dans la corbeille restaure le dossier', async () => {
    const f = await lib.createFolder('Temp');
    const d = await lib.createDocument({ title: 'Dedans', source: 'scan', folderId: f.id, pages: [await makePage(lib)] });
    await lib.trashFolder(f.id);
    await lib.restoreDocuments([d.id]);
    expect(lib.folder(f.id)?.deletedAt).toBeUndefined();
  });

  test('ramasse-miettes des blobs orphelins', async () => {
    await lib.putBlob(new Blob(['orphelin']));
    const d = await lib.createDocument({ title: 'Gardé', source: 'scan', pages: [await makePage(lib)] });
    expect(await lib.collectGarbage()).toBe(1);
    expect((await adapter.blobs.keys()).length).toBe(Library.blobIds(d).length);
  });

  test('sauvegarde et restauration ZIP', async () => {
    const f = await lib.createFolder('Banque');
    await lib.createDocument({ title: 'Relevé', source: 'scan', folderId: f.id, pages: [await makePage(lib, 'solde créditeur')] });
    const backup = await lib.exportBackup();
    const other = new Library(createMemoryAdapter<DocumentRecord, Folder, HistoryEntry>());
    await other.init();
    const r = await other.importBackup(backup);
    expect(r).toEqual({ documents: 1, folders: 1 });
    const d = other.documents()[0] as DocumentRecord;
    expect(other.folderPath(d.folderId)).toBe('Banque');
    expect(await (await other.getBlob(d.pages[0]?.processedBlobId ?? ''))?.text()).toBe('processed');
    expect(other.search('crediteur')).toHaveLength(1);
    // Importing twice does not duplicate.
    expect(await other.importBackup(backup)).toEqual({ documents: 0, folders: 0 });
    await expect(other.importBackup(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });

  test('écritures concurrentes sérialisées : aucune mise à jour perdue', async () => {
    const d = await lib.createDocument({ title: 'Concurrence', source: 'scan', pages: [await makePage(lib), await makePage(lib)] });
    const [p1, p2] = d.pages as [Page, Page];
    // Background OCR and a user edit started at the same time, each changing a different page.
    const slowOcr = lib.updateDocument(d.id, async (latest) => {
      await new Promise((r) => setTimeout(r, 20));
      return { ...latest, pages: latest.pages.map((p) => (p.id === p1.id ? { ...p, text: 'texte OCR' } : p)) };
    });
    const edit = lib.updateDocument(d.id, (latest) => ({
      ...latest,
      pages: latest.pages.map((p) => (p.id === p2.id ? { ...p, filter: 'bw' as const } : p)),
    }));
    await Promise.all([slowOcr, edit]);
    const final = lib.get(d.id) as DocumentRecord;
    expect(final.pages[0]?.text).toBe('texte OCR');
    expect(final.pages[1]?.filter).toBe('bw');
    expect(final.revision).toBe(d.revision + 2);
  });

  test('paramètres persistants', async () => {
    expect(await lib.getSetting('theme', 'system')).toBe('system');
    await lib.setSetting('theme', 'dark');
    expect(await lib.getSetting('theme', 'system')).toBe('dark');
  });
});
