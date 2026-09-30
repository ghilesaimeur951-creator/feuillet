import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OcrEngine } from '../../src/services/ocr/engine';
import type { TesseractCoreFactory } from '../../src/services/ocr/engine';
import { classifyDocument, extractInvoiceData } from '../../src/core/ocr/analysis';

/**
 * Real OCR with the exact WebAssembly build and language models shipped in public/vendor
 * (same engine code as the browser worker).
 */
const ROOT = join(import.meta.dir, '..', '..');
const VENDOR = join(ROOT, 'public', 'vendor');
const FIX = join(ROOT, 'tests', 'fixtures', 'ocr');

async function engine(langs: string[]): Promise<OcrEngine> {
  const mod = (await import(join(VENDOR, 'tesseract', 'tesseract-core-simd-lstm.wasm.js'))) as { default: TesseractCoreFactory };
  const e = await OcrEngine.create(mod.default);
  for (const l of langs) e.loadLanguage(l, readFileSync(join(VENDOR, 'tessdata', `${l}.traineddata`)));
  e.init(langs);
  return e;
}

describe('OCR Tesseract (WASM local)', () => {
  test('reconnaît une facture en français, avec positions des mots', async () => {
    const e = await engine(['fra']);
    const r = e.recognize(readFileSync(join(FIX, 'invoice.jpg')));
    expect(r.text).toContain('Facture EDF');
    expect(r.text).toContain('84,20');
    expect(r.text).toMatch(/échéance/);
    expect(r.confidence).toBeGreaterThan(70);
    const edf = r.words.find((w) => w.text === 'EDF');
    expect(edf).toBeDefined();
    expect(edf?.width).toBeGreaterThan(20);
    // End-to-end post-processing on real OCR output.
    expect(classifyDocument(r.text).kind).toBe('facture');
    expect(extractInvoiceData(r.text).totalTTC).toBe(84.2);
    e.dispose();
  }, 60000);

  test('multilingue : allemand, italien, espagnol', async () => {
    const e = await engine(['deu', 'ita', 'spa']);
    const r = e.recognize(readFileSync(join(FIX, 'multilang.png')));
    expect(r.text).toContain('fällig');
    expect(r.text).toContain('è pagata');
    expect(r.text).toMatch(/est[áà] pagada/); // accent ambiguity between the Italian and Spanish models
    e.dispose();
  }, 60000);

  test('refuse une langue non chargée ou un code invalide', async () => {
    const mod = (await import(join(VENDOR, 'tesseract', 'tesseract-core-simd-lstm.wasm.js'))) as { default: TesseractCoreFactory };
    const e = await OcrEngine.create(mod.default);
    expect(() => e.init(['fra'])).toThrow();
    expect(() => e.loadLanguage('../x', new Uint8Array())).toThrow();
  }, 60000);
});
