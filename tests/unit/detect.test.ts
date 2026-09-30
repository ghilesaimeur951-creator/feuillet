import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
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
      // Every corner within 2 % of the frame diagonal (≈ 12 px on a 480×360 frame).
      expect(err).toBeLessThan(diag * 0.02);
      expect(r.partial).toBe(false);
    });
  }
});
