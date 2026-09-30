import type { ExtractedDocument } from '../core/office/model';
import type { FontSpec, LaidOutPage } from '../core/office/layout';
import { DEFAULT_PAGE, layoutDocument } from '../core/office/layout';
import { toArrayBuffer } from '../core/util/bytes';
import { canvasToBlob, createCanvas, ctx2d } from './image-io';

const FONT_FAMILY = '"Liberation Sans", Arial, Helvetica, system-ui, sans-serif';

function fontCss(f: FontSpec): string {
  return `${f.italic ? 'italic ' : ''}${f.bold ? '700 ' : '400 '}${Math.round(f.size)}px ${FONT_FAMILY}`;
}

export interface RenderedOfficePage {
  image: Blob;
  width: number;
  height: number;
  text: string;
  words: LaidOutPage['words'];
}

/**
 * Converts an extracted Office/TXT document into real page images (A4 at 150 dpi) with their
 * text and word positions (so the exported PDF keeps a selectable, searchable text layer).
 */
export async function renderExtractedDocument(
  doc: ExtractedDocument,
  onProgress?: (done: number, total: number) => void,
): Promise<RenderedOfficePage[]> {
  // Decode embedded images first (the layout engine needs their sizes synchronously).
  const images = new Map<number, ImageBitmap>();
  for (const [i, b] of doc.blocks.entries()) {
    if (b.kind !== 'image') continue;
    try {
      images.set(i, await createImageBitmap(new Blob([toArrayBuffer(b.data)], { type: b.mime })));
    } catch {
      /* unsupported image: skipped by the layout (null size) */
    }
  }
  const measureCanvas = createCanvas(8, 8);
  const mctx = ctx2d(measureCanvas);
  const measure = (text: string, f: FontSpec) => {
    mctx.font = fontCss(f);
    return mctx.measureText(text).width;
  };
  const pages = layoutDocument(doc, {
    ...DEFAULT_PAGE,
    measure,
    imageSize: (i) => {
      const bmp = images.get(i);
      return bmp ? { width: bmp.width, height: bmp.height } : null;
    },
  });
  const out: RenderedOfficePage[] = [];
  for (const [pi, p] of pages.entries()) {
    const c = createCanvas(p.width, p.height);
    const g = ctx2d(c);
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, p.width, p.height);
    g.textBaseline = 'alphabetic';
    for (const op of p.ops) {
      if (op.type === 'rect') {
        if (op.fill) {
          g.fillStyle = op.fill;
          g.fillRect(op.x, op.y, op.w, op.h);
        }
        if (op.stroke) {
          g.strokeStyle = op.stroke;
          g.lineWidth = 1.5;
          g.strokeRect(op.x, op.y, op.w, op.h);
        }
      } else if (op.type === 'text') {
        g.font = fontCss(op.font);
        g.fillStyle = op.color;
        g.fillText(op.text, op.x, op.y);
      } else {
        const bmp = images.get(op.blockIndex);
        if (bmp) g.drawImage(bmp, op.x, op.y, op.w, op.h);
      }
    }
    out.push({ image: await canvasToBlob(c, 'image/jpeg', 0.9), width: p.width, height: p.height, text: p.text.trim(), words: p.words });
    onProgress?.(pi + 1, pages.length);
  }
  for (const b of images.values()) b.close();
  return out;
}
