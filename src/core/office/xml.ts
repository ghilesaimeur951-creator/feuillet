/**
 * Small, dependency-free XML parser for Office Open XML parts. Produces an element tree with
 * local names (namespace prefixes stripped). DTDs are ignored (no entity expansion → no XXE /
 * billion-laughs), which is the safe behaviour for untrusted files.
 */

export interface XmlElement {
  name: string;
  /** Qualified name as written in the document (with prefix). */
  qname: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

export type XmlNode = XmlElement | string;

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e.startsWith('#x')) return safeCodePoint(parseInt(e.slice(2), 16), m);
    if (e.startsWith('#')) return safeCodePoint(parseInt(e.slice(1), 10), m);
    return ENTITIES[e] ?? m;
  });
}

function safeCodePoint(cp: number, fallback: string): string {
  return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : fallback;
}

function localName(q: string): string {
  const i = q.indexOf(':');
  return i >= 0 ? q.slice(i + 1) : q;
}

export function parseXml(src: string): XmlElement {
  const root: XmlElement = { name: '#document', qname: '#document', attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  let i = 0;
  const n = src.length;
  const attrRe = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  while (i < n) {
    const lt = src.indexOf('<', i);
    const top = stack[stack.length - 1] as XmlElement;
    if (lt < 0) {
      const t = src.slice(i);
      if (t.trim()) top.children.push(decodeEntities(t));
      break;
    }
    if (lt > i) {
      const t = src.slice(i, lt);
      if (t.length) top.children.push(decodeEntities(t));
    }
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      top.children.push(src.slice(lt + 9, end < 0 ? n : end));
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      // DOCTYPE or other declarations: skipped entirely (no entity expansion).
      let depth = 0;
      let j = lt + 2;
      for (; j < n; j++) {
        const c = src[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    const gt = findTagEnd(src, lt + 1);
    if (gt < 0) break;
    const body = src.slice(lt + 1, gt);
    i = gt + 1;
    if (body.startsWith('/')) {
      const qname = body.slice(1).trim();
      // Pop to the matching element (tolerant of minor malformation).
      for (let k = stack.length - 1; k > 0; k--) {
        if ((stack[k] as XmlElement).qname === qname) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const sp = inner.search(/\s/);
    const qname = sp < 0 ? inner : inner.slice(0, sp);
    const attrs: Record<string, string> = {};
    if (sp >= 0) {
      attrRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      const attrSrc = inner.slice(sp);
      while ((m = attrRe.exec(attrSrc))) {
        attrs[localName(m[1] as string)] = decodeEntities(m[3] ?? m[4] ?? '');
        attrs[m[1] as string] = decodeEntities(m[3] ?? m[4] ?? '');
      }
    }
    const el: XmlElement = { name: localName(qname), qname, attrs, children: [] };
    top.children.push(el);
    if (!selfClosing) stack.push(el);
  }
  const first = root.children.find((c): c is XmlElement => typeof c !== 'string');
  if (!first) throw new Error('XML vide ou invalide');
  return first;
}

function findTagEnd(s: string, from: number): number {
  let quote: string | null = null;
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return j;
  }
  return -1;
}

export function children(el: XmlElement, name?: string): XmlElement[] {
  return el.children.filter((c): c is XmlElement => typeof c !== 'string' && (name === undefined || c.name === name));
}

export function child(el: XmlElement, name: string): XmlElement | undefined {
  return el.children.find((c): c is XmlElement => typeof c !== 'string' && c.name === name);
}

/** Depth-first search for descendants with the given local name. */
export function descendants(el: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    if (c.name === name) out.push(c);
    descendants(c, name, out);
  }
  return out;
}

export function textContent(el: XmlElement): string {
  let s = '';
  for (const c of el.children) s += typeof c === 'string' ? c : textContent(c);
  return s;
}
