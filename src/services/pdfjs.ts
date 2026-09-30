import { appUrl } from './config';

/** Minimal typings for the vendored pdf.js build (public/vendor/pdfjs). */
interface PdfViewport {
  width: number;
  height: number;
  transform: number[];
}
interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}
interface PdfPageProxy {
  getViewport(o: { scale: number }): PdfViewport;
  render(o: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport; background?: string }): { promise: Promise<void> };
  getTextContent(): Promise<{ items: Array<PdfTextItem | { type: string }> }>;
  cleanup(): void;
}
interface PdfDocumentProxy {
  numPages: number;
  getPage(n: number): Promise<PdfPageProxy>;
  getMetadata(): Promise<{ info?: { Title?: string } }>;
  destroy(): Promise<void>;
}
interface PdfLoadingTask {
  promise: Promise<PdfDocumentProxy>;
  onPassword: ((update: (pw: string) => void, reason: number) => void) | null;
  destroy(): Promise<void>;
}
interface PdfJsModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(o: Record<string, unknown>): PdfLoadingTask;
  Util: { transform(a: number[], b: number[]): number[] };
}

let modPromise: Promise<PdfJsModule> | null = null;

/** Lazily loads pdf.js (≈ 1.5 MB) only when a PDF is imported. */
export function loadPdfJs(): Promise<PdfJsModule> {
  if (!modPromise) {
    modPromise = (import(/* @vite-ignore */ appUrl('vendor/pdfjs/pdf.mjs')) as Promise<PdfJsModule>).then((m) => {
      m.GlobalWorkerOptions.workerSrc = appUrl('vendor/pdfjs/pdf.worker.mjs');
      return m;
    });
    modPromise.catch(() => {
      modPromise = null;
    });
  }
  return modPromise;
}

export interface RenderedPdfPage {
  index: number;
  image: Blob;
  width: number;
  height: number;
  text: string;
  words: Array<{ text: string; x: number; y: number; width: number; height: number }>;
}

export class PdfPasswordError extends Error {
  constructor(readonly wrong: boolean) {
    super(wrong ? 'Mot de passe incorrect' : 'Ce PDF est protégé par un mot de passe');
  }
}

/**
 * Renders every page of a PDF to a JPEG image (at ~200 dpi, capped) and extracts its text layer
 * with word positions, so imported PDFs are immediately searchable without OCR.
 */
export async function renderPdf(
  data: Uint8Array,
  opts: { password?: string; maxSide?: number; onProgress?: (done: number, total: number) => void; maxPages?: number } = {},
): Promise<{ title?: string; pages: RenderedPdfPage[] }> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({
    data: data.slice(),
    cMapUrl: appUrl('vendor/pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: appUrl('vendor/pdfjs/standard_fonts/'),
    isEvalSupported: false,
    enableXfa: false,
    ...(opts.password ? { password: opts.password } : {}),
  });
  let passwordRequested: PdfPasswordError | null = null;
  task.onPassword = (_update, reason) => {
    passwordRequested = new PdfPasswordError(reason === 2);
    void task.destroy();
  };
  let pdf: PdfDocumentProxy;
  try {
    pdf = await task.promise;
  } catch (e) {
    if (passwordRequested) throw passwordRequested;
    const msg = e instanceof Error ? e.message : String(e);
    if (/password/i.test(msg)) throw new PdfPasswordError(/incorrect/i.test(msg));
    throw new Error(`PDF illisible ou corrompu (${msg})`);
  }
  try {
    const meta = await pdf.getMetadata().catch(() => ({ info: {} as { Title?: string } }));
    const maxSide = opts.maxSide ?? 2400;
    const total = Math.min(pdf.numPages, opts.maxPages ?? 500);
    const pages: RenderedPdfPage[] = [];
    for (let i = 1; i <= total; i++) {
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(200 / 72, maxSide / Math.max(base.width, base.height));
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas indisponible');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const image = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Rendu impossible'))), 'image/jpeg', 0.9));
      const tc = await page.getTextContent();
      const words: RenderedPdfPage['words'] = [];
      const lines: string[] = [];
      let lastY = Number.NaN;
      let line = '';
      for (const it of tc.items) {
        if (!('str' in it) || !it.str) continue;
        // Symbol-font bullets come out as private-use code points.
        it.str = it.str.replace(/[\uE000-\uF8FF]/g, '•');
        const t = pdfjs.Util.transform(vp.transform, it.transform);
        const fontH = Math.hypot(t[2] as number, t[3] as number);
        const x = t[4] as number;
        const y = (t[5] as number) - fontH;
        const w = it.width * scale;
        if (!Number.isNaN(lastY) && Math.abs(y - lastY) > fontH * 0.5) {
          lines.push(line.trim());
          line = '';
        }
        line += `${it.str} `;
        lastY = y;
        // Split the text run into words with proportional widths.
        const parts = it.str.split(/(\s+)/);
        const totalLen = it.str.length || 1;
        let offset = 0;
        for (const p of parts) {
          const pw = (p.length / totalLen) * w;
          if (p.trim()) words.push({ text: p, x: x + (offset / totalLen) * w, y, width: pw, height: fontH * 1.15 });
          offset += p.length;
        }
      }
      if (line.trim()) lines.push(line.trim());
      pages.push({ index: i - 1, image, width: canvas.width, height: canvas.height, text: lines.join('\n'), words });
      page.cleanup();
      canvas.width = canvas.height = 0;
      opts.onProgress?.(i, total);
    }
    const title = meta.info?.Title?.trim();
    return { ...(title ? { title } : {}), pages };
  } finally {
    await pdf.destroy();
  }
}
