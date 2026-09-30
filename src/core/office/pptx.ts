import type { ZipArchive } from '../zip/zip';
import type { Block, ExtractedDocument, TextRun } from './model';
import { mimeFromPath, readCoreTitle, readRels } from './docx';
import type { XmlElement } from './xml';
import { child, children, descendants, parseXml, textContent } from './xml';

function paragraphRuns(p: XmlElement): TextRun[] {
  const runs: TextRun[] = [];
  for (const c of children(p)) {
    if (c.name === 'r' || c.name === 'fld') {
      const t = child(c, 't');
      const rPr = child(c, 'rPr');
      const text = t ? textContent(t) : '';
      if (text) runs.push({ text, ...(rPr?.attrs.b === '1' ? { bold: true } : {}), ...(rPr?.attrs.i === '1' ? { italic: true } : {}) });
    } else if (c.name === 'br') runs.push({ text: '\n' });
  }
  return runs;
}

/** PPTX → one page per slide: title as heading, text boxes as paragraphs/bullets, tables and pictures. */
export async function parsePptx(zip: ZipArchive): Promise<ExtractedDocument> {
  const presPath = 'ppt/presentation.xml';
  if (!zip.has(presPath)) throw new Error('Fichier PPTX invalide (ppt/presentation.xml manquant)');
  const pres = parseXml(await zip.readText(presPath));
  const rels = await readRels(zip, presPath);
  const list = child(pres, 'sldIdLst');
  const slidePaths = (list ? children(list, 'sldId') : [])
    .map((s) => rels.get(s.attrs.id ?? s.attrs['r:id'] ?? '')?.target)
    .filter((p): p is string => !!p && zip.has(p));
  const blocks: Block[] = [];
  const warnings: string[] = [];
  for (const [i, path] of slidePaths.entries()) {
    const slide = parseXml(await zip.readText(path));
    const srels = await readRels(zip, path);
    const tree = descendants(slide, 'spTree')[0];
    let hasTitle = false;
    const body: Block[] = [];
    const visit = async (el: XmlElement) => {
      for (const c of children(el)) {
        if (c.name === 'sp') {
          const ph = descendants(c, 'ph')[0];
          const isTitle = ph && (ph.attrs.type === 'title' || ph.attrs.type === 'ctrTitle');
          const txBody = child(c, 'txBody');
          if (!txBody) continue;
          const paras = children(txBody, 'p').map(paragraphRuns).filter((r) => r.some((x) => x.text.trim()));
          if (!paras.length) continue;
          if (isTitle && !hasTitle) {
            hasTitle = true;
            body.unshift({ kind: 'heading', level: 1, runs: paras.flatMap((r, k) => (k ? [{ text: ' ' }, ...r] : r)) });
          } else {
            for (const runs of paras) body.push({ kind: 'paragraph', runs, ...(ph && ph.attrs.type !== 'subTitle' ? { list: 'bullet' as const } : {}) });
          }
        } else if (c.name === 'grpSp') {
          await visit(c);
        } else if (c.name === 'graphicFrame') {
          const tbl = descendants(c, 'tbl')[0];
          if (tbl) {
            const rows = children(tbl, 'tr').map((tr) => children(tr, 'tc').map((tc) => descendants(tc, 't').map(textContent).join(' ').trim()));
            if (rows.length) body.push({ kind: 'table', rows });
          } else warnings.push('Les graphiques et SmartArt ne sont pas convertis.');
        } else if (c.name === 'pic') {
          const blip = descendants(c, 'blip')[0];
          const rel = blip?.attrs.embed ? srels.get(blip.attrs.embed) : undefined;
          if (rel && zip.has(rel.target) && mimeFromPath(rel.target)) {
            body.push({ kind: 'image', data: await zip.read(rel.target), mime: mimeFromPath(rel.target) });
          }
        }
      }
    };
    if (tree) await visit(tree);
    if (!hasTitle) body.unshift({ kind: 'heading', level: 2, runs: [{ text: `Diapositive ${i + 1}` }] });
    blocks.push(...body);
    if (i < slidePaths.length - 1) blocks.push({ kind: 'pagebreak' });
  }
  const title = await readCoreTitle(zip);
  return { ...(title ? { title } : {}), source: 'pptx', blocks, warnings: [...new Set(warnings)] };
}

/** Plain text → paragraphs. Detects UTF-8 and falls back to Windows-1252. */
export function parseTxt(bytes: Uint8Array): ExtractedDocument {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('windows-1252').decode(bytes);
  }
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks: Block[] = text.split('\n').map((line) => (line === '\f' ? { kind: 'pagebreak' as const } : { kind: 'paragraph' as const, runs: line ? [{ text: line }] : [] }));
  return { source: 'txt', blocks, warnings: [] };
}
