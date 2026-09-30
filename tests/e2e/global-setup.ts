import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Converts the committed MJPEG camera fixture to Y4M (the format Chromium's fake camera reads). */
export default function globalSetup(): void {
  const root = join(HERE, '..', '..');
  const dir = join(root, 'tests', 'e2e', '.artifacts');
  const out = join(dir, 'document.y4m');
  if (!existsSync(join(root, 'dist', 'index.html'))) throw new Error('Construisez l’application d’abord : bun run build');
  if (existsSync(out)) return;
  mkdirSync(dir, { recursive: true });
  try {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', join(root, 'tests', 'fixtures', 'e2e', 'document.mjpeg'), '-pix_fmt', 'yuv420p', out]);
  } catch {
    throw new Error('ffmpeg est requis pour générer le flux caméra simulé des tests e2e');
  }
}
