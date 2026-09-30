import type { ZipArchive } from '../zip/zip';
import type { Block, ExtractedDocument, TextRun } from './model';
import type { XmlElement } from './xml';
import { child, children, descendants, parseXml, textContent } from './xml';

/** Resolves a relationship file (…/_rels/x.rels) into id → absolute part path. */
export async function readRels(zip: ZipArchive, partPath: string): Promise<Map<string, { target: string; type: string }>> {
  const dir = partPath.includes('/') ? partPath.slice(0, partPath.lastIndexOf('/')) : '';
  const file = partPath.slice(partPath.lastIndexOf('/') + 1);
  const relsPath = `${dir ? `${dir}/` : ''}_rels/${file}.rels`;
  const map = new Map<string, { target: string; type: string }>();
  if (!zip.has(relsPath)) return map;
  const xml = parseXml(await zip.readText(relsPath));
  for (const r of children(xml, 'Relationship')) {
    const target = r.attrs.Target ?? '';
    const external = r.attrs.TargetMode === 'External';
    const resolved = external ? target : resolvePath(dir, target);
    map.set(r.attrs.Id ?? '', { target: resolved, type: r.attrs.Type ?? '' });
  }
  return map;
}

export function resolvePath(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (baseDir ? baseDir.split('/') : []).concat(target.split('/'));
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

export function mimeFromPath(p: string): string {
  const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
  return (
    ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' } as Record<string, string>)[
      ext
    ] ?? ''
  );
}

export async function readCoreTitle(zip: ZipArchive): Promise<string | undefined> {
  if (!zip.has('docProps/core.xml')) return undefined;
  const core = parseXml(await zip.readText('docProps/core.xml'));
  const t = descendants(core, 'title')[0];
  const s = t ? textContent(t).trim() : '';
  return s || undefined;
}

function runsOf(p: XmlElement): TextRun[] {
  const runs: TextRun[] = [];
  const walk = (el: XmlElement) => {
    for (const c of el.children) {
      if (typeof c === 'string') continue;
      if (c.name === 'r') {
        const rPr = child(c, 'rPr');
        const bold = !!rPr && !!child(rPr, 'b') && child(rPr, 'b')?.attrs.val !== '0' && child(rPr, 'b')?.attrs.val !== 'false';
        const italic = !!rPr && !!child(rPr, 'i') && child(rPr, 'i')?.attrs.val !== '0';
        let text = '';
        for (const rc of c.children) {
          if (typeof rc === 'string') continue;
          if (rc.name === 't') text += textContent(rc);
          else if (rc.name === 'tab') text += '\t';
          else if (rc.name === 'br' && rc.attrs.type !== 'page') text += '\n';
          else if (rc.name === 'noBreakHyphen') text += '-';
        }
        if (text) runs.push({ text, ...(bold ? { bold } : {}), ...(italic ? { italic } : {}) });
      } else if (
        c.name === 'hyperlink' ||
        c.name === 'smartTag' ||
        c.name === 'ins' ||
        c.name === 'fldSimple' ||
        c.name === 'sdtContent' ||
        c.name === 'sdt'
      ) {
        walk(c);
      }
    }
  };
  walk(p);
  return runs;
}

function headingLevel(style: string | undefined): number {
  if (!style) return 0;
  if (/^(title|titre)$/i.test(style)) return 1;
  const m = /(?:heading|titre|berschrift|t[ií]tulo|titolo)\s*([1-6])/i.exec(style);
  return m ? Number(m[1]) : 0;
}

/**
 * DOCX → neutral blocks: headings, paragraphs (bold/italic runs, lists, alignment),
 * tables, page breaks and embedded images.
 */
