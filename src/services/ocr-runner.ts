import type { DocumentRecord, Page } from '../core/docs/model';
import { documentText } from '../core/docs/model';
import { classifyDocument, extractInvoiceData, suggestTags, suggestTitle } from '../core/ocr/analysis';
import type { Library } from './library';
import { ocr } from './ocr/client';
import type { OcrProgress } from './ocr/client';
import { settings } from './settings';

/** True when the title is a generic default we may replace by an OCR-based name. */
export function isDefaultTitle(title: string): boolean {
  return /^(scan|document|import|numérisation|page)\b[\s\d:/.,h-]*$/i.test(title.trim()) || /^Scan du /.test(title);
}

/**
 * Runs OCR on the pages of a document (all pages without OCR by default), then classifies the
 * document, extracts invoice data, suggests tags and — if the title is generic — renames it.
 */
export async function runOcr(
  lib: Library,
  docId: string,
  opts: {
    pageIds?: readonly string[];
    force?: boolean;
    langs?: readonly string[];
    onProgress?: (done: number, total: number, p?: OcrProgress) => void;
  } = {},
): Promise<DocumentRecord> {
  let doc = lib.get(docId);
  if (!doc) throw new Error('Document introuvable');
  const langs = opts.langs ?? settings.get('ocrLanguages');
  if (!langs.length) throw new Error('Choisissez au moins une langue OCR dans les paramètres');
  const targets = doc.pages.filter((p) => (opts.pageIds ? opts.pageIds.includes(p.id) : opts.force || !p.ocr));
  const results = new Map<string, Page['ocr']>();
  for (const [i, p] of targets.entries()) {
    const blob = await lib.getBlob(p.processedBlobId);
    if (!blob) continue;
    const r = await ocr.recognize(blob, langs, (pr) => opts.onProgress?.(i + pr.value, targets.length, pr));
    results.set(p.id, r);
    opts.onProgress?.(i + 1, targets.length);
  }
  doc = lib.get(docId) as DocumentRecord; // may have changed meanwhile
  const pages = doc.pages.map((p) => (results.has(p.id) ? { ...p, ocr: results.get(p.id) as NonNullable<Page['ocr']> } : p));
  const next: DocumentRecord = { ...doc, pages };
  const text = documentText(next);
  const { kind } = classifyDocument(text);
  if (kind) next.kind = kind;
  if (kind === 'facture' || kind === 'recu') next.invoice = extractInvoiceData(text);
  if (settings.get('autoName') && isDefaultTitle(next.title)) {
    const t = suggestTitle(text, kind, next.invoice);
    if (t) next.title = t;
  }
  if (next.tags.length === 0) next.tags = suggestTags(text, kind, next.invoice);
  return lib.saveDocument(next, 'ocr', `${results.size} page(s)`);
}

/** Saves a manual correction of the recognised text of a page. */
export async function saveEditedText(lib: Library, docId: string, pageId: string, text: string): Promise<DocumentRecord> {
  const doc = lib.get(docId);
  if (!doc) throw new Error('Document introuvable');
  const pages = doc.pages.map((p) => {
    if (p.id !== pageId) return p;
    if (p.ocr) return { ...p, ocr: { ...p.ocr, text, edited: true } };
    return { ...p, text };
  });
  return lib.saveDocument({ ...doc, pages }, 'modified', 'Texte corrigé');
}
