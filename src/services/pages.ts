import type { Page } from '../core/docs/model';
import { newId } from '../core/docs/model';
import { rotateAnnotations } from '../core/docs/annotations';
import type { Quad } from '../core/geometry/geometry';
import type { Adjustments, FilterId } from '../core/imaging/filters';
import { NEUTRAL_ADJUSTMENTS } from '../core/imaging/filters';
import { renderAnnotatedPage } from './annotate';
import { canvasToBlob, createCanvas, ctx2d, decodeToBitmap } from './image-io';
import type { Library } from './library';
import { processing } from './processing/client';
import { settings } from './settings';

/** Creation and re-rendering of pages (rectification + filter + rotation, off the main thread). */

export interface PageSource {
  original: Blob;
  width: number;
  height: number;
  quad: Quad | null;
  filter?: FilterId;
  adjustments?: Adjustments;
  rotation?: Page['rotation'];
  text?: string;
  textWords?: Page['textWords'];
  /** Snap the output ratio to known paper formats (default true). */
  snapRatio?: boolean;
  /** Reuse an already stored original (scan captures) instead of storing a copy. */
  originalBlobId?: string;
}

function maxSide(): number {
  return { standard: 2400, high: 3508, max: 4096 }[settings.get('scanResolution')];
}

export async function createPage(lib: Library, src: PageSource): Promise<Page> {
  const filter = src.filter ?? 'original';
  const adjustments = src.adjustments ?? NEUTRAL_ADJUSTMENTS;
  const rotation = src.rotation ?? 0;
  const r = await processing.render({ original: src.original, quad: src.quad, rotation, filter, adjustments, maxSide: maxSide(), quality: 0.9, snapRatio: src.snapRatio !== false });
  const originalBlobId = src.originalBlobId ?? (await lib.putBlob(src.original));
  return {
    id: newId('p'),
    originalBlobId,
    originalWidth: src.width,
    originalHeight: src.height,
    quad: src.quad,
    rotation,
    filter,
    adjustments,
    processedBlobId: await lib.putBlob(r.processed),
    width: r.width,
    height: r.height,
    thumbBlobId: await lib.putBlob(r.thumb),
    annotations: [],
    hash: r.hash,
    blank: r.blank,
    ...(src.text ? { text: src.text } : {}),
    ...(src.textWords ? { textWords: src.textWords } : {}),
  };
}

/**
 * Re-renders a page after a change of crop, rotation or filter. Returns a new Page object with new
 * blob ids (old blobs are garbage-collected later, so undo keeps working).
 */
export async function rerenderPage(lib: Library, page: Page, changes: Partial<Pick<Page, 'quad' | 'rotation' | 'filter' | 'adjustments'>>): Promise<Page> {
  const original = await lib.getBlob(page.originalBlobId);
  if (!original) throw new Error('Image originale introuvable');
  const next = { ...page, ...changes };
  const r = await processing.render({
    original,
    quad: next.quad,
    rotation: next.rotation,
    filter: next.filter,
    adjustments: next.adjustments,
    maxSide: maxSide(),
    quality: 0.9,
    cacheKey: page.originalBlobId,
  });
  const geometryChanged = 'quad' in changes && JSON.stringify(changes.quad) !== JSON.stringify(page.quad);
  const turns = ((next.rotation - page.rotation) % 4 + 4) % 4;
  const result: Page = {
    ...next,
    processedBlobId: await lib.putBlob(r.processed),
    thumbBlobId: await lib.putBlob(r.thumb),
    width: r.width,
    height: r.height,
    hash: r.hash,
    blank: r.blank,
    annotations: turns ? rotateAnnotations(page.annotations, turns) : page.annotations,
  };
  // Word boxes are tied to the old geometry: OCR positions / imported text boxes become invalid.
  if (geometryChanged || turns) {
    delete result.textWords;
    if (result.ocr) result.ocr = { ...result.ocr, words: [] };
  }
  if (result.annotations.length) result.thumbBlobId = await lib.putBlob(await annotatedThumb(lib, result));
  return result;
}

/** Thumbnail including annotations/signatures. */
export async function annotatedThumb(lib: Library, page: Page): Promise<Blob> {
  const { blob } = await renderAnnotatedPage(page, (id) => lib.getBlob(id), { maxSide: 360, quality: 0.78 });
  return blob;
}

/** Duplicates a page with its own blobs. */
export async function copyPage(lib: Library, page: Page): Promise<Page> {
  const dup = async (id: string) => {
    const b = await lib.getBlob(id);
    return b ? lib.putBlob(b) : id;
  };
  return {
    ...structuredClone(page),
    id: newId('p'),
    originalBlobId: await dup(page.originalBlobId),
    processedBlobId: await dup(page.processedBlobId),
    thumbBlobId: await dup(page.thumbBlobId),
  };
}

/** Splits a rectified double page (book mode) into its left and right halves. */
export async function splitDoublePage(lib: Library, page: Page): Promise<[Page, Page]> {
  const blob = await lib.getBlob(page.processedBlobId);
  if (!blob) throw new Error('Image introuvable');
  const bmp = await decodeToBitmap(blob);
  const half = Math.floor(bmp.width / 2);
  const make = async (x: number, w: number): Promise<Page> => {
    const c = createCanvas(w, bmp.height);
    ctx2d(c).drawImage(bmp, x, 0, w, bmp.height, 0, 0, w, bmp.height);
    const img = await canvasToBlob(c, 'image/jpeg', 0.9);
    return createPage(lib, { original: img, width: w, height: bmp.height, quad: null, filter: 'original' });
  };
  const left = await make(0, half);
  const right = await make(half, bmp.width - half);
  bmp.close();
  return [left, right];
}
