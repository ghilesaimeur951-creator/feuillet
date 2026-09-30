import { gaussianBlur } from '../cv/filters';
import type { GrayImage, RGBAImage } from './image';
import { cloneRGBA, resizeGray, toGray } from './image';

export type FilterId = 'original' | 'auto' | 'document' | 'enhanced' | 'bw' | 'grayscale';

export const FILTERS: ReadonlyArray<{ id: FilterId; label: string; description: string }> = [
  { id: 'original', label: 'Original', description: 'Image redressée sans traitement' },
  { id: 'auto', label: 'Auto', description: 'Ombres atténuées, niveaux et netteté automatiques' },
  { id: 'document', label: 'Document', description: 'Fond blanchi, texte renforcé, couleurs conservées' },
  { id: 'enhanced', label: 'Couleur+', description: 'Balance des blancs et couleurs ravivées' },
  { id: 'bw', label: 'N&B', description: 'Noir et blanc pur, idéal pour le texte' },
  { id: 'grayscale', label: 'Gris', description: 'Niveaux de gris nettoyés' },
];

export interface Adjustments {
  /** -100..100 */
  brightness: number;
  /** -100..100 */
  contrast: number;
  /** -100..100 */
  saturation: number;
  /** 0..100 */
  sharpness: number;
  /** -100..100 (±2 EV) */
  exposure: number;
  /** 0..100 — edge-preserving noise reduction (also attenuates moiré). */
  denoise: number;
}

export const NEUTRAL_ADJUSTMENTS: Adjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  sharpness: 0,
  exposure: 0,
  denoise: 0,
};

export function isNeutral(a: Adjustments): boolean {
  return (Object.keys(NEUTRAL_ADJUSTMENTS) as Array<keyof Adjustments>).every((k) => a[k] === 0);
}

/**
 * Estimates the paper background (illumination) of each channel: downscale, max-filter
 * (text is darker than paper, so the local maximum is the paper), blur, then upsample.
 */
export function estimateBackground(img: RGBAImage, channel: 0 | 1 | 2 | 'luma'): Float32Array {
  const { width: w, height: h } = img;
  const src: GrayImage =
    channel === 'luma'
      ? toGray(img)
      : {
          width: w,
          height: h,
          data: (() => {
            const d = new Uint8ClampedArray(w * h);
            for (let i = 0, j = channel; i < d.length; i++, j += 4) d[i] = img.data[j] as number;
            return d;
          })(),
        };
  const cell = Math.max(4, Math.round(Math.max(w, h) / 96));
  const sw = Math.max(2, Math.ceil(w / cell));
  const sh = Math.max(2, Math.ceil(h / cell));
  const small = resizeGray(src, sw, sh);
  // Max filter to erase text strokes, then a blur for smooth illumination.
  const r = 2;
  const maxed = new Uint8ClampedArray(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let m = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(sh - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.min(sw - 1, Math.max(0, x + dx));
          const v = small.data[yy * sw + xx] as number;
          if (v > m) m = v;
        }
      }
      maxed[y * sw + x] = m;
    }
  }
  const smooth = gaussianBlur({ width: sw, height: sh, data: maxed }, 1.5);
  // Bilinear upsample.
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / cell - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ay = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / cell - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const ax = fx - x0;
      const s = smooth.data;
      const v =
        (s[y0 * sw + x0] as number) * (1 - ax) * (1 - ay) +
        (s[y0 * sw + x1] as number) * ax * (1 - ay) +
        (s[y1 * sw + x0] as number) * (1 - ax) * ay +
        (s[y1 * sw + x1] as number) * ax * ay;
      out[y * w + x] = Math.max(24, v);
    }
  }
  return out;
}

/** Divides each channel by its estimated background: removes shadows and whitens the paper. */
export function flattenIllumination(img: RGBAImage, strength = 1): RGBAImage {
  const out = cloneRGBA(img);
  const n = img.width * img.height;
  const bgL = estimateBackground(img, 'luma');
  for (let i = 0; i < n; i++) {
    const g = 255 / (bgL[i] as number);
    const k = 1 + (g - 1) * strength;
    const o = i * 4;
    out.data[o] = (img.data[o] as number) * k;
    out.data[o + 1] = (img.data[o + 1] as number) * k;
    out.data[o + 2] = (img.data[o + 2] as number) * k;
  }
  return out;
}

function percentileFromHist(hist: Uint32Array, total: number, p: number): number {
  const target = total * p;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v] as number;
    if (acc >= target) return v;
  }
  return 255;
}

/** Stretches levels so that the given luminance percentiles map to 0 and 255. */
export function autoLevels(img: RGBAImage, lowP = 0.01, highP = 0.99): RGBAImage {
  const hist = new Uint32Array(256);
  const d = img.data;
  const n = img.width * img.height;
  for (let i = 0; i < d.length; i += 4) {
    const l = ((d[i] as number) * 77 + (d[i + 1] as number) * 150 + (d[i + 2] as number) * 29) >> 8;
    hist[l] = (hist[l] as number) + 1;
  }
  const lo = percentileFromHist(hist, n, lowP);
  const hi = Math.max(lo + 16, percentileFromHist(hist, n, highP));
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = ((v - lo) * 255) / (hi - lo);
  const out = cloneRGBA(img);
  for (let i = 0; i < d.length; i += 4) {
    out.data[i] = lut[d[i] as number] as number;
    out.data[i + 1] = lut[d[i + 1] as number] as number;
    out.data[i + 2] = lut[d[i + 2] as number] as number;
  }
  return out;
}

