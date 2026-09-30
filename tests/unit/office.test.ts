import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createZip, crc32, isSafeZipPath, ZipArchive } from '../../src/core/zip/zip';
import { parseDocx } from '../../src/core/office/docx';
import { excelSerialToDate, parseCellRef, parseXlsx } from '../../src/core/office/xlsx';
import { parsePptx, parseTxt } from '../../src/core/office/pptx';
import { documentText } from '../../src/core/office/model';
import type { ExtractedDocument } from '../../src/core/office/model';
import { breakLines, layoutDocument } from '../../src/core/office/layout';
import type { FontSpec } from '../../src/core/office/layout';
import { parseXml, textContent, descendants } from '../../src/core/office/xml';

const DIR = join(import.meta.dir, '..', 'fixtures', 'office');
const open = (f: string) => ZipArchive.open(readFileSync(join(DIR, f)));
const measure = (t: string, f: FontSpec) => t.length * f.size * 0.5;

describe('ZIP', () => {
  test('aller-retour avec compression et CRC', async () => {
    const text = 'Bonjour — '.repeat(200);
    const zip = await createZip([
      { name: 'a.txt', data: text },
      { name: 'dir/b.bin', data: new Uint8Array([1, 2, 3]), compress: false },
    ]);
    const z = ZipArchive.open(zip);
    expect(z.names()).toEqual(['a.txt', 'dir/b.bin']);
    expect(await z.readText('a.txt')).toBe(text);
    expect(Array.from(await z.read('dir/b.bin'))).toEqual([1, 2, 3]);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  test('archive lisible par unzip (interopérabilité)', async () => {
    const zip = await createZip([{ name: 'hello.txt', data: 'bonjour' }]);
    const r = spawnSync('unzip', ['-t', '/dev/stdin'], { input: zip, encoding: 'utf8' });
    if (r.status !== null) expect(r.stdout + r.stderr).toMatch(/No errors|OK/);
  });

  test('protection : chemins dangereux et bombes ZIP', async () => {
    expect(isSafeZipPath('../etc/passwd')).toBe(false);
    expect(isSafeZipPath('/abs')).toBe(false);
    expect(isSafeZipPath('C:/x')).toBe(false);
    expect(isSafeZipPath('ok/fichier.json')).toBe(true);
    await expect(createZip([{ name: '../x', data: 'a' }])).rejects.toThrow();
    const big = await createZip([{ name: 'zeros.bin', data: new Uint8Array(2_000_000) }]);
    expect(() => ZipArchive.open(big, { maxEntries: 10, maxTotalSize: 1_000_000, maxEntrySize: 1_000_000 })).toThrow();
    expect(() => ZipArchive.open(new Uint8Array(100))).toThrow();
  });
});

describe('XML', () => {
  test('entités, CDATA, commentaires, DOCTYPE ignoré (pas d’XXE)', () => {
    const x = parseXml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "BOOM">]><!-- c --><a:r xmlns:a="u" a:v="1 &amp; 2"><t>&lt;b&gt; &#233;&#x20AC;</t><![CDATA[<raw>]]><t>&e;</t></a:r>');
    expect(x.name).toBe('r');
    expect(x.attrs.v).toBe('1 & 2');
    expect(textContent(x)).toBe('<b> é€<raw>&e;');
    expect(descendants(x, 't')).toHaveLength(2);
  });
});

describe('import Office', () => {
  test('DOCX : titres, gras, listes, tableau', async () => {
    const doc = await parseDocx(open('sample.docx'));
    const text = documentText(doc);
    expect(text).toContain('Rapport trimestriel');
    expect(text).toContain('paragraphe important');
    expect(text).toContain('é à ç œ €');
    expect(doc.blocks.find((b) => b.kind === 'heading')).toBeDefined();
    const table = doc.blocks.find((b) => b.kind === 'table');
    expect(table && table.kind === 'table' ? table.rows : []).toEqual([
      ['Produit', 'Prix'],
      ['Papier A4', '4,50'],
      ['Encre', '19,90'],
    ]);
    const bold = doc.blocks.flatMap((b) => (b.kind === 'paragraph' ? b.runs : [])).find((r) => r.bold);
    expect(bold?.text).toBe('paragraphe important');
    const lists = doc.blocks.filter((b) => b.kind === 'paragraph' && b.list);
    expect(lists.length).toBeGreaterThanOrEqual(4);
    expect(lists.some((b) => b.kind === 'paragraph' && b.list === 'number')).toBe(true);
    expect(lists.some((b) => b.kind === 'paragraph' && b.list === 'bullet')).toBe(true);
  });

  test('XLSX : chaînes partagées, nombres, en-têtes', async () => {
    const doc = await parseXlsx(open('releve.xlsx'));
    const table = doc.blocks.find((b) => b.kind === 'table');
    expect(table?.kind).toBe('table');
    const rows = table && table.kind === 'table' ? table.rows : [];
    expect(rows[0]).toEqual(['Date', 'Libellé', 'Montant']);
    expect(rows[1]?.[1]).toBe('Facture EDF');
    expect(rows[1]?.[2]).toBe('84.2');
    expect(rows[1]?.[0]).toBe('2024-03-01');
    expect(parseCellRef('AB10')).toEqual({ col: 27, row: 9 });
    expect(excelSerialToDate(45352)).toBe('2024-03-01');
  });

  test('PPTX : une page par diapositive, titres et puces', async () => {
    const doc = await parsePptx(open('deck.pptx'));
    const text = documentText(doc);
    expect(text).toContain('Présentation du projet');
    expect(text).toContain('Budget prévisionnel');
    expect(text).toContain('Merci de votre attention');
    expect(doc.blocks.filter((b) => b.kind === 'pagebreak')).toHaveLength(1);
    expect(doc.blocks.filter((b) => b.kind === 'heading').length).toBeGreaterThanOrEqual(2);
  });

  test('TXT : UTF-8 et repli Windows-1252', () => {
    expect(documentText(parseTxt(readFileSync(join(DIR, 'notes.txt'))))).toContain('Notes de réunion');
    expect(documentText(parseTxt(readFileSync(join(DIR, 'legacy.txt'))))).toContain('Deuxième ligne');
  });
});

describe('mise en page des documents convertis', () => {
  test('coupure de lignes gloutonne et mots trop longs', () => {
    const font = { size: 10, bold: false, italic: false };
    const tokens = 'aaa bbb ccc ddd'.split(/( )/).map((t) => ({ text: t, font, space: t === ' ', newline: false }));
    const lines = breakLines(tokens, 40, measure, 1.2);
    expect(lines.map((l) => l.items.map((i) => i.text).join(''))).toEqual(['aaa bbb', 'ccc ddd']);
    const long = breakLines([{ text: 'x'.repeat(30), font, space: false, newline: false }], 50, measure, 1.2);
    expect(long.length).toBe(3);
  });

  test('pagination, sauts de page et mots positionnés', () => {
    const doc: ExtractedDocument = {
      source: 'txt',
      warnings: [],
      blocks: [
        { kind: 'heading', level: 1, runs: [{ text: 'Titre' }] },
        ...Array.from({ length: 120 }, (_, i) => ({ kind: 'paragraph' as const, runs: [{ text: `Ligne numéro ${i} avec du texte.` }] })),
        { kind: 'pagebreak' },
        { kind: 'table', rows: [['A', 'B'], ['1', '2']] },
      ],
    };
    const pages = layoutDocument(doc, { width: 600, height: 800, margin: 50, baseSize: 12, lineHeight: 1.4, measure, imageSize: () => null });
    expect(pages.length).toBeGreaterThanOrEqual(3);
    for (const p of pages) {
      for (const op of p.ops) if (op.type === 'text') expect(op.y).toBeLessThanOrEqual(800 - 50 + 12);
    }
    const last = pages[pages.length - 1];
    expect(last?.text).toContain('A\tB');
    expect(pages[0]?.words[0]?.text).toBe('Titre');
  });
});
