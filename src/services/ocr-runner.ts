import type { DocumentRecord, Page } from '../core/docs/model';
import { documentText } from '../core/docs/model';
import { classifyDocument, extractInvoiceData, suggestTags, suggestTitle } from '../core/ocr/analysis';
import type { OcrResult } from '../core/ocr/analysis';
import { rotateBlob } from './image-io';
import { rerenderPage } from './pages';
import { processing } from './processing/client';
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
  const doc = lib.get(docId);
  if (!doc) throw new Error('Document introuvable');
  const langs = opts.langs ?? settings.get('ocrLanguages');
  if (!langs.length) throw new Error('Choisissez au moins une langue OCR dans les paramètres');
  const targets = doc.pages.filter((p) => (opts.pageIds ? opts.pageIds.includes(p.id) : opts.force || !p.ocr));
  const results = new Map<string, Page['ocr']>();
  const rotated = new Map<string, Page>();
  for (const [i, p] of targets.entries()) {
    const blob = await lib.getBlob(p.processedBlobId);
    if (!blob) continue;
    const onProgress = (pr: OcrProgress) => opts.onProgress?.(i + pr.value, targets.length, pr);
    let r = await ocr.recognize(blob, langs, onProgress);
    if (settings.get('autoOrient')) {
      const best = await bestOrientation(blob, langs, r, onProgress);
      if (best.turns) {
        // Re-render the page upright; the OCR of the rotated image matches the new page image.
        rotated.set(p.id, await rerenderPage(lib, p, { rotation: ((p.rotation + best.turns) % 4) as Page['rotation'] }));
        r = best.result;
      }
    }
    results.set(p.id, r);
    opts.onProgress?.(i + 1, targets.length);
  }
  const sources = new Map(targets.map((p) => [p.id, p]));
  // Apply the results on the latest version of the document (the user may have edited it meanwhile).
  return lib.updateDocument(
    docId,
    async (latest) => {
      const pages: Page[] = [];
      for (const p of latest.pages) {
        const r = results.get(p.id);
        const source = sources.get(p.id);
        if (!r || !source) {
          pages.push(p);
          continue;
        }
        const sameGeometry = p.rotation === source.rotation && JSON.stringify(p.quad) === JSON.stringify(source.quad);
        if (!sameGeometry) {
          // Cropped or rotated meanwhile: these word positions no longer match the page.
          pages.push(p);
          continue;
        }
        const upright = rotated.get(p.id);
        if (upright) {
          const base = p.processedBlobId === source.processedBlobId ? upright : await rerenderPage(lib, p, { rotation: upright.rotation });
          pages.push({ ...base, ocr: r });
        } else pages.push({ ...p, ocr: r });
      }
      const next: DocumentRecord = { ...latest, pages };
      const text = documentText(next);
      const { kind } = classifyDocument(text);
      if (kind) next.kind = kind;
      if (kind === 'facture' || kind === 'recu') next.invoice = extractInvoiceData(text);
      if (settings.get('autoName') && isDefaultTitle(next.title)) {
        const t = suggestTitle(text, kind, next.invoice);
        if (t) next.title = t;
      }
      if (next.tags.length === 0) next.tags = suggestTags(text, kind, next.invoice);
      return next;
    },
    'ocr',
    `${results.size} page(s)`,
  );
}

/**
 * Automatic orientation: when the recognition confidence is low, tries the plausible rotations
 * (text-line direction analysis narrows them down) and keeps the one Tesseract reads best.
 */
async function bestOrientation(
  blob: Blob,
  langs: readonly string[],
  base: OcrResult,
  onProgress: (p: OcrProgress) => void,
): Promise<{ turns: number; result: OcrResult & { width: number; height: number } }> {
  let best = { turns: 0, result: base as OcrResult & { width: number; height: number } };
  if (base.confidence >= 62 && base.words.length >= 4) return best;
  const dir = await processing.orientation(blob).catch(() => ({ turns: 0 as const, confidence: 0 }));
  const candidates = dir.turns === 1 && dir.confidence > 0.25 ? [1, 3] : [2];
  for (const t of candidates) {
    const r = await ocr.recognize(await rotateBlob(blob, t), langs, onProgress);
    if (r.confidence > best.result.confidence + 12 && r.words.length >= base.words.length * 0.5) best = { turns: t, result: r };
  }
  return best;
}

/** Saves a manual correction of the recognised text of a page. */
export async function saveEditedText(lib: Library, docId: string, pageId: string, text: string): Promise<DocumentRecord> {
  return lib.updateDocument(
    docId,
    (latest) => ({
      ...latest,
      pages: latest.pages.map((p) => {
        if (p.id !== pageId) return p;
        if (p.ocr) return { ...p, ocr: { ...p.ocr, text, edited: true } };
        return { ...p, text };
      }),
    }),
    'modified',
    'Texte corrigé',
  );
}
