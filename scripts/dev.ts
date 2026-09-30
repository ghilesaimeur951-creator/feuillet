/**
 * Development: rebuilds on change and serves dist/.
 * `bun run dev` → http://localhost:5173 ; `bun run dev -- --https` for camera testing on a phone.
 */
import { watch } from 'node:fs';
import { join } from 'node:path';
import { build } from './build';
import { serve } from './serve';

const ROOT = join(import.meta.dir, '..');
Bun.argv.push('--dev');
await build();
const https = Bun.argv.includes('--https');
const s = serve(join(ROOT, 'dist'), Number(Bun.env.PORT ?? 5173), https);
console.log(`▶ ${https ? 'https' : 'http'}://localhost:${s.port} — reconstruction automatique à chaque modification`);

let timer: ReturnType<typeof setTimeout> | null = null;
for (const dir of ['src', 'public']) {
  watch(join(ROOT, dir), { recursive: true }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      build().catch((e: unknown) => console.error(e));
    }, 120);
  });
}
