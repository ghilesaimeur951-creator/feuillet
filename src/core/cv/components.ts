import type { Point } from '../geometry/geometry';
import type { GrayImage } from '../imaging/image';

export interface Component {
  /** Number of pixels in the component. */
  size: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Outline samples: for every row, the leftmost and rightmost pixel (and same per column). Their hull equals the component hull. */
  outline: Point[];
  touchesBorder: boolean;
}

export interface ComponentOptions {
  /** Components with a bounding box smaller than this fraction of the image area are skipped. */
  minBoxAreaRatio?: number;
  maxComponents?: number;
}

/**
 * 8-connected component labelling of non-zero pixels. For each sufficiently large component,
 * returns row/column extremes which are enough to compute its convex hull and fit its sides.
 */
export function findComponents(bin: GrayImage, opts: ComponentOptions = {}): Component[] {
  const { width: w, height: h, data } = bin;
  const visited = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const minBox = (opts.minBoxAreaRatio ?? 0.02) * w * h;
  const result: Component[] = [];
  const pixels: number[] = [];
  for (let start = 0; start < data.length; start++) {
    if (data[start] === 0 || visited[start] === 1) continue;
    visited[start] = 1;
    let sp = 0;
    stack[sp++] = start;
    pixels.length = 0;
    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;
    while (sp > 0) {
      const p = stack[--sp] as number;
      pixels.push(p);
      const px = p % w;
      const py = (p - px) / w;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = py + dy;
        if (yy < 0 || yy >= h) continue;
        const rowOff = yy * w;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = px + dx;
          if (xx < 0 || xx >= w) continue;
          const q = rowOff + xx;
          if (visited[q] === 0 && data[q] !== 0) {
            visited[q] = 1;
            stack[sp++] = q;
          }
        }
      }
    }
    const boxArea = (maxX - minX + 1) * (maxY - minY + 1);
    if (boxArea < minBox) continue;
    const bh = maxY - minY + 1;
    const bw = maxX - minX + 1;
    const rowMin = new Int32Array(bh).fill(w);
    const rowMax = new Int32Array(bh).fill(-1);
    const colMin = new Int32Array(bw).fill(h);
    const colMax = new Int32Array(bw).fill(-1);
    for (const p of pixels) {
      const px = p % w;
      const py = (p - px) / w;
      const ry = py - minY;
      const cx = px - minX;
      if (px < (rowMin[ry] as number)) rowMin[ry] = px;
      if (px > (rowMax[ry] as number)) rowMax[ry] = px;
      if (py < (colMin[cx] as number)) colMin[cx] = py;
      if (py > (colMax[cx] as number)) colMax[cx] = py;
    }
    const outline: Point[] = [];
    for (let r = 0; r < bh; r++) {
      if ((rowMax[r] as number) < 0) continue;
      outline.push({ x: rowMin[r] as number, y: r + minY });
      if (rowMax[r] !== rowMin[r]) outline.push({ x: rowMax[r] as number, y: r + minY });
    }
    for (let c = 0; c < bw; c++) {
      if ((colMax[c] as number) < 0) continue;
      outline.push({ x: c + minX, y: colMin[c] as number });
      if (colMax[c] !== colMin[c]) outline.push({ x: c + minX, y: colMax[c] as number });
    }
    result.push({
      size: pixels.length,
      minX,
      minY,
      maxX,
      maxY,
      outline,
      touchesBorder: minX <= 1 || minY <= 1 || maxX >= w - 2 || maxY >= h - 2,
    });
  }
  result.sort((a, b) => (b.maxX - b.minX) * (b.maxY - b.minY) - (a.maxX - a.minX) * (a.maxY - a.minY));
  return result.slice(0, opts.maxComponents ?? 12);
}
