import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Point, Quad } from '../../src/core/geometry/geometry';
import { createRGBA, rotateRGBA90, toGray } from '../../src/core/imaging/image';
import type { RGBAImage } from '../../src/core/imaging/image';
import { warpPerspective } from '../../src/core/imaging/warp';
import { applyHomography, computeHomography } from '../../src/core/geometry/homography';
import { detectDocument } from '../../src/core/cv/detect';
import { gaussianBlur } from '../../src/core/cv/filters';
import { assessQuality } from '../../src/core/cv/quality';
import { readPng } from './helpers/png';

/** Draws a checkerboard "document" into a canvas through a known homography. */
function renderProjectedChecker(W: number, H: number, quad: Quad, docW: number, docH: number, cell: number): RGBAImage {
  const img = createRGBA(W, H, [30, 30, 30, 255]);
  const Hm = computeHomography(quad, [
    { x: 0, y: 0 },
    { x: docW, y: 0 },
    { x: docW, y: docH },
    { x: 0, y: docH },
  ]);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = applyHomography(Hm, { x: x + 0.5, y: y + 0.5 });
      if (p.x < 0 || p.y < 0 || p.x >= docW || p.y >= docH) continue;
      const v = (Math.floor(p.x / cell) + Math.floor(p.y / cell)) % 2 === 0 ? 240 : 20;
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    }
  }
  return img;
}

describe('transformation de perspective', () => {
  const quad: Quad = [
    { x: 80, y: 40 },
    { x: 330, y: 70 },
    { x: 370, y: 300 },
    { x: 40, y: 280 },
  ];

  test('redresse un damier photographié en biais en un damier régulier', () => {
    const src = renderProjectedChecker(420, 340, quad, 200, 280, 40);
    const out = warpPerspective(src, quad, 200, 280);
    expect(out.width).toBe(200);
    expect(out.height).toBe(280);
    // Sample the centre of each cell: must alternate like the original checkerboard.
    let errors = 0;
    for (let cy = 0; cy < 7; cy++) {
      for (let cx = 0; cx < 5; cx++) {
        const x = cx * 40 + 20;
        const y = cy * 40 + 20;
        const v = out.data[(y * 200 + x) * 4] as number;
        const expected = (cx + cy) % 2 === 0 ? 240 : 20;
        if (Math.abs(v - expected) > 40) errors++;
      }
    }
    expect(errors).toBe(0);
  });

  test('n’est pas un simple recadrage de la boîte englobante', () => {
    const src = renderProjectedChecker(420, 340, quad, 200, 280, 40);
    const out = warpPerspective(src, quad, 200, 280);
    // The four output corners must be inside the document (no dark table visible).
    for (const [x, y] of [
      [2, 2],
      [197, 2],
      [197, 277],
      [2, 277],
    ] as const) {
      const v = out.data[(y * 200 + x) * 4] as number;
      expect(v === 240 || v > 200 || v < 40).toBe(true);
    }
    const tlv = out.data[(2 * 200 + 2) * 4] as number;
    expect(tlv).toBeGreaterThan(200); // top-left cell is light
  });

  test('chaîne complète : détection puis redressement d’une scène réelle', () => {
    const rgba = readPng(join(import.meta.dir, '..', 'fixtures', 'cv', 'strong-perspective.png'));
    const r = detectDocument(toGray(rgba));
    expect(r.quad).not.toBeNull();
    const out = warpPerspective(rgba, r.quad as Quad, 252, 356);
    // Page borders should be paper-white after rectification (no table left).
    const g = toGray(out);
    let bright = 0;
    let total = 0;
    for (let x = 12; x < 240; x++) {
      for (const y of [12, 344]) {
        total++;
        if ((g.data[y * 252 + x] as number) > 170) bright++;
      }
    }
    expect(bright / total).toBeGreaterThan(0.9);
  });

  test('rotation par quarts de tour', () => {
    const img = createRGBA(3, 2);
    img.data.set([1, 0, 0, 255], 0); // pixel (0,0)
    const r = rotateRGBA90(img, 1);
    expect(r.width).toBe(2);
    expect(r.height).toBe(3);
    expect(r.data[(0 * 2 + 1) * 4]).toBe(1); // (0,0) → (h-1, 0)
    const back = rotateRGBA90(rotateRGBA90(rotateRGBA90(r, 1), 1), 1);
    expect(Array.from(back.data)).toEqual(Array.from(img.data));
  });
});

describe('qualité de l’image', () => {
  const rgba = readPng(join(import.meta.dir, '..', 'fixtures', 'cv', 'white-on-dark.png'));
  const gray = toGray(rgba);
  const quad = detectDocument(gray).quad as Quad;

  test('image nette vs floue', () => {
    const sharp = assessQuality(gray, quad);
    const blurred = assessQuality(gaussianBlur(gray, 3), quad);
    expect(sharp.blurry).toBe(false);
    expect(blurred.blurry).toBe(true);
    expect(sharp.sharpness).toBeGreaterThan(blurred.sharpness * 3);
  });

  test('faible luminosité signalée', () => {
    const dark = toGray(readPng(join(import.meta.dir, '..', 'fixtures', 'cv', 'low-light.png')));
    const q = detectDocument(dark).quad;
    expect(q).not.toBeNull();
    expect(assessQuality(dark, q).brightness).toBeLessThan(assessQuality(gray, quad).brightness * 0.6);
    expect(assessQuality(dark, null).tooDark).toBe(true);
    expect(assessQuality(gray, quad).tooDark).toBe(false);
  });

  test('reflet détecté', () => {
    // Simulate a camera exposing the paper around 215 with a specular highlight on it.
    const g = { ...gray, data: gray.data.map((v) => Math.round(v * 0.86)) };
    const c = quad.reduce<Point>((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 });
    for (let y = -25; y < 25; y++) for (let x = -25; x < 25; x++) g.data[(Math.round(c.y) + y) * g.width + Math.round(c.x) + x] = 255;
    expect(assessQuality(g, quad).hasGlare).toBe(true);
    expect(assessQuality({ ...gray, data: gray.data.map((v) => Math.round(v * 0.86)) }, quad).hasGlare).toBe(false);
    // A uniformly over-exposed page is not reported as glare.
    expect(assessQuality(gray, quad).hasGlare).toBe(false);
  });
});
