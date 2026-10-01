import type { DocumentRecord, Page } from '../core/docs/model';
import { documentText } from '../core/docs/model';
import { isDuplicate } from '../core/imaging/analysis';
import type { Library } from './library';
import { copyPage } from './pages';

/** Document-level tools: merge, split, extract, blank pages, duplicates. */

export async function mergeDocuments(lib: Library, ids: readonly string[], title?: string): Promise<DocumentRecord> {
  const docs = ids.map((id) => lib.get(id)).filter((d): d is DocumentRecord => !!d);
  if (docs.length < 2) throw new Error('Sélectionnez au moins deux documents');
  if (docs.some((d) => d.locked)) throw new Error('Déverrouillez d’abord les documents verrouillés');
  const pages: Page[] = [];
  for (const d of docs) for (const p of d.pages) pages.push(await copyPage(lib, p));
  const first = docs[0] as DocumentRecord;
  return lib.createDocument({
    title: title ?? `${first.title} + ${docs.length - 1} autre${docs.length > 2 ? 's' : ''}`,
    pages,
    source: 'merge',
    folderId: first.folderId,
    tags: [...new Set(docs.flatMap((d) => d.tags))],
  });
}

/** Parses "1-3, 5, 7-9" (1-based, inclusive) into sorted unique zero-based indexes. */
export function parsePageRanges(input: string, pageCount: number): number[] {
  const out = new Set<number>();
  for (const part of input.split(/[,;]\s*/)) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(p);
    if (!m) throw new Error(`Plage invalide : « ${p} »`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a || b > pageCount) throw new Error(`Plage hors limites : « ${p} » (document de ${pageCount} pages)`);
    for (let i = a; i <= b; i++) out.add(i - 1);
  }
  if (!out.size) throw new Error('Aucune page sélectionnée');
  return [...out].sort((x, y) => x - y);
}

/** Copies the given pages into a new document. */
export async function extractPages(lib: Library, docId: string, indexes: readonly number[], title?: string): Promise<DocumentRecord> {
  const doc = lib.get(docId);
  if (!doc) throw new Error('Document introuvable');
  const pages: Page[] = [];
  for (const i of indexes) {
    const p = doc.pages[i];
    if (p) pages.push(await copyPage(lib, p));
  }
  if (!pages.length) throw new Error('Aucune page à extraire');
  const label =
    indexes.length === 1 ? `p. ${(indexes[0] as number) + 1}` : `p. ${(indexes[0] as number) + 1}-${(indexes[indexes.length - 1] as number) + 1}`;
  return lib.createDocument({ title: title ?? `${doc.title} (${label})`, pages, source: 'split', folderId: doc.folderId, tags: [...doc.tags] });
}

/** Splits a document every `every` pages, or at the given 1-based page numbers where a new part starts. */
export async function splitDocument(lib: Library, docId: string, opts: { every?: number; startsAt?: number[] }): Promise<DocumentRecord[]> {
  const doc = lib.get(docId);
  if (!doc) throw new Error('Document introuvable');
  const n = doc.pages.length;
  let starts: number[];
  if (opts.every && opts.every > 0) starts = Array.from({ length: Math.ceil(n / opts.every) }, (_, i) => i * (opts.every as number));
  else starts = [0, ...(opts.startsAt ?? []).map((x) => x - 1).filter((x) => x > 0 && x < n)];
  starts = [...new Set(starts)].sort((a, b) => a - b);
  if (starts.length < 2) throw new Error('Le découpage ne produit qu’un seul document');
  const out: DocumentRecord[] = [];
  for (const [k, s] of starts.entries()) {
    const e = (starts[k + 1] ?? n) - 1;
    out.push(
      await extractPages(
        lib,
        docId,
        Array.from({ length: e - s + 1 }, (_, i) => s + i),
        `${doc.title} (partie ${k + 1})`,
      ),
    );
  }
  return out;
}

export function blankPageIds(doc: DocumentRecord): string[] {
  return doc.pages.filter((p) => p.blank && !(p.ocr?.text ?? p.text ?? '').trim() && p.annotations.length === 0).map((p) => p.id);
}

export interface DuplicateGroup {
  hash: string;
  items: Array<{ doc: DocumentRecord; page: Page; index: number }>;
}

/** Groups visually identical pages across the whole library (perceptual hash). */
export function findDuplicatePages(lib: Library): DuplicateGroup[] {
  const entries: Array<{ doc: DocumentRecord; page: Page; index: number }> = [];
  for (const d of lib.documents()) d.pages.forEach((page, index) => page.hash && !page.blank && entries.push({ doc: d, page, index }));
  const groups: DuplicateGroup[] = [];
  const used = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i] as (typeof entries)[number];
    if (used.has(a.page.id)) continue;
    const g: DuplicateGroup = { hash: a.page.hash as string, items: [a] };
    for (let j = i + 1; j < entries.length; j++) {
      const b = entries[j] as (typeof entries)[number];
      if (used.has(b.page.id)) continue;
      if (isDuplicate(a.page.hash as string, b.page.hash as string)) {
        // Same picture: confirm with the text when both pages have one.
        const ta = (a.page.ocr?.text ?? a.page.text ?? '').trim();
        const tb = (b.page.ocr?.text ?? b.page.text ?? '').trim();
        if (ta && tb && ta.slice(0, 200) !== tb.slice(0, 200)) continue;
        g.items.push(b);
        used.add(b.page.id);
      }
    }
    if (g.items.length > 1) {
      used.add(a.page.id);
      groups.push(g);
    }
  }
  return groups;
}

export function documentWordCount(doc: DocumentRecord): number {
  const t = documentText(doc).trim();
  return t ? t.split(/\s+/).length : 0;
}
