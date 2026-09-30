import type { GrayImage } from '../imaging/image';

/** Low-level filters for the real-time vision pipeline. All functions are allocation-explicit. */

export function gaussianKernel(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 2.5));
  const k = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] = (k[i] as number) / sum;
  return k;
}

/** Separable Gaussian blur with clamped borders. */
export function gaussianBlur(src: GrayImage, sigma: number): GrayImage {
  const { width: w, height: h } = src;
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) >> 1;
  const tmp = new Float32Array(w * h);
  const out = new Uint8ClampedArray(w * h);
  const s = src.data;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        let xx = x + i;
        if (xx < 0) xx = 0;
        else if (xx >= w) xx = w - 1;
        acc += (s[row + xx] as number) * (k[i + r] as number);
      }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        let yy = y + i;
        if (yy < 0) yy = 0;
        else if (yy >= h) yy = h - 1;
        acc += (tmp[yy * w + x] as number) * (k[i + r] as number);
      }
      out[y * w + x] = acc + 0.5;
    }
  }
  return { width: w, height: h, data: out };
}

export interface Gradient {
  width: number;
  height: number;
  magnitude: Float32Array;
  /** Quantised direction: 0 = horizontal gradient (vertical edge), 1 = 45°, 2 = vertical, 3 = 135°. */
  direction: Uint8Array;
}

export function sobel(src: GrayImage): Gradient {
  const { width: w, height: h } = src;
  const s = src.data;
  const magnitude = new Float32Array(w * h);
  const direction = new Uint8Array(w * h);
  const TAN22 = 0.41421356;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = s[i - w - 1] as number;
      const b = s[i - w] as number;
      const c = s[i - w + 1] as number;
      const d = s[i - 1] as number;
      const f = s[i + 1] as number;
      const g = s[i + w - 1] as number;
      const hh = s[i + w] as number;
      const k = s[i + w + 1] as number;
      const gx = c + 2 * f + k - a - 2 * d - g;
      const gy = g + 2 * hh + k - a - 2 * b - c;
      magnitude[i] = Math.sqrt(gx * gx + gy * gy);
      const ax = Math.abs(gx);
      const ay = Math.abs(gy);
      let dir: number;
      if (ay <= ax * TAN22) dir = 0;
      else if (ax <= ay * TAN22) dir = 2;
      else dir = gx * gy > 0 ? 1 : 3;
      direction[i] = dir;
    }
  }
  return { width: w, height: h, magnitude, direction };
}

/** Value at the given quantile of the non-zero magnitudes (histogram based, O(n)). */
export function magnitudeQuantile(mag: Float32Array, q: number): number {
  const BINS = 1024;
  const MAX = 1448; // max Sobel L2 magnitude for 8-bit input
  const hist = new Uint32Array(BINS);
  let n = 0;
  for (let i = 0; i < mag.length; i++) {
    const v = mag[i] as number;
    if (v <= 0) continue;
    const b = Math.min(BINS - 1, ((v / MAX) * BINS) | 0);
    hist[b] = (hist[b] as number) + 1;
    n++;
  }
  if (n === 0) return 0;
  const target = n * q;
  let acc = 0;
  for (let b = 0; b < BINS; b++) {
    acc += hist[b] as number;
    if (acc >= target) return ((b + 0.5) / BINS) * MAX;
  }
  return MAX;
}

export interface CannyOptions {
  low?: number;
  high?: number;
  /** When thresholds are not given, high = clamp(quantile(highQuantile), minHigh, maxHigh). */
  highQuantile?: number;
  minHigh?: number;
  maxHigh?: number;
  lowRatio?: number;
}

