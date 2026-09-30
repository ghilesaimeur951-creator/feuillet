import { concatBytes, deflateRaw, inflateRaw, textDecoder, textEncoder } from '../util/bytes';

/** Minimal ZIP reader/writer (store + deflate), with zip-bomb and path-traversal guards. */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = (CRC_TABLE[(c ^ (data[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  crc: number;
  offset: number;
  encrypted: boolean;
}

export interface ZipLimits {
  maxEntries: number;
  maxTotalSize: number;
  maxEntrySize: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 10000,
  maxTotalSize: 512 * 1024 * 1024,
  maxEntrySize: 256 * 1024 * 1024,
};

export class ZipArchive {
  private constructor(
    private readonly bytes: Uint8Array,
    readonly entries: ReadonlyMap<string, ZipEntry>,
    private readonly limits: ZipLimits,
  ) {}

  static open(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipArchive {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Archive ZIP invalide (fin de répertoire introuvable)');
    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    if (count > limits.maxEntries) throw new Error('Archive ZIP : trop de fichiers');
    const entries = new Map<string, ZipEntry>();
    let total = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw new Error('Archive ZIP : répertoire central corrompu');
      const flags = view.getUint16(p + 8, true);
      const method = view.getUint16(p + 10, true);
      const crc = view.getUint32(p + 16, true);
      const compressedSize = view.getUint32(p + 20, true);
      const size = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const offset = view.getUint32(p + 42, true);
      const name = textDecoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      if (size > limits.maxEntrySize) throw new Error(`Archive ZIP : fichier trop volumineux (${name})`);
      total += size;
      if (total > limits.maxTotalSize) throw new Error('Archive ZIP : contenu décompressé trop volumineux');
      entries.set(name, { name, method, compressedSize, size, crc, offset, encrypted: (flags & 1) === 1 });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return new ZipArchive(bytes, entries, limits);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  async read(name: string): Promise<Uint8Array> {
    const e = this.entries.get(name);
    if (!e) throw new Error(`Fichier absent de l'archive : ${name}`);
    if (e.encrypted) throw new Error('Archive ZIP chiffrée non supportée');
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    if (view.getUint32(e.offset, true) !== 0x04034b50) throw new Error('Archive ZIP : en-tête local invalide');
    const nameLen = view.getUint16(e.offset + 26, true);
    const extraLen = view.getUint16(e.offset + 28, true);
    const start = e.offset + 30 + nameLen + extraLen;
    const raw = this.bytes.subarray(start, start + e.compressedSize);
    let data: Uint8Array;
    if (e.method === 0) data = raw;
    else if (e.method === 8) data = await inflateRaw(raw);
    else throw new Error(`Méthode de compression ZIP ${e.method} non supportée`);
    if (data.length > this.limits.maxEntrySize || data.length !== e.size) throw new Error(`Archive ZIP : taille incohérente (${name})`);
    if (crc32(data) !== e.crc) throw new Error(`Archive ZIP : somme de contrôle invalide (${name})`);
    return data;
  }

  async readText(name: string): Promise<string> {
    return textDecoder.decode(await this.read(name));
  }
}

/** Rejects absolute paths and "..": prevents path traversal when restoring archives. */
export function isSafeZipPath(name: string): boolean {
  if (!name || name.startsWith('/') || name.includes('\\') || /^[a-zA-Z]:/.test(name)) return false;
  return !name.split('/').some((seg) => seg === '..');
}

export interface ZipInput {
  name: string;
  data: Uint8Array | string;
  /** Deflate this entry (default true; JPEG/PNG are stored). */
  compress?: boolean;
}

function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export async function createZip(files: readonly ZipInput[], now = new Date()): Promise<Uint8Array> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const { time, date } = dosDateTime(now);
  for (const f of files) {
    if (!isSafeZipPath(f.name)) throw new Error(`Nom de fichier ZIP invalide : ${f.name}`);
    const data = typeof f.data === 'string' ? textEncoder.encode(f.data) : f.data;
    const name = textEncoder.encode(f.name);
    const crc = crc32(data);
    const compress = f.compress !== false && data.length > 64;
    const body = compress ? await deflateRaw(data) : data;
    const method = compress ? 8 : 0;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    locals.push(local, body);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const cd = concatBytes(centrals);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cd.length, true);
  ev.setUint32(16, offset, true);
  return concatBytes([...locals, cd, end]);
}
