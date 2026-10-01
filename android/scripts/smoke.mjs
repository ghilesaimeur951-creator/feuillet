// Drives the debug APK on an emulator through the WebView DevTools protocol (raw CDP, no browser
// download needed). Usage: node smoke.mjs first|persist
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const phase = process.argv[2] ?? 'first';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9222/json')).json();
      const t = list.find((x) => x.type === 'page' && x.url.includes('appassets.androidplatform.net'));
      if (t) return t;
    } catch {}
    await sleep(1000);
  }
  throw new Error('WebView introuvable via DevTools');
}

const t = await target();
console.log('Page :', t.url);
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let seq = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  }
};
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++seq;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
await send('Runtime.enable');

async function evaluate(body) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}
async function waitFor(label, body, timeout = 60_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await evaluate(body);
      if (last) {
        console.log(`✓ ${label}`);
        return last;
      }
    } catch (e) {
      last = e.message;
    }
    await sleep(500);
  }
  throw new Error(`Échec : ${label} (dernier résultat : ${last})`);
}
const clickText = (text) =>
  evaluate(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(text)}); if(!b) throw new Error('bouton absent: ${text}'); b.click(); return true;`);

try {
  await waitFor('application démarrée', `return !!document.querySelector('.app') && !document.querySelector('.fatal');`);
  await waitFor('pont natif présent, pas de service worker', `return typeof FeuilletAndroid==='object' && (await navigator.serviceWorker.getRegistrations()).length===0;`);

  if (phase === 'first') {
    await waitFor('bibliothèque vide', `return document.body.innerText.includes('Aucun document');`);
    const w = await waitFor(
      'caméra (getUserMedia)',
      `const s=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}}}); const st=s.getVideoTracks()[0].getSettings(); s.getTracks().forEach(x=>x.stop()); return st.width||1;`,
    );
    console.log('  largeur vidéo :', w);
    await evaluate(`location.hash='#/scan'; return true;`);
    await waitFor('écran scanner : flux vidéo affiché', `const v=document.querySelector('video'); return !!v && v.readyState>=2 && v.videoWidth>0;`, 30_000);
    await evaluate(`location.hash='#/'; return true;`);
    await waitFor('retour bibliothèque', `return document.body.innerText.includes('Aucun document');`);

    // Import (same path as a drag-and-drop): exercises workers, IndexedDB and image processing.
    const b64 = readFileSync(join(ROOT, 'tests/fixtures/ocr/invoice.jpg')).toString('base64');
    await evaluate(`const bin=Uint8Array.from(atob(${JSON.stringify(b64)}),c=>c.charCodeAt(0)); const dt=new DataTransfer(); dt.items.add(new File([bin],'facture.jpg',{type:'image/jpeg'}));
      for (const type of ['dragenter','dragover','drop']) window.dispatchEvent(new DragEvent(type,{dataTransfer:dt,bubbles:true,cancelable:true})); return true;`);
    await waitFor('document importé', `return location.hash.startsWith('#/doc/') && document.querySelectorAll('.page-grid .page-tile').length===1;`, 90_000);

    // OCR: Tesseract WASM + French model, served from the APK inside a worker.
    await clickText('OCR');
    await waitFor('OCR terminé', `return document.body.innerText.includes('OCR 1/1');`, 240_000);

    // PDF export through the native bridge (saved into Downloads/Feuillet by the bash script check).
    await evaluate(`document.querySelector('[data-testid=export-open]').click(); return true;`);
    await waitFor('feuille d’export ouverte', `return !!document.querySelector('[data-testid=export-download]');`);
    await evaluate(`document.querySelector('[data-testid=export-download]').click(); return true;`);
    await waitFor('export terminé', `return !document.querySelector('[data-testid=export-download]');`, 120_000);
    await sleep(3000);
  } else {
    await waitFor('document conservé après redémarrage', `location.hash='#/'; return document.querySelectorAll('.doc-card').length===1;`, 30_000);
    await evaluate(`location.hash='#/search?q=electricite'; return true;`);
    await waitFor('recherche plein texte sur l’OCR', `return document.querySelectorAll('.doc-row').length===1;`, 30_000);
  }
  if (errors.length) console.log('Erreurs JavaScript (non bloquantes) :', errors.slice(0, 10));
  console.log(`Phase « ${phase} » réussie.`);
  ws.close();
  process.exit(0);
} catch (e) {
  console.error(e.message);
  console.error('Erreurs JavaScript :', errors.slice(0, 20));
  try {
    console.error('Texte affiché :', (await evaluate(`return document.body.innerText.slice(0,1500)`)) ?? '');
  } catch {}
  process.exit(1);
}
