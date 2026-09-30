import type { Point, Quad } from '../geometry/geometry';
import {
  convexHull,
  cross,
  distance,
  fitLine,
  isConvex,
  lineIntersection,
  orderQuad,
  polygonArea,
  quadAngles,
} from '../geometry/geometry';
import type { GrayImage } from '../imaging/image';
import { findComponents } from './components';
import type { Component } from './components';
import { canny, dilate, erode, gaussianBlur, histogram, otsuThreshold, threshold } from './filters';

export interface CandidateScore {
  total: number;
  area: number;
  angles: number;
  support: number;
  contrast: number;
  fill: number;
  centrality: number;
}

export interface Candidate {
  quad: Quad;
  source: 'edges' | 'bright' | 'dark';
  score: CandidateScore;
  /** True when at least one side lies on the image border (document partly out of frame). */
  partial: boolean;
}

export interface DetectionResult {
  quad: Quad | null;
  score: number;
  partial: boolean;
  candidates: Candidate[];
  width: number;
  height: number;
  /** Time spent in ms (informational). */
  elapsed: number;
}

export interface DetectOptions {
  /** Minimum total score to accept a detection. */
  minScore?: number;
  /** Gaussian sigma applied before edge detection. */
  blurSigma?: number;
  /** Keep all candidates in the result (debug). */
  keepCandidates?: boolean;
  /** Minimum quad area as a fraction of the frame. */
  minAreaRatio?: number;
}

const DEFAULTS: Required<DetectOptions> = {
  minScore: 0.3,
  blurSigma: 1.3,
  keepCandidates: false,
  minAreaRatio: 0.04,
};

/**
 * Reduces a convex polygon to 4 vertices by repeatedly removing the vertex whose removal
 * loses the least area (Visvalingam–Whyatt). Works well on hulls of rectangles seen in perspective,
 * including slightly rounded or clipped corners.
 */
export function simplifyToQuad(hull: readonly Point[]): Point[] | null {
  if (hull.length < 4) return null;
  const pts = hull.slice();
  while (pts.length > 4) {
    let minIdx = 0;
    let minArea = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length] as Point;
      const b = pts[i] as Point;
      const c = pts[(i + 1) % pts.length] as Point;
      const area = Math.abs(cross(a, b, c));
      if (area < minArea) {
        minArea = area;
        minIdx = i;
      }
    }
    pts.splice(minIdx, 1);
  }
  return pts;
}

/**
 * Refines each side of a rough quad by fitting a line through the outline samples close to it,
 * then intersects consecutive lines. This recovers sharp corners that blur or occlusion rounded off.
 */
export function refineQuad(rough: Quad, outline: readonly Point[], diag: number): Quad {
  const tol = Math.max(2, diag * 0.012);
  const lines: Array<{ point: Point; dir: Point } | null> = [];
  for (let s = 0; s < 4; s++) {
    const a = rough[s] as Point;
    const b = rough[(s + 1) % 4] as Point;
    const len = distance(a, b);
    if (len < 1) {
      lines.push(null);
      continue;
    }
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const near: Point[] = [];
    for (const p of outline) {
      const t = ((p.x - a.x) * ux + (p.y - a.y) * uy) / len;
      if (t < 0.12 || t > 0.88) continue;
      const d = Math.abs((p.x - a.x) * uy - (p.y - a.y) * ux);
      if (d <= tol) near.push(p);
    }
    lines.push(near.length >= 8 ? fitLine(near) : null);
  }
  const corners: Point[] = [];
  for (let c = 0; c < 4; c++) {
    const prev = lines[(c + 3) % 4];
    const next = lines[c];
    const original = rough[c] as Point;
    if (!prev || !next) {
      corners.push(original);
      continue;
    }
    const p = lineIntersection(
      prev.point,
      { x: prev.point.x + prev.dir.x, y: prev.point.y + prev.dir.y },
      next.point,
      { x: next.point.x + next.dir.x, y: next.point.y + next.dir.y },
    );
    corners.push(p && distance(p, original) < diag * 0.08 ? p : original);
  }
  return orderQuad(corners);
}

