import { serveRpc } from '../services/workers/rpc';
import { OcrEngine } from '../services/ocr/engine';
import type { OcrOutput, TesseractCoreFactory } from '../services/ocr/engine';

/**
 * OCR worker (classic worker: Tesseract's Emscripten build is loaded with importScripts).
 * Language models are fetched from this site only and cached for offline use. The image never
 * leaves the device.
 */

declare function importScripts(...urls: string[]): void;

interface InitParams {
  coreUrl: string;
  langBaseUrl: string;
  langs: string[];
}

const scope = self as unknown as Parameters<typeof serveRpc>[0] & { TesseractCore?: TesseractCoreFactory };
let engine: OcrEngine | null = null;
let progressSink: ((p: unknown) => void) | null = null;

async function fetchLanguage(url: string): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open('feuillet-tessdata-v1');
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch {
    cache = null;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Données de langue introuvables (${res.status})`);
  const buf = await res.arrayBuffer();
  try {
    await cache?.put(url, new Response(buf.slice(0)));
  } catch {
    /* quota: ignore */
  }
  return new Uint8Array(buf);
}

serveRpc(scope, {
  init: async (p: InitParams, progress) => {
    progressSink = progress;
    if (!engine) {
      progress({ status: 'Chargement du moteur OCR', value: 0 });
      importScripts(p.coreUrl);
      const factory = scope.TesseractCore;
      if (!factory) throw new Error('Moteur OCR introuvable');
      engine = await OcrEngine.create(factory, (v) => progressSink?.({ status: 'Reconnaissance du texte', value: v }));
    }
    for (const [i, lang] of p.langs.entries()) {
      if (engine.hasLanguage(lang)) continue;
      progress({ status: `Chargement de la langue (${lang})`, value: i / p.langs.length });
      engine.loadLanguage(lang, await fetchLanguage(`${p.langBaseUrl}${lang}.traineddata`));
    }
    engine.init(p.langs);
    return { result: true };
  },
  recognize: async (p: { image: Blob }, progress) => {
    if (!engine) throw new Error('Moteur OCR non initialisé');
    progressSink = progress;
    const bytes = new Uint8Array(await p.image.arrayBuffer());
    const out: OcrOutput = engine.recognize(bytes);
    return { result: out };
  },
});
