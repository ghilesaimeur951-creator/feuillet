// Renders public/icons/icon.svg to the PNG sizes required by the web app manifest (uses Playwright's Chromium).
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const svg = readFileSync(new URL('../public/icons/icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, pad, bg] of [['icon-192.png', 192, 0, 'transparent'], ['icon-512.png', 512, 0, 'transparent'], ['icon-maskable-512.png', 512, 51, '#1d5c86']]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:${bg}"><div style="width:${size}px;height:${size}px;display:grid;place-items:center">${svg.replace('<svg', `<svg width="${size - 2 * pad}" height="${size - 2 * pad}"`)}</div></body></html>`);
  await page.screenshot({ path: new URL(`../public/icons/${name}`, import.meta.url).pathname, omitBackground: bg === 'transparent' });
}
await browser.close();
console.log('icons rendered');
