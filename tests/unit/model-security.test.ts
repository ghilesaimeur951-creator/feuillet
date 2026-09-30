import { describe, expect, test } from 'bun:test';
import { addPages, duplicatePage, movePage, removePages, replacePage, rotatePage, setFilter, UndoStack } from '../../src/core/docs/pages';
import type { Folder, Page } from '../../src/core/docs/model';
import { folderPath, isDescendantFolder, newId } from '../../src/core/docs/model';
import { NEUTRAL_ADJUSTMENTS } from '../../src/core/imaging/filters';
import { classifyImport, exportFileName, ImportError, ooxmlKindFromContentTypes, sanitizeFileName, sniffType } from '../../src/core/security/validate';

function page(id: string): Page {
  return {
    id,
    originalBlobId: `o-${id}`,
    originalWidth: 100,
    originalHeight: 200,
    quad: null,
    rotation: 0,
    filter: 'original',
    adjustments: NEUTRAL_ADJUSTMENTS,
    processedBlobId: `p-${id}`,
    width: 100,
    height: 200,
    thumbBlobId: `t-${id}`,
    annotations: [],
  };
}

const ids = (ps: Page[]) => ps.map((p) => p.id);

describe('opérations sur les pages', () => {
  const pages = ['a', 'b', 'c'].map(page);

  test('ajout, insertion, suppression', () => {
    expect(ids(addPages(pages, [page('d')]))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(addPages(pages, [page('d')], 1))).toEqual(['a', 'd', 'b', 'c']);
    expect(ids(removePages(pages, ['b']))).toEqual(['a', 'c']);
    expect(ids(pages)).toEqual(['a', 'b', 'c']); // immutability
  });

  test('réorganisation (glisser-déposer)', () => {
    expect(ids(movePage(pages, 0, 2))).toEqual(['b', 'c', 'a']);
    expect(ids(movePage(pages, 2, 0))).toEqual(['c', 'a', 'b']);
    expect(ids(movePage(pages, 1, 1))).toEqual(['a', 'b', 'c']);
    expect(ids(movePage(pages, 9, 0))).toEqual(['a', 'b', 'c']);
  });

  test('duplication et remplacement (rescan)', () => {
    expect(ids(duplicatePage(pages, 'b', (p) => ({ ...p, id: 'b2' })))).toEqual(['a', 'b', 'b2', 'c']);
    expect(replacePage(pages, 'b', { ...page('x') }).map((p) => p.id)).toEqual(['a', 'x', 'c']);
  });

  test('rotation : dimensions échangées, modulo 4', () => {
    const r = rotatePage(page('a'), 1);
    expect(r.rotation).toBe(1);
    expect([r.width, r.height]).toEqual([200, 100]);
    expect(rotatePage(rotatePage(r, -1), 0).rotation).toBe(0);
    expect(rotatePage(page('a'), 6).rotation).toBe(2);
  });

  test('filtre sur une page ou sur toutes', () => {
    expect(setFilter(pages, ['b'], 'bw').map((p) => p.filter)).toEqual(['original', 'bw', 'original']);
    expect(setFilter(pages, 'all', 'document').every((p) => p.filter === 'document')).toBe(true);
  });

  test('annuler / rétablir', () => {
    const u = new UndoStack<string[]>(['a']);
    u.push(['a', 'b']);
    u.push(['a', 'b', 'c']);
    expect(u.undo()).toEqual(['a', 'b']);
    expect(u.undo()).toEqual(['a']);
    expect(u.canUndo).toBe(false);
    expect(u.redo()).toEqual(['a', 'b']);
    u.push(['z']);
    expect(u.canRedo).toBe(false);
  });
});

