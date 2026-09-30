import type { Point, Quad } from '../geometry/geometry';
import { maxCornerDistance } from '../geometry/geometry';

export interface StabilizerOptions {
  /** Frame diagonal in the coordinate space of the quads (used to normalise distances). */
  diagonal: number;
  /** Smoothing factor when the document barely moves (0..1, lower = smoother). */
  slowAlpha?: number;
  /** Smoothing factor when the document moves quickly. */
  fastAlpha?: number;
  /** Time without detection after which the overlay is dropped (ms). */
  lostAfterMs?: number;
  /** A new quad farther than this (fraction of diagonal) from the current one must be confirmed by the next frame. */
  jumpThreshold?: number;
  /** Window used to evaluate stability (ms). */
  stabilityWindowMs?: number;
  /** Max corner motion within the window, as a fraction of diagonal, to be considered stable. */
  stableTolerance?: number;
}

export interface StabilizedState {
  /** Smoothed quad to display, or null when nothing is tracked. */
  quad: Quad | null;
  /** 0..1 — how confident we are that a document is present. */
  confidence: number;
  /** True when the document has been nearly motionless for the whole stability window. */
  stable: boolean;
  /** How long (ms) the document has been continuously stable. */
  stableForMs: number;
  /** Normalised motion of the last update (fraction of the diagonal). */
  motion: number;
  partial: boolean;
}

interface Sample {
  t: number;
  quad: Quad;
}

/**
 * Temporal filter for detected corners: rejects single-frame outliers, smooths jitter with an
 * adaptive exponential filter and measures stability for auto-capture.
 */
export class QuadStabilizer {
  private readonly o: Required<StabilizerOptions>;
  private current: Quad | null = null;
  private pending: Quad | null = null;
  private lastSeen = -Infinity;
  private confidence = 0;
  private history: Sample[] = [];
  private stableSince: number | null = null;
  private partial = false;
  private lastMotion = 0;

  constructor(options: StabilizerOptions) {
    this.o = {
      slowAlpha: 0.35,
      fastAlpha: 0.75,
      lostAfterMs: 450,
      jumpThreshold: 0.12,
      stabilityWindowMs: 500,
      stableTolerance: 0.018,
      ...options,
    };
  }

  reset(): void {
    this.current = null;
    this.pending = null;
    this.lastSeen = -Infinity;
    this.confidence = 0;
    this.history = [];
    this.stableSince = null;
    this.partial = false;
    this.lastMotion = 0;
  }

  update(quad: Quad | null, score: number, now: number, partial = false): StabilizedState {
    const diag = this.o.diagonal;
    if (quad) {
      this.lastSeen = now;
      this.partial = partial;
      this.confidence = this.confidence * 0.6 + Math.min(1, score + 0.2) * 0.4;
      if (!this.current) {
        this.current = quad;
        this.pending = null;
        this.lastMotion = 1;
      } else {
        const jump = maxCornerDistance(this.current, quad) / diag;
        if (jump > this.o.jumpThreshold) {
          // Large jump: accept only if confirmed by a consistent second frame.
          if (this.pending && maxCornerDistance(this.pending, quad) / diag < this.o.jumpThreshold / 2) {
            this.current = quad;
            this.pending = null;
            this.history = [];
            this.stableSince = null;
          } else {
            this.pending = quad;
          }
          this.lastMotion = jump;
        } else {
          this.pending = null;
          // Adaptive alpha: follow quickly when moving, smooth heavily when still.
          const k = Math.min(1, jump / 0.04);
          const alpha = this.o.slowAlpha + (this.o.fastAlpha - this.o.slowAlpha) * k;
          const cur: Quad = this.current;
          this.current = quad.map((p, i) => lerp(cur[i] as Point, p, alpha)) as unknown as Quad;
          this.lastMotion = jump;
        }
      }
      this.history.push({ t: now, quad });
    } else {
      this.confidence *= 0.7;
      if (now - this.lastSeen > this.o.lostAfterMs) {
        this.current = null;
        this.pending = null;
        this.history = [];
        this.stableSince = null;
      }
    }
    // Stability: all raw quads within the window must stay within tolerance of each other.
    const windowStart = now - this.o.stabilityWindowMs;
    this.history = this.history.filter((s) => s.t >= windowStart - 1);
    let stable = false;
    if (this.current && quad && this.history.length >= 3 && (this.history[0] as Sample).t <= windowStart + this.o.stabilityWindowMs * 0.4) {
      const ref = this.history[this.history.length - 1] as Sample;
      stable = this.history.every((s) => maxCornerDistance(s.quad, ref.quad) / diag < this.o.stableTolerance);
    }
    if (stable) {
      if (this.stableSince === null) this.stableSince = now;
    } else {
      this.stableSince = null;
    }
    return {
      quad: this.current,
      confidence: this.current ? this.confidence : 0,
      stable,
      stableForMs: this.stableSince === null ? 0 : now - this.stableSince,
      motion: this.lastMotion,
      partial: this.partial,
    };
  }
}

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
