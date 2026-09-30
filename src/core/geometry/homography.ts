import type { Point, Quad } from './geometry';
import { distance } from './geometry';

/** Row-major 3x3 matrix. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

/**
 * Solves A x = b for a square system using Gaussian elimination with partial pivoting.
 * Returns null when the system is singular.
 */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i] as number]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs((M[col] as number[])[col] as number);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs((M[r] as number[])[col] as number);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (best < 1e-12) return null;
    if (pivot !== col) {
      const tmp = M[col] as number[];
      M[col] = M[pivot] as number[];
      M[pivot] = tmp;
    }
    const pr = M[col] as number[];
    const pv = pr[col] as number;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const row = M[r] as number[];
      const f = (row[col] as number) / pv;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) row[c] = (row[c] as number) - f * (pr[c] as number);
    }
  }
  return M.map((row, i) => (row[n] as number) / (row[i] as number));
}

/**
 * Computes the homography H such that H * src[i] ~ dst[i] (Direct Linear Transform with h33 = 1).
 */
export function computeHomography(src: readonly Point[], dst: readonly Point[]): Mat3 {
  if (src.length !== 4 || dst.length !== 4) throw new Error('Homographie : 4 correspondances requises');
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const s = src[i] as Point;
    const d = dst[i] as Point;
    A.push([s.x, s.y, 1, 0, 0, 0, -d.x * s.x, -d.x * s.y]);
    b.push(d.x);
    A.push([0, 0, 0, s.x, s.y, 1, -d.y * s.x, -d.y * s.y]);
    b.push(d.y);
  }
  const h = solveLinear(A, b);
  if (!h) throw new Error('Homographie dégénérée (points alignés ou confondus)');
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1] as Mat3;
}

export function applyHomography(H: Mat3, p: Point): Point {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return {
    x: (H[0] * p.x + H[1] * p.y + H[2]) / w,
    y: (H[3] * p.x + H[4] * p.y + H[5]) / w,
  };
}

export function invert3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) throw new Error('Matrice non inversible');
  const inv = 1 / det;
  return [
    A * inv,
    -(b * i - c * h) * inv,
    (b * f - c * e) * inv,
    B * inv,
    (a * i - c * g) * inv,
    -(a * f - c * d) * inv,
    C * inv,
    -(a * h - b * g) * inv,
    (a * e - b * d) * inv,
  ];
}

/** Common paper aspect ratios (long side / short side). */
export const KNOWN_RATIOS: ReadonlyArray<{ name: string; ratio: number }> = [
  { name: 'A4', ratio: 297 / 210 },
  { name: 'Letter', ratio: 11 / 8.5 },
  { name: 'Carte', ratio: 85.6 / 53.98 },
];

/**
 * Estimates the output size of the rectified document. Uses the longest opposite edges
 * (never shrinks the content) and snaps the aspect ratio to a known paper format when close.
 */
export function estimateOutputSize(q: Quad, opts: { snap?: boolean; maxSide?: number } = {}): { width: number; height: number } {
  const wTop = distance(q[0], q[1]);
  const wBottom = distance(q[3], q[2]);
  const hLeft = distance(q[0], q[3]);
  const hRight = distance(q[1], q[2]);
  let width = Math.max(wTop, wBottom);
  let height = Math.max(hLeft, hRight);
  if (opts.snap !== false) {
    const long = Math.max(width, height);
    const short = Math.min(width, height);
    const r = long / Math.max(1, short);
    for (const k of KNOWN_RATIOS) {
      if (Math.abs(r - k.ratio) / k.ratio < 0.06) {
        const newShort = long / k.ratio;
        if (width >= height) height = newShort;
        else width = newShort;
        break;
      }
    }
  }
  const maxSide = opts.maxSide ?? 4096;
  const s = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}