describe('dossiers', () => {
  const f = (id: string, parentId: string | null, name = id): Folder => ({ id, name, parentId, createdAt: 0, updatedAt: 0 });
  const folders = new Map([f('root', null, 'Administratif'), f('tax', 'root', 'Impôts'), f('y', 'tax', '2024')].map((x) => [x.id, x]));

  test('chemin complet et détection de cycles', () => {
    expect(folderPath('y', folders)).toBe('Administratif / Impôts / 2024');
    expect(folderPath(null, folders)).toBe('');
    expect(isDescendantFolder('y', 'root', folders)).toBe(true);
    expect(isDescendantFolder('root', 'y', folders)).toBe(false);
  });

  test('identifiants uniques', () => {
    const set = new Set(Array.from({ length: 500 }, () => newId()));
    expect(set.size).toBe(500);
  });
});

describe('validation des imports', () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  test('détection par le contenu réel (octets magiques)', () => {
    expect(sniffType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('png');
    expect(sniffType(enc('%PDF-1.7\n'))).toBe('pdf');
    expect(sniffType(new Uint8Array([0x50, 0x4b, 3, 4]))).toBe('zip');
    expect(sniffType(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toBe('ole');
    expect(sniffType(enc('<svg xmlns="x"><script/></svg>'))).toBe('svg');
    expect(sniffType(enc('Bonjour'))).toBe('text');
    expect(sniffType(new Uint8Array([0, 1, 2, 3]))).toBe('unknown');
  });

  test('une extension mensongère ne suffit pas', () => {
    // A PDF renamed .jpg is imported as a PDF, a text file renamed .pdf is rejected.
    expect(classifyImport('photo.jpg', enc('%PDF-1.4 ...'))).toBe('pdf');
    expect(() => classifyImport('facture.pdf', enc('ceci n’est pas un pdf'))).toThrow(ImportError);
    expect(() => classifyImport('page.html', enc('<html><script>alert(1)</script></html>'))).toThrow();
  });

  test('formats refusés avec explication', () => {
    try {
      classifyImport('vieux.doc', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2]));
      throw new Error('attendu');
    } catch (e) {
      expect(e).toBeInstanceOf(ImportError);
      expect((e as ImportError).code).toBe('legacy-office');
      expect((e as Error).message).toContain('DOCX');
    }
    expect(() => classifyImport('x.svg', enc('<svg></svg>'))).toThrow();
    expect(() => classifyImport('vide.txt', new Uint8Array(0))).toThrow();
  });

  test('limites de taille', () => {
    const big = new Uint8Array(2000);
    big.set([0xff, 0xd8, 0xff, 0xe0]);
    expect(() => classifyImport('big.jpg', big, null, { maxImageBytes: 1000, maxPdfBytes: 1, maxOfficeBytes: 1, maxTextBytes: 1, maxImagePixels: 1 })).toThrow();
  });

  test('conteneurs OOXML', () => {
    expect(ooxmlKindFromContentTypes('<Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>')).toBe('docx');
    expect(ooxmlKindFromContentTypes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')).toBe('xlsx');
    expect(ooxmlKindFromContentTypes('application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml')).toBe('pptx');
    expect(ooxmlKindFromContentTypes('<Types/>')).toBeNull();
    expect(classifyImport('x.docx', new Uint8Array([0x50, 0x4b, 3, 4]), 'docx')).toBe('docx');
    expect(() => classifyImport('x.zip', new Uint8Array([0x50, 0x4b, 3, 4]), null)).toThrow();
  });

  test('noms de fichiers dangereux', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Windows\\evil.pdf')).toBe('evil.pdf');
    expect(sanitizeFileName('fac<>ture:|?*.pdf')).toBe('fac ture .pdf');
    expect(sanitizeFileName('CON.pdf')).toBe('_CON.pdf');
    expect(sanitizeFileName('...')).toBe('document');
    expect(sanitizeFileName('a\u0000b\u001fc')).toBe('a b c');
    expect([...sanitizeFileName('x'.repeat(500))].length).toBe(120);
    expect(exportFileName('Facture EDF — mars', 'pdf')).toBe('Facture EDF — mars.pdf');
    expect(exportFileName('scan.pdf', 'pdf')).toBe('scan.pdf');
  });
});