export async function parseDocx(zip: ZipArchive): Promise<ExtractedDocument> {
  const warnings: string[] = [];
  const main = 'word/document.xml';
  if (!zip.has(main)) throw new Error('Fichier DOCX invalide (word/document.xml manquant)');
  const doc = parseXml(await zip.readText(main));
  const rels = await readRels(zip, main);
  const body = child(doc, 'body');
  if (!body) throw new Error('Fichier DOCX invalide (corps absent)');
  const blocks: Block[] = [];
  const counters = new Map<string, number>();
  const numFormats = await readNumbering(zip);

  const paragraph = async (p: XmlElement) => {
    const pPr = child(p, 'pPr');
    const style = pPr ? child(pPr, 'pStyle')?.attrs.val : undefined;
    const numPr = pPr ? child(pPr, 'numPr') : undefined;
    const jc = pPr ? child(pPr, 'jc')?.attrs.val : undefined;
    if (descendants(p, 'br').some((b) => b.attrs.type === 'page') || (pPr && child(pPr, 'pageBreakBefore'))) {
      blocks.push({ kind: 'pagebreak' });
    }
    for (const blip of descendants(p, 'blip')) {
      const id = blip.attrs.embed;
      const rel = id ? rels.get(id) : undefined;
      if (rel && zip.has(rel.target) && mimeFromPath(rel.target)) {
        const extent = descendants(p, 'extent')[0];
        const cx = extent ? Number(extent.attrs.cx) / 12700 : undefined;
        const cy = extent ? Number(extent.attrs.cy) / 12700 : undefined;
        blocks.push({
          kind: 'image',
          data: await zip.read(rel.target),
          mime: mimeFromPath(rel.target),
          ...(cx ? { widthPt: cx } : {}),
          ...(cy ? { heightPt: cy } : {}),
        });
      } else if (id) {
        warnings.push('Une image au format non pris en charge a été ignorée.');
      }
    }
    const runs = runsOf(p);
    if (runs.length === 0) {
      blocks.push({ kind: 'paragraph', runs: [] });
      return;
    }
    const level = headingLevel(style);
    if (level) {
      blocks.push({ kind: 'heading', level, runs });
      return;
    }
    if (numPr) {
      const numId = child(numPr, 'numId')?.attrs.val ?? '0';
      const ilvl = child(numPr, 'ilvl')?.attrs.val ?? '0';
      const key = `${numId}:${ilvl}`;
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      const fmt = numFormats.get(numId)?.get(ilvl) ?? 'bullet';
      blocks.push({ kind: 'paragraph', runs, list: fmt === 'bullet' || fmt === 'none' ? 'bullet' : 'number', listIndex: n });
      return;
    }
    const align = jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : undefined;
    blocks.push({ kind: 'paragraph', runs, ...(align ? { align } : {}) });
  };

  for (const el of children(body)) {
    if (el.name === 'p') await paragraph(el);
    else if (el.name === 'tbl') {
      const rows = children(el, 'tr').map((tr) =>
        children(tr, 'tc').map((tc) =>
          children(tc, 'p')
            .map((p) =>
              runsOf(p)
                .map((r) => r.text)
                .join(''),
            )
            .join('\n')
            .trim(),
        ),
      );
      if (rows.length) blocks.push({ kind: 'table', rows });
    } else if (el.name === 'sdt') {
      const content = child(el, 'sdtContent');
      if (content) for (const p of children(content, 'p')) await paragraph(p);
    }
  }
  const title = await readCoreTitle(zip);
  return { ...(title ? { title } : {}), source: 'docx', blocks, warnings: [...new Set(warnings)] };
}

/** numId → (ilvl → numFmt) from word/numbering.xml. */
async function readNumbering(zip: ZipArchive): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  if (!zip.has('word/numbering.xml')) return out;
  const xml = parseXml(await zip.readText('word/numbering.xml'));
  const abstract = new Map<string, Map<string, string>>();
  for (const a of children(xml, 'abstractNum')) {
    const levels = new Map<string, string>();
    for (const l of children(a, 'lvl')) levels.set(l.attrs.ilvl ?? '0', child(l, 'numFmt')?.attrs.val ?? 'bullet');
    abstract.set(a.attrs.abstractNumId ?? '', levels);
  }
  for (const n of children(xml, 'num')) {
    const abs = child(n, 'abstractNumId')?.attrs.val ?? '';
    out.set(n.attrs.numId ?? '', abstract.get(abs) ?? new Map());
  }
  return out;
}
