import { normalize } from '../search/text';

/** OCR result model and post-processing (TSV parsing, classification, invoice extraction, naming). */

export interface OcrWord {
  text: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
  line: number;
}

export interface OcrResult {
  text: string;
  words: OcrWord[];
  confidence: number;
  language: string;
  /** Size of the image the coordinates refer to. */
  width: number;
  height: number;
  createdAt: number;
  /** True when the user edited the text manually. */
  edited?: boolean;
}

/**
 * Parses Tesseract TSV output (level page block par line word left top width height conf text).
 */
export function parseTesseractTsv(tsv: string): { words: OcrWord[]; text: string; confidence: number } {
  const words: OcrWord[] = [];
  const lines: string[][] = [];
  let lineKey = '';
  let lineIdx = -1;
  let paraKey = '';
  let confSum = 0;
  const out: string[] = [];
  for (const row of tsv.split('\n')) {
    const cols = row.split('\t');
    if (cols.length < 12 || cols[0] !== '5') continue;
    const text = (cols.slice(11).join('\t') ?? '').trim();
    if (!text) continue;
    const conf = Number(cols[10]);
    const pk = `${cols[2]}:${cols[3]}`;
    const lk = `${pk}:${cols[4]}`;
    if (lk !== lineKey) {
      if (paraKey && pk !== paraKey) lines.push([]); // blank line between paragraphs
      lineKey = lk;
      paraKey = pk;
      lineIdx++;
      lines.push([]);
    }
    (lines[lines.length - 1] as string[]).push(text);
    words.push({
      text,
      confidence: Number.isFinite(conf) ? conf : 0,
      x: Number(cols[6]),
      y: Number(cols[7]),
      width: Number(cols[8]),
      height: Number(cols[9]),
      line: lineIdx,
    });
    confSum += Number.isFinite(conf) ? conf : 0;
  }
  for (const l of lines) out.push(l.join(' '));
  return {
    words,
    text: out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    confidence: words.length ? confSum / words.length : 0,
  };
}

export type DocumentKind = 'facture' | 'recu' | 'devis' | 'contrat' | 'releve' | 'fiche-de-paie' | 'ordonnance' | 'identite' | 'courrier' | 'impots';

export const KIND_LABELS: Record<DocumentKind, string> = {
  facture: 'Facture',
  recu: 'Reçu',
  devis: 'Devis',
  contrat: 'Contrat',
  releve: 'Relevé',
  'fiche-de-paie': 'Fiche de paie',
  ordonnance: 'Ordonnance',
  identite: "Pièce d'identité",
  courrier: 'Courrier',
  impots: 'Impôts',
};

const KIND_KEYWORDS: Record<DocumentKind, string[]> = {
  facture: [
    'facture',
    'invoice',
    'factura',
    'rechnung',
    'fattura',
    'montant ttc',
    'total ttc',
    'net a payer',
    'date d echeance',
    'tva intracommunautaire',
  ],
  recu: [
    'recu',
    'ticket',
    'receipt',
    'caisse',
    'carte bancaire',
    'cb',
    'merci de votre visite',
    'rendu',
    'quittung',
    'scontrino',
    'ticket de caisse',
  ],
  devis: ['devis', 'quotation', 'quote', 'presupuesto', 'angebot', 'preventivo', 'bon pour accord', 'validite de l offre'],
  contrat: [
    'contrat',
    'contract',
    'contrato',
    'vertrag',
    'contratto',
    'entre les soussignes',
    'article 1',
    'il a ete convenu',
    'fait en deux exemplaires',
    'signature',
  ],
  releve: ['releve de compte', 'releve', 'statement', 'solde', 'extracto', 'kontoauszug', 'estratto conto', 'iban', 'bic', 'operations'],
  'fiche-de-paie': ['bulletin de paie', 'bulletin de salaire', 'fiche de paie', 'salaire brut', 'net a payer avant impot', 'cotisations', 'payslip'],
  ordonnance: ['ordonnance', 'prescription', 'posologie', 'docteur', 'dr', 'medecin', 'pharmacie', 'comprime', 'receta'],
  identite: ['carte nationale d identite', 'passeport', 'passport', 'permis de conduire', 'date de naissance', 'nationalite', 'identity card'],
  courrier: ['madame', 'monsieur', 'objet', 'veuillez agreer', 'cordialement', 'salutations distinguees', 'dear', 'sincerely'],
  impots: [
    'avis d imposition',
    'impots',
    'impot sur le revenu',
    'direction generale des finances publiques',
    'numero fiscal',
    'taxe fonciere',
    'taxe d habitation',
  ],
};

