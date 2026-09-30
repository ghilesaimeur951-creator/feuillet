import { HELVETICA_WIDTHS } from './helvetica-widths';

/** Unicode → Windows-1252 (WinAnsiEncoding) for the 0x80..0x9F range. */
const CP1252_EXTRA: Record<number, number> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};

/**
 * Encodes text to WinAnsi bytes. Characters that cannot be represented are transliterated
 * when possible (NFD without diacritics) and otherwise replaced by '?'.
 */
export function encodeWinAnsi(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) {
      out.push(0x20);
    } else if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) {
      out.push(cp);
    } else if (CP1252_EXTRA[cp] !== undefined) {
      out.push(CP1252_EXTRA[cp] as number);
    } else {
      const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      const b = base.codePointAt(0);
      out.push(b !== undefined && b >= 0x20 && b <= 0x7e ? b : 0x3f);
    }
  }
  return new Uint8Array(out);
}

/** Width of WinAnsi-encoded text in Helvetica at the given font size (points). */
export function helveticaWidth(bytes: Uint8Array, fontSize: number): number {
  let w = 0;
  for (const b of bytes) w += b >= 32 ? (HELVETICA_WIDTHS[b - 32] ?? 556) : 0;
  return (w / 1000) * fontSize;
}

/** Hex string literal for a PDF content stream. */
export function hexLiteral(bytes: Uint8Array): string {
  let s = '<';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return `${s}>`;
}

/** UTF-16BE with BOM, used for document information strings (supports any Unicode text). */
export function utf16beWithBom(text: string): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xfe;
  out[1] = 0xff;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[2 + i * 2] = c >> 8;
    out[3 + i * 2] = c & 0xff;
  }
  return out;
}
