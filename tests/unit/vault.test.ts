import { beforeEach, describe, expect, test } from 'bun:test';
import { Library } from '../../src/services/library';
import type { LibraryAdapter } from '../../src/services/library';
import { createMemoryAdapter } from '../../src/services/storage/adapter';
import type { DocumentRecord, Folder, HistoryEntry, Page } from '../../src/core/docs/model';
import { newId, pageCount } from '../../src/core/docs/model';
import { NEUTRAL_ADJUSTMENTS } from '../../src/core/imaging/filters';
import { checkVaultPassword, deriveVaultKey, isSealed, seal, unseal, WrongPasswordError } from '../../src/core/security/vault';
import { textEncoder } from '../../src/core/util/bytes';

const SECRET = 'NUMERO-SECURITE-SOCIALE-1850775123456';

let adapter: LibraryAdapter;
let lib: Library;

async function page(l: Library): Promise<Page> {
  const b = (s: string, type = 'image/jpeg') => new Blob([s], { type });
  return {
    id: newId('p'),
    originalBlobId: await l.putBlob(b(`orig ${SECRET}`)),
    originalWidth: 100,
    originalHeight: 140,
    quad: null,
    rotation: 0,
    filter: 'document',
    adjustments: NEUTRAL_ADJUSTMENTS,
    processedBlobId: await l.putBlob(b(`processed ${SECRET}`)),
    width: 100,
    height: 140,
    thumbBlobId: await l.putBlob(b('thumb', 'image/webp')),
    annotations: [{ id: 'sig', type: 'image', blobId: await l.putBlob(b('signature', 'image/png')), x: 0, y: 0, w: 0.2, h: 0.1, signature: true }],
    ocr: { text: `Attestation ${SECRET}`, words: [], confidence: 90, language: 'fra', width: 100, height: 140, createdAt: 1 },
  };
}

/** Every byte the storage holds, as text (to prove the secret no longer appears anywhere). */
async function storageDump(): Promise<string> {
  const parts: string[] = [JSON.stringify(await adapter.documents.all())];
  for (const k of await adapter.blobs.keys()) parts.push(new TextDecoder('latin1').decode(await (await adapter.blobs.get(k))!.arrayBuffer()));
  return parts.join('\n');
}

beforeEach(async () => {
  adapter = createMemoryAdapter<DocumentRecord, Folder, HistoryEntry>();
  lib = new Library(adapter);
  lib.vaultIterations = 1000; // fast tests; the app uses 600 000
  await lib.init();
});

describe('chiffrement (vault)', () => {
  test('AES-GCM : aller-retour, mauvais mot de passe, mauvais document', async () => {
    const k = await deriveVaultKey('correct horse', undefined, 1000);
    const sealed = await seal(k.key, textEncoder.encode('bonjour'), 'doc1');
    expect(isSealed(sealed)).toBe(true);
    expect(new TextDecoder().decode(await unseal(k.key, sealed, 'doc1'))).toBe('bonjour');
    const wrong = await deriveVaultKey('wrong horse', k.salt, 1000);
    await expect(unseal(wrong.key, sealed, 'doc1')).rejects.toBeInstanceOf(WrongPasswordError);
    await expect(unseal(k.key, sealed, 'doc2')).rejects.toBeInstanceOf(WrongPasswordError);
    const tampered = sealed.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 1;
    await expect(unseal(k.key, tampered, 'doc1')).rejects.toBeInstanceOf(WrongPasswordError);
  });

  test('IV aléatoire : deux chiffrements du même contenu diffèrent', async () => {
    const k = await deriveVaultKey('motdepasse', undefined, 1000);
    const a = await seal(k.key, textEncoder.encode('x'), 'd');
    const b = await seal(k.key, textEncoder.encode('x'), 'd');
    expect(a.join()).not.toBe(b.join());
  });

  test('mot de passe trop court refusé', () => {
    expect(checkVaultPassword('12345')).not.toBeNull();
    expect(checkVaultPassword('123456')).toBeNull();
  });
});

