/** Basic 2D geometry used by the vision pipeline and the crop editor. */

export interface Point {
  x: number;
  y: number;
}

/** Four corners, always ordered: top-left, top-right, bottom-right, bottom-left (P1..P4). */
export type Quad = readonly [Point, Point, Point, Point];

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Signed area (shoelace). Positive for clockwise polygons in image coordinates (y down). */
export function signedArea(poly: readonly Point[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Point;
    const b = poly[(i + 1) % poly.length] as Point;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export function polygonArea(poly: readonly Point[]): number {
  return Math.abs(signedArea(poly));
}

export function perimeter(poly: readonly Point[]): number {
  let p = 0;
  for (let i = 0; i < poly.length; i++) {
    p += distance(poly[i] as Point, poly[(i + 1) % poly.length] as Point);
  }
  return p;
}

export function centroid(points: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  const n = Math.max(1, points.length);
  return { x: x / n, y: y / n };
}

/** Andrew's monotone chain. Returns hull in clockwise order (image coordinates), no duplicate end point. */
export function convexHull(input: readonly Point[]): Point[] {
  if (input.length < 3) return input.slice();
  const pts = input.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2] as Point, lower[lower.length - 1] as Point, p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i] as Point;
    while (upper.length >= 2 && cross(upper[upper.length - 2] as Point, upper[upper.length - 1] as Point, p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  // Monotone chain yields counter-clockwise in a y-up frame, which is clockwise on screen (y down).
  return lower.concat(upper);
}

export function isConvex(poly: readonly Point[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const c = cross(poly[i] as Point, poly[(i + 1) % n] as Point, poly[(i + 2) % n] as Point);
    if (Math.abs(c) < 1e-9) continue;
    const s = Math.sign(c);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

/** Interior angle in degrees at vertex b of the path a-b-c. */
export function angleAt(a: Point, b: Point, c: Point): number {
  const v1x = a.x - b.x;
  const v1y = a.y - b.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const d = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (d === 0) return 0;
  const cos = Math.min(1, Math.max(-1, (v1x * v2x + v1y * v2y) / d));
  return (Math.acos(cos) * 180) / Math.PI;
}

export function quadAngles(q: Quad): [number, number, number, number] {
  return [angleAt(q[3], q[0], q[1]), angleAt(q[0], q[1], q[2]), angleAt(q[1], q[2], q[3]), angleAt(q[2], q[3], q[0])];
}

/**
 * Orders four arbitrary points as TL, TR, BR, BL.
 * Points are first sorted clockwise around their centroid (robust to rotation and perspective),
 * then rotated so the first vertex is the top-left one (smallest x + y, ties broken by y).
 */
export function orderQuad(points: readonly Point[]): Quad {
  if (points.length !== 4) throw new Error(`orderQuad attend 4 points, reçu ${points.length}`);
  const c = centroid(points);
  const sorted = points
    .map((p) => ({ p, a: Math.atan2(p.y - c.y, p.x - c.x) }))
    .sort((u, v) => u.a - v.a)
    .map((u) => u.p);
  // atan2 increasing with y-down == clockwise on screen.
  let start = 0;
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const p = sorted[i] as Point;
    const key = p.x + p.y;
    if (key < best - 1e-9 || (Math.abs(key - best) <= 1e-9 && p.y < (sorted[start] as Point).y)) {
      best = key;
      start = i;
    }
  }
  const r = [0, 1, 2, 3].map((k) => sorted[(start + k) % 4] as Point);
  return [r[0] as Point, r[1] as Point, r[2] as Point, r[3] as Point];
}

export function quadToArray(q: Quad): number[] {
  return [q[0].x, q[0].y, q[1].x, q[1].y, q[2].x, q[2].y, q[3].x, q[3].y];
}

export function scaleQuad(q: Quad, sx: number, sy: number = sx): Quad {
  return q.map((p) => ({ x: p.x * sx, y: p.y * sy })) as unknown as Quad;
}

export function clampQuad(q: Quad, width: number, height: number): Quad {
  return q.map((p) => ({
    x: Math.min(width, Math.max(0, p.x)),
    y: Math.min(height, Math.max(0, p.y)),
  })) as unknown as Quad;
}

export function fullFrameQuad(width: number, height: number, inset = 0): Quad {
  return [
    { x: inset, y: inset },
    { x: width - inset, y: inset },
    { x: width - inset, y: height - inset },
    { x: inset, y: height - inset },
  ];
}

/** Largest corner displacement between two quads. */
export function maxCornerDistance(a: Quad, b: Quad): number {
  let m = 0;
  for (let i = 0; i < 4; i++) m = Math.max(m, distance(a[i] as Point, b[i] as Point));
  return m;
}

/** Intersection of line (p1,p2) with line (p3,p4); null if parallel. */
export function lineIntersection(p1: Point, p2: Point, p3: Point, p4: Point): Point | null {
  const d = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
  if (Math.abs(d) < 1e-9) return null;
  const a = p1.x * p2.y - p1.y * p2.x;
  const b = p3.x * p4.y - p3.y * p4.x;
  return {
    x: (a * (p3.x - p4.x) - (p1.x - p2.x) * b) / d,
    y: (a * (p3.y - p4.y) - (p1.y - p2.y) * b) / d,
  };
}

/** Total-least-squares line fit. Returns a point on the line and a unit direction. */
export function fitLine(points: readonly Point[]): { point: Point; dir: Point } | null {
  if (points.length < 2) return null;
  const c = centroid(points);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of points) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { point: c, dir: { x: Math.cos(theta), y: Math.sin(theta) } };
}

export function pointInPolygon(p: Point, poly: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as Point;
    const b = poly[j] as Point;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Rotates a point around the image origin for a 90° step rotation of an image of size (w,h). */
export function rotatePoint90(p: Point, w: number, h: number, turns: number): Point {
  const t = ((turns % 4) + 4) % 4;
  if (t === 0) return { ...p };
  if (t === 1) return { x: h - p.y, y: p.x };
  if (t === 2) return { x: w - p.x, y: h - p.y };
  return { x: p.y, y: w - p.x };
}
