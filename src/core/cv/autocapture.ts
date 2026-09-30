import type { FrameQuality } from './quality';
import type { StabilizedState } from './stabilizer';

export type AutoCaptureStatus =
  | 'searching'
  | 'detected'
  | 'hold-still'
  | 'partial'
  | 'blurry'
  | 'too-dark'
  | 'capturing'
  | 'cooldown';

export interface AutoCaptureState {
  status: AutoCaptureStatus;
  /** 0..1 progress towards an automatic capture. */
  progress: number;
  /** True exactly on the frame where the capture must be triggered. */
  fire: boolean;
}

export interface AutoCaptureOptions {
  /** Continuous stability required before firing (ms). */
  holdMs?: number;
  /** Minimum confidence required. */
  minConfidence?: number;
  /** Pause after a capture (ms). */
  cooldownMs?: number;
}

/**
 * Decides when to fire an automatic capture. After a capture, it waits for a cooldown and then
 * for the scene to change (document removed or moved) before capturing again — which enables
 * fast continuous multi-page scanning without duplicate shots.
 */
export class AutoCaptureController {
  private readonly holdMs: number;
  private readonly minConfidence: number;
  private readonly cooldownMs: number;
  private lastCapture = -Infinity;
  private awaitingChange = false;

  constructor(opts: AutoCaptureOptions = {}) {
    this.holdMs = opts.holdMs ?? 900;
    this.minConfidence = opts.minConfidence ?? 0.55;
    this.cooldownMs = opts.cooldownMs ?? 1500;
  }

  reset(): void {
    this.lastCapture = -Infinity;
    this.awaitingChange = false;
  }

  /** Call when a capture was taken (automatic or manual). */
  notifyCaptured(now: number): void {
    this.lastCapture = now;
    this.awaitingChange = true;
  }

  update(s: StabilizedState, q: FrameQuality | null, now: number, enabled: boolean): AutoCaptureState {
    if (now - this.lastCapture < this.cooldownMs) return { status: 'cooldown', progress: 0, fire: false };
    if (this.awaitingChange) {
      // Require the document to leave the frame or move significantly before re-arming.
      if (!s.quad || s.motion > 0.08) this.awaitingChange = false;
      else return { status: 'cooldown', progress: 0, fire: false };
    }
    if (!s.quad || s.confidence < this.minConfidence * 0.6) return { status: 'searching', progress: 0, fire: false };
    if (s.partial) return { status: 'partial', progress: 0, fire: false };
    if (q?.tooDark) return { status: 'too-dark', progress: 0, fire: false };
    if (!enabled) return { status: 'detected', progress: 0, fire: false };
    if (s.confidence < this.minConfidence || !s.stable) return { status: 'hold-still', progress: 0, fire: false };
    if (q?.blurry) return { status: 'blurry', progress: 0, fire: false };
    const progress = Math.min(1, s.stableForMs / this.holdMs);
    if (progress >= 1) return { status: 'capturing', progress: 1, fire: true };
    return { status: 'hold-still', progress, fire: false };
  }
}