describe('documents verrouillés', () => {
  test('verrouiller : plus aucune donnée lisible, recherche masquée ; déverrouiller restaure tout', async () => {
    const d = await lib.createDocument({
      title: 'Attestation',
      source: 'scan',
      pages: [await page(lib), await page(lib)],
      tags: ['santé'],
      notes: `note ${SECRET}`,
      originalFile: {
        blobId: await lib.putBlob(new Blob([`pdf ${SECRET}`], { type: 'application/pdf' })),
        name: 'a.pdf',
        mime: 'application/pdf',
        size: 10,
      },
    });
    expect(lib.search('1850775123456')).toHaveLength(1);
    expect(await storageDump()).toContain(SECRET);

    const locked = await lib.lockDocument(d.id, 'motdepasse');
    expect(locked.locked).toBeDefined();
    expect(locked.pages).toHaveLength(0);
    expect(pageCount(locked)).toBe(2);
    expect(locked.tags).toEqual([]);
    expect(locked.notes).toBe('');
    expect(locked.originalFile).toBeUndefined();
    expect(await storageDump()).not.toContain(SECRET);
    expect(await storageDump()).not.toContain('signature');
    expect(lib.search('1850775123456')).toHaveLength(0);
    expect(lib.search('santé')).toHaveLength(0);
    expect(lib.search('Attestation')).toHaveLength(1); // the title stays visible
    expect(await lib.collectGarbage()).toBe(0); // sealed blobs are referenced

    await expect(lib.unlockDocument(d.id, 'mauvais!')).rejects.toBeInstanceOf(WrongPasswordError);
    expect(lib.get(d.id)?.locked).toBeDefined();

    const open = await lib.unlockDocument(d.id, 'motdepasse');
    expect(open.locked).toBeUndefined();
    expect(open.pages).toHaveLength(2);
    expect(open.tags).toEqual(['santé']);
    expect(open.notes).toBe(`note ${SECRET}`);
    expect(open.pages[0]?.ocr?.text).toContain(SECRET);
    expect(await (await lib.getBlob(open.pages[1]!.processedBlobId))!.text()).toBe(`processed ${SECRET}`);
    expect((await lib.getBlob(open.pages[0]!.thumbBlobId))!.type).toBe('image/webp');
    const sig = open.pages[0]!.annotations[0]!;
    expect(sig.type === 'image' && (await (await lib.getBlob(sig.blobId))!.text())).toBe('signature');
    expect(await (await lib.getBlob(open.originalFile!.blobId))!.text()).toBe(`pdf ${SECRET}`);
    expect(lib.search('1850775123456')).toHaveLength(1);
    // No leftover blobs: exactly the referenced ones.
    expect((await adapter.blobs.keys()).sort()).toEqual(Library.blobIds(open).sort());
  });

  test('persistance : un document verrouillé le reste après fermeture et se déverrouille ensuite', async () => {
    const d = await lib.createDocument({ title: 'Secret', source: 'scan', pages: [await page(lib)] });
    await lib.lockDocument(d.id, 'motdepasse');
    const again = new Library(adapter);
    await again.init();
    expect(again.get(d.id)?.locked).toBeDefined();
    const open = await again.unlockDocument(d.id, 'motdepasse');
    expect(open.pages).toHaveLength(1);
  });

  test('modifications publiques permises, contenu protégé contre les écritures concurrentes', async () => {
    const d = await lib.createDocument({ title: 'Secret', source: 'scan', pages: [await page(lib)] });
    await lib.lockDocument(d.id, 'motdepasse');
    await lib.rename(d.id, 'Neutre');
    await lib.toggleFavorite(d.id);
    await lib.setTags(d.id, ['fuite']);
    // A stale writer (e.g. background OCR) tries to put plaintext pages back: ignored.
    await lib.updateDocument(d.id, (latest) => ({ ...latest, pages: d.pages, notes: 'fuite' }));
    const cur = lib.get(d.id)!;
    expect(cur.title).toBe('Neutre');
    expect(cur.favorite).toBe(true);
    expect(cur.pages).toEqual([]);
    expect(cur.tags).toEqual([]);
    expect(cur.notes).toBe('');
    expect((await lib.unlockDocument(d.id, 'motdepasse')).pages).toHaveLength(1);
    await expect(lib.lockDocument(d.id, '123')).rejects.toThrow(/au moins/);
  });

  test('ouverture temporaire puis reverrouillage silencieux', async () => {
    const d = await lib.createDocument({ title: 'Secret', source: 'scan', pages: [await page(lib)] });
    const locked = await lib.lockDocument(d.id, 'motdepasse');
    const open = await lib.unlockDocument(d.id, 'motdepasse', true);
    expect(open.relockPending).toBe(true);
    expect(open.updatedAt).toBe(locked.updatedAt);
    const relocked = await lib.lockDocument(d.id, 'motdepasse', true);
    expect(relocked.locked).toBeDefined();
    expect(relocked.relockPending).toBeUndefined();
    expect(relocked.updatedAt).toBe(locked.updatedAt);
    await expect(lib.duplicate(d.id)).rejects.toThrow(/Déverrouillez/);
  });

  test('sauvegarde / restauration conserve le chiffrement', async () => {
    const d = await lib.createDocument({ title: 'Secret', source: 'scan', pages: [await page(lib)] });
    await lib.lockDocument(d.id, 'motdepasse');
    const zip = await lib.exportBackup();
    expect(new TextDecoder('latin1').decode(zip)).not.toContain(SECRET);
    const other = new Library(createMemoryAdapter<DocumentRecord, Folder, HistoryEntry>());
    await other.init();
    await other.importBackup(zip);
    const open = await other.unlockDocument(d.id, 'motdepasse');
    expect(await (await other.getBlob(open.pages[0]!.processedBlobId))!.text()).toBe(`processed ${SECRET}`);
  });
});
