import { serveRpc } from '../services/workers/rpc';
import type { RenderParams } from '../services/processing/handlers';
import { analyzeOrientation, detectInImage, previewPage, renderPage } from '../services/processing/handlers';

/** Heavy image processing off the main thread: rectification, filters, encoding, analysis. */
serveRpc(self as unknown as Parameters<typeof serveRpc>[0], {
  capabilities: () => ({ result: { offscreen: typeof OffscreenCanvas !== 'undefined' && !!new OffscreenCanvas(1, 1).getContext('2d') } }),
  render: async (p: RenderParams) => ({ result: await renderPage(p) }),
  preview: async (p: RenderParams) => ({ result: await previewPage(p) }),
  detect: async (p: { blob: Blob }) => ({ result: await detectInImage(p.blob) }),
  orientation: async (p: { blob: Blob }) => ({ result: await analyzeOrientation(p.blob) }),
});
