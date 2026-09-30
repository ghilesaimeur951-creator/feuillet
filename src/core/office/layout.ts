import type { Block, ExtractedDocument, TextRun } from './model';

/**
 * Paginates a neutral document into drawing operations for fixed-size pages. Pure logic:
 * text measurement and image sizes are injected so the engine is testable without a canvas.
 */

export interface FontSpec {
  size: number;
  bold: boolean;
  italic: boolean;
}

export type MeasureText = (text: string, font: FontSpec) => number;

export type DrawOp =
  | { type: 'text'; x: number; y: number; text: string; font: FontSpec; color: string }
  | { type: 'rect'; x: number; y: number; w: number; h: number; stroke?: string; fill?: string }
  | { type: 'image'; x: number; y: number; w: number; h: number; blockIndex: number };

export interface LaidOutWord {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaidOutPage {
  width: number;
  height: number;
  ops: DrawOp[];
  words: LaidOutWord[];
  text: string;
}

export interface LayoutOptions {
  width: number;
  height: number;
  margin: number;
  baseSize: number;
  lineHeight: number;
  imageSize: (blockIndex: number) => { width: number; height: number } | null;
  measure: MeasureText;
}

/** A4 at 150 dpi. */
export const DEFAULT_PAGE = { width: 1240, height: 1754, margin: 130, baseSize: 22, lineHeight: 1.4 };

interface Token {
  text: string;
  font: FontSpec;
  space: boolean;
  newline: boolean;
}

function tokenize(runs: readonly TextRun[], size: number, forceBold = false): Token[] {
  const tokens: Token[] = [];
  for (const r of runs) {
    const font = { size, bold: forceBold || !!r.bold, italic: !!r.italic };
    const parts = r.text.replace(/\t/g, '    ').split(/(\n| +)/);
    for (const p of parts) {
      if (!p) continue;
      if (p === '\n') tokens.push({ text: '', font, space: false, newline: true });
      else if (/^ +$/.test(p)) tokens.push({ text: ' ', font, space: true, newline: false });
      else tokens.push({ text: p, font, space: false, newline: false });
    }
  }
  return tokens;
}

interface Line {
  items: Array<{ text: string; font: FontSpec; x: number; width: number }>;
  width: number;
  height: number;
}

/** Greedy line breaking with hard breaks and splitting of over-long words. */
export function breakLines(tokens: Token[], maxWidth: number, measure: MeasureText, lineHeight: number): Line[] {
  const lines: Line[] = [];
  let cur: Line = { items: [], width: 0, height: 0 };
  const flush = () => {
    // Trim trailing spaces.
    while (cur.items.length && (cur.items[cur.items.length - 1] as { text: string }).text === ' ') {
      const it = cur.items.pop() as { width: number };
      cur.width -= it.width;
    }
    lines.push(cur);
    cur = { items: [], width: 0, height: 0 };
  };
  for (const t of tokens) {
    const lh = t.font.size * lineHeight;
    if (t.newline) {
      cur.height = Math.max(cur.height, lh);
      flush();
      continue;
    }
    if (t.space && cur.items.length === 0) continue;
    let w = measure(t.text, t.font);
    if (!t.space && cur.width + w > maxWidth && cur.items.length > 0) {
      flush();
    }
    if (!t.space && w > maxWidth) {
      // Split a word that is wider than the line.
      let rest = t.text;
      while (rest.length) {
        let n = rest.length;
        while (n > 1 && measure(rest.slice(0, n), t.font) > maxWidth - cur.width) n--;
        const piece = rest.slice(0, n);
        const pw = measure(piece, t.font);
        cur.items.push({ text: piece, font: t.font, x: cur.width, width: pw });
        cur.width += pw;
        cur.height = Math.max(cur.height, lh);
        rest = rest.slice(n);
        if (rest.length) flush();
      }
      continue;
    }
    w = measure(t.text, t.font);
    cur.items.push({ text: t.text, font: t.font, x: cur.width, width: w });
    cur.width += w;
    cur.height = Math.max(cur.height, lh);
  }
  if (cur.items.length || lines.length === 0) {
    if (!cur.height) cur.height = (tokens[0]?.font.size ?? 16) * lineHeight;
    flush();
  }
  return lines;
}

const HEADING_SCALE = [1, 1.75, 1.45, 1.25, 1.12, 1.05, 1];

export function layoutDocument(doc: ExtractedDocument, o: LayoutOptions): LaidOutPage[] {
  const pages: LaidOutPage[] = [];
  const contentW = o.width - 2 * o.margin;
  const bottom = o.height - o.margin;
  let page: LaidOutPage = newPage();
  let y = o.margin;

  function newPage(): LaidOutPage {
    return { width: o.width, height: o.height, ops: [], words: [], text: '' };
  }
  function nextPage() {
    pages.push(page);
    page = newPage();
    y = o.margin;
  }
  function emitLine(line: Line, x0: number, align: 'left' | 'center' | 'right' = 'left', color = '#111') {
    if (y + line.height > bottom && y > o.margin) nextPage();
    const shift = align === 'center' ? (contentW - line.width) / 2 : align === 'right' ? contentW - line.width : 0;
    const maxSize = Math.max(...line.items.map((i) => i.font.size), 1);
    const baseline = y + line.height * 0.5 + maxSize * 0.35;
    for (const it of line.items) {
      if (it.text === ' ') continue;
      const x = x0 + shift + it.x;
      page.ops.push({ type: 'text', x, y: baseline, text: it.text, font: it.font, color });
      page.words.push({ text: it.text, x, y: baseline - it.font.size * 0.8, width: it.width, height: it.font.size * 1.05 });
    }
    page.text += `${line.items.map((i) => i.text).join('')}\n`;
    y += line.height;
  }
  function paragraph(
    runs: readonly TextRun[],
    size: number,
    opts: { bold?: boolean; indent?: number; prefix?: string; align?: 'left' | 'center' | 'right'; color?: string } = {},
  ) {
    const indent = opts.indent ?? 0;
    const tokens = tokenize(opts.prefix ? [{ text: `${opts.prefix} ` }, ...runs] : runs, size, opts.bold);
    const lines = breakLines(tokens, contentW - indent, o.measure, o.lineHeight);
    for (const l of lines) emitLine(l, o.margin + indent, opts.align, opts.color);
  }

  doc.blocks.forEach((b: Block, index) => {
    switch (b.kind) {
      case 'pagebreak':
        if (y > o.margin || page.ops.length) nextPage();
        break;
      case 'heading': {
        const size = o.baseSize * (HEADING_SCALE[Math.min(6, b.level)] ?? 1);
        if (y > o.margin) y += size * 0.6;
        if (y + size * 3 > bottom) nextPage();
        paragraph(b.runs, size, { bold: true, color: '#0f2a3d' });
        y += size * 0.3;
        break;
      }
      case 'paragraph': {
        if (b.runs.length === 0 || !b.runs.some((r) => r.text.trim())) {
          y += o.baseSize * o.lineHeight * 0.6;
          if (y > bottom) nextPage();
          break;
        }
        const prefix = b.list === 'number' ? `${b.listIndex ?? 1}.` : b.list === 'bullet' ? '•' : undefined;
        paragraph(b.runs, o.baseSize, {
          indent: b.list ? o.baseSize * 1.5 : 0,
          ...(prefix ? { prefix } : {}),
          ...(b.align ? { align: b.align } : {}),
        });
        y += o.baseSize * 0.35;
        break;
      }
      case 'table':
        layoutTable(b.rows);
        y += o.baseSize * 0.6;
        break;
      case 'image': {
        const dim = o.imageSize(index);
        if (!dim) break;
        const pxPerPt = o.width / 595.28;
        let w = b.widthPt ? b.widthPt * pxPerPt : dim.width;
        let h = b.heightPt ? b.heightPt * pxPerPt : dim.height;
        const maxH = (bottom - o.margin) * 0.9;
        const s = Math.min(1, contentW / w, maxH / h);
        w *= s;
        h *= s;
        if (y + h > bottom) nextPage();
        page.ops.push({ type: 'image', x: o.margin + (contentW - w) / 2, y, w, h, blockIndex: index });
        y += h + o.baseSize * 0.6;
        break;
      }
    }
  });

  function layoutTable(rows: string[][]) {
    const cols = Math.max(...rows.map((r) => r.length), 1);
    let size = o.baseSize * 0.85;
    const pad = 8;
    // Column weights from content length (bounded), then fit to the content width.
    const weights = Array.from({ length: cols }, (_, c) => Math.min(40, Math.max(4, ...rows.map((r) => (r[c] ?? '').length))));
    const totalW = weights.reduce((a, b) => a + b, 0);
    const colW = weights.map((w) => (w / totalW) * contentW);
    if (Math.min(...colW) < size * 3) size = Math.max(12, size * 0.75);
    rows.forEach((row, ri) => {
      const cellLines = colW.map((w, c) =>
        breakLines(tokenize([{ text: row[c] ?? '' }], size, ri === 0), Math.max(10, w - 2 * pad), o.measure, 1.25),
      );
      const rowH = Math.max(...cellLines.map((ls) => ls.reduce((h, l) => h + l.height, 0))) + 2 * pad;
      if (y + rowH > bottom && y > o.margin) nextPage();
      let x = o.margin;
      const rowText: string[] = [];
      cellLines.forEach((ls, c) => {
        const w = colW[c] as number;
        page.ops.push({ type: 'rect', x, y, w, h: rowH, stroke: '#9aa5b1', ...(ri === 0 ? { fill: '#eef2f6' } : {}) });
        let cy = y + pad;
        for (const l of ls) {
          const baseline = cy + l.height * 0.5 + size * 0.35;
          for (const it of l.items) {
            if (it.text === ' ') continue;
            page.ops.push({ type: 'text', x: x + pad + it.x, y: baseline, text: it.text, font: it.font, color: '#111' });
            page.words.push({ text: it.text, x: x + pad + it.x, y: baseline - size * 0.8, width: it.width, height: size * 1.05 });
          }
          cy += l.height;
        }
        rowText.push(row[c] ?? '');
        x += w;
      });
      page.text += `${rowText.join('\t')}\n`;
      y += rowH;
    });
  }

  if (page.ops.length || pages.length === 0) pages.push(page);
  return pages;
}