/** Canny edge detector on an already smoothed image. Returns a 0/255 edge map. */
export function canny(src: GrayImage, opts: CannyOptions = {}): { edges: GrayImage; gradient: Gradient; high: number; low: number } {
  const grad = sobel(src);
  const { width: w, height: h, magnitude: m, direction: dir } = grad;
  let high = opts.high;
  if (high === undefined) {
    const q = magnitudeQuantile(m, opts.highQuantile ?? 0.85);
    high = Math.min(opts.maxHigh ?? 320, Math.max(opts.minHigh ?? 40, q));
  }
  const low = opts.low ?? high * (opts.lowRatio ?? 0.4);
  // Non-maximum suppression.
  const nms = new Uint8Array(w * h); // 0 none, 1 weak, 2 strong
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = m[i] as number;
      if (v < low) continue;
      let n1: number;
      let n2: number;
      switch (dir[i]) {
        case 0:
          n1 = m[i - 1] as number;
          n2 = m[i + 1] as number;
          break;
        case 2:
          n1 = m[i - w] as number;
          n2 = m[i + w] as number;
          break;
        case 1:
          n1 = m[i - w - 1] as number;
          n2 = m[i + w + 1] as number;
          break;
        default:
          n1 = m[i - w + 1] as number;
          n2 = m[i + w - 1] as number;
      }
      if (v >= n1 && v > n2) nms[i] = v >= high ? 2 : 1;
    }
  }
  // Hysteresis.
  const out = new Uint8ClampedArray(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  for (let i = 0; i < nms.length; i++) {
    if (nms[i] === 2 && out[i] === 0) {
      out[i] = 255;
      stack[sp++] = i;
      while (sp > 0) {
        const p = stack[--sp] as number;
        const px = p % w;
        const py = (p - px) / w;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = py + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = px + dx;
            if (xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (out[q] === 0 && (nms[q] as number) > 0) {
              out[q] = 255;
              stack[sp++] = q;
            }
          }
        }
      }
    }
  }
  return { edges: { width: w, height: h, data: out }, gradient: grad, high, low };
}

/** Binary dilation with a square structuring element of the given radius (separable max filter). */
export function dilate(src: GrayImage, radius = 1): GrayImage {
  return morph(src, radius, true);
}

export function erode(src: GrayImage, radius = 1): GrayImage {
  return morph(src, radius, false);
}

function morph(src: GrayImage, r: number, isMax: boolean): GrayImage {
  const { width: w, height: h } = src;
  const tmp = new Uint8ClampedArray(w * h);
  const out = new Uint8ClampedArray(w * h);
  const s = src.data;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = isMax ? 0 : 255;
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w - 1, x + r);
      for (let xx = x0; xx <= x1; xx++) {
        const p = s[row + xx] as number;
        v = isMax ? (p > v ? p : v) : p < v ? p : v;
      }
      tmp[row + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      let v = isMax ? 0 : 255;
      for (let yy = y0; yy <= y1; yy++) {
        const p = tmp[yy * w + x] as number;
        v = isMax ? (p > v ? p : v) : p < v ? p : v;
      }
      out[y * w + x] = v;
    }
  }
  return { width: w, height: h, data: out };
}

export function histogram(src: GrayImage): Uint32Array {
  const hist = new Uint32Array(256);
  const d = src.data;
  for (let i = 0; i < d.length; i++) {
    const v = d[i] as number;
    hist[v] = (hist[v] as number) + 1;
  }
  return hist;
}

/** Otsu's threshold on a 256-bin histogram. */
export function otsuThreshold(hist: Uint32Array): number {
  let total = 0;
  let sum = 0;
  for (let i = 0; i < 256; i++) {
    total += hist[i] as number;
    sum += i * (hist[i] as number);
  }
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t] as number;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * (hist[t] as number);
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

export function threshold(src: GrayImage, t: number, invert = false): GrayImage {
  const out = new Uint8ClampedArray(src.data.length);
  for (let i = 0; i < out.length; i++) {
    const on = (src.data[i] as number) > t;
    out[i] = on !== invert ? 255 : 0;
  }
  return { width: src.width, height: src.height, data: out };
}

/** Variance of the 4-neighbour Laplacian, optionally restricted by a mask (non-zero = included). */
export function laplacianVariance(src: GrayImage, mask?: Uint8Array): number {
  const { width: w, height: h, data: s } = src;
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mask && mask[i] === 0) continue;
      const v =
        4 * (s[i] as number) - (s[i - 1] as number) - (s[i + 1] as number) - (s[i - w] as number) - (s[i + w] as number);
      sum += v;
      sum2 += v * v;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}
