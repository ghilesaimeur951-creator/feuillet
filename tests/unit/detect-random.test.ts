import { describe, expect, test } from 'bun:test';
import { detectDocument } from '../../src/core/cv/detect';
import { gaussianBlur } from '../../src/core/cv/filters';
import type { Point, Quad } from '../../src/core/geometry/geometry';
import { distance, isConvex, pointInPolygon, quadAngles } from '../../src/core/geometry/geometry';
import type { GrayImage } from '../../src/core/imaging/image';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Scene {
  gray: GrayImage;
  quad: Quad;
}

/** Random camera-like scene: textured table, paper in perspective with text lines, blur and noise. */
export function scene(seed: number, W = 360, H = 270): Scene {
  const r = rng(seed);
  const cx = W / 2 + (r() - 0.5) * W * 0.15;
  const cy = H / 2 + (r() - 0.5) * H * 0.15;
  const hw = W * (0.18 + r() * 0.17);
  const hh = H * (0.28 + r() * 0.17);
  const ang = (r() - 0.5) * 0.7;
  const base = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([x, y]) => ({
    x: cx + (x as number) * Math.cos(ang) - (y as number) * Math.sin(ang),
    y: cy + (x as number) * Math.sin(ang) + (y as number) * Math.cos(ang),
  }));
  // Perspective: pull the top corners towards each other.
  const k = r() * 0.25;
  const q = base.map((p, i) => (i < 2 ? { x: p.x + (cx - p.x) * k, y: p.y } : p)) as unknown as Quad;
  const table = 20 + r() * 110;
  const paper = Math.min(250, table + 45 + r() * 100);
  const data = new Uint8ClampedArray(W * H);
  const lines: Array<{ y: number; x0: number; x1: number }> = [];
  for (let i = 0; i < 12; i++) lines.push({ y: 0.15 + i * 0.06, x0: 0.1, x1: 0.35 + r() * 0.55 });
  // Inverse bilinear mapping inside the quad to draw text lines in paper space.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p: Point = { x: x + 0.5, y: y + 0.5 };
      let v = table + (((x * 7 + y * 13) % 17) - 8) * 0.8;
      if (pointInPolygon(p, q as unknown as Point[])) {
        v = paper;
        const top = { x: q[0].x + (q[1].x - q[0].x) * 0.5, y: q[0].y + (q[1].y - q[0].y) * 0.5 };
        const bottom = { x: q[3].x + (q[2].x - q[3].x) * 0.5, y: q[3].y + (q[2].y - q[3].y) * 0.5 };
        const vy = (p.y - top.y) / Math.max(1, bottom.y - top.y);
        const left = { x: q[0].x + (q[3].x - q[0].x) * vy, y: 0 };
        const right = { x: q[1].x + (q[2].x - q[1].x) * vy, y: 0 };
        const vx = (p.x - left.x) / Math.max(1, right.x - left.x);
        for (const l of lines) if (Math.abs(vy - l.y) < 0.012 && vx > l.x0 && vx < l.x1) v = paper * 0.35;
      }
      data[y * W + x] = v;
    }
  }
  const blurred = gaussianBlur({ width: W, height: H, data }, 0.8 + r() * 0.6);
  for (let i = 0; i < blurred.data.length; i++) blurred.data[i] = (blurred.data[i] as number) + (r() - 0.5) * 10;
  return { gray: blurred, quad: q };
}

describe('robustesse sur des scènes aléatoires', () => {
  test('taux de détection ≥ 95 % et erreur médiane ≤ 1,5 px', () => {
    const errors: number[] = [];
    let missed = 0;
    let n = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const s = scene(seed);
      // Keep realistic, fully visible documents (partial documents are covered by the fixtures).
      if (!isConvex(s.quad) || quadAngles(s.quad).some((a) => a < 50 || a > 130)) continue;
      if (s.quad.some((p) => p.x < 3 || p.y < 3 || p.x > s.gray.width - 3 || p.y > s.gray.height - 3)) continue;
      n++;
      const r = detectDocument(s.gray);
      if (!r.quad) {
        missed++;
        continue;
      }
      errors.push(Math.max(...r.quad.map((p, i) => distance(p, s.quad[i] as Point))));
    }
    errors.sort((a, b) => a - b);
    const median = errors[errors.length >> 1] as number;
    const p90 = errors[Math.floor(errors.length * 0.9)] as number;
    if (process.env.CV_STATS)
      console.log(
        `scènes ${n}, manquées ${missed}, médiane ${median.toFixed(2)} px, p90 ${p90.toFixed(2)} px, max ${(errors[errors.length - 1] as number).toFixed(2)} px`,
      );
    expect(n).toBeGreaterThan(60);
    expect(missed / n).toBeLessThanOrEqual(0.05);
    expect(median).toBeLessThanOrEqual(1.5);
    expect(p90).toBeLessThanOrEqual(4);
  });

  test('performance : analyse d’une image 360×270 en temps réel', () => {
    const s = scene(7);
    detectDocument(s.gray); // warm-up (JIT)
    // Median of individual timings: robust to a busy machine or a GC pause.
    const times: number[] = [];
    for (let i = 0; i < 21; i++) {
      const t0 = performance.now();
      detectDocument(s.gray);
      times.push(performance.now() - t0);
    }
    const ms = times.sort((a, b) => a - b)[10] as number;
    if (process.env.CV_STATS) console.log(`détection : ${ms.toFixed(1)} ms / image 360×270`);
    // Generous bound for CI machines; typical desktop ≈ 15–25 ms, recent phones ≈ 30–60 ms.
    expect(ms).toBeLessThan(120);
  });
});
