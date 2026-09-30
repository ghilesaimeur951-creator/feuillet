import { detectDocument } from '../../core/cv/detect';
import type { Quad } from '../../core/geometry/geometry';
import { centroid, scaleQuad } from '../../core/geometry/geometry';
import { estimateOutputSize } from '../../core/geometry/homography';
import { blankPageScore, dHash, detectTextDirection } from '../../core/imaging/analysis';
import type { Adjustments, FilterId } from '../../core/imaging/filters';
import { processImage } from '../../core/imaging/filters';
import type { RGBAImage } from '../../core/imaging/image';
import { resizeRGBA, rotateRGBA90, toGray } from '../../core/imaging/image';
import { warpPerspective } from '../../core/imaging/warp';
import { decodeToRGBA, encodeRGBA } from '../image-io';

/** Image-processing operations. Executed in the processing worker (or on the main thread as a fallback). */

export interface RenderParams {
  original: Blob;
  quad: Quad | null;
  rotation: 0 | 1 | 2 | 3;
  filter: FilterId;
  adjustments: Adjustments;
  /** Long side of the processed image. */
  maxSide: number;
  quality: number;
  /** Snap the aspect ratio to A4/Letter/card when close. */
  snapRatio?: boolean;
  /** Cache key for the rectified base (previews reuse it while sliders move). */
  cacheKey?: string;
}

export interface RenderResult {
  processed: Blob;
  width: number;
  height: number;
  thumb: Blob;
  hash: string;
  blank: boolean;
}

function insetQuad(q: Quad, f: number): Quad {
  const c = centroid(q);
  return q.map((p) => ({ x: p.x + (c.x - p.x) * f * 2, y: p.y + (c.y - p.y) * f * 2 })) as unknown as Quad;
}

let baseCache: { key: string; img: RGBAImage } | null = null;

/** Decodes the original and applies the perspective correction (or a plain resize). */
async function rectified(p: RenderParams): Promise<RGBAImage> {
  const key = p.cacheKey ? `${p.cacheKey}|${JSON.stringify(p.quad)}|${p.maxSide}|${p.snapRatio !== false}` : '';
  if (key && baseCache?.key === key) return baseCache.img;
  const img = await decodeToRGBA(p.original, 4096);
  let out: RGBAImage;
  if (p.quad) {
    // Quad is expressed in original pixels; the decoded image may have been capped at 4096 px.
    const size0 = await originalSize(p.original, img);
    // Shrink the quad very slightly towards its centre: removes the 1-2 px of background that
    // the blurred paper edge always leaves after rectification.
    const q = insetQuad(scaleQuad(p.quad, img.width / size0.width, img.height / size0.height), 0.004);
    const { width, height } = estimateOutputSize(q, { snap: p.snapRatio !== false, maxSide: p.maxSide });
    out = warpPerspective(img, q, width, height);
  } else {
    const s = Math.min(1, p.maxSide / Math.max(img.width, img.height));
    out = s < 1 ? resizeRGBA(img, Math.round(img.width * s), Math.round(img.height * s)) : img;
  }
  if (key) baseCache = { key, img: out };
  return out;
}

const sizeCache = new WeakMap<Blob, { width: number; height: number }>();
async function originalSize(blob: Blob, decoded: RGBAImage): Promise<{ width: number; height: number }> {
  const c = sizeCache.get(blob);
  if (c) return c;
  // decodeToRGBA caps at 4096: recover the true size to rescale the quad.
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(() => null);
  const s = bmp ? { width: bmp.width, height: bmp.height } : { width: decoded.width, height: decoded.height };
  bmp?.close();
  sizeCache.set(blob, s);
  return s;
}

export async function renderPage(p: RenderParams): Promise<RenderResult> {
  const base = await rectified(p);
  let img = processImage(base, p.filter, p.adjustments);
  if (p.rotation) img = rotateRGBA90(img, p.rotation);
  const processed = await encodeRGBA(img, 'image/jpeg', p.quality);
  const ts = 360 / Math.max(img.width, img.height);
  const thumbImg = ts < 1 ? resizeRGBA(img, Math.max(1, Math.round(img.width * ts)), Math.max(1, Math.round(img.height * ts))) : img;
  const thumb = await encodeRGBA(thumbImg, 'image/jpeg', 0.78);
  return { processed, width: img.width, height: img.height, thumb, hash: dHash(thumbImg), blank: blankPageScore(thumbImg).blank };
}

/** Fast preview (downscaled). */
export async function previewPage(p: RenderParams): Promise<Blob> {
  const base = await rectified({ ...p, maxSide: Math.min(p.maxSide, 1100) });
  let img = processImage(base, p.filter, p.adjustments);
  if (p.rotation) img = rotateRGBA90(img, p.rotation);
  return encodeRGBA(img, 'image/jpeg', 0.85);
}

/** Detects the document in a still image; returns the quad in original pixels. */
export async function detectInImage(blob: Blob): Promise<{ quad: Quad | null; width: number; height: number; score: number }> {
  const full = await decodeToRGBA(blob, 4096);
  const size = await originalSize(blob, full);
  const small = resizeRGBA(
    full,
    Math.max(1, Math.round((full.width * 640) / Math.max(full.width, full.height))),
    Math.max(1, Math.round((full.height * 640) / Math.max(full.width, full.height))),
  );
  const r = detectDocument(toGray(small), { minScore: 0.35 });
  return {
    quad: r.quad && !r.partial ? scaleQuad(r.quad, size.width / small.width, size.height / small.height) : null,
    width: size.width,
    height: size.height,
    score: r.score,
  };
}

export async function analyzeOrientation(blob: Blob): Promise<{ turns: 0 | 1; confidence: number }> {
  return detectTextDirection(await decodeToRGBA(blob, 900));
}
