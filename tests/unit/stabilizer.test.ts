import { describe, expect, test } from 'bun:test';
import type { Quad } from '../../src/core/geometry/geometry';
import { QuadStabilizer } from '../../src/core/cv/stabilizer';
import { AutoCaptureController } from '../../src/core/cv/autocapture';
import type { FrameQuality } from '../../src/core/cv/quality';

const base: Quad = [
  { x: 100, y: 50 },
  { x: 300, y: 60 },
  { x: 310, y: 330 },
  { x: 90, y: 320 },
];

function jitter(q: Quad, amp: number, seed: number): Quad {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
  return q.map((p) => ({ x: p.x + rnd() * 2 * amp, y: p.y + rnd() * 2 * amp })) as unknown as Quad;
}

const goodQuality: FrameQuality = { sharpness: 300, brightness: 180, glare: 0, blurry: false, tooDark: false, hasGlare: false };

describe('stabilisation temporelle', () => {
  test('réduit fortement le tremblement des coins', () => {
    const st = new QuadStabilizer({ diagonal: 600 });
    let rawVar = 0;
    let smoothVar = 0;
    let prevRaw: Quad | null = null;
    let prevSmooth: Quad | null = null;
    for (let i = 0; i < 60; i++) {
      const raw = jitter(base, 3, i + 1);
      const s = st.update(raw, 0.9, i * 66);
      if (prevRaw && prevSmooth && s.quad) {
        rawVar += Math.abs(raw[0].x - prevRaw[0].x);
        smoothVar += Math.abs(s.quad[0].x - prevSmooth[0].x);
      }
      prevRaw = raw;
      prevSmooth = s.quad;
    }
    expect(smoothVar).toBeLessThan(rawVar * 0.6);
  });

  test('ignore une détection aberrante isolée', () => {
    const st = new QuadStabilizer({ diagonal: 600 });
    for (let i = 0; i < 5; i++) st.update(base, 0.9, i * 66);
    const outlier = base.map((p) => ({ x: p.x + 150, y: p.y })) as unknown as Quad;
    const s = st.update(outlier, 0.9, 5 * 66);
    expect(s.quad?.[0].x).toBeCloseTo(100, 0);
    const back = st.update(base, 0.9, 6 * 66);
    expect(back.quad?.[0].x).toBeCloseTo(100, 0);
  });

  test('suit un vrai déplacement confirmé', () => {
    const st = new QuadStabilizer({ diagonal: 600 });
    for (let i = 0; i < 5; i++) st.update(base, 0.9, i * 66);
    const moved = base.map((p) => ({ x: p.x + 150, y: p.y })) as unknown as Quad;
    st.update(moved, 0.9, 400);
    const s = st.update(moved, 0.9, 466);
    expect(s.quad?.[0].x).toBeCloseTo(250, 0);
  });

  test('perd le document après un délai sans détection (pas de contour inventé)', () => {
    const st = new QuadStabilizer({ diagonal: 600, lostAfterMs: 300 });
    st.update(base, 0.9, 0);
    expect(st.update(null, 0, 100).quad).not.toBeNull();
    expect(st.update(null, 0, 500).quad).toBeNull();
  });

  test('stabilité mesurée dans la durée', () => {
    const st = new QuadStabilizer({ diagonal: 600 });
    let last = st.update(base, 0.9, 0);
    for (let t = 66; t <= 1200; t += 66) last = st.update(jitter(base, 1, t), 0.9, t);
    expect(last.stable).toBe(true);
    expect(last.stableForMs).toBeGreaterThan(400);
  });
});

describe('capture automatique', () => {
  test('déclenche après un maintien stable, puis attend un changement de page', () => {
    const st = new QuadStabilizer({ diagonal: 600 });
    const ac = new AutoCaptureController({ holdMs: 600, cooldownMs: 500 });
    let fireAt = -1;
    let maxProgress = 0;
    for (let t = 0; t <= 3000; t += 50) {
      const s = st.update(base, 0.9, t);
      const a = ac.update(s, goodQuality, t, true);
      maxProgress = Math.max(maxProgress, a.progress);
      if (a.fire) {
        fireAt = t;
        ac.notifyCaptured(t);
        break;
      }
    }
    expect(fireAt).toBeGreaterThan(600);
    expect(maxProgress).toBe(1);
    // Same page still in view: no second capture.
    for (let t = fireAt + 50; t < fireAt + 3000; t += 50) {
      const a = ac.update(st.update(base, 0.9, t), goodQuality, t, true);
      expect(a.fire).toBe(false);
    }
  });

  test('ne déclenche pas si l’image est floue ou le document partiel', () => {
    const st = new QuadStabilizer({ diagonal: 600 });
    const ac = new AutoCaptureController({ holdMs: 300 });
    for (let t = 0; t <= 2000; t += 50) {
      const a = ac.update(st.update(base, 0.9, t), { ...goodQuality, blurry: true }, t, true);
      expect(a.fire).toBe(false);
    }
    const st2 = new QuadStabilizer({ diagonal: 600 });
    for (let t = 0; t <= 2000; t += 50) {
      const a = ac.update(st2.update(base, 0.9, t, true), goodQuality, t, true);
      expect(a.status).toBe('partial');
    }
  });

  test('désactivée : signale seulement la détection', () => {
    const st = new QuadStabilizer({ diagonal: 600 });
    const ac = new AutoCaptureController();
    let a = ac.update(st.update(base, 0.9, 0), goodQuality, 0, false);
    for (let t = 50; t < 2000; t += 50) a = ac.update(st.update(base, 0.9, t), goodQuality, t, false);
    expect(a.status).toBe('detected');
    expect(a.fire).toBe(false);
  });
});
