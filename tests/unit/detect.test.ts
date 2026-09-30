import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { detectDocument } from '../../src/core/cv/detect';
import type { Quad } from '../../src/core/geometry/geometry';
import { distance } from '../../src/core/geometry/geometry';
import { toGray } from '../../src/core/imaging/image';
import { readPng } from './helpers/png';

interface Case {
  name: string;
  file: string;
  corners: [number, number][] | null;
  expect: 'detect' | 'none' | 'partial-or-none';
  note: string;
}

const DIR = join(import.meta.dir, '..', 'fixtures', 'cv');
const cases = JSON.parse(readFileSync(join(DIR, 'cases.json'), 'utf8')) as Case[];

function maxError(q: Quad, gt: [number, number][]): number {
  return Math.max(...q.map((p, i) => distance(p, { x: (gt[i] as [number, number])[0], y: (gt[i] as [number, number])[1] })));
}

describe('détection de document sur scènes synthétiques (section 31)', () => {
  for (const c of cases) {
    test(`${c.name} — ${c.note}`, () => {
      const gray = toGray(readPng(join(DIR, c.file)));
      const r = detectDocument(gray);
      const diag = Math.hypot(gray.width, gray.height);
      if (c.expect === 'none') {
        expect(r.quad).toBeNull();
        return;
      }
      if (c.expect === 'partial-or-none') {
        if (r.quad) expect(r.partial).toBe(true);
        return;
      }
      expect(r.quad).not.toBeNull();
      const err = maxError(r.quad as Quad, c.corners as [number, number][]);
      // Every corner within 0.6 % of the frame diagonal (≈ 3.6 px on a 480×360 frame; sub-pixel refinement gives ≈ 1 px).
      expect(err).toBeLessThan(diag * 0.006);
      expect(r.partial).toBe(false);
    });
  }
});

describe('comparaison avec la chaîne OpenCV classique', () => {
  test('précision des coins au moins équivalente à OpenCV (Canny + findContours + approxPolyDP)', () => {
    const r = spawnSync('python3', [join(import.meta.dir, '..', '..', 'scripts', 'opencv_baseline.py')], { encoding: 'utf8' });
    if (r.status !== 0) return; // OpenCV (python3-opencv) not installed: comparison skipped.
    const baseline = r.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { name: string; found: boolean; maxError: number | null });
    let ours = 0;
    let theirs = 0;
    let n = 0;
    for (const c of cases) {
      const b = baseline.find((x) => x.name === c.name);
      if (!b || b.maxError === null || c.expect !== 'detect') continue;
      const q = detectDocument(toGray(readPng(join(DIR, c.file)))).quad;
      if (!q) continue;
      ours += maxError(q, c.corners as [number, number][]);
      theirs += b.maxError;
      n++;
    }
    expect(n).toBeGreaterThan(8);
    expect(ours / n).toBeLessThanOrEqual(theirs / n);
  });
});
