/** Camera access: stream management, torch/zoom, full-resolution capture and analysis frames. */

interface ImageCaptureLike {
  takePhoto(settings?: { imageWidth?: number; imageHeight?: number }): Promise<Blob>;
  getPhotoCapabilities?(): Promise<{ imageWidth?: { max: number }; imageHeight?: { max: number } }>;
}
declare const ImageCapture: { new (track: MediaStreamTrack): ImageCaptureLike } | undefined;

export class CameraError extends Error {
  constructor(
    message: string,
    readonly code: 'denied' | 'not-found' | 'busy' | 'insecure' | 'unsupported' | 'unknown',
  ) {
    super(message);
  }
}

function mapError(e: unknown): CameraError {
  const name = e instanceof DOMException || e instanceof Error ? e.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CameraError('Accès à la caméra refusé. Autorisez la caméra dans les réglages du navigateur (icône à gauche de l’adresse), puis réessayez.', 'denied');
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new CameraError('Aucune caméra compatible n’a été trouvée sur cet appareil.', 'not-found');
    case 'NotReadableError':
    case 'AbortError':
      return new CameraError('La caméra est déjà utilisée par une autre application.', 'busy');
    default:
      return new CameraError(`Impossible de démarrer la caméra (${e instanceof Error ? e.message : String(e)}).`, 'unknown');
  }
}

export interface CameraCapabilities {
  torch: boolean;
  zoom: { min: number; max: number; step: number } | null;
}

export class Camera {
  private stream: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;
  private video: HTMLVideoElement | null = null;
  private torchOn = false;

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  static async listCameras(): Promise<MediaDeviceInfo[]> {
    try {
      return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    } catch {
      return [];
    }
  }

  async start(video: HTMLVideoElement, deviceId?: string): Promise<void> {
    if (!window.isSecureContext) throw new CameraError('La caméra nécessite une connexion sécurisée (HTTPS) ou localhost.', 'insecure');
    if (!Camera.isSupported()) throw new CameraError('Ce navigateur ne permet pas d’accéder à la caméra. Utilisez l’import de photos.', 'unsupported');
    this.stop();
    const base: MediaTrackConstraints = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } };
    // From the most to the least demanding; phones negotiate the best resolution they support.
    const attempts: MediaTrackConstraints[] = [
      { ...base, width: { ideal: 3840 }, height: { ideal: 2160 } },
      { ...base, width: { ideal: 1920 }, height: { ideal: 1080 } },
      base,
    ];
    let lastErr: unknown = null;
    for (const video of attempts) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        break;
      } catch (e) {
        lastErr = e;
        const name = e instanceof Error ? e.name : '';
        if (name === 'NotAllowedError' || name === 'SecurityError') break;
      }
    }
    if (!this.stream) throw mapError(lastErr);
    this.track = this.stream.getVideoTracks()[0] ?? null;
    this.video = video;
    video.srcObject = this.stream;
    video.muted = true;
    video.setAttribute('playsinline', 'true');
    await video.play().catch(() => undefined);
    if (!video.videoWidth) {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        video.addEventListener('loadedmetadata', done, { once: true });
        setTimeout(done, 3000);
      });
    }
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
    this.torchOn = false;
    if (this.video) this.video.srcObject = null;
  }

  get active(): boolean {
    return !!this.track && this.track.readyState === 'live';
  }

  get deviceId(): string | undefined {
    return this.track?.getSettings().deviceId;
  }

  capabilities(): CameraCapabilities {
    const caps = (this.track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean; zoom?: { min: number; max: number; step: number } };
    return { torch: !!caps.torch, zoom: caps.zoom && caps.zoom.max > caps.zoom.min ? caps.zoom : null };
  }

  async setTorch(on: boolean): Promise<boolean> {
    if (!this.track) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      this.torchOn = on;
      return true;
    } catch {
      return false;
    }
  }

  get torch(): boolean {
    return this.torchOn;
  }

  async setZoom(z: number): Promise<void> {
    await this.track?.applyConstraints({ advanced: [{ zoom: z } as MediaTrackConstraintSet] }).catch(() => undefined);
  }

  /** Draws the current frame into `canvas`, downscaled so that its long side is `maxSide`. */
  grabFrame(canvas: HTMLCanvasElement | OffscreenCanvas, maxSide: number): ImageData | null {
    const v = this.video;
    if (!v || !v.videoWidth || v.readyState < 2) return null;
    const s = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.round(v.videoWidth * s);
    const h = Math.round(v.videoHeight * s);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const g = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!g) return null;
    g.drawImage(v, 0, 0, w, h);
    return g.getImageData(0, 0, w, h);
  }

  get videoSize(): { width: number; height: number } {
    return { width: this.video?.videoWidth ?? 0, height: this.video?.videoHeight ?? 0 };
  }

  /** Full-resolution video frame (always geometrically consistent with the analysis frames). */
  async captureVideoFrame(): Promise<{ blob: Blob; width: number; height: number }> {
    const v = this.video;
    if (!v || !v.videoWidth) throw new CameraError('La caméra n’est pas prête.', 'unknown');
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const g = c.getContext('2d');
    if (!g) throw new CameraError('Canvas indisponible', 'unsupported');
    g.drawImage(v, 0, 0);
    const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Capture impossible'))), 'image/jpeg', 0.95));
    return { blob, width: c.width, height: c.height };
  }

  /**
   * High-resolution still photo through ImageCapture when available (Chrome/Android), which uses
   * the full sensor resolution. Returns null when unsupported.
   */
  async takePhoto(): Promise<{ blob: Blob; width: number; height: number } | null> {
    if (!this.track || typeof ImageCapture === 'undefined') return null;
    try {
      const ic = new ImageCapture(this.track);
      const blob = await ic.takePhoto();
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      const r = { blob, width: bmp.width, height: bmp.height };
      bmp.close();
      return r;
    } catch {
      return null;
    }
  }
}
