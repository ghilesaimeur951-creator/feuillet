/** Tiny request/response RPC over postMessage, with transferables and progress events. */

export interface RpcRequest {
  id: number;
  method: string;
  params: unknown;
}

export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
  | { id: number; progress: unknown };

interface WorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
  addEventListener(type: 'error', fn: (e: ErrorEvent) => void): void;
  terminate?: () => void;
}

export class RpcClient {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: ((p: unknown) => void) | undefined }>();

  constructor(private readonly worker: WorkerLike) {
    worker.addEventListener('message', (e: MessageEvent) => {
      const msg = e.data as RpcResponse;
      const p = this.pending.get(msg.id);
      if (!p) return;
      if ('progress' in msg) {
        p.onProgress?.(msg.progress);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    });
    worker.addEventListener('error', (e: ErrorEvent) => {
      const err = new Error(e.message || 'Erreur dans le worker');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
  }

  call<T>(method: string, params: unknown, transfer: Transferable[] = [], onProgress?: (p: unknown) => void): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.worker.postMessage({ id, method, params } satisfies RpcRequest, transfer);
    });
  }

  terminate(): void {
    this.worker.terminate?.();
    for (const p of this.pending.values()) p.reject(new Error('Worker arrêté'));
    this.pending.clear();
  }
}

export type Handler = (params: never, progress: (p: unknown) => void) => Promise<{ result: unknown; transfer?: Transferable[] }> | { result: unknown; transfer?: Transferable[] };

interface WorkerScope {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
}

/** Worker side: dispatches requests to handlers and posts results back. */
export function serveRpc(scope: WorkerScope, handlers: Record<string, Handler>): void {
  scope.addEventListener('message', async (e: MessageEvent) => {
    const { id, method, params } = e.data as RpcRequest;
    const h = handlers[method];
    if (!h) {
      scope.postMessage({ id, ok: false, error: `Méthode inconnue : ${method}` } satisfies RpcResponse);
      return;
    }
    try {
      const { result, transfer } = await h(params as never, (progress) => scope.postMessage({ id, progress } satisfies RpcResponse));
      scope.postMessage({ id, ok: true, result } satisfies RpcResponse, transfer ?? []);
    } catch (err) {
      scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies RpcResponse);
    }
  });
}
