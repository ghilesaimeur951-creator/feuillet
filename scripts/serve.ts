/**
 * Static server for dist/ (preview and end-to-end tests). Optional HTTPS for testing the camera
 * from a phone on the local network: `bun scripts/serve.ts dist --https` (self-signed certificate
 * generated with openssl in .cert/).
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { spawnSync } from 'node:child_process';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.traineddata': 'application/octet-stream',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

export function serve(dir: string, port: number, https = false): { port: number; stop(): void } {
  const root = resolve(dir);
  let tls: { cert: Blob; key: Blob } | undefined;
  if (https) {
    const certDir = resolve('.cert');
    const cert = join(certDir, 'cert.pem');
    const key = join(certDir, 'key.pem');
    if (!existsSync(cert)) {
      mkdirSync(certDir, { recursive: true });
      const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '365', '-subj', '/CN=feuillet.local'], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`openssl indisponible : ${r.stderr}`);
    }
    tls = { cert: Bun.file(cert), key: Bun.file(key) };
  }
  const server = (Bun.serve as unknown as (o: Record<string, unknown>) => { port: number; stop(): void })({
    port,
    hostname: '0.0.0.0',
    ...(tls ? { tls } : {}),
    fetch(req: Request) {
      const url = new URL(req.url);
      let path = decodeURIComponent(url.pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = resolve(join(root, path));
      if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) return new Response('Not found', { status: 404 });
      const headers: Record<string, string> = {
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
        'Cache-Control': path === '/index.html' || path === '/sw.js' ? 'no-cache' : 'public, max-age=3600',
      };
      return new Response(Bun.file(file), { headers });
    },
  });
  return server;
}

if (import.meta.main) {
  const dir = Bun.argv[2] && !Bun.argv[2].startsWith('--') ? Bun.argv[2] : 'dist';
  const https = Bun.argv.includes('--https');
  const port = Number(Bun.env.PORT ?? 4173);
  const s = serve(dir, port, https);
  console.log(`Feuillet servi sur ${https ? 'https' : 'http'}://localhost:${s.port}  (réseau local : ${https ? 'https' : 'http'}://<ip-de-cette-machine>:${s.port})`);
}
