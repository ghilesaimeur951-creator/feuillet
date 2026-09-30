import type { Annotation, Page } from '../core/docs/model';
import type { AnyCanvas } from './image-io';
import { canvasToBlob, createCanvas, ctx2d, decodeToBitmap } from './image-io';

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** Draws normalised annotations onto a context of size (w, h). */
export async function drawAnnotations(g: Ctx, list: readonly Annotation[], w: number, h: number, loadBlob: (id: string) => Promise<Blob | undefined>): Promise<void> {
  for (const a of list) {
    g.save();
    switch (a.type) {
      case 'ink': {
        g.strokeStyle = a.color;
        g.globalAlpha = a.opacity;
        g.lineWidth = Math.max(1, a.width * w);
        g.lineCap = 'round';
        g.lineJoin = 'round';
        g.beginPath();
        a.points.forEach((p, i) => (i ? g.lineTo(p.x * w, p.y * h) : g.moveTo(p.x * w, p.y * h)));
        if (a.points.length === 1) g.lineTo((a.points[0]?.x ?? 0) * w + 0.1, (a.points[0]?.y ?? 0) * h);
        g.stroke();
        break;
      }
      case 'highlight':
        g.fillStyle = a.color;
        g.globalAlpha = 0.38;
        g.globalCompositeOperation = 'multiply';
        g.fillRect(a.x * w, a.y * h, a.w * w, a.h * h);
        break;
      case 'rect':
      case 'ellipse':
        g.strokeStyle = a.color;
        g.lineWidth = Math.max(1, a.width * w);
        g.beginPath();
        if (a.type === 'rect') g.rect(a.x * w, a.y * h, a.w * w, a.h * h);
        else g.ellipse((a.x + a.w / 2) * w, (a.y + a.h / 2) * h, Math.abs(a.w * w) / 2, Math.abs(a.h * h) / 2, 0, 0, Math.PI * 2);
        g.stroke();
        break;
      case 'arrow': {
        const x1 = a.x1 * w;
        const y1 = a.y1 * h;
        const x2 = a.x2 * w;
        const y2 = a.y2 * h;
        const lw = Math.max(1, a.width * w);
        g.strokeStyle = a.color;
        g.fillStyle = a.color;
        g.lineWidth = lw;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
        g.stroke();
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const head = lw * 4;
        g.beginPath();
        g.moveTo(x2, y2);
        g.lineTo(x2 - head * Math.cos(ang - 0.45), y2 - head * Math.sin(ang - 0.45));
        g.lineTo(x2 - head * Math.cos(ang + 0.45), y2 - head * Math.sin(ang + 0.45));
        g.closePath();
        g.fill();
        break;
      }
      case 'text': {
        const size = Math.max(6, a.size * w);
        g.fillStyle = a.color;
        g.font = `${Math.round(size)}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
        g.textBaseline = 'top';
        a.text.split('\n').forEach((line, i) => g.fillText(line, a.x * w, a.y * h + i * size * 1.25));
        break;
      }
      case 'image': {
        const blob = await loadBlob(a.blobId);
        if (blob) {
          const bmp = await decodeToBitmap(blob);
          g.drawImage(bmp, a.x * w, a.y * h, a.w * w, a.h * h);
          bmp.close();
        }
        break;
      }
    }
    g.restore();
  }
}

/** Processed page image with annotations burned in (for export and thumbnails). */
export async function renderAnnotatedPage(
  page: Page,
  loadBlob: (id: string) => Promise<Blob | undefined>,
  opts: { maxSide?: number; type?: 'image/jpeg' | 'image/png'; quality?: number } = {},
): Promise<{ blob: Blob; width: number; height: number }> {
  const src = await loadBlob(page.processedBlobId);
  if (!src) throw new Error('Image de la page introuvable');
  if (page.annotations.length === 0 && !opts.maxSide && (opts.type ?? 'image/jpeg') === 'image/jpeg') {
    return { blob: src, width: page.width, height: page.height };
  }
  const bmp = await decodeToBitmap(src);
  const s = Math.min(1, (opts.maxSide ?? Infinity) / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s));
  const h = Math.max(1, Math.round(bmp.height * s));
  const c: AnyCanvas = createCanvas(w, h);
  const g = ctx2d(c);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, h);
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  await drawAnnotations(g, page.annotations, w, h, loadBlob);
  const blob = await canvasToBlob(c, opts.type ?? 'image/jpeg', opts.quality ?? 0.9);
  return { blob, width: w, height: h };
}