/** Keyword-based classification. Returns the best kind when the evidence is sufficient. */
export function classifyDocument(text: string): { kind: DocumentKind | null; scores: Partial<Record<DocumentKind, number>> } {
  const n = ` ${normalize(text)} `;
  const scores: Partial<Record<DocumentKind, number>> = {};
  let best: DocumentKind | null = null;
  let bestScore = 0;
  for (const [kind, words] of Object.entries(KIND_KEYWORDS) as Array<[DocumentKind, string[]]>) {
    let s = 0;
    for (const w of words) {
      const re = new RegExp(`\\b${w.replace(/ /g, '\\s+')}\\b`, 'g');
      const count = (n.match(re) ?? []).length;
      if (count) s += (w.includes(' ') ? 2 : 1) * Math.min(3, count);
    }
    // A line of the header starting with the document's own name ("FACTURE N° …") is strong evidence.
    const head = text
      .split('\n')
      .slice(0, 8)
      .map((l) => normalize(l));
    if (words[0] && head.some((l) => l.startsWith(`${words[0]} `) || l === words[0])) s += 3;
    scores[kind] = s;
    if (s > bestScore) {
      bestScore = s;
      best = kind;
    }
  }
  return { kind: bestScore >= 4 ? best : null, scores };
}

export interface InvoiceData {
  company?: string;
  number?: string;
  date?: string;
  totalHT?: number;
  vat?: number;
  totalTTC?: number;
  currency?: string;
}

