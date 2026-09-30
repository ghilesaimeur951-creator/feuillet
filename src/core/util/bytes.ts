/** Byte helpers shared by the PDF, ZIP and DOCX writers. */

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** Copies into a fresh ArrayBuffer-backed array (WebCrypto and Blob require non-shared buffers). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

/** zlib-wrapped deflate (PDF FlateDecode) using the platform CompressionStream. */
export async function deflateZlib(data: Uint8Array): Promise<Uint8Array> {
  return streamTransform(data, new CompressionStream('deflate'));
}

export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return streamTransform(data, new CompressionStream('deflate-raw'));
}

export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return streamTransform(data, new DecompressionStream('deflate-raw'));
}

export async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  return streamTransform(data, new DecompressionStream('deflate'));
}

async function streamTransform(data: Uint8Array, transform: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const stream = new Blob([toArrayBuffer(data)]).stream().pipeThrough(transform);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}
