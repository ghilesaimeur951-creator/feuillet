import type { RGBAImage } from '../core/imaging/image';

/**
 * Decoding / encoding of images with the platform codecs. Works on the main thread and inside
 * workers (OffscreenCanvas). EXIF orientation is applied at decode time.
 */

export type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

export function hasOffscreenCanvas(): boolean {
  if (typeof OffscreenCanvas === 'undefined') return false;
  try {
    return new OffscreenCanvas(1, 1).getContext('2d') !== null;
  } catch {
    return false;
  }
}

export function createCanvas(width: number, height: number): AnyCanvas {
  if (hasOffscreenCanvas()) return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

export function ctx2d(c: AnyCanvas): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D {
  const ctx = c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) throw new Error('Canvas 2D indisponible');
  return ctx;
}

export async function decodeToBitmap(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    try {
      return await createImageBitmap(blob);
    } catch {
      throw new Error('Image illisible ou format non pris en charge par ce navigateur');
    }
  }
}

/** Decodes a blob to RGBA, optionally downscaled so that the long side is at most `maxSide`. */
export async function decodeToRGBA(blob: Blob, maxSide = Infinity): Promise<RGBAImage> {
  const bmp = await decodeToBitmap(blob);
  try {
    return bitmapToRGBA(bmp, maxSide);
  } finally {
    bmp.close();
  }
}

export function bitmapToRGBA(
  src: ImageBitmap | HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas,
  maxSide = Infinity,
  srcW?: number,
  srcH?: number,
): RGBAImage {
  const w0 = srcW ?? ('videoWidth' in src ? src.videoWidth : src.width);
  const h0 = srcH ?? ('videoHeight' in src ? src.videoHeight : src.height);
  const s = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * s));
  const h = Math.max(1, Math.round(h0 * s));
  const c = createCanvas(w, h);
  const g = ctx2d(c);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src as CanvasImageSource, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h);
  return { width: w, height: h, data: d.data };
}

export async function encodeRGBA(img: RGBAImage, type: 'image/jpeg' | 'image/png' = 'image/jpeg', quality = 0.85): Promise<Blob> {
  const c = createCanvas(img.width, img.height);
  const g = ctx2d(c);
  g.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  return canvasToBlob(c, type, quality);
}

export async function canvasToBlob(c: AnyCanvas, type: string, quality?: number): Promise<Blob> {
  if ('convertToBlob' in c) return c.convertToBlob({ type, ...(quality !== undefined ? { quality } : {}) });
  return new Promise((resolve, reject) => {
    (c as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new Error('Encodage de l’image impossible'))), type, quality);
  });
}

/** Re-encodes an image blob as JPEG with a maximum size (used by PDF quality profiles). */
export async function reencodeJpeg(blob: Blob, maxSide: number, quality: number): Promise<{ blob: Blob; width: number; height: number }> {
  const bmp = await decodeToBitmap(blob);
  try {
    const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * s));
    const h = Math.max(1, Math.round(bmp.height * s));
    const c = createCanvas(w, h);
    const g = ctx2d(c);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, w, h);
    return { blob: await canvasToBlob(c, 'image/jpeg', quality), width: w, height: h };
  } finally {
    bmp.close();
  }
}

export async function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  const bmp = await decodeToBitmap(blob);
  const r = { width: bmp.width, height: bmp.height };
  bmp.close();
  return r;
}

/** Rotates an encoded image by clockwise quarter turns (JPEG output). */
export async function rotateBlob(blob: Blob, turns: number, quality = 0.9): Promise<Blob> {
  const t = ((turns % 4) + 4) % 4;
  if (t === 0) return blob;
  const bmp = await decodeToBitmap(blob);
  try {
    const swap = t % 2 === 1;
    const c = createCanvas(swap ? bmp.height : bmp.width, swap ? bmp.width : bmp.height);
    const g = ctx2d(c);
    g.translate(c.width / 2, c.height / 2);
    g.rotate((t * Math.PI) / 2);
    g.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
    return await canvasToBlob(c, 'image/jpeg', quality);
  } finally {
    bmp.close();
  }
}
