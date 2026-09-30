import { describe, expect, test } from 'bun:test';
import type { Point } from '../../src/core/geometry/geometry';
import {
  convexHull,
  isConvex,
  orderQuad,
  polygonArea,
  quadAngles,
  rotatePoint90,
  lineIntersection,
  fitLine,
} from '../../src/core/geometry/geometry';
import { applyHomography, computeHomography, estimateOutputSize, invert3 } from '../../src/core/geometry/homography';

const TL = { x: 10, y: 12 };
const TR = { x: 200, y: 20 };
const BR = { x: 190, y: 300 };
const BL = { x: 5, y: 280 };

function permutations<T>(a: T[]): T[][] {
  if (a.length <= 1) return [a];
  return a.flatMap((x, i) => permutations([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));
}

describe('classement des quatre coins (P1..P4)', () => {
  test('toutes les permutations donnent TL, TR, BR, BL', () => {
    for (const p of permutations([TL, TR, BR, BL])) {
      expect(orderQuad(p)).toEqual([TL, TR, BR, BL]);
    }
  });

  test('document fortement incliné (≈ 40°)', () => {
    const c = { x: 100, y: 100 };
    const a = (40 * Math.PI) / 180;
    const rot = (x: number, y: number): Point => ({
      x: c.x + x * Math.cos(a) - y * Math.sin(a),
      y: c.y + x * Math.sin(a) + y * Math.cos(a),
    });
    const tl = rot(-50, -70);
    const tr = rot(50, -70);
    const br = rot(50, 70);
    const bl = rot(-50, 70);
    const q = orderQuad([br, tl, bl, tr]);
    // Clockwise order must be preserved, starting from the top-left-most vertex.
    expect(polygonArea(q)).toBeCloseTo(100 * 140, 3);
    expect(isConvex(q)).toBe(true);
    const idx = [tl, tr, br, bl].findIndex((p) => p === q[0]);
    const expected = [0, 1, 2, 3].map((k) => [tl, tr, br, bl][(idx + k) % 4]);
    expect(q).toEqual(expected as unknown as typeof q);
  });

  test('forte perspective (trapèze)', () => {
    const q = orderQuad([
      { x: 190, y: 380 },
      { x: 180, y: 80 },
      { x: 320, y: 80 },
      { x: 440, y: 390 },
    ]);
    expect(q[0]).toEqual({ x: 180, y: 80 });
    expect(q[1]).toEqual({ x: 320, y: 80 });
    expect(q[2]).toEqual({ x: 440, y: 390 });
    expect(q[3]).toEqual({ x: 190, y: 380 });
  });

  test('rejette un nombre de points différent de 4', () => {
    expect(() => orderQuad([TL, TR, BR])).toThrow();
  });
});

describe('géométrie', () => {
  test('enveloppe convexe d’un carré avec points intérieurs', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 5, y: 5 },
      { x: 3, y: 7 },
      { x: 5, y: 0 },
    ];
    const hull = convexHull(pts);
    expect(hull).toHaveLength(4);
    expect(polygonArea(hull)).toBe(100);
  });

  test('angles d’un rectangle = 90°', () => {
    for (const a of quadAngles([TL, { x: 110, y: 12 }, { x: 110, y: 80 }, { x: 10, y: 80 }])) {
      expect(a).toBeCloseTo(90, 6);
    }
  });

  test('convexité', () => {
    expect(isConvex([TL, TR, BR, BL])).toBe(true);
    expect(isConvex([TL, BR, TR, BL])).toBe(false);
  });

  test('intersection de droites et ajustement', () => {
    expect(lineIntersection({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toEqual({ x: 5, y: 5 });
    expect(lineIntersection({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 })).toBeNull();
    const l = fitLine([
      { x: 0, y: 1 },
      { x: 1, y: 3 },
      { x: 2, y: 5 },
      { x: 3, y: 7 },
    ]);
    expect(l).not.toBeNull();
    expect(Math.abs((l?.dir.y ?? 0) / (l?.dir.x ?? 1))).toBeCloseTo(2, 6);
  });

  test('rotation de point par quarts de tour', () => {
    const p = { x: 2, y: 3 };
    expect(rotatePoint90(p, 10, 20, 1)).toEqual({ x: 17, y: 2 });
    expect(rotatePoint90(p, 10, 20, 2)).toEqual({ x: 8, y: 17 });
    expect(rotatePoint90(p, 10, 20, 3)).toEqual({ x: 3, y: 8 });
    expect(rotatePoint90(p, 10, 20, 4)).toEqual(p);
  });
});

describe('homographie', () => {
  const src = [
    { x: 120, y: 40 },
    { x: 400, y: 70 },
    { x: 430, y: 380 },
    { x: 90, y: 350 },
  ];
  const dst = [
    { x: 0, y: 0 },
    { x: 210, y: 0 },
    { x: 210, y: 297 },
    { x: 0, y: 297 },
  ];

  test('envoie exactement les 4 coins sur le rectangle cible', () => {
    const H = computeHomography(src, dst);
    src.forEach((p, i) => {
      const q = applyHomography(H, p);
      expect(q.x).toBeCloseTo((dst[i] as Point).x, 6);
      expect(q.y).toBeCloseTo((dst[i] as Point).y, 6);
    });
  });

  test('préserve l’alignement (propriété projective) et est inversible', () => {
    const H = computeHomography(src, dst);
    const Hi = invert3(H);
    // Midpoint of a destination edge maps to a point on the corresponding source edge.
    const m = applyHomography(Hi, { x: 105, y: 0 });
    const a = src[0] as Point;
    const b = src[1] as Point;
    const crossVal = (b.x - a.x) * (m.y - a.y) - (b.y - a.y) * (m.x - a.x);
    expect(Math.abs(crossVal)).toBeLessThan(1e-6);
    const back = applyHomography(H, m);
    expect(back.x).toBeCloseTo(105, 6);
    expect(back.y).toBeCloseTo(0, 6);
  });

  test('refuse les points dégénérés', () => {
    expect(() =>
      computeHomography(
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
          { x: 2, y: 2 },
          { x: 3, y: 3 },
        ],
        dst,
      ),
    ).toThrow();
  });

  test('taille de sortie : aimante au ratio A4 quand proche', () => {
    const s = estimateOutputSize([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 290 },
      { x: 0, y: 290 },
    ]);
    expect(s.height / s.width).toBeCloseTo(297 / 210, 2);
    const free = estimateOutputSize(
      [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
        { x: 200, y: 290 },
        { x: 0, y: 290 },
      ],
      { snap: false },
    );
    expect(free).toEqual({ width: 200, height: 290 });
  });
});