/** Gray-world white balance computed on bright (paper) pixels only. */
export function whiteBalance(img: RGBAImage): RGBAImage {
  const d = img.data;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = ((d[i] as number) * 77 + (d[i + 1] as number) * 150 + (d[i + 2] as number) * 29) >> 8;
    if (l < 120) continue;
    r += d[i] as number;
    g += d[i + 1] as number;
    b += d[i + 2] as number;
    n++;
  }
  if (n < 100) return cloneRGBA(img);
  const avg = (r + g + b) / (3 * n);
  const kr = avg / Math.max(1, r / n);
  const kg = avg / Math.max(1, g / n);
  const kb = avg / Math.max(1, b / n);
  const out = cloneRGBA(img);
  for (let i = 0; i < d.length; i += 4) {
    out.data[i] = (d[i] as number) * kr;
    out.data[i + 1] = (d[i + 1] as number) * kg;
    out.data[i + 2] = (d[i + 2] as number) * kb;
  }
  return out;
}

/** Applies an S-ish tone curve that pushes the paper to white and ink to black. */
function documentCurve(img: RGBAImage, whitePoint: number, blackPoint: number, gamma: number): RGBAImage {
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const t = Math.min(1, Math.max(0, (v - blackPoint) / (whitePoint - blackPoint)));
    lut[v] = Math.pow(t, gamma) * 255;
  }
  const out = cloneRGBA(img);
  for (let i = 0; i < img.data.length; i += 4) {
    out.data[i] = lut[img.data[i] as number] as number;
    out.data[i + 1] = lut[img.data[i + 1] as number] as number;
    out.data[i + 2] = lut[img.data[i + 2] as number] as number;
  }
  return out;
}

/** Unsharp mask on all channels. amount ~0..2, sigma in pixels. */
export function unsharpMask(img: RGBAImage, amount: number, sigma = 1): RGBAImage {
  if (amount <= 0) return cloneRGBA(img);
  const { width: w, height: h } = img;
  const out = cloneRGBA(img);
  for (let c = 0; c < 3; c++) {
    const ch = new Uint8ClampedArray(w * h);
    for (let i = 0, j = c; i < ch.length; i++, j += 4) ch[i] = img.data[j] as number;
    const blurred = gaussianBlur({ width: w, height: h, data: ch }, sigma).data;
    for (let i = 0, j = c; i < ch.length; i++, j += 4) {
      const v = ch[i] as number;
      out.data[j] = v + amount * (v - (blurred[i] as number));
    }
  }
  return out;
}

/** Edge-preserving smoothing (Lee filter using integral images) — reduces sensor noise and moiré. */
export function denoise(img: RGBAImage, strength: number): RGBAImage {
  if (strength <= 0) return cloneRGBA(img);
  const { width: w, height: h } = img;
  const r = strength > 60 ? 2 : 1;
  const noiseVar = 20 + strength * 6;
  const out = cloneRGBA(img);
  const W1 = w + 1;
  const S = new Float64Array(W1 * (h + 1));
  const S2 = new Float64Array(W1 * (h + 1));
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) {
      let rs = 0;
      let rs2 = 0;
      for (let x = 0; x < w; x++) {
        const v = img.data[(y * w + x) * 4 + c] as number;
        rs += v;
        rs2 += v * v;
        S[(y + 1) * W1 + x + 1] = (S[y * W1 + x + 1] as number) + rs;
        S2[(y + 1) * W1 + x + 1] = (S2[y * W1 + x + 1] as number) + rs2;
      }
    }
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r);
        const x1 = Math.min(w, x + r + 1);
        const n = (y1 - y0) * (x1 - x0);
        const s = (S[y1 * W1 + x1] as number) - (S[y0 * W1 + x1] as number) - (S[y1 * W1 + x0] as number) + (S[y0 * W1 + x0] as number);
        const s2 = (S2[y1 * W1 + x1] as number) - (S2[y0 * W1 + x1] as number) - (S2[y1 * W1 + x0] as number) + (S2[y0 * W1 + x0] as number);
        const mean = s / n;
        const variance = Math.max(0, s2 / n - mean * mean);
        const k = variance / (variance + noiseVar);
        const o = (y * w + x) * 4 + c;
        out.data[o] = mean + k * ((img.data[o] as number) - mean);
      }
    }
  }
  return out;
}

