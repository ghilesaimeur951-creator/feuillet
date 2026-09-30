import type { OcrResult } from '../../core/ocr/analysis';
import { appUrl } from '../config';
import { RpcClient } from '../workers/rpc';
import type { OcrOutput } from './engine';

/** Detects WebAssembly SIMD support (tiny module using a v128 instruction). */
function supportsSimd(): boolean {
  try {
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch {
    return false;
  }
}

export interface OcrProgress {
  status: string;
  value: number;
}

/**
 * OCR service: a single worker, lazily created, with a queue (Tesseract is single-threaded).
 * 100 % local: engine and language models are served by this application.
 */
class OcrService {
  private client: RpcClient | null = null;
  private langsKey = '';
  private queue: Promise<unknown> = Promise.resolve();

  private getClient(): RpcClient {
    if (!this.client) this.client = new RpcClient(new Worker(appUrl('assets/ocr.worker.js'), { name: 'ocr' }));
    return this.client;
  }

  /** Runs OCR on an encoded image (JPEG/PNG). */
  recognize(image: Blob, langs: readonly string[], onProgress?: (p: OcrProgress) => void): Promise<OcrResult & { width: number; height: number }> {
    const run = async () => {
      const c = this.getClient();
      const key = langs.join('+');
      if (key !== this.langsKey) {
        await c.call(
          'init',
          {
            coreUrl: appUrl(`vendor/tesseract/${supportsSimd() ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js'}`),
            langBaseUrl: appUrl('vendor/tessdata/'),
            langs: [...langs],
          },
          [],
          (p) => onProgress?.(p as OcrProgress),
        );
        this.langsKey = key;
      }
      const out = await c.call<OcrOutput>('recognize', { image }, [], (p) => onProgress?.(p as OcrProgress));
      const bmp = await createImageBitmap(image);
      const size = { width: bmp.width, height: bmp.height };
      bmp.close();
      return { text: out.text, words: out.words, confidence: out.confidence, language: key, createdAt: Date.now(), ...size };
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Frees the engine memory (≈ 100 MB) when OCR is no longer needed. */
  shutdown(): void {
    this.client?.terminate();
    this.client = null;
    this.langsKey = '';
  }
}

export const ocr = new OcrService();
