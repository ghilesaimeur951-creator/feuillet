import type { GrayImage, RGBAImage } from './image';
import { resizeGray, toGray } from './image';
import { flattenIllumination } from './filters';

/**
 * Blank-page detection: after flattening the illumination, a blank page has almost no dark
 * pixels. Returns the fraction of "ink" pixels and the verdict.
 */
export function blankPageScore(img: RGBAImage): { ink: number; blank: boolean } {
  const small = downscaleForAnalysis(img, 600);
  const g = toGray(flattenIllumination(small, 1));
  let ink = 0;
  // Ignore a 4 % margin (crop residue, page edges).
  const mx = Math.round(g.width * 0.04);
  const my = Math.round(g.height * 0.04);
  let n = 0;
  for (let y = my; y < g.height - my; y++) {
    for (let x = mx; x < g.width - mx; x++) {
      n++;
      if ((g.data[y * g.width + x] as number) < 160) ink++;
    }
  }
  const ratio = n ? ink / n : 0;
  return { ink: ratio, blank: ratio < 0.0025 };
}

/** 64-bit difference hash (dHash) as a 16-char hex string: robust to scale and small edits. */
export function dHash(img: RGBAImage | GrayImage): string {
  const g = img.data.length === img.width * img.height ? (img as GrayImage) : toGray(img as RGBAImage);
  const s = resizeGray(g, 9, 8);
  let hex = '';
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) {
      byte = (byte << 1) | ((s.data[y * 9 + x] as number) > (s.data[y * 9 + x + 1] as number) ? 1 : 0);
    }
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

export function hammingDistanceHex(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 2) {
    let x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/** Two pages are considered duplicates when their dHash differ by at most 5 bits out of 64. */
export function isDuplicate(hashA: string, hashB: string): boolean {
  return hammingDistanceHex(hashA, hashB) <= 5;
}

export function downscaleForAnalysis(img: RGBAImage, maxSide: number): RGBAImage {
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (s >= 1) return img;
  const w = Math.max(1, Math.round(img.width * s));
  const h = Math.max(1, Math.round(img.height * s));
  const g = resizeGray(toGray(img), w, h);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = g.data[i] as number;
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data: out };
}

/**
 * Detects whether text lines run horizontally or vertically using projection profiles:
 * horizontal lines produce a strongly modulated row profile. Returns the number of clockwise
 * quarter turns (0 or 1) that makes lines horizontal. 180° ambiguity is resolved by OCR later.
 */
export function detectTextDirection(img: RGBAImage): { turns: 0 | 1; confidence: number } {
  const small = downscaleForAnalysis(img, 500);
  const g = toGray(flattenIllumination(small, 1));
  const { width: w, height: h } = g;
  const rows = new Float64Array(h);
  const cols = new Float64Array(w);
  let ink = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dark = (g.data[y * w + x] as number) < 150 ? 1 : 0;
      rows[y] = (rows[y] as number) + dark;
      cols[x] = (cols[x] as number) + dark;
      ink += dark;
    }
  }
  if (ink < w * h * 0.003) return { turns: 0, confidence: 0 };
  const modulation = (p: Float64Array, len: number) => {
    // Mean absolute difference between consecutive bins, normalised by the mean: text lines
    // alternate ink/gaps and produce strong modulation perpendicular to their direction.
    let diff = 0;
    let sum = 0;
    for (let i = 0; i < p.length; i++) {
      sum += (p[i] as number) / len;
      if (i) diff += Math.abs((p[i] as number) - (p[i - 1] as number)) / len;
    }
    return sum > 0 ? diff / sum : 0;
  };
  const mr = modulation(rows, w);
  const mc = modulation(cols, h);
  const turns = mc > mr * 1.35 ? 1 : 0;
  const confidence = Math.min(1, Math.abs(Math.log((mr + 1e-9) / (mc + 1e-9))));
  return { turns, confidence };
}
