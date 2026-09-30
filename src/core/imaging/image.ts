/** Minimal image containers, structurally compatible with the DOM ImageData. */

export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface GrayImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function createRGBA(width: number, height: number, fill?: [number, number, number, number]): RGBAImage {
  const data = new Uint8ClampedArray(width * height * 4);
  if (fill) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = fill[0];
      data[i + 1] = fill[1];
      data[i + 2] = fill[2];
      data[i + 3] = fill[3];
    }
  }
  return { width, height, data };
}

export function createGray(width: number, height: number, fill = 0): GrayImage {
  const data = new Uint8ClampedArray(width * height);
  if (fill) data.fill(fill);
  return { width, height, data };
}

export function cloneRGBA(img: RGBAImage): RGBAImage {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

/** ITU-R BT.601 luma with integer arithmetic. */
export function toGray(img: RGBAImage): GrayImage {
  const out = new Uint8ClampedArray(img.width * img.height);
  const d = img.data;
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    out[j] = ((d[i] as number) * 77 + (d[i + 1] as number) * 150 + (d[i + 2] as number) * 29) >> 8;
  }
  return { width: img.width, height: img.height, data: out };
}

export function grayToRGBA(g: GrayImage): RGBAImage {
  const out = new Uint8ClampedArray(g.width * g.height * 4);
  for (let j = 0, i = 0; j < g.data.length; j++, i += 4) {
    const v = g.data[j] as number;
    out[i] = v;
    out[i + 1] = v;
    out[i + 2] = v;
    out[i + 3] = 255;
  }
  return { width: g.width, height: g.height, data: out };
}

/** Area-averaging downscale of a gray image by an integer-free factor (box filter). */
export function resizeGray(src: GrayImage, width: number, height: number): GrayImage {
  const out = new Uint8ClampedArray(width * height);
  const sx = src.width / width;
  const sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1 && yy < src.height; yy++) {
        const row = yy * src.width;
        for (let xx = x0; xx < x1 && xx < src.width; xx++) {
          sum += src.data[row + xx] as number;
          n++;
        }
      }
      out[y * width + x] = n ? sum / n : 0;
    }
  }
  return { width, height, data: out };
}

/** Bilinear resize of an RGBA image (used for thumbnails and previews). */
export function resizeRGBA(src: RGBAImage, width: number, height: number): RGBAImage {
  if (width < src.width / 2 || height < src.height / 2) {
    // Strong downscale: average boxes to avoid aliasing.
    const out = new Uint8ClampedArray(width * height * 4);
    const sx = src.width / width;
    const sy = src.height / height;
    for (let y = 0; y < height; y++) {
      const y0 = Math.floor(y * sy);
      const y1 = Math.min(src.height, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
      for (let x = 0; x < width; x++) {
        const x0 = Math.floor(x * sx);
        const x1 = Math.min(src.width, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let n = 0;
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) {
            const i = (yy * src.width + xx) * 4;
            r += src.data[i] as number;
            g += src.data[i + 1] as number;
            b += src.data[i + 2] as number;
            a += src.data[i + 3] as number;
            n++;
          }
        }
        const o = (y * width + x) * 4;
        out[o] = r / n;
        out[o + 1] = g / n;
        out[o + 2] = b / n;
        out[o + 3] = a / n;
      }
    }
    return { width, height, data: out };
  }
  const out = new Uint8ClampedArray(width * height * 4);
  const sx = src.width / width;
  const sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5);
    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5);
      sampleBilinear(src, fx, fy, out, (y * width + x) * 4);
    }
  }
  return { width, height, data: out };
}

/** Writes the bilinear sample of `src` at (fx, fy) into `out[o..o+3]`. Out-of-range → white. */
export function sampleBilinear(src: RGBAImage, fx: number, fy: number, out: Uint8ClampedArray, o: number): void {
  const w = src.width;
  const h = src.height;
  if (fx < -0.5 || fy < -0.5 || fx > w - 0.5 || fy > h - 0.5) {
    out[o] = 255;
    out[o + 1] = 255;
    out[o + 2] = 255;
    out[o + 3] = 255;
    return;
  }
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(fy)));
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const ax = Math.min(1, Math.max(0, fx - x0));
  const ay = Math.min(1, Math.max(0, fy - y0));
  const d = src.data;
  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4;
  const i11 = (y1 * w + x1) * 4;
  const w00 = (1 - ax) * (1 - ay);
  const w10 = ax * (1 - ay);
  const w01 = (1 - ax) * ay;
  const w11 = ax * ay;
  for (let c = 0; c < 4; c++) {
    out[o + c] = (d[i00 + c] as number) * w00 + (d[i10 + c] as number) * w10 + (d[i01 + c] as number) * w01 + (d[i11 + c] as number) * w11;
  }
}

/** Rotates an image by a multiple of 90° clockwise. */
export function rotateRGBA90(src: RGBAImage, turns: number): RGBAImage {
  const t = ((turns % 4) + 4) % 4;
  if (t === 0) return cloneRGBA(src);
  const { width: w, height: h } = src;
  const W = t % 2 === 1 ? h : w;
  const H = t % 2 === 1 ? w : h;
  const out = new Uint8ClampedArray(W * H * 4);
  const s = new Uint32Array(src.data.buffer, src.data.byteOffset, w * h);
  const o = new Uint32Array(out.buffer);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number;
      let ny: number;
      if (t === 1) {
        nx = h - 1 - y;
        ny = x;
      } else if (t === 2) {
        nx = w - 1 - x;
        ny = h - 1 - y;
      } else {
        nx = y;
        ny = w - 1 - x;
      }
      o[ny * W + nx] = s[y * w + x] as number;
    }
  }
  return { width: W, height: H, data: out };
}
