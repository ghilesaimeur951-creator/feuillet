import { newId } from '../core/docs/model';
import type { Library } from './library';
import { canvasToBlob, createCanvas, ctx2d, decodeToBitmap } from './image-io';

export interface SavedSignature {
  id: string;
  blobId: string;
  width: number;
  height: number;
  createdAt: number;
}

const KEY = 'signatures';

export async function listSignatures(lib: Library): Promise<SavedSignature[]> {
  return lib.getSetting<SavedSignature[]>(KEY, []);
}

export async function saveSignature(lib: Library, png: Blob, width: number, height: number): Promise<SavedSignature> {
  const sig: SavedSignature = { id: newId('s'), blobId: await lib.putBlob(png), width, height, createdAt: Date.now() };
  await lib.setSetting(KEY, [sig, ...(await listSignatures(lib))].slice(0, 12));
  return sig;
}

export async function deleteSignature(lib: Library, id: string): Promise<void> {
  const list = await listSignatures(lib);
  const s = list.find((x) => x.id === id);
  await lib.setSetting(
    KEY,
    list.filter((x) => x.id !== id),
  );
  // The blob stays if a page still uses it; otherwise the garbage collector removes it later.
  void s;
}

/**
 * Turns a photo/scan of a handwritten signature into a transparent PNG: the paper becomes
 * transparent, the ink is kept (and slightly darkened), and the image is cropped to the ink.
 */
export async function cleanSignatureImage(file: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  const bmp = await decodeToBitmap(file);
  const s = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s));
  const h = Math.max(1, Math.round(bmp.height * s));
  const c = createCanvas(w, h);
  const g = ctx2d(c);
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const l = 0.299 * (d[i] as number) + 0.587 * (d[i + 1] as number) + 0.114 * (d[i + 2] as number);
      // Smooth alpha ramp between ink (dark) and paper (light).
      const a = l > 200 ? 0 : l < 120 ? 255 : Math.round(((200 - l) / 80) * 255);
      d[i + 3] = Math.min(d[i + 3] as number, a);
      if (a > 40) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('Aucune signature détectée dans l’image (fond trop sombre ?)');
  g.putImageData(img, 0, 0);
  const pad = 6;
  const cx = Math.max(0, minX - pad);
  const cy = Math.max(0, minY - pad);
  const cw = Math.min(w - cx, maxX - minX + 1 + 2 * pad);
  const ch = Math.min(h - cy, maxY - minY + 1 + 2 * pad);
  const out = createCanvas(cw, ch);
  ctx2d(out).drawImage(c as CanvasImageSource, cx, cy, cw, ch, 0, 0, cw, ch);
  return { blob: await canvasToBlob(out, 'image/png'), width: cw, height: ch };
}
