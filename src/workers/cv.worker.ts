import { serveRpc } from '../services/workers/rpc';
import { detectDocument } from '../core/cv/detect';
import { assessQuality } from '../core/cv/quality';
import type { FrameQuality } from '../core/cv/quality';
import type { Quad } from '../core/geometry/geometry';
import { toGray } from '../core/imaging/image';

export interface FrameAnalysis {
  quad: Quad | null;
  score: number;
  partial: boolean;
  quality: FrameQuality;
  width: number;
  height: number;
  elapsed: number;
}

/** Real-time document detection on downscaled camera frames. */
serveRpc(self as unknown as Parameters<typeof serveRpc>[0], {
  analyze: (p: { width: number; height: number; data: Uint8ClampedArray; minScore?: number }) => {
    const t0 = performance.now();
    const gray = toGray({ width: p.width, height: p.height, data: p.data });
    const r = detectDocument(gray, p.minScore !== undefined ? { minScore: p.minScore } : {});
    const quality = assessQuality(gray, r.quad);
    const result: FrameAnalysis = {
      quad: r.quad,
      score: r.score,
      partial: r.partial,
      quality,
      width: p.width,
      height: p.height,
      elapsed: performance.now() - t0,
    };
    // Give the frame buffer back to the caller so it can be reused.
    return { result: { analysis: result, buffer: p.data }, transfer: [p.data.buffer] };
  },
});
