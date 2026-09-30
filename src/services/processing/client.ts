import { appUrl } from '../config';
import { RpcClient } from '../workers/rpc';
import type { RenderParams, RenderResult } from './handlers';
import type { Quad } from '../../core/geometry/geometry';

/**
 * Chooses where image processing runs: a dedicated worker when OffscreenCanvas is available there
 * (keeps the UI fluid), otherwise the main thread (older Safari).
 */
class ProcessingService {
  private client: RpcClient | null = null;
  private ready: Promise<boolean> | null = null;
  private direct: typeof import('./handlers') | null = null;

  private init(): Promise<boolean> {
    if (!this.ready) {
      this.ready = (async () => {
        try {
          const w = new Worker(appUrl('assets/processing.worker.js'), { type: 'module', name: 'processing' });
          const c = new RpcClient(w);
          const caps = await Promise.race([
            c.call<{ offscreen: boolean }>('capabilities', null),
            new Promise<{ offscreen: boolean }>((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
          ]);
          if (caps.offscreen) {
            this.client = c;
            return true;
          }
          c.terminate();
        } catch {
          /* fall through to the main thread */
        }
        this.direct = await import('./handlers');
        return false;
      })();
    }
    return this.ready;
  }

  async render(p: RenderParams): Promise<RenderResult> {
    await this.init();
    if (this.client) return this.client.call<RenderResult>('render', p);
    return (this.direct as typeof import('./handlers')).renderPage(p);
  }

  async preview(p: RenderParams): Promise<Blob> {
    await this.init();
    if (this.client) return this.client.call<Blob>('preview', p);
    return (this.direct as typeof import('./handlers')).previewPage(p);
  }

  async detect(blob: Blob): Promise<{ quad: Quad | null; width: number; height: number; score: number }> {
    await this.init();
    if (this.client) return this.client.call('detect', { blob });
    return (this.direct as typeof import('./handlers')).detectInImage(blob);
  }

  async orientation(blob: Blob): Promise<{ turns: 0 | 1; confidence: number }> {
    await this.init();
    if (this.client) return this.client.call('orientation', { blob });
    return (this.direct as typeof import('./handlers')).analyzeOrientation(blob);
  }
}

export const processing = new ProcessingService();
