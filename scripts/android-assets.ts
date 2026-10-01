/** Copies the web build (dist/) into the Android project (android/app/src/main/assets/www). */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const dist = join(root, 'dist');
const target = join(root, 'android', 'app', 'src', 'main', 'assets', 'www');
if (!existsSync(join(dist, 'index.html'))) throw new Error('dist/ absent : lancez « bun run build » d’abord');
rmSync(target, { recursive: true, force: true });
// The service worker is useless in the APK (files are served from the package itself).
cpSync(dist, target, { recursive: true });
rmSync(join(target, 'sw.js'), { force: true });
console.log(`✔ assets web copiés dans ${target}`);