/** Sauvola-style adaptive binarisation on a (background-flattened) gray image. */
export function binarize(gray: GrayImage, k = 0.18): GrayImage {
  const { width: w, height: h, data } = gray;
  const win = Math.max(15, Math.round(Math.max(w, h) / 50)) | 1;
  const r = win >> 1;
  const W1 = w + 1;
  const S = new Float64Array(W1 * (h + 1));
  const S2 = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0;
    let rs2 = 0;
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x] as number;
      rs += v;
      rs2 += v * v;
      S[(y + 1) * W1 + x + 1] = (S[y * W1 + x + 1] as number) + rs;
      S2[(y + 1) * W1 + x + 1] = (S2[y * W1 + x + 1] as number) + rs2;
    }
  }
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const n = (y1 - y0) * (x1 - x0);
      const s = (S[y1 * W1 + x1] as number) - (S[y0 * W1 + x1] as number) - (S[y1 * W1 + x0] as number) + (S[y0 * W1 + x0] as number);
      const s2 = (S2[y1 * W1 + x1] as number) - (S2[y0 * W1 + x1] as number) - (S2[y1 * W1 + x0] as number) + (S2[y0 * W1 + x0] as number);
      const mean = s / n;
      const sd = Math.sqrt(Math.max(0, s2 / n - mean * mean));
      const t = mean * (1 + k * (sd / 128 - 1));
      const v = data[y * w + x] as number;
      // Very light pixels are always paper (avoids noise in empty regions).
      out[y * w + x] = v > t || v > 225 ? 255 : 0;
    }
  }
  // Remove isolated black specks.
  const clean = new Uint8ClampedArray(out);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (out[i] !== 0) continue;
      let black = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (out[i + dy * w + dx] === 0) black++;
      if (black <= 1) clean[i] = 255;
    }
  }
  return { width: w, height: h, data: clean };
}

function grayToRgbaInPlace(g: GrayImage): RGBAImage {
  const out = new Uint8ClampedArray(g.width * g.height * 4);
  for (let i = 0, j = 0; i < g.data.length; i++, j += 4) {
    const v = g.data[i] as number;
    out[j] = v;
    out[j + 1] = v;
    out[j + 2] = v;
    out[j + 3] = 255;
  }
  return { width: g.width, height: g.height, data: out };
}

/** Applies one of the scan presets. */
export function applyPreset(img: RGBAImage, filter: FilterId): RGBAImage {
  switch (filter) {
    case 'original':
      return cloneRGBA(img);
    case 'auto': {
      const flat = flattenIllumination(img, 0.92);
      return unsharpMask(autoLevels(flat, 0.005, 0.99), 0.35, 1);
    }
    case 'document': {
      const flat = flattenIllumination(img, 1);
      return unsharpMask(documentCurve(flat, 228, 60, 1.35), 0.5, 1);
    }
    case 'enhanced': {
      const wb = whiteBalance(flattenIllumination(img, 0.85));
      const lv = autoLevels(wb, 0.01, 0.99);
      return unsharpMask(adjustSaturation(lv, 30), 0.4, 1);
    }
    case 'grayscale': {
      const flat = flattenIllumination(img, 1);
      return grayToRgbaInPlace(toGray(documentCurve(flat, 236, 40, 1.2)));
    }
    case 'bw': {
      const flat = toGray(flattenIllumination(img, 1));
      return grayToRgbaInPlace(binarize(flat));
    }
  }
}

function adjustSaturation(img: RGBAImage, amount: number): RGBAImage {
  const k = 1 + amount / 100;
  const out = cloneRGBA(img);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] as number;
    const g = d[i + 1] as number;
    const b = d[i + 2] as number;
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    out.data[i] = l + (r - l) * k;
    out.data[i + 1] = l + (g - l) * k;
    out.data[i + 2] = l + (b - l) * k;
  }
  return out;
}

/** Manual adjustments applied after the preset. */
export function applyAdjustments(img: RGBAImage, a: Adjustments): RGBAImage {
  if (isNeutral(a)) return img;
  let cur = a.denoise > 0 ? denoise(img, a.denoise) : img;
  const exposure = Math.pow(2, a.exposure / 50);
  const c = (a.contrast / 100) * 200;
  const contrastF = (259 * (c + 255)) / (255 * (259 - c));
  const bright = a.brightness * 1.28;
  const sat = 1 + a.saturation / 100;
  const lut = new Float32Array(256);
  for (let v = 0; v < 256; v++) lut[v] = (v * exposure - 128) * contrastF + 128 + bright;
  const out = cloneRGBA(cur);
  const d = cur.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = lut[d[i] as number] as number;
    const g = lut[d[i + 1] as number] as number;
    const b = lut[d[i + 2] as number] as number;
    if (sat !== 1) {
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      out.data[i] = l + (r - l) * sat;
      out.data[i + 1] = l + (g - l) * sat;
      out.data[i + 2] = l + (b - l) * sat;
    } else {
      out.data[i] = r;
      out.data[i + 1] = g;
      out.data[i + 2] = b;
    }
  }
  cur = out;
  if (a.sharpness > 0) cur = unsharpMask(cur, (a.sharpness / 100) * 1.5, 1);
  return cur;
}

export function processImage(img: RGBAImage, filter: FilterId, adjustments: Adjustments = NEUTRAL_ADJUSTMENTS): RGBAImage {
  return applyAdjustments(applyPreset(img, filter), adjustments);
}
