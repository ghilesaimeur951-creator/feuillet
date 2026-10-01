import { blobToBase64, nativeBridge, nativeFileName } from './native';
import type { DocumentRecord, Page } from '../core/docs/model';
import { documentText } from '../core/docs/model';
import { buildDocx } from '../core/office/docx-writer';
import type { OrientationId, PageSizeId, QualityProfile } from '../core/pdf/layout';
import { QUALITY_PROFILES } from '../core/pdf/layout';
import type { PdfWord } from '../core/pdf/writer';
import { buildPdf } from '../core/pdf/writer';
import { exportFileName } from '../core/security/validate';
import { textEncoder, toArrayBuffer } from '../core/util/bytes';
import { createZip } from '../core/zip/zip';
import { renderAnnotatedPage } from './annotate';
import { reencodeJpeg } from './image-io';
import type { Library } from './library';

export interface PdfExportOptions {
  pageSize: PageSizeId;
  orientation: OrientationId;
  quality: QualityProfile['id'];
  /** Margin in points. */
  margin: number;
  searchable: boolean;
  pageNumbers: boolean;
  watermark?: string;
  password?: string;
  /** Subset of pages (in document order); all pages when omitted. */
  pageIds?: readonly string[];
}

function selectedPages(doc: DocumentRecord, ids?: readonly string[]): Page[] {
  if (!ids || ids.length === 0) return doc.pages;
  const set = new Set(ids);
  return doc.pages.filter((p) => set.has(p.id));
}

/** Words of the page (OCR, else imported text layer) scaled to an image of size (w, h). */
export function pageWords(page: Page, w: number, h: number): PdfWord[] {
  if (page.ocr && page.ocr.words.length && page.ocr.width > 0) {
    const sx = w / page.ocr.width;
    const sy = h / page.ocr.height;
    return page.ocr.words.map((x) => ({ text: x.text, x: x.x * sx, y: x.y * sy, width: x.width * sx, height: x.height * sy }));
  }
  if (page.textWords && page.textWords.length) {
    const sx = w / page.width;
    const sy = h / page.height;
    return page.textWords.map((x) => ({ text: x.text, x: x.x * sx, y: x.y * sy, width: x.width * sx, height: x.height * sy }));
  }
  return [];
}

/** Builds a real PDF from the document pages (annotations and signatures included). */
export async function exportPdf(
  lib: Library,
  doc: DocumentRecord,
  o: PdfExportOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  const profile = QUALITY_PROFILES.find((p) => p.id === o.quality) ?? (QUALITY_PROFILES[1] as QualityProfile);
  const pages = selectedPages(doc, o.pageIds);
  if (pages.length === 0) throw new Error('Aucune page à exporter');
  const inputs = [];
  for (const [i, p] of pages.entries()) {
    const annotated = await renderAnnotatedPage(p, (id) => lib.getBlob(id), { quality: 0.92 });
    const jpeg = await reencodeJpeg(annotated.blob, profile.maxSide, profile.jpegQuality);
    inputs.push({
      jpeg: new Uint8Array(await jpeg.blob.arrayBuffer()),
      size: o.pageSize,
      orientation: o.orientation,
      margin: o.margin,
      ...(o.searchable ? { words: pageWords(p, jpeg.width, jpeg.height) } : {}),
      ...(o.pageNumbers ? { footer: `${i + 1} / ${pages.length}` } : {}),
      ...(o.watermark?.trim() ? { watermark: { text: o.watermark.trim(), opacity: 0.18 } } : {}),
    });
    onProgress?.(i + 1, pages.length);
  }
  const bytes = await buildPdf({
    pages: inputs,
    info: {
      title: doc.title,
      ...(doc.tags.length ? { keywords: doc.tags.join(', ') } : {}),
      ...(doc.notes ? { subject: doc.notes.slice(0, 200) } : {}),
    },
    ...(o.password ? { password: { user: o.password } } : {}),
  });
  return new Blob([toArrayBuffer(bytes)], { type: 'application/pdf' });
}

