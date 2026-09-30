import { dateTokens, editDistance, normalize, tokenize } from './text';

/** Fields indexed for each document, with their relevance weight. */
export interface SearchableDocument {
  id: string;
  title: string;
  folderPath: string;
  tags: readonly string[];
  notes: string;
  /** OCR text or text extracted from imported files. */
  content: string;
  /** e.g. "pdf", "image", "docx", plus the detected kind ("facture"...). */
  type: string;
  createdAt: number;
  updatedAt: number;
}

export interface SearchFilters {
  type?: string;
  from?: number;
  to?: number;
}

export interface SearchHit {
  id: string;
  score: number;
  /** Fields that matched. */
  fields: string[];
  /** Short excerpt of the content around the first match (plain text). */
  snippet: string;
  /** [start, end) ranges within the snippet to highlight. */
  highlights: Array<[number, number]>;
}

const WEIGHTS = { title: 6, tags: 5, folder: 3, notes: 2, type: 2, date: 1.5, content: 1 } as const;
type Field = keyof typeof WEIGHTS;

interface IndexedDoc {
  doc: SearchableDocument;
  tokens: Record<Field, Set<string>>;
  contentNorm: string;
}

export interface ParsedQuery {
  terms: string[];
  phrases: string[];
}

/** Parses a query: plain terms plus "quoted phrases". */
export function parseQuery(q: string): ParsedQuery {
  const phrases: string[] = [];
  const rest = q.replace(/"([^"]+)"/g, (_, p: string) => {
    const n = normalize(p);
    if (n) phrases.push(n);
    return ' ';
  });
  return { terms: tokenize(rest), phrases };
}

/**
 * In-memory full-text index. Matching is accent- and case-insensitive; every query term must
 * match some field (AND). Exact tokens score highest, then prefixes (search as you type), then
 * fuzzy matches (one typo for words of 5+ letters, OCR errors included).
 */
export class SearchIndex {
  private docs = new Map<string, IndexedDoc>();

  get size(): number {
    return this.docs.size;
  }

  upsert(doc: SearchableDocument): void {
    this.docs.set(doc.id, {
      doc,
      contentNorm: normalize(doc.content),
      tokens: {
        title: new Set(tokenize(doc.title)),
        tags: new Set(doc.tags.flatMap(tokenize)),
        folder: new Set(tokenize(doc.folderPath)),
        notes: new Set(tokenize(doc.notes)),
        type: new Set(tokenize(doc.type)),
        date: new Set(tokenize(`${dateTokens(doc.createdAt)} ${dateTokens(doc.updatedAt)}`)),
        content: new Set(tokenize(doc.content)),
      },
    });
  }

  remove(id: string): void {
    this.docs.delete(id);
  }

  clear(): void {
    this.docs.clear();
  }

  search(query: string, filters: SearchFilters = {}, limit = 100): SearchHit[] {
    const { terms, phrases } = parseQuery(query);
    const hits: SearchHit[] = [];
    for (const entry of this.docs.values()) {
      const d = entry.doc;
      if (filters.type && !entry.tokens.type.has(normalize(filters.type))) continue;
      if (filters.from !== undefined && d.createdAt < filters.from) continue;
      if (filters.to !== undefined && d.createdAt > filters.to) continue;
      let score = 0;
      const fields = new Set<string>();
      let ok = true;
      terms.forEach((term, ti) => {
        if (!ok) return;
        const isLast = ti === terms.length - 1;
        let best = 0;
        for (const f of Object.keys(WEIGHTS) as Field[]) {
          const m = matchTerm(term, entry.tokens[f], isLast);
          if (m > 0) {
            fields.add(f);
            best = Math.max(best, m * WEIGHTS[f]);
          }
        }
        if (best === 0) ok = false;
        score += best;
      });
      if (!ok) continue;
      for (const p of phrases) {
        const inTitle = normalize(d.title).includes(p);
        const inContent = entry.contentNorm.includes(p);
        if (!inTitle && !inContent && !normalize(d.notes).includes(p)) {
          ok = false;
          break;
        }
        score += inTitle ? 8 : 4;
        fields.add(inTitle ? 'title' : 'content');
      }
      if (!ok) continue;
      if (terms.length === 0 && phrases.length === 0) score = 1;
      // Slight boost for recently updated documents.
      score += Math.max(0, 0.5 - (Date.now() - d.updatedAt) / (1000 * 3600 * 24 * 365));
      const { snippet, highlights } = makeSnippet(d.content, [...terms, ...phrases]);
      hits.push({ id: d.id, score, fields: [...fields], snippet, highlights });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }
}

function matchTerm(term: string, tokens: Set<string>, allowPrefix: boolean): number {
  if (tokens.has(term)) return 1;
  let best = 0;
  for (const t of tokens) {
    if (allowPrefix && term.length >= 2 && t.startsWith(term)) best = Math.max(best, 0.7);
    else if (term.length >= 5 && Math.abs(t.length - term.length) <= 1 && t[0] === term[0] && editDistance(term, t, 1) <= 1) best = Math.max(best, 0.45);
    if (best >= 0.7) break;
  }
  return best;
}

/** Builds a ~160 character excerpt around the first matching term, with highlight ranges. */
export function makeSnippet(content: string, needles: readonly string[], radius = 70): { snippet: string; highlights: Array<[number, number]> } {
  if (!content) return { snippet: '', highlights: [] };
  // Map normalised positions back to the original string via a per-character normalisation.
  const chars = [...content];
  let norm = '';
  const map: number[] = [];
  let origIndex = 0;
  for (const ch of chars) {
    const n = normalize(ch) || ' ';
    for (const c of n) {
      norm += c;
      map.push(origIndex);
    }
    origIndex += ch.length;
  }
  let first = -1;
  let firstLen = 0;
  for (const n of needles) {
    if (!n) continue;
    const idx = norm.indexOf(n);
    if (idx >= 0 && (first < 0 || idx < first)) {
      first = idx;
      firstLen = n.length;
    }
  }
  const origStart = first >= 0 ? (map[first] as number) : 0;
  const start = Math.max(0, origStart - radius);
  const end = Math.min(content.length, origStart + firstLen + radius);
  let snippet = content.slice(start, end).replace(/\s+/g, ' ');
  const prefix = start > 0 ? '… ' : '';
  const suffix = end < content.length ? ' …' : '';
  snippet = prefix + snippet.trim() + suffix;
  const highlights: Array<[number, number]> = [];
  const sNorm = [...snippet].map((c) => (normalize(c) || ' ').slice(0, 1)).join('');
  for (const n of needles) {
    if (!n) continue;
    let from = 0;
    for (;;) {
      const i = sNorm.indexOf(n, from);
      if (i < 0) break;
      highlights.push([i, i + n.length]);
      from = i + n.length;
    }
  }
  highlights.sort((a, b) => a[0] - b[0]);
  return { snippet, highlights };
}
