/** Neutral document model produced by the Office/TXT importers and consumed by the page layout engine. */

export interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

export type Block =
  | { kind: 'heading'; level: number; runs: TextRun[] }
  | { kind: 'paragraph'; runs: TextRun[]; list?: 'bullet' | 'number'; listIndex?: number; align?: 'left' | 'center' | 'right' }
  | { kind: 'table'; rows: string[][]; caption?: string }
  | { kind: 'image'; data: Uint8Array; mime: string; widthPt?: number; heightPt?: number }
  | { kind: 'pagebreak' };

export interface ExtractedDocument {
  title?: string;
  /** One of 'docx' | 'xlsx' | 'pptx' | 'txt'. */
  source: string;
  blocks: Block[];
  /** Human-readable notes about content that could not be converted faithfully. */
  warnings: string[];
}

export function runsText(runs: readonly TextRun[]): string {
  return runs.map((r) => r.text).join('');
}

/** Plain text of the whole document (used for search indexing). */
export function documentText(doc: ExtractedDocument): string {
  const parts: string[] = [];
  for (const b of doc.blocks) {
    if (b.kind === 'heading' || b.kind === 'paragraph') parts.push(runsText(b.runs));
    else if (b.kind === 'table') for (const row of b.rows) parts.push(row.join('\t'));
  }
  return parts.join('\n');
}
