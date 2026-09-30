/**
 * Project lint rules (complements `tsc --strict` and Prettier):
 * forbids `any`, ts-ignore, console.log, debugger, invisible characters, oversized files and
 * anything that looks like a secret.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const TARGETS = ['src', 'tests/unit', 'tests/e2e', 'scripts'];
/** Maximum length of a TypeScript module (stylesheets are exempt). */
const MAX_LINES = 800;

interface Rule {
  id: string;
  re: RegExp;
  message: string;
  appliesTo?: (file: string) => boolean;
}

const RULES: Rule[] = [
  { id: 'no-any', re: /(:\s*any\b|\bas\s+any\b|<any>|any\[\])/, message: 'type `any` interdit' },
  { id: 'no-ts-ignore', re: /@ts-(ignore|nocheck)/, message: 'directive @ts-ignore/@ts-nocheck interdite' },
  { id: 'no-console-log', re: /\bconsole\.log\(/, message: 'console.log interdit dans le code applicatif', appliesTo: (f) => f.startsWith('src/') },
  { id: 'no-debugger', re: /\bdebugger\b/, message: 'instruction debugger' },
  { id: 'no-invisible-chars', re: /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u00a0\u200b-\u200f\u202f\u2060\ufeff\ufffe\uffff\u0300-\u036f]/, message: 'caractère invisible ou de contrôle littéral (utiliser un échappement \\uXXXX)' },
  { id: 'no-secrets', re: /(AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{24,}|-----BEGIN (RSA |EC )?PRIVATE KEY-----|ghp_[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{35})/, message: 'secret potentiel dans le code' },
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|css)$/.test(e)) out.push(p);
  }
  return out;
}

let errors = 0;
let files = 0;
for (const t of TARGETS) {
  for (const abs of walk(join(ROOT, t))) {
    files++;
    const file = relative(ROOT, abs);
    if (file === 'scripts/lint.ts') continue;
    const text = readFileSync(abs, 'utf8');
    const lines = text.split('\n');
    if (!file.endsWith('.css') && lines.length > MAX_LINES) {
      console.error(`${file}: fichier trop long (${lines.length} lignes > ${MAX_LINES})`);
      errors++;
    }
    lines.forEach((line, i) => {
      for (const r of RULES) {
        if (r.appliesTo && !r.appliesTo(file)) continue;
        if (r.re.test(line)) {
          console.error(`${file}:${i + 1}: [${r.id}] ${r.message}`);
          errors++;
        }
      }
    });
  }
}

if (errors) {
  console.error(`\n✖ ${errors} problème(s) dans ${files} fichiers`);
  process.exit(1);
}
console.log(`✔ lint : ${files} fichiers conformes`);