/** "1 234,56" / "1,234.56" / "1234.5" → number. */
export function parseAmount(s: string): number | null {
  let t = s.replace(/[\s\u00a0\u202f']/g, '');
  if (!/\d/.test(t)) return null;
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  if (lastComma > lastDot) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  const v = Number(t);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

const MONTHS: Record<string, number> = {
  janvier: 1,
  janv: 1,
  jan: 1,
  january: 1,
  enero: 1,
  januar: 1,
  gennaio: 1,
  fevrier: 2,
  fev: 2,
  feb: 2,
  february: 2,
  febrero: 2,
  februar: 2,
  febbraio: 2,
  mars: 3,
  mar: 3,
  march: 3,
  marzo: 3,
  marz: 3,
  avril: 4,
  avr: 4,
  apr: 4,
  april: 4,
  abril: 4,
  aprile: 4,
  mai: 5,
  may: 5,
  mayo: 5,
  maggio: 5,
  juin: 6,
  jun: 6,
  june: 6,
  junio: 6,
  juni: 6,
  giugno: 6,
  juillet: 7,
  juil: 7,
  jul: 7,
  july: 7,
  julio: 7,
  juli: 7,
  luglio: 7,
  aout: 8,
  aug: 8,
  august: 8,
  agosto: 8,
  septembre: 9,
  sept: 9,
  sep: 9,
  september: 9,
  septiembre: 9,
  settembre: 9,
  octobre: 10,
  oct: 10,
  october: 10,
  octubre: 10,
  oktober: 10,
  ottobre: 10,
  novembre: 11,
  nov: 11,
  november: 11,
  noviembre: 11,
  decembre: 12,
  dec: 12,
  december: 12,
  diciembre: 12,
  dezember: 12,
  dicembre: 12,
};

/** Finds the first plausible date in the text and returns it as YYYY-MM-DD. */
export function findDate(text: string): string | undefined {
  const iso = /\b(20\d{2}|19\d{2})-(\d{1,2})-(\d{1,2})\b/.exec(text);
  const cands: Array<{ idx: number; y: number; m: number; d: number }> = [];
  if (iso) cands.push({ idx: iso.index, y: +(iso[1] as string), m: +(iso[2] as string), d: +(iso[3] as string) });
  const re = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let y = +(m[3] as string);
    if (y < 100) y += 2000;
    cands.push({ idx: m.index, y, m: +(m[2] as string), d: +(m[1] as string) });
  }
  const norm = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const re2 = /\b(\d{1,2})(?:er)?\.?\s+([a-z]{3,9})\.?\s+(\d{4})\b/g;
  while ((m = re2.exec(norm))) {
    const month = MONTHS[m[2] as string];
    if (month) cands.push({ idx: m.index, y: +(m[3] as string), m: month, d: +(m[1] as string) });
  }
  cands.sort((a, b) => a.idx - b.idx);
  for (const c of cands) {
    if (c.m >= 1 && c.m <= 12 && c.d >= 1 && c.d <= 31 && c.y >= 1990 && c.y <= 2100) {
      return `${c.y}-${String(c.m).padStart(2, '0')}-${String(c.d).padStart(2, '0')}`;
    }
  }
  return undefined;
}

const AMOUNT = String.raw`(-?\d{1,3}(?:[\s\u00a0\u202f.,']\d{3})*(?:[.,]\d{1,2})?|-?\d+(?:[.,]\d{1,2})?)`;

function amountAfter(labels: string, text: string): number | undefined {
  const re = new RegExp(`(?:${labels})[^\\d\\n-]{0,40}?${AMOUNT}\\s*(?:€|eur|euros|\\$|usd|£|gbp|chf)?`, 'gi');
  let m: RegExpExecArray | null;
  let last: number | undefined;
  while ((m = re.exec(text))) {
    const v = parseAmount(m[1] as string);
    if (v !== null) last = v;
  }
  return last;
}

/** Extracts structured invoice/receipt data. Every field is optional: only what is found is returned. */
export function extractInvoiceData(text: string): InvoiceData {
  const out: InvoiceData = {};
  const n = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const totalTTC =
    amountAfter(
      'total\\s*ttc|montant\\s*ttc|net\\s*a\\s*payer|total\\s*a\\s*payer|total\\s*du|montant\\s*du|amount\\s*due|grand\\s*total|total\\s*eur|gesamtbetrag|totale',
      n,
    ) ?? amountAfter('\\btotal\\b', n);
  if (totalTTC !== undefined) out.totalTTC = totalTTC;
  const totalHT = amountAfter(
    'total\\s*ht|montant\\s*ht|sous[-\\s]?total|subtotal|net\\s*amount|total\\s*hors\\s*taxes?|zwischensumme|imponibile',
    n,
  );
  if (totalHT !== undefined) out.totalHT = totalHT;
  const vat = amountAfter('(?:montant\\s*)?t\\.?v\\.?a\\.?(?:\\s*\\(?\\d{1,2}(?:[.,]\\d+)?\\s*%\\)?)?|\\bvat\\b|mwst|\\biva\\b', n);
  if (vat !== undefined && vat !== out.totalTTC) out.vat = vat;
  if (out.totalHT !== undefined && out.totalTTC !== undefined && out.vat === undefined) {
    const v = Math.round((out.totalTTC - out.totalHT) * 100) / 100;
    if (v > 0) out.vat = v;
  }
  if (/€|\beur(?:os?)?\b/i.test(text)) out.currency = 'EUR';
  else if (/\$|\busd\b/i.test(text)) out.currency = 'USD';
  else if (/£|\bgbp\b/i.test(text)) out.currency = 'GBP';
  else if (/\bchf\b/i.test(text)) out.currency = 'CHF';
  const num =
    /(?:facture|invoice|factura|rechnung|fattura|re[cç]u|ticket)\s*(?:n[°o.º]*|no\.?|num(?:ero|éro)?\.?|#|nr\.?)\s*:?\s*([A-Z0-9][A-Z0-9\-/_.]{2,24})/i.exec(
      text,
    );
  if (num) out.number = (num[1] as string).replace(/[.]$/, '');
  const date = findDate(text);
  if (date) out.date = date;
  const company = findCompany(text);
  if (company) out.company = company;
  return out;
}

const LEGAL_FORMS = /\b(sas|sasu|sarl|eurl|sa|sci|snc|gmbh|ag|ltd|limited|inc|llc|s\.?p\.?a|s\.?r\.?l|s\.?l|bv|nv)\b\.?/i;
const NOISE_LINE = /^(facture|invoice|re[cç]u|ticket|devis|date|page|client|tel|t[ée]l[ée]phone|adresse|www\.|http)/i;

export function findCompany(text: string): string | undefined {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 2 && l.length <= 60);
  // "FACTURE EDF", "Invoice ACME Ltd": the issuer often follows the document type in the header.
  for (const l of lines.slice(0, 6)) {
    const m =
      /^(?:facture|invoice|factura|rechnung|fattura|re[cç]u|ticket)\s+(?!n[°o.º]|no\b|num|du\b|de\b|d['’])([A-Z][A-Za-z0-9&.'’ -]{1,30})$/i.exec(l);
    if (m && /[A-Z]{2,}/.test(m[1] as string)) return (m[1] as string).trim();
  }
  const legal = lines.find((l) => LEGAL_FORMS.test(l) && /[a-z]/i.test(l));
  if (legal) return legal.replace(/\s{2,}/g, ' ');
  const upper = lines.slice(0, 8).find((l) => /^[A-Z0-9&'’ .-]{2,40}$/.test(l) && /[A-Z]{2,}/.test(l) && !NOISE_LINE.test(l));
  return upper;
}

/** Suggests a document title from OCR text: "<Type> <Company> <date>" or the first meaningful line. */
export function suggestTitle(text: string, kind: DocumentKind | null, invoice?: InvoiceData): string | null {
  const parts: string[] = [];
  if (kind) parts.push(KIND_LABELS[kind]);
  const company = invoice?.company ?? findCompany(text);
  if (company && kind) parts.push(titleCase(company));
  const date = invoice?.date ?? findDate(text);
  if (date && kind) parts.push(date);
  if (parts.length >= 2) return parts.join(' — ').slice(0, 80);
  const first = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length >= 4 && /[\p{L}]{3,}/u.test(l));
  return first ? first.slice(0, 60) : null;
}

function titleCase(s: string): string {
  if (s !== s.toUpperCase()) return s;
  // Keep short acronyms (EDF, SA, SNCF…) in capitals, title-case longer words.
  return s
    .split(/(\s+|-)/)
    .map((w) => (w.length <= 4 ? w : w.charAt(0) + w.slice(1).toLowerCase()))
    .join('');
}

/** Suggested tags: document kind, company and year. */
export function suggestTags(text: string, kind: DocumentKind | null, invoice?: InvoiceData): string[] {
  const tags = new Set<string>();
  if (kind) tags.add(KIND_LABELS[kind].toLowerCase());
  const company = invoice?.company ?? (kind ? findCompany(text) : undefined);
  if (company) {
    const short = company.replace(LEGAL_FORMS, '').trim().split(/\s+/).slice(0, 2).join(' ');
    if (short.length >= 2 && short.length <= 24) tags.add(short.toLowerCase());
  }
  const date = invoice?.date ?? findDate(text);
  if (date) tags.add(date.slice(0, 4));
  return [...tags];
}
