import { inflateSync, deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import type { GrayImage, RGBAImage } from '../../src/core/imaging/image';

/** Tiny PNG codec for tests (8-bit gray, gray+alpha, RGB, RGBA; non-interlaced). */
export function decodePng(buf: Uint8Array): RGBAImage {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];
  while (pos < buf.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(...buf.subarray(pos + 4, pos + 8));
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = d.getUint32(0);
      height = d.getUint32(4);
      if (data[8] !== 8) throw new Error('PNG: seule la profondeur 8 bits est supportée');
      colorType = data[9] as number;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const total = idat.reduce((s, a) => s + a.length, 0);
  const joined = new Uint8Array(total);
  let o = 0;
  for (const a of idat) {
    joined.set(a, o);
    o += a.length;
  }
  const raw = inflateSync(joined);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType as 0 | 2 | 4 | 6];
  if (!channels) throw new Error(`PNG: type de couleur ${colorType} non supporté`);
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] as number;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? (pixels[y * stride + x - channels] as number) : 0;
      const b = y > 0 ? (pixels[(y - 1) * stride + x] as number) : 0;
      const c = x >= channels && y > 0 ? (pixels[(y - 1) * stride + x - channels] as number) : 0;
      let v = line[x] as number;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[y * stride + x] = v & 255;
    }
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    if (channels === 1 || channels === 2) {
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = pixels[s] as number;
      out[i * 4 + 3] = channels === 2 ? (pixels[s + 1] as number) : 255;
    } else {
      out[i * 4] = pixels[s] as number;
      out[i * 4 + 1] = pixels[s + 1] as number;
      out[i * 4 + 2] = pixels[s + 2] as number;
      out[i * 4 + 3] = channels === 4 ? (pixels[s + 3] as number) : 255;
    }
  }
  return { width, height, data: out };
}

export function readPng(path: string): RGBAImage {
  return decodePng(readFileSync(path));
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 255] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Encodes an RGBA image as PNG (filter 0). Useful for debugging and OCR fixtures. */
export function encodePng(img: RGBAImage | GrayImage): Uint8Array {
  const gray = img.data.length === img.width * img.height;
  const ch = gray ? 1 : 4;
  const raw = new Uint8Array((img.width * ch + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (img.width * ch + 1)] = 0;
    raw.set(img.data.subarray(y * img.width * ch, (y + 1) * img.width * ch), y * (img.width * ch + 1) + 1);
  }
  const chunks: Uint8Array[] = [];
  const chunk = (type: string, data: Uint8Array) => {
    const c = new Uint8Array(12 + data.length);
    const v = new DataView(c.buffer);
    v.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
    c.set(data, 8);
    v.setUint32(8 + data.length, crc(c.subarray(4, 8 + data.length)));
    chunks.push(c);
  };
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, img.width);
  iv.setUint32(4, img.height);
  ihdr[8] = 8;
  ihdr[9] = gray ? 0 : 6;
  chunk('IHDR', ihdr);
  chunk('IDAT', deflateSync(raw));
  chunk('IEND', new Uint8Array(0));
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const total = sig.length + chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  out.set(sig, 0);
  let o = sig.length;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
