import type { Quad } from '../geometry/geometry';
import { computeHomography } from '../geometry/homography';
import type { RGBAImage } from './image';
import { sampleBilinear } from './image';

/**
 * Perspective-corrects the region delimited by `quad` (TL, TR, BR, BL in source pixels)
 * into a `width` x `height` rectangle. Real projective warp (inverse mapping + bilinear sampling),
 * not a bounding-box crop.
 */
export function warpPerspective(src: RGBAImage, quad: Quad, width: number, height: number): RGBAImage {
  const dstRect = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  // Map destination pixel centres back to source coordinates.
  const H = computeHomography(dstRect, quad);
  const out = new Uint8ClampedArray(width * height * 4);
  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = H;
  for (let y = 0; y < height; y++) {
    const cy = y + 0.5;
    // Incremental evaluation along the row.
    let nx = h0 * 0.5 + h1 * cy + h2;
    let ny = h3 * 0.5 + h4 * cy + h5;
    let nw = h6 * 0.5 + h7 * cy + h8;
    let o = y * width * 4;
    for (let x = 0; x < width; x++) {
      const sx = nx / nw - 0.5;
      const sy = ny / nw - 0.5;
      sampleBilinear(src, sx, sy, out, o);
      o += 4;
      nx += h0;
      ny += h3;
      nw += h6;
    }
  }
  return { width, height, data: out };
}