function sampleGray(img: GrayImage, x: number, y: number): number {
  const xi = Math.max(0, Math.min(img.width - 1, Math.round(x)));
  const yi = Math.max(0, Math.min(img.height - 1, Math.round(y)));
  return img.data[yi * img.width + xi] as number;
}

function isBorderSide(a: Point, b: Point, w: number, h: number): boolean {
  const mx = w * 0.02 + 1;
  const my = h * 0.02 + 1;
  return (
    (a.x <= mx && b.x <= mx) || (a.y <= my && b.y <= my) || (a.x >= w - 1 - mx && b.x >= w - 1 - mx) || (a.y >= h - 1 - my && b.y >= h - 1 - my)
  );
}

function ramp(v: number, lo: number, hi: number): number {
  if (v <= lo) return 0;
  if (v >= hi) return 1;
  return (v - lo) / (hi - lo);
}

/** Scores a candidate quad against the edge map and the smoothed image. */
export function scoreQuad(
  quad: Quad,
  hullArea: number,
  edgeTol: GrayImage,
  gray: GrayImage,
  minAreaRatio: number,
): { score: CandidateScore; partial: boolean } | null {
  const w = gray.width;
  const h = gray.height;
  const frameArea = w * h;
  const diag = Math.hypot(w, h);
  if (!isConvex(quad)) return null;
  const area = polygonArea(quad);
  const areaRatio = area / frameArea;
  if (areaRatio < minAreaRatio) return null;
  for (let i = 0; i < 4; i++) {
    if (distance(quad[i] as Point, quad[(i + 1) % 4] as Point) < diag * 0.06) return null;
  }
  const angles = quadAngles(quad);
  let angleScore = 1;
  for (const a of angles) {
    if (a < 25 || a > 155) return null;
    angleScore *= a < 55 ? ramp(a, 25, 55) : a > 125 ? ramp(155 - a, 0, 30) : 1;
  }
  angleScore = Math.pow(angleScore, 0.5);
  // Opposite sides should not be wildly different (extreme perspective is unrealistic).
  const r1 = distance(quad[0], quad[1]) / Math.max(1, distance(quad[3], quad[2]));
  const r2 = distance(quad[0], quad[3]) / Math.max(1, distance(quad[1], quad[2]));
  if (Math.min(r1, 1 / r1) < 0.35 || Math.min(r2, 1 / r2) < 0.35) return null;

  let supportMin = 1;
  let supportSum = 0;
  let supportN = 0;
  let inside = 0;
  let outside = 0;
  let contrastN = 0;
  let partial = false;
  const off = Math.max(2, diag * 0.012);
  const c = { x: (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4, y: (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4 };
  for (let s = 0; s < 4; s++) {
    const a = quad[s] as Point;
    const b = quad[(s + 1) % 4] as Point;
    if (isBorderSide(a, b, w, h)) {
      partial = true;
      continue;
    }
    const len = distance(a, b);
    const n = Math.max(16, Math.min(80, Math.round(len / 3)));
    let hits = 0;
    // Outward normal: points away from the quad centre.
    let nx = -(b.y - a.y) / len;
    let ny = (b.x - a.x) / len;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if ((mid.x - c.x) * nx + (mid.y - c.y) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    for (let k = 0; k < n; k++) {
      const t = 0.06 + (0.88 * (k + 0.5)) / n;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      if (sampleGray(edgeTol, x, y) > 0) hits++;
      const ox = x + nx * off;
      const oy = y + ny * off;
      if (ox >= 0 && oy >= 0 && ox < w && oy < h) {
        inside += sampleGray(gray, x - nx * off, y - ny * off);
        outside += sampleGray(gray, ox, oy);
        contrastN++;
      }
    }
    const sup = hits / n;
    supportMin = Math.min(supportMin, sup);
    supportSum += sup;
    supportN++;
  }
  if (supportN < 2) return null;
  const support = 0.6 * supportMin + 0.4 * (supportSum / supportN);
  const contrast = contrastN ? Math.abs(inside - outside) / contrastN / 255 : 0;
  const fill = Math.min(1, area / Math.max(1, hullArea));

  const areaScore = areaRatio > 0.97 ? 0.4 : Math.min(1, 0.35 + ramp(areaRatio, minAreaRatio, 0.35) * 0.65);
  const centreDist = Math.hypot(c.x / w - 0.5, c.y / h - 0.5);
  const centrality = 1 - Math.min(0.3, centreDist * 0.5);
  const contrastScore = Math.min(1, 0.25 + contrast * 7);
  const fillScore = ramp(fill, 0.7, 0.95);

  const total =
    areaScore * angleScore * Math.pow(support, 1.3) * contrastScore * (0.3 + 0.7 * fillScore) * centrality * (partial ? 0.85 : 1);
  return {
    score: { total, area: areaScore, angles: angleScore, support, contrast, fill, centrality },
    partial,
  };
}

function candidateFromComponent(comp: Component, diag: number): { quad: Quad; hullArea: number } | null {
  if (comp.outline.length < 4) return null;
  const hull = convexHull(comp.outline);
  if (hull.length < 4) return null;
  const hullArea = polygonArea(hull);
  const rough = simplifyToQuad(hull);
  if (!rough) return null;
  let quad: Quad;
  try {
    quad = refineQuad(orderQuad(rough), comp.outline, diag);
  } catch {
    return null;
  }
  return { quad, hullArea };
}

/**
 * Full document detection on a (downscaled) grayscale frame:
 * blur → Canny (adaptive thresholds) → closing → connected contours → convex hull →
 * 4-vertex approximation → side refinement → multi-criteria scoring; plus an Otsu segmentation
 * generator for low-texture scenes. Returns null quad when nothing is reliable.
 */
export function detectDocument(gray: GrayImage, options: DetectOptions = {}): DetectionResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const opts = { ...DEFAULTS, ...options };
  const { width: w, height: h } = gray;
  const diag = Math.hypot(w, h);
  const blurred = gaussianBlur(gray, opts.blurSigma);
  const { edges } = canny(blurred, { highQuantile: 0.88, minHigh: 36, maxHigh: 300, lowRatio: 0.4 });
  const closed = dilate(edges, 1);
  const edgeTol = dilate(edges, 2);

  const candidates: Candidate[] = [];
  const consider = (comp: Component, source: Candidate['source']) => {
    const c = candidateFromComponent(comp, diag);
    if (!c) return;
    const s = scoreQuad(c.quad, c.hullArea, edgeTol, blurred, opts.minAreaRatio);
    if (!s) return;
    candidates.push({ quad: c.quad, source, score: s.score, partial: s.partial });
  };

  for (const comp of findComponents(closed, { minBoxAreaRatio: opts.minAreaRatio * 0.8, maxComponents: 10 })) {
    consider(comp, 'edges');
  }

  // Segmentation generator: bright (paper on dark) and dark (dark card on light) regions.
  const t = otsuThreshold(histogram(blurred));
  const bright = erode(dilate(threshold(blurred, t), 1), 1);
  for (const comp of findComponents(erode(bright, 1), { minBoxAreaRatio: opts.minAreaRatio, maxComponents: 4 })) {
    consider(comp, 'bright');
  }
  const dark = erode(threshold(blurred, t, true), 1);
  for (const comp of findComponents(dark, { minBoxAreaRatio: opts.minAreaRatio, maxComponents: 3 })) {
    if (comp.touchesBorder) continue;
    consider(comp, 'dark');
  }

  candidates.sort((a, b) => b.score.total - a.score.total);
  const best = candidates[0];
  const accepted = best && best.score.total >= opts.minScore ? best : null;
  const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return {
    quad: accepted ? accepted.quad : null,
    score: accepted ? accepted.score.total : best ? best.score.total : 0,
    partial: accepted ? accepted.partial : false,
    candidates: opts.keepCandidates ? candidates : [],
    width: w,
    height: h,
    elapsed,
  };
}
