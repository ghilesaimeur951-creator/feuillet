/**
 * Production build (Bun bundler):
 *  - app bundle (ESM, code splitting, CSS extracted, hashed names)
 *  - workers as classic scripts with stable names (vision, processing, OCR)
 *  - static files from public/ (manifest, icons, vendored engines)
 *  - index.html with injected assets, service worker with precache list
 * Usage: bun scripts/build.ts [--dev]
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const DIST = join(ROOT, 'dist');
const dev = Bun.argv.includes('--dev');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function fail(what: string, logs: unknown[]): never {
  console.error(`✖ Échec du build (${what})`);
  for (const l of logs) console.error(l);
  process.exit(1);
}

export async function build(): Promise<void> {
  const t0 = performance.now();
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(join(DIST, 'assets'), { recursive: true });

  const app = await Bun.build({
    entrypoints: [join(ROOT, 'src/main.tsx')],
    outdir: join(DIST, 'assets'),
    target: 'browser',
    format: 'esm',
    splitting: true,
    minify: !dev,
    sourcemap: dev ? 'inline' : 'linked',
    naming: { entry: '[name]-[hash].[ext]', chunk: 'chunk-[hash].[ext]', asset: '[name]-[hash].[ext]' },
    define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
  });
  if (!app.success) fail('application', app.logs);

  const workers = await Bun.build({
    entrypoints: ['cv', 'processing', 'ocr'].map((w) => join(ROOT, `src/workers/${w}.worker.ts`)),
    outdir: join(DIST, 'assets'),
    target: 'browser',
    format: 'iife',
    minify: !dev,
    sourcemap: dev ? 'inline' : 'none',
    naming: '[name].[ext]',
  });
  if (!workers.success) fail('workers', workers.logs);

  cpSync(join(ROOT, 'public'), DIST, { recursive: true });

  const assets = app.outputs.map((o) => relative(DIST, o.path));
  const entry = assets.find((a) => /^assets\/main-.*\.js$/.test(a));
  const css = assets.filter((a) => a.endsWith('.css'));
  if (!entry) fail('point d’entrée introuvable', assets);
  let html = readFileSync(join(ROOT, 'src/index.html'), 'utf8');
  html = html.replace('<!--STYLES-->', css.map((c) => `<link rel="stylesheet" href="${c}" />`).join('\n    '));
  html = html.replace('<!--SCRIPTS-->', `<script type="module" src="${entry}"></script>`);
  writeFileSync(join(DIST, 'index.html'), html);

  // Service worker: precache the app shell (small files), not the vendored engines.
  const shell = walk(DIST)
    .map((p) => relative(DIST, p).split('\\').join('/'))
    .filter((p) => !p.startsWith('vendor/') && !p.endsWith('.map') && p !== 'sw.js');
  const hasher = new Bun.CryptoHasher('sha256');
  for (const f of shell.sort()) hasher.update(readFileSync(join(DIST, f)));
  const buildId = hasher.digest('hex').slice(0, 12);
  const sw = readFileSync(join(ROOT, 'src/sw.template.js'), 'utf8')
    .replace('__BUILD_ID__', buildId)
    .replace('__PRECACHE__', JSON.stringify(['./', ...shell.filter((p) => p !== 'index.html')], null, 0));
  writeFileSync(join(DIST, 'sw.js'), sw);

  const size = (p: string) => (existsSync(p) ? statSync(p).size : 0);
  const kb = (n: number) => `${(n / 1024).toFixed(1)} Ko`;
  const js = assets.filter((a) => a.endsWith('.js')).reduce((s, a) => s + size(join(DIST, a)), 0);
  console.log(`✔ Build ${dev ? 'dev' : 'production'} en ${Math.round(performance.now() - t0)} ms — id ${buildId}`);
  console.log(`  application : ${kb(js)} JS, ${kb(css.reduce((s, a) => s + size(join(DIST, a)), 0))} CSS`);
  for (const w of ['cv', 'processing', 'ocr']) console.log(`  worker ${w} : ${kb(size(join(DIST, `assets/${w}.worker.js`)))}`);
}

if (import.meta.main) await build();
