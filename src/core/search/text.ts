/** Text normalisation and tokenisation shared by the search engine and the OCR post-processing. */

/** Lowercase, strip diacritics, unify apostrophes; keeps letters and digits. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/ß/g, 'ss')
    .replace(/[’'`]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function tokenize(text: string): string[] {
  const n = normalize(text);
  return n ? n.split(' ') : [];
}

/** Levenshtein distance with early exit when above `max`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0] as number;
    prev[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] as number;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min((prev[j] as number) + 1, (prev[j - 1] as number) + 1, diagonal + cost);
      diagonal = tmp;
      rowMin = Math.min(rowMin, prev[j] as number);
    }
    if (rowMin > max) return max + 1;
  }
  return prev[b.length] as number;
}

const MONTHS_FR = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];
const MONTHS_EN = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Searchable tokens for a timestamp: ISO date, year, month number/names, French format. */
export function dateTokens(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  const mm = String(m + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${y} ${y}-${mm} ${y}-${mm}-${dd} ${dd}/${mm}/${y} ${MONTHS_FR[m]} ${MONTHS_EN[m]}`;
}
