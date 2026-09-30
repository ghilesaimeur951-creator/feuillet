import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { buildPdf } from '../../src/core/pdf/writer';
import { readJpegInfo } from '../../src/core/pdf/jpeg';
import { estimatePdfSize, layoutPage, QUALITY_PROFILES } from '../../src/core/pdf/layout';
import { encodeWinAnsi, helveticaWidth } from '../../src/core/pdf/text';

const FIX = join(import.meta.dir, '..', 'fixtures', 'pdf');
const page = readFileSync(join(FIX, 'page.jpg'));
const landscape = readFileSync(join(FIX, 'landscape.jpg'));
const gray = readFileSync(join(FIX, 'gray.jpg'));
const OUT = join(tmpdir(), 'feuillet-pdf-tests');
mkdirSync(OUT, { recursive: true });

function has(cmd: string): boolean {
  return spawnSync('which', [cmd]).status === 0;
}

function run(cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(cmd, args, { encoding: 'utf8' });
}

describe('mise en page', () => {
  test('A4 portrait, image centrée et contenue dans les marges', () => {
    const l = layoutPage(1000, 2000, 'A4', 'portrait', 20);
    expect(l.pageWidth).toBeCloseTo(595.28, 1);
    expect(l.pageHeight).toBeCloseTo(841.89, 1);
    expect(l.height).toBeCloseTo(841.89 - 40, 1);
    expect(l.x).toBeCloseTo((595.28 - l.width) / 2, 3);
  });

  test('orientation automatique paysage', () => {
    const l = layoutPage(2000, 1000, 'Letter', 'auto', 0);
    expect(l.pageWidth).toBe(792);
    expect(l.pageHeight).toBe(612);
  });

  test('taille automatique = ratio de l’image', () => {
    const l = layoutPage(300, 900, 'auto', 'auto', 10);
    expect((l.pageHeight - 20) / (l.pageWidth - 20)).toBeCloseTo(3, 5);
  });

  test('estimation de taille croissante avec la qualité', () => {
    const pages = [{ width: 2480, height: 3508 }];
    const [small, std, high] = QUALITY_PROFILES.map((p) => estimatePdfSize(pages, p));
    expect(small as number).toBeLessThan(std as number);
    expect(std as number).toBeLessThan(high as number);
  });
});

describe('encodage du texte', () => {
  test('WinAnsi : accents français, euro, œ', () => {
    expect(Array.from(encodeWinAnsi('é€œ'))).toEqual([0xe9, 0x80, 0x9c]);
    expect(Array.from(encodeWinAnsi('ş'))).toEqual([0x73]); // transliterated
    expect(helveticaWidth(encodeWinAnsi('A'), 1000)).toBe(667);
  });

  test('lecture des en-têtes JPEG', () => {
    expect(readJpegInfo(page)).toEqual({ width: 620, height: 877, components: 3, adobe: false });
    expect(readJpegInfo(gray).components).toBe(1);
    expect(() => readJpegInfo(new Uint8Array([1, 2, 3]))).toThrow();
  });
});

describe('génération PDF', () => {
  test('PDF multipage valide (qpdf), dimensions et texte OCR recherchable', async () => {
    const bytes = await buildPdf({
      pages: [
        {
          jpeg: page,
          size: 'A4',
          orientation: 'auto',
          margin: 0,
          words: [
            { text: 'Facture', x: 40, y: 55, width: 110, height: 32 },
            { text: 'EDF', x: 160, y: 55, width: 60, height: 32 },
            { text: 'Montant', x: 40, y: 115, width: 110, height: 32 },
            { text: 'TTC', x: 160, y: 115, width: 60, height: 32 },
            { text: '84,20', x: 230, y: 115, width: 80, height: 32 },
            { text: '€', x: 320, y: 115, width: 20, height: 32 },
          ],
          footer: '1 / 3',
        },
        { jpeg: landscape, size: 'A4', orientation: 'auto', margin: 18, footer: '2 / 3', watermark: { text: 'CONFIDENTIEL', opacity: 0.2 } },
        { jpeg: gray, size: 'auto', orientation: 'auto', margin: 0 },
      ],
      info: { title: 'Facture EDF — mars', author: 'Test' },
    });
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('%PDF-1.7');
    const file = join(OUT, 'multi.pdf');
    writeFileSync(file, bytes);
    if (has('qpdf')) {
      const r = run('qpdf', ['--check', file]);
      expect(r.stdout + r.stderr).toContain('No syntax or stream encoding errors');
      expect(r.status).toBe(0);
    }
    if (has('pdfinfo')) {
      const info = run('pdfinfo', [file]).stdout;
      expect(info).toMatch(/Pages:\s+3/);
      expect(info).toContain('Facture EDF — mars');
      expect(info).toMatch(/Page size:\s+595\.28 x 841\.89/);
      const p2 = run('pdfinfo', ['-f', '2', '-l', '2', file]).stdout;
      expect(p2).toMatch(/Page\s+2 size:\s+841\.89 x 595\.28/);
    }
    if (has('pdftotext')) {
      const text = run('pdftotext', ['-f', '1', '-l', '1', file, '-']).stdout;
      expect(text).toContain('Facture EDF');
      expect(text).toContain('84,20');
      expect(text).toContain('€');
    }
  });

  test('PDF protégé par mot de passe (AES-256)', async () => {
    const bytes = await buildPdf({
      pages: [{ jpeg: page, size: 'A4', orientation: 'portrait', margin: 10, words: [{ text: 'Secret', x: 40, y: 55, width: 110, height: 32 }] }],
      info: { title: 'Confidentiel' },
      password: { user: 'Mot-de-passe-€' },
    });
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).toContain('/Filter /Standard /V 5 /R 6');
    expect(text).not.toContain('Secret');
    const file = join(OUT, 'encrypted.pdf');
    writeFileSync(file, bytes);
    if (has('qpdf')) {
      const bad = run('qpdf', ['--check', '--password=faux', file]);
      expect(bad.status).not.toBe(0);
      const ok = run('qpdf', ['--check', '--password=Mot-de-passe-€', file]);
      expect(ok.stdout).toContain('No syntax or stream encoding errors');
      const dec = join(OUT, 'decrypted.pdf');
      expect(run('qpdf', ['--password=Mot-de-passe-€', '--decrypt', file, dec]).status).toBe(0);
      if (has('pdftotext')) expect(run('pdftotext', [dec, '-']).stdout).toContain('Secret');
      if (has('pdfinfo')) expect(run('pdfinfo', [dec]).stdout).toContain('Confidentiel');
    }
  }, 30000);

  test('refuse un document vide', async () => {
    await expect(buildPdf({ pages: [] })).rejects.toThrow();
  });
});
