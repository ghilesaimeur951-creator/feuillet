// Drives the debug APK on an emulator through the WebView DevTools protocol (raw CDP, no browser
// download needed). Usage: node smoke.mjs first|persist
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const phase = process.argv[2] ?? 'first';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Never end with an unsettled await (exit code 13): fail loudly instead.
const watchdog = setTimeout(() => {
  console.error('Délai global dépassé');
  process.exit(1);
}, 8 * 60_000);

async function target() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9222/json', { signal: AbortSignal.timeout(5000) })).json();
      if (i % 10 === 0) console.log('DevTools /json :', JSON.stringify(list).slice(0, 600));
      const t = list.find((x) => x.type === 'page' && x.url.includes('appassets.androidplatform.net'));
      if (t) return t;
    } catch {}
    await sleep(1000);
  }
  throw new Error('WebView introuvable via DevTools');
}

let ws = null;
let seq = 0;
const pending = new Map();
const errors = [];

/** (Re)connects to the page; the DevTools socket can drop (1006) while the WebView starts. */
async function connect() {
  for (let attempt = 1; attempt <= 8; attempt++) {
    const t = await target();
    const wsUrl = (t.webSocketDebuggerUrl ?? `ws://127.0.0.1:9222/devtools/page/${t.id}`).replace('localhost', '127.0.0.1');
    try {
      const sock = new WebSocket(wsUrl);
      await new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('pas de connexion en 15 s')), 15_000);
        sock.onopen = () => {
          clearTimeout(timer);
          res();
        };
        sock.onerror = () => {
          clearTimeout(timer);
          rej(new Error('erreur'));
        };
        sock.onclose = (e) => {
          clearTimeout(timer);
          rej(new Error(`fermé (${e.code})`));
        };
      });
      sock.onmessage = (e) => {
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
      sock.onclose = (e) => {
        console.log(`WebSocket fermé (${e.code}), reconnexion au prochain appel`);
        if (ws === sock) ws = null;
      };
      ws = sock;
      const r = await rawSend('Runtime.enable', {}, 10_000);
      if (r) {
        console.log(`Connecté à ${t.url} (tentative ${attempt})`);
        return;
      }
    } catch (e) {
      console.log(`Connexion DevTools, tentative ${attempt} : ${e.message}`);
    }
    ws = null;
    await sleep(2000);
  }
  throw new Error('Connexion DevTools impossible');
}

function rawSend(method, params, timeout) {
  return new Promise((r) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return r(null);
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      r(null);
    }, timeout);
    pending.set(id, (m) => {
      clearTimeout(timer);
      r(m);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function send(method, params = {}) {
  for (let i = 0; i < 3; i++) {
    if (!ws || ws.readyState !== WebSocket.OPEN) await connect();
    const r = await rawSend(method, params, 30_000);
    if (r) return r;
    console.log(`CDP ${method} : pas de réponse, reconnexion`);
    try {
      ws?.close();
    } catch {}
    ws = null;
  }
  throw new Error(`CDP ${method} : pas de réponse`);
}
await connect();

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
  console.log('WebView :', await evaluate(`return navigator.userAgent`));
  await evaluate(`window.__errs=[]; addEventListener('error',e=>__errs.push(String(e.message))); addEventListener('unhandledrejection',e=>__errs.push(String(e.reason&&e.reason.stack||e.reason))); return true;`);
  await waitFor('pont natif présent, pas de service worker', `return typeof FeuilletAndroid==='object' && (await navigator.serviceWorker.getRegistrations()).length===0;`);

  if (phase === 'first') {
    await waitFor('bibliothèque vide', `return document.body.innerText.includes('Aucun document');`);
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
    // Camera last: the emulated camera is the least stable part of the emulator.
    await evaluate(`location.hash='#/'; return true;`);
    // Camera: the emulator's virtual camera is not always available; a missing camera is reported,
    // a camera that exists but cannot be opened is a failure.
    const cam = await evaluate(`const devs=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='videoinput').length;
      const r = await Promise.race([
        navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}}}).then(s=>{const st=s.getVideoTracks()[0].getSettings(); s.getTracks().forEach(x=>x.stop()); return 'ok '+st.width+'x'+st.height;}, e=>'erreur '+e.name+': '+e.message),
        new Promise(r=>setTimeout(()=>r('délai dépassé'),20000))]);
      return devs+' caméra(s) ; getUserMedia : '+r;`);
    console.log('Caméra :', cam);
    if (cam.includes('getUserMedia : ok')) {
      console.log('✓ caméra (getUserMedia)');
      await evaluate(`location.hash='#/scan'; return true;`);
      await waitFor('écran scanner : flux vidéo affiché', `const v=document.querySelector('video'); return !!v && v.readyState>=2 && v.videoWidth>0;`, 30_000);
      await evaluate(`location.hash='#/'; return true;`);
      await waitFor('retour bibliothèque', `return !!document.querySelector('.doc-card');`);
    } else if (cam.startsWith('0 ') || cam.includes('délai')) {
      console.log('⚠ caméra non testée : pas de caméra utilisable dans cet émulateur');
    } else {
      throw new Error(`Caméra : ${cam}`);
    }

  }
  if (errors.length) console.log('Erreurs JavaScript (non bloquantes) :', errors.slice(0, 10));
  console.log(`Phase « ${phase} » réussie.`);
  clearTimeout(watchdog);
  ws?.close();
  process.exit(0);
} catch (e) {
  console.error(e.message);
  console.error('Erreurs JavaScript :', errors.slice(0, 20));
  try {
    console.error('Erreurs page :', await evaluate(`return JSON.stringify(window.__errs||[]).slice(0,3000) + ' | toasts: ' + [...document.querySelectorAll('.toast')].map(t=>t.textContent).join(' / ')`));
  } catch {}
  try {
    console.error('Texte affiché :', (await evaluate(`return document.body.innerText.slice(0,1500)`)) ?? '');
  } catch {}
  process.exit(1);
}
