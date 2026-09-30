import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Quad } from '../../src/core/geometry/geometry';
import { warpPerspective } from '../../src/core/imaging/warp';
import { createRGBA, rotateRGBA90, toGray } from '../../src/core/imaging/image';
import type { RGBAImage } from '../../src/core/imaging/image';
import { applyAdjustments, applyPreset, FILTERS, NEUTRAL_ADJUSTMENTS, processImage } from '../../src/core/imaging/filters';
import { blankPageScore, dHash, detectTextDirection, hammingDistanceHex, isDuplicate } from '../../src/core/imaging/analysis';
import { readPng } from './helpers/png';

const DIR = join(import.meta.dir, '..', 'fixtures', 'cv');
const cases = JSON.parse(readFileSync(join(DIR, 'cases.json'), 'utf8')) as Array<{ name: string; corners: [number, number][] }>;

function rectified(name: string): RGBAImage {
  const c = cases.find((k) => k.name === name);
  if (!c) throw new Error(name);
  const q = c.corners.map(([x, y]) => ({ x, y })) as unknown as Quad;
  // Inset by 2 % to stay on the paper.
  return warpPerspective(readPng(join(DIR, `${name}.png`)), q, 252, 356);
}

function stats(img: RGBAImage, x0: number, y0: number, x1: number, y1: number): { mean: number; sd: number } {
  const g = toGray(img);
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = g.data[y * g.width + x] as number;
      s += v;
      s2 += v * v;
      n++;
    }
  }
  const mean = s / n;
  return { mean, sd: Math.sqrt(s2 / n - mean * mean) };
}

describe('filtres de scan', () => {
  const page = rectified('shadow');

  test('la page ombrée a bien un fort gradient d’éclairage au départ', () => {
    const left = stats(page, 10, 150, 40, 200).mean;
    const right = stats(page, 200, 150, 240, 200).mean;
    expect(right - left).toBeGreaterThan(60);
  });

  test('« Document » supprime l’ombre et blanchit le fond', () => {
    const out = applyPreset(page, 'document');
    const left = stats(out, 10, 150, 40, 200).mean;
    const right = stats(out, 200, 150, 240, 200).mean;
    expect(Math.abs(right - left)).toBeLessThan(20);
    expect(left).toBeGreaterThan(225);
  });

  test('« N&B » produit une image binaire où le texte reste noir', () => {
    const out = applyPreset(page, 'bw');
    const values = new Set<number>();
    for (let i = 0; i < out.data.length; i += 4) values.add(out.data[i] as number);
    expect([...values].sort()).toEqual([0, 255]);
    let black = 0;
    for (let i = 0; i < out.data.length; i += 4) if (out.data[i] === 0) black++;
    const ratio = black / (out.width * out.height);
    expect(ratio).toBeGreaterThan(0.01); // text lines survive
    expect(ratio).toBeLessThan(0.25); // shadow is not turned black
  });

  test('« Gris » renvoie une image sans couleur', () => {
    const colored = createRGBA(20, 20, [200, 120, 40, 255]);
    const out = applyPreset(colored, 'grayscale');
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i]).toBe(out.data[i + 1] as number);
      expect(out.data[i + 1]).toBe(out.data[i + 2] as number);
    }
  });

  test('chaque préréglage modifie réellement l’image (sauf Original)', () => {
    for (const f of FILTERS) {
      const out = applyPreset(page, f.id);
      let diff = 0;
      for (let i = 0; i < out.data.length; i++) diff += Math.abs((out.data[i] as number) - (page.data[i] as number));
      if (f.id === 'original') expect(diff).toBe(0);
      else expect(diff / out.data.length).toBeGreaterThan(1);
    }
  });

  test('réglages manuels : luminosité, contraste, saturation, exposition, netteté', () => {
    const img = createRGBA(16, 16, [100, 150, 200, 255]);
    const brighter = applyAdjustments(img, { ...NEUTRAL_ADJUSTMENTS, brightness: 40 });
    expect(brighter.data[0]).toBeGreaterThan(100);
    const desat = applyAdjustments(img, { ...NEUTRAL_ADJUSTMENTS, saturation: -100 });
    expect(Math.abs((desat.data[0] as number) - (desat.data[2] as number))).toBeLessThanOrEqual(1);
    const exposed = applyAdjustments(img, { ...NEUTRAL_ADJUSTMENTS, exposure: 50 });
    expect(exposed.data[0]).toBeGreaterThan(190);
    const contrast = applyAdjustments(img, { ...NEUTRAL_ADJUSTMENTS, contrast: 50 });
    expect(contrast.data[0]).toBeLessThan(100);
    expect(contrast.data[2]).toBeGreaterThan(200);
    expect(applyAdjustments(img, NEUTRAL_ADJUSTMENTS)).toBe(img);
    const sharp = processImage(page, 'original', { ...NEUTRAL_ADJUSTMENTS, sharpness: 80 });
    expect(stats(sharp, 20, 40, 230, 320).sd).toBeGreaterThan(stats(page, 20, 40, 230, 320).sd);
  });

  test('réduction du bruit diminue la variance sur une zone uniforme', () => {
    const noisy = createRGBA(64, 64);
    let s = 7;
    for (let i = 0; i < noisy.data.length; i += 4) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const v = 180 + ((s % 41) - 20);
      noisy.data[i] = noisy.data[i + 1] = noisy.data[i + 2] = v;
      noisy.data[i + 3] = 255;
    }
    const out = applyAdjustments(noisy, { ...NEUTRAL_ADJUSTMENTS, denoise: 80 });
    expect(stats(out, 4, 4, 60, 60).sd).toBeLessThan(stats(noisy, 4, 4, 60, 60).sd * 0.6);
  });
});

describe('analyse de page', () => {
  test('page blanche détectée, page avec texte non', () => {
    const blank = createRGBA(300, 420, [236, 236, 232, 255]);
    expect(blankPageScore(blank).blank).toBe(true);
    expect(blankPageScore(rectified('white-on-dark')).blank).toBe(false);
  });

  test('empreinte perceptuelle : doublons reconnus, pages différentes distinguées', () => {
    const a = rectified('white-on-dark');
    const a2 = rectified('low-light');
    const b = rectified('receipt');
    expect(dHash(a)).toHaveLength(16);
    expect(isDuplicate(dHash(a), dHash(a))).toBe(true);
    expect(hammingDistanceHex(dHash(a), dHash(b))).toBeGreaterThan(5);
    // Same page, different exposure → still a duplicate.
    expect(hammingDistanceHex(dHash(a), dHash(a2))).toBeLessThanOrEqual(8);
  });

  test('orientation du texte : page tournée de 90° détectée', () => {
    const page = rectified('white-on-dark');
    expect(detectTextDirection(page).turns).toBe(0);
    expect(detectTextDirection(rotateRGBA90(page, 1)).turns).toBe(1);
  });
});
