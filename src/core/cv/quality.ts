import type { Point, Quad } from '../geometry/geometry';
import { distance } from '../geometry/geometry';
import type { GrayImage } from '../imaging/image';

export interface FrameQuality {
  /** Laplacian variance on the document (interior and border band). Higher = sharper. */
  sharpness: number;
  /** Mean luminance 0..255 on the document (or whole frame). */
  brightness: number;
  /** Fraction of saturated pixels on the document (specular glare). */
  glare: number;
  blurry: boolean;
  tooDark: boolean;
  hasGlare: boolean;
}

export interface QualityThresholds {
  minSharpness: number;
  minBrightness: number;
  maxGlare: number;
}

export const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = {
  minSharpness: 55,
  minBrightness: 55,
  maxGlare: 0.035,
};

/**
 * Rasterises the quad into a mask (scanline fill) and a thin band along its outline.
 * Both masks are Uint8Array of the image size.
 */
export function quadMasks(q: Quad, w: number, h: number, bandWidth: number): { inside: Uint8Array; band: Uint8Array } {
  const inside = new Uint8Array(w * h);
  const band = new Uint8Array(w * h);
  const minY = Math.max(0, Math.floor(Math.min(...q.map((p) => p.y))));
  const maxY = Math.min(h - 1, Math.ceil(Math.max(...q.map((p) => p.y))));
  for (let y = minY; y <= maxY; y++) {
    const xs: number[] = [];
    for (let i = 0; i < 4; i++) {
      const a = q[i] as Point;
      const b = q[(i + 1) % 4] as Point;
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
        xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
    xs.sort((u, v) => u - v);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k] as number));
      const x1 = Math.min(w - 1, Math.floor(xs[k + 1] as number));
      for (let x = x0; x <= x1; x++) inside[y * w + x] = 1;
    }
  }
  for (let i = 0; i < 4; i++) {
    const a = q[i] as Point;
    const b = q[(i + 1) % 4] as Point;
    const n = Math.ceil(distance(a, b));
    for (let k = 0; k <= n; k++) {
      const cx = a.x + ((b.x - a.x) * k) / Math.max(1, n);
      const cy = a.y + ((b.y - a.y) * k) / Math.max(1, n);
      for (let dy = -bandWidth; dy <= bandWidth; dy++) {
        const y = Math.round(cy + dy);
        if (y < 0 || y >= h) continue;
        for (let dx = -bandWidth; dx <= bandWidth; dx++) {
          const x = Math.round(cx + dx);
          if (x >= 0 && x < w) band[y * w + x] = 1;
        }
      }
    }
  }
  return { inside, band };
}

function laplacianStats(g: GrayImage, mask: Uint8Array): number {
  const { width: w, height: h, data: s } = g;
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mask[i] === 0) continue;
      const v = 4 * (s[i] as number) - (s[i - 1] as number) - (s[i + 1] as number) - (s[i - w] as number) - (s[i + w] as number);
      sum += v;
      sum2 += v * v;
      n++;
    }
  }
  if (!n) return 0;
  const m = sum / n;
  return sum2 / n - m * m;
}

/**
 * Measures sharpness, exposure and glare for a frame (on the document area when a quad is known).
 * Sharpness uses the maximum of interior texture and border-step sharpness so that blank pages
 * are not mistaken for blurry ones.
 */
export function assessQuality(gray: GrayImage, quad: Quad | null, t: QualityThresholds = DEFAULT_QUALITY_THRESHOLDS): FrameQuality {
  const { width: w, height: h, data } = gray;
  let mask: Uint8Array;
  let band: Uint8Array | null = null;
  if (quad) {
    const m = quadMasks(quad, w, h, 2);
    mask = m.inside;
    band = m.band;
  } else {
    mask = new Uint8Array(w * h).fill(1);
  }
  let sum = 0;
  let n = 0;
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) {
    if (mask[i] === 0) continue;
    const v = data[i] as number;
    sum += v;
    n++;
    hist[v] = (hist[v] as number) + 1;
  }
  const brightness = n ? sum / n : 0;
  // Glare = saturated blobs that are much brighter than the paper itself. A uniformly
  // over-exposed white page is not glare (the text remains readable).
  let paper = 0;
  for (let v = 0, acc = 0; v < 256; v++) {
    acc += hist[v] as number;
    if (acc >= n * 0.6) {
      paper = v;
      break;
    }
  }
  let glare = 0;
  if (n && paper < 232) {
    const from = Math.min(250, paper + 35);
    let sat = 0;
    for (let v = from; v < 256; v++) sat += hist[v] as number;
    glare = sat / n;
  }
  const interior = laplacianStats(gray, mask);
  const border = band ? laplacianStats(gray, band) * 0.5 : 0;
  const sharpness = Math.max(interior, border);
  return {
    sharpness,
    brightness,
    glare,
    blurry: sharpness < t.minSharpness,
    tooDark: brightness < t.minBrightness,
    hasGlare: glare > t.maxGlare,
  };
}
