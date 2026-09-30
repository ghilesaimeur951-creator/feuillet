import type { Annotation } from './model';

/** Rotates normalised annotation coordinates by clockwise quarter turns (follows page rotation). */
export function rotateAnnotations(list: readonly Annotation[], turns: number): Annotation[] {
  const t = ((turns % 4) + 4) % 4;
  if (t === 0) return list.map((a) => ({ ...a }));
  const pt = (x: number, y: number): [number, number] => {
    let px = x;
    let py = y;
    for (let i = 0; i < t; i++) {
      const nx = 1 - py;
      py = px;
      px = nx;
    }
    return [px, py];
  };
  const box = (x: number, y: number, w: number, h: number) => {
    const [ax, ay] = pt(x, y);
    const [bx, by] = pt(x + w, y + h);
    return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
  };
  return list.map((a): Annotation => {
    switch (a.type) {
      case 'ink':
        return {
          ...a,
          points: a.points.map((p) => {
            const [x, y] = pt(p.x, p.y);
            return { x, y };
          }),
        };
      case 'arrow': {
        const [x1, y1] = pt(a.x1, a.y1);
        const [x2, y2] = pt(a.x2, a.y2);
        return { ...a, x1, y1, x2, y2 };
      }
      case 'text': {
        const [x, y] = pt(a.x, a.y);
        return { ...a, x, y };
      }
      default:
        return { ...a, ...box(a.x, a.y, a.w, a.h) };
    }
  });
}
