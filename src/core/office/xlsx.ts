import type { ZipArchive } from '../zip/zip';
import type { Block, ExtractedDocument } from './model';
import { readCoreTitle, readRels } from './docx';
import { child, children, descendants, parseXml, textContent } from './xml';

const MAX_ROWS = 1000;
const MAX_COLS = 40;

/** "BC12" → { col: 54, row: 11 } (zero-based). */
export function parseCellRef(ref: string): { col: number; row: number } | null {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.toUpperCase());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1] as string) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) - 1 };
}

/** Excel serial date (1900 system) → ISO date string. */
export function excelSerialToDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  const iso = d.toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function formatNumber(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 1e10) / 1e10);
}

/** XLSX → one heading + table per sheet (shared strings, inline strings, booleans, dates). */
export async function parseXlsx(zip: ZipArchive): Promise<ExtractedDocument> {
  const warnings: string[] = [];
  const wbPath = 'xl/workbook.xml';
  if (!zip.has(wbPath)) throw new Error('Fichier XLSX invalide (xl/workbook.xml manquant)');
  const wb = parseXml(await zip.readText(wbPath));
  const rels = await readRels(zip, wbPath);
  const shared: string[] = [];
  if (zip.has('xl/sharedStrings.xml')) {
    const sst = parseXml(await zip.readText('xl/sharedStrings.xml'));
    for (const si of children(sst, 'si')) shared.push(descendants(si, 't').map(textContent).join(''));
  }
  // Styles: which cellXfs indexes are dates.
  const dateStyles = new Set<number>();
  if (zip.has('xl/styles.xml')) {
    const st = parseXml(await zip.readText('xl/styles.xml'));
    const customDate = new Set<number>();
    const numFmts = child(st, 'numFmts');
    if (numFmts) {
      for (const f of children(numFmts, 'numFmt')) {
        const code = (f.attrs.formatCode ?? '').replace(/"[^"]*"|\[[^\]]*\]/g, '');
        if (/[dmy]/i.test(code) && !/^[#0.,% ]*$/.test(code)) customDate.add(Number(f.attrs.numFmtId));
      }
    }
    const xfs = child(st, 'cellXfs');
    if (xfs) {
      children(xfs, 'xf').forEach((xf, i) => {
        const id = Number(xf.attrs.numFmtId ?? 0);
        if (BUILTIN_DATE_FORMATS.has(id) || customDate.has(id)) dateStyles.add(i);
      });
    }
  }
  const blocks: Block[] = [];
  const sheetsEl = child(wb, 'sheets');
  const sheets = sheetsEl ? children(sheetsEl, 'sheet') : [];
  for (const [si, sheet] of sheets.entries()) {
    const rid = sheet.attrs.id ?? sheet.attrs['r:id'];
    const rel = rid ? rels.get(rid) : undefined;
    if (!rel || !zip.has(rel.target)) continue;
    const xml = parseXml(await zip.readText(rel.target));
    const data = child(xml, 'sheetData');
    const grid: string[][] = [];
    let maxCol = -1;
    let truncated = false;
    for (const row of data ? children(data, 'row') : []) {
      for (const c of children(row, 'c')) {
        const ref = parseCellRef(c.attrs.r ?? '');
        if (!ref) continue;
        if (ref.row >= MAX_ROWS || ref.col >= MAX_COLS) {
          truncated = true;
          continue;
        }
        const t = c.attrs.t;
        const v = child(c, 'v');
        let value = '';
        if (t === 's') value = shared[Number(v ? textContent(v) : -1)] ?? '';
        else if (t === 'inlineStr') value = descendants(c, 't').map(textContent).join('');
        else if (t === 'b') value = v && textContent(v) === '1' ? 'VRAI' : 'FAUX';
        else if (t === 'e') value = v ? textContent(v) : '#ERR';
        else if (v) {
          const raw = textContent(v);
          value = t === 'str' ? raw : dateStyles.has(Number(c.attrs.s ?? -1)) ? excelSerialToDate(Number(raw)) : formatNumber(raw);
        }
        if (!value) continue;
        while (grid.length <= ref.row) grid.push([]);
        (grid[ref.row] as string[])[ref.col] = value;
        maxCol = Math.max(maxCol, ref.col);
      }
    }
    // Drop fully empty leading/trailing rows and normalise widths.
    const rows = grid.filter((r) => r.some((v) => v)).map((r) => Array.from({ length: maxCol + 1 }, (_, i) => r[i] ?? ''));
    blocks.push({ kind: 'heading', level: 2, runs: [{ text: sheet.attrs.name ?? `Feuille ${si + 1}` }] });
    if (rows.length) blocks.push({ kind: 'table', rows });
    else blocks.push({ kind: 'paragraph', runs: [{ text: '(feuille vide)', italic: true }] });
    if (truncated) warnings.push(`La feuille « ${sheet.attrs.name ?? si + 1} » a été tronquée à ${MAX_ROWS} lignes × ${MAX_COLS} colonnes.`);
    if (si < sheets.length - 1) blocks.push({ kind: 'pagebreak' });
  }
  if (descendants(wb, 'definedName').length) warnings.push('Les formules sont converties avec leur dernière valeur calculée.');
  const title = await readCoreTitle(zip);
  return { ...(title ? { title } : {}), source: 'xlsx', blocks, warnings };
}