/** JPG/PNG export: a single image, or a ZIP when several pages are exported. */
export async function exportImages(
  lib: Library,
  doc: DocumentRecord,
  format: 'jpeg' | 'png',
  pageIds?: readonly string[],
): Promise<{ blob: Blob; filename: string }> {
  const pages = selectedPages(doc, pageIds);
  const type = format === 'png' ? 'image/png' : 'image/jpeg';
  const ext = format === 'png' ? 'png' : 'jpg';
  const files: Array<{ name: string; data: Uint8Array; compress: boolean }> = [];
  for (const [i, p] of pages.entries()) {
    const r = await renderAnnotatedPage(p, (id) => lib.getBlob(id), { type, quality: 0.92 });
    files.push({
      name: `${exportFileName(doc.title, '').replace(/\.$/, '')}-p${String(i + 1).padStart(2, '0')}.${ext}`,
      data: new Uint8Array(await r.blob.arrayBuffer()),
      compress: false,
    });
  }
  if (files.length === 1) {
    const f = files[0] as { name: string; data: Uint8Array };
    return { blob: new Blob([toArrayBuffer(f.data)], { type }), filename: exportFileName(doc.title, ext) };
  }
  return { blob: new Blob([toArrayBuffer(await createZip(files))], { type: 'application/zip' }), filename: exportFileName(doc.title, 'zip') };
}

export function exportText(doc: DocumentRecord): { blob: Blob; filename: string } {
  const text = documentText(doc);
  return { blob: new Blob([textEncoder.encode(`\uFEFF${text}`)], { type: 'text/plain;charset=utf-8' }), filename: exportFileName(doc.title, 'txt') };
}

export async function exportDocx(lib: Library, doc: DocumentRecord, includeImages: boolean): Promise<{ blob: Blob; filename: string }> {
  const pages = [];
  for (const p of doc.pages) {
    const text = p.ocr?.text ?? p.text ?? '';
    if (includeImages) {
      const r = await renderAnnotatedPage(p, (id) => lib.getBlob(id), { maxSide: 1800, quality: 0.85 });
      pages.push({ image: { data: new Uint8Array(await r.blob.arrayBuffer()), width: r.width, height: r.height }, text });
    } else pages.push({ text });
  }
  const bytes = await buildDocx({ title: doc.title, pages });
  return {
    blob: new Blob([toArrayBuffer(bytes)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    filename: exportFileName(doc.title, 'docx'),
  };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const android = nativeBridge();
  if (android) {
    void blobToBase64(blob).then((b64) => android.saveFile(nativeFileName(filename), blob.type || 'application/octet-stream', b64));
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function canShareFiles(): boolean {
  if (nativeBridge()) return true;
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File([''], 'x.pdf', { type: 'application/pdf' })] });
  } catch {
    return false;
  }
}

/** Native share sheet (mobile). Returns false when the platform cannot share files. */
export async function shareBlob(blob: Blob, filename: string, title: string): Promise<'shared' | 'cancelled' | 'unsupported'> {
  const android = nativeBridge();
  if (android) {
    android.shareFile(nativeFileName(filename), blob.type || 'application/octet-stream', await blobToBase64(blob), title);
    return 'shared';
  }
  const file = new File([blob], filename, { type: blob.type });
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function' || !navigator.canShare({ files: [file] }))
    return 'unsupported';
  try {
    await navigator.share({ files: [file], title });
    return 'shared';
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
    throw e;
  }
}

/** Prints a PDF through a hidden iframe (falls back to opening it in a new tab). */
export function printPdf(blob: Blob, name = 'document.pdf'): void {
  const android = nativeBridge();
  if (android) {
    void blobToBase64(blob).then((b64) => android.printPdf(nativeFileName(name), b64));
    return;
  }
  const url = URL.createObjectURL(blob);
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  frame.src = url;
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch {
      window.open(url, '_blank', 'noopener');
    }
    setTimeout(() => {
      frame.remove();
      URL.revokeObjectURL(url);
    }, 120_000);
  };
  document.body.appendChild(frame);
}
