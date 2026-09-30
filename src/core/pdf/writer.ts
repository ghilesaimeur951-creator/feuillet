import { concatBytes, deflateZlib, latin1, randomBytes, textEncoder, toHex } from '../util/bytes';
import { readJpegInfo } from './jpeg';
import type { OrientationId, PageSizeId } from './layout';
import { layoutPage } from './layout';
import { aesEncryptWithIv, setupAes256 } from './security';
import { encodeWinAnsi, helveticaWidth, hexLiteral, utf16beWithBom } from './text';

/** A word of recognised text in image pixel coordinates (top-left origin). */
export interface PdfWord {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfPageInput {
  /** Baseline JPEG bytes. */
  jpeg: Uint8Array;
  size: PageSizeId;
  orientation: OrientationId;
  /** Margin in points. */
  margin: number;
  /** Invisible OCR text layer (makes the PDF searchable and selectable). */
  words?: readonly PdfWord[];
  /** Optional visible footer (e.g. page numbers). */
  footer?: string;
  /** Optional diagonal watermark. */
  watermark?: { text: string; opacity: number };
}

export interface PdfDocumentInput {
  pages: readonly PdfPageInput[];
  info?: { title?: string; author?: string; subject?: string; keywords?: string; creator?: string };
  /** AES-256 encryption when a user password is provided. */
  password?: { user: string; owner?: string };
  /** Deterministic output for tests (fixed date / IDs). */
  fixedDate?: Date;
}

interface Obj {
  id: number;
  /** Dictionary part (for streams: without /Length and /Filter). */
  dict: string;
  stream?: Uint8Array;
  /** Stream already compressed with Flate. */
  flate?: boolean;
}

function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, '');
}

/**
 * Builds the content stream of a page: the page image, the invisible OCR text layer
 * (text rendering mode 3), an optional watermark and footer.
 */
export function buildPageContent(
  page: PdfPageInput,
  imgW: number,
  imgH: number,
  layout: ReturnType<typeof layoutPage>,
): string {
  const ops: string[] = [];
  ops.push('q', `${fmt(layout.width)} 0 0 ${fmt(layout.height)} ${fmt(layout.x)} ${fmt(layout.y)} cm`, '/Im0 Do', 'Q');
  const sx = layout.width / imgW;
  const sy = layout.height / imgH;
  if (page.words && page.words.length > 0) {
    ops.push('BT', '3 Tr');
    for (const w of page.words) {
      const txt = w.text.trim();
      if (!txt || w.width <= 0 || w.height <= 0) continue;
      const bytes = encodeWinAnsi(txt);
      const size = Math.max(1, w.height * sy * 0.92);
      const natural = helveticaWidth(bytes, size);
      const target = w.width * sx;
      const tz = natural > 0 ? Math.max(10, Math.min(500, (target / natural) * 100)) : 100;
      const x = layout.x + w.x * sx;
      // Baseline ≈ bottom of the box raised by the descender (~20 % of the size).
      const y = layout.y + layout.height - (w.y + w.height) * sy + size * 0.2;
      ops.push(`/F0 ${fmt(size)} Tf`, `${fmt(tz)} Tz`, `1 0 0 1 ${fmt(x)} ${fmt(y)} Tm`, `${hexLiteral(bytes)} Tj`);
    }
    ops.push('ET');
  }
  if (page.watermark && page.watermark.text.trim()) {
    const bytes = encodeWinAnsi(page.watermark.text.trim());
    const diag = Math.hypot(layout.pageWidth, layout.pageHeight);
    const size = Math.min(96, (diag * 0.75) / Math.max(1, helveticaWidth(bytes, 1)));
    const angle = Math.atan2(layout.pageHeight, layout.pageWidth);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const tw = helveticaWidth(bytes, size);
    const cx = layout.pageWidth / 2 - (c * tw) / 2 + (s * size * 0.35);
    const cy = layout.pageHeight / 2 - (s * tw) / 2 - (c * size * 0.35);
    ops.push('q', '/GSw gs', '0.75 0.1 0.1 rg', 'BT', `/F0 ${fmt(size)} Tf`, `${fmt(c)} ${fmt(s)} ${fmt(-s)} ${fmt(c)} ${fmt(cx)} ${fmt(cy)} Tm`, `${hexLiteral(bytes)} Tj`, 'ET', 'Q');
  }
  if (page.footer) {
    const bytes = encodeWinAnsi(page.footer);
    const size = 9;
    const tw = helveticaWidth(bytes, size);
    ops.push('q', '0.35 g', 'BT', `/F0 ${size} Tf`, `1 0 0 1 ${fmt((layout.pageWidth - tw) / 2)} ${fmt(Math.max(8, Math.min(18, layout.y / 2)))} Tm`, `${hexLiteral(bytes)} Tj`, 'ET', 'Q');
  }
  return ops.join('\n');
}

