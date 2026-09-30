import { appUrl } from './config';
import { RpcClient } from './workers/rpc';
import type { FrameAnalysis } from '../workers/cv.worker';

export type { FrameAnalysis };

/** Real-time detection client: one frame in flight at a time, buffers recycled. */
export class LiveDetector {
  private client: RpcClient;

  constructor() {
    this.client = new RpcClient(new Worker(appUrl('assets/cv.worker.js'), { name: 'vision' }));
  }

  async analyze(frame: ImageData): Promise<FrameAnalysis> {
    const data = frame.data;
    const r = await this.client.call<{ analysis: FrameAnalysis }>('analyze', { width: frame.width, height: frame.height, data }, [data.buffer]);
    return r.analysis;
  }

  dispose(): void {
    this.client.terminate();
  }
}