/** Writes a complete, standards-compliant PDF 1.7 file (PDF 2.0 AES-256 security when encrypted). */
export async function buildPdf(input: PdfDocumentInput): Promise<Uint8Array> {
  if (input.pages.length === 0) throw new Error('Impossible de créer un PDF sans page');
  const objs: Obj[] = [];
  let nextId = 1;
  const alloc = () => nextId++;
  const catalogId = alloc();
  const pagesId = alloc();
  const fontId = alloc();
  const gsId = alloc();
  const pageIds: number[] = [];

  objs.push({ id: fontId, dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' });
  const opacity = input.pages.find((p) => p.watermark)?.watermark?.opacity ?? 0.18;
  objs.push({ id: gsId, dict: `<< /Type /ExtGState /ca ${fmt(opacity)} /CA ${fmt(opacity)} >>` });

  for (const page of input.pages) {
    const info = readJpegInfo(page.jpeg);
    const layout = layoutPage(info.width, info.height, page.size, page.orientation, page.margin);
    const imgId = alloc();
    const contentId = alloc();
    const pageId = alloc();
    pageIds.push(pageId);
    const cs = info.components === 1 ? '/DeviceGray' : info.components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
    const decode = info.components === 4 && info.adobe ? ' /Decode [1 0 1 0 1 0 1 0]' : '';
    objs.push({
      id: imgId,
      dict: `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode${decode}`,
      stream: page.jpeg,
    });
    const content = buildPageContent(page, info.width, info.height, layout);
    objs.push({ id: contentId, dict: '<<', stream: await deflateZlib(textEncoder.encode(content)), flate: true });
    objs.push({
      id: pageId,
      dict:
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${fmt(layout.pageWidth)} ${fmt(layout.pageHeight)}] ` +
        `/Resources << /XObject << /Im0 ${imgId} 0 R >> /Font << /F0 ${fontId} 0 R >> /ExtGState << /GSw ${gsId} 0 R >> /ProcSet [/PDF /Text /ImageC /ImageB] >> ` +
        `/Contents ${contentId} 0 R >>`,
    });
  }
  objs.push({ id: pagesId, dict: `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>` });
  objs.push({ id: catalogId, dict: `<< /Type /Catalog /Pages ${pagesId} 0 R /ViewerPreferences << /DisplayDocTitle true >> >>` });

  const encryption = input.password?.user !== undefined && input.password.user.length > 0 ? await setupAes256(input.password.user, input.password.owner) : null;
  const encryptString = async (bytes: Uint8Array): Promise<string> =>
    `<${toHex(encryption ? await aesEncryptWithIv(encryption.fileKey, bytes) : bytes)}>`;

  // Document information dictionary.
  const infoId = alloc();
  const date = input.fixedDate ?? new Date();
  const infoParts: string[] = [];
  const meta = { Producer: 'Feuillet', Creator: input.info?.creator ?? 'Feuillet', ...(input.info?.title ? { Title: input.info.title } : {}) } as Record<string, string>;
  if (input.info?.author) meta.Author = input.info.author;
  if (input.info?.subject) meta.Subject = input.info.subject;
  if (input.info?.keywords) meta.Keywords = input.info.keywords;
  for (const [k, v] of Object.entries(meta)) infoParts.push(`/${k} ${await encryptString(utf16beWithBom(v))}`);
  infoParts.push(`/CreationDate ${await encryptString(latin1(pdfDate(date)))}`);
  infoParts.push(`/ModDate ${await encryptString(latin1(pdfDate(date)))}`);
  objs.push({ id: infoId, dict: `<< ${infoParts.join(' ')} >>` });

  let encryptId = 0;
  if (encryption) {
    encryptId = alloc();
    objs.push({ id: encryptId, dict: encryption.dictionary });
  }

  objs.sort((a, b) => a.id - b.id);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (b: Uint8Array) => {
    chunks.push(b);
    offset += b.length;
  };
  push(latin1('%PDF-1.7\n%âãÏÓ\n'));
  const offsets = new Array<number>(nextId).fill(0);
  for (const o of objs) {
    offsets[o.id] = offset;
    if (o.stream) {
      const data = encryption ? await aesEncryptWithIv(encryption.fileKey, o.stream) : o.stream;
      const base = o.dict === '<<' ? '<<' : o.dict;
      const filter = o.flate ? ' /Filter /FlateDecode' : '';
      push(latin1(`${o.id} 0 obj\n${base}${filter} /Length ${data.length} >>\nstream\n`));
      push(data);
      push(latin1('\nendstream\nendobj\n'));
    } else {
      push(latin1(`${o.id} 0 obj\n${o.dict}\nendobj\n`));
    }
  }
  const xrefOffset = offset;
  let xref = `xref\n0 ${nextId}\n0000000000 65535 f \n`;
  for (let id = 1; id < nextId; id++) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  const fileId = toHex(input.fixedDate ? new Uint8Array(16).fill(7) : randomBytes(16));
  const trailer =
    `trailer\n<< /Size ${nextId} /Root ${catalogId} 0 R /Info ${infoId} 0 R /ID [<${fileId}> <${fileId}>]` +
    `${encryption ? ` /Encrypt ${encryptId} 0 R` : ''} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  push(latin1(xref + trailer));
  return concatBytes(chunks);
}
