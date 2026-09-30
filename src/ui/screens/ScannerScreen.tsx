import { useEffect, useRef, useState } from 'preact/hooks';
import { AutoCaptureController } from '../../core/cv/autocapture';
import type { AutoCaptureStatus } from '../../core/cv/autocapture';
import type { FrameQuality } from '../../core/cv/quality';
import { QuadStabilizer } from '../../core/cv/stabilizer';
import type { Quad } from '../../core/geometry/geometry';
import { scaleQuad } from '../../core/geometry/geometry';
import { goBack, navigate } from '../../app/router';
import { errorMessage, haptic, library, toast, useSettings } from '../../app/state';
import { Camera, CameraError } from '../../services/camera';
import { LiveDetector } from '../../services/live-detector';
import { processing } from '../../services/processing/client';
import { addCapture, getSession, SCAN_MODES, setMode, startSession, subscribeSession } from '../../services/scan-session';
import type { ScanMode, ScanSession } from '../../services/scan-session';
import { settings } from '../../services/settings';
import { Icon } from '../components/Icon';
import type { IconName } from '../components/Icon';
import { BlobImage, Button, IconButton } from '../components/ui';

const ANALYSIS_SIDE = 360;
const MIN_FRAME_INTERVAL = 66;

interface Status {
  text: string;
  icon: IconName;
  tone: 'idle' | 'ok' | 'warn' | 'busy';
}

function describe(status: AutoCaptureStatus, q: FrameQuality | null, multipage: boolean, progress: number): Status {
  switch (status) {
    case 'searching':
      return { text: 'Recherche du document…', icon: 'scan', tone: 'idle' };
    case 'partial':
      return { text: 'Document partiellement hors cadre — reculez un peu', icon: 'alert', tone: 'warn' };
    case 'too-dark':
      return { text: 'Trop sombre — ajoutez de la lumière ou activez la lampe', icon: 'alert', tone: 'warn' };
    case 'blurry':
      return { text: 'Image floue — stabilisez l’appareil', icon: 'alert', tone: 'warn' };
    case 'hold-still':
      return progress > 0 ? { text: 'Document détecté — ne bougez plus…', icon: 'check', tone: 'ok' } : { text: 'Document détecté — tenez stable', icon: 'check', tone: 'ok' };
    case 'capturing':
      return { text: 'Capture…', icon: 'check', tone: 'busy' };
    case 'cooldown':
      return { text: multipage ? 'Page capturée — présentez la suivante' : 'Page capturée', icon: 'check', tone: 'ok' };
    default:
      return q?.hasGlare ? { text: 'Document détecté — attention au reflet', icon: 'alert', tone: 'warn' } : { text: 'Document détecté', icon: 'check', tone: 'ok' };
  }
}

function playShutter() {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.value = 1400;
    g.gain.setValueAtTime(0.15, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.09);
    setTimeout(() => void ctx.close(), 300);
  } catch {
    /* ignore */
  }
}

/** Live camera scanner: real-time four-corner detection, stabilised overlay, auto-capture. */
export function ScannerScreen({ query }: { query: URLSearchParams }) {
  const s = useSettings();
  const videoRef = useRef<HTMLVideoElement>(null);
  const polyRef = useRef<SVGPolygonElement>(null);
  const handlesRef = useRef<SVGGElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const cameraRef = useRef<Camera | null>(null);
  const [phase, setPhase] = useState<'starting' | 'running' | 'error'>('starting');
  const [error, setError] = useState<CameraError | null>(null);
  const [status, setStatus] = useState<Status>({ text: 'Démarrage de la caméra…', icon: 'scan', tone: 'idle' });
  const [progress, setProgress] = useState(0);
  const [frameSize, setFrameSize] = useState({ w: 16, h: 9 });
  const [torch, setTorch] = useState(false);
  const [caps, setCaps] = useState({ torch: false, cameras: 0 });
  const [session, setSession] = useState<ScanSession | null>(getSession());
  const [flash, setFlash] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const autoRef = useRef(s.autoCapture);
  autoRef.current = s.autoCapture;
  const stateRef = useRef<{ quad: Quad | null; frame: { w: number; h: number }; controller: AutoCaptureController; busy: boolean }>({
    quad: null,
    frame: { w: 1, h: 1 },
    controller: new AutoCaptureController({ holdMs: 900 }),
    busy: false,
  });

  const docId = query.get('doc') ?? undefined;
  const replacePageId = query.get('replace') ?? undefined;
  const folderId = query.get('folder');
  const mode = (session?.mode ?? (query.get('mode') as ScanMode | null) ?? (docId && !replacePageId ? 'multipage' : 'document')) as ScanMode;
  const multipage = (mode === 'multipage' || mode === 'book') && !replacePageId;
  const multipageRef = useRef(multipage);
  multipageRef.current = multipage;
  const captureRef = useRef<(auto: boolean) => Promise<void>>(async () => undefined);

  useEffect(() => subscribeSession(() => setSession(getSession())), []);

  useEffect(() => {
    const lib = library();
    void startSession(lib, mode, { ...(docId ? { docId } : {}), ...(replacePageId ? { replacePageId } : {}), folderId: folderId ?? null }).then(setSession);
  }, [docId, replacePageId]);

  // Camera + detection loop.
  useEffect(() => {
    let alive = true;
    const cam = new Camera();
    cameraRef.current = cam;
    const detector = new LiveDetector();
    let stabilizer: QuadStabilizer | null = null;
    const canvas = document.createElement('canvas');
    let lastFrame = 0;
    let target: Quad | null = null;
    let shown: Quad | null = null;
    let raf = 0;
    let quality: FrameQuality | null = null;

    const render = () => {
      // Display interpolation at screen refresh rate for a fluid, jitter-free overlay.
      if (target) {
        shown = shown ? (shown.map((p, i) => ({ x: p.x + ((target as Quad)[i].x - p.x) * 0.45, y: p.y + ((target as Quad)[i].y - p.y) * 0.45 })) as unknown as Quad) : target;
      } else shown = null;
      const poly = polyRef.current;
      const hs = handlesRef.current;
      if (poly && hs) {
        if (shown) {
          poly.setAttribute('points', shown.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
          poly.style.opacity = '1';
          [...hs.children].forEach((c, i) => {
            c.setAttribute('cx', String((shown as Quad)[i]?.x ?? 0));
            c.setAttribute('cy', String((shown as Quad)[i]?.y ?? 0));
          });
          hs.style.opacity = '1';
        } else {
          poly.style.opacity = '0';
          hs.style.opacity = '0';
        }
      }
      raf = requestAnimationFrame(render);
    };

    const tick = async () => {
      if (!alive) return;
      const now = performance.now();
      if (document.hidden || stateRef.current.busy || now - lastFrame < MIN_FRAME_INTERVAL) {
        setTimeout(tick, 30);
        return;
      }
      lastFrame = now;
      const frame = cam.grabFrame(canvas, ANALYSIS_SIDE);
      if (!frame) {
        setTimeout(tick, 60);
        return;
      }
      if (!stabilizer || stateRef.current.frame.w !== frame.width) {
        stabilizer = new QuadStabilizer({ diagonal: Math.hypot(frame.width, frame.height) });
        stateRef.current.frame = { w: frame.width, h: frame.height };
        setFrameSize({ w: frame.width, h: frame.height });
      }
      try {
        const a = await detector.analyze(frame);
        if (!alive) return;
        quality = a.quality;
        const t = performance.now();
        const st = stabilizer.update(a.quad, a.score, t, a.partial);
        target = st.quad;
        stateRef.current.quad = st.quad;
        const ac = stateRef.current.controller.update(st, quality, t, autoRef.current && !stateRef.current.busy);
        setProgress(ac.progress);
        setStatus(describe(ac.status, quality, multipageRef.current, ac.progress));
        if (ac.fire) void captureRef.current(true);
      } catch {
        /* frame dropped */
      }
      setTimeout(tick, 0);
    };

    (async () => {
      try {
        await cam.start(videoRef.current as HTMLVideoElement);
        if (!alive) {
          cam.stop();
          return;
        }
        setCaps({ torch: cam.capabilities().torch, cameras: (await Camera.listCameras()).length });
        setPhase('running');
        raf = requestAnimationFrame(render);
        void tick();
      } catch (e) {
        setError(e instanceof CameraError ? e : new CameraError(errorMessage(e), 'unknown'));
        setPhase('error');
      }
    })();

    const onVis = () => {
      if (document.hidden) setTorch(false);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
      cam.stop();
      detector.dispose();
    };
  }, []);

  const capture = async (auto = false) => {
    const cam = cameraRef.current;
    const st = stateRef.current;
    if (!cam || st.busy) return;
    st.busy = true;
    setCapturing(true);
    haptic(auto ? [20, 40, 20] : 25);
    if (settings.get('shutterSound')) playShutter();
    setFlash(true);
    setTimeout(() => setFlash(false), 180);
    try {
      const lib = library();
      const quadA = st.quad;
      const frame = st.frame;
      const video = cam.videoSize;
      let shot: { blob: Blob; width: number; height: number } | null = null;
      let quad: Quad | null = null;
      if (settings.get('scanResolution') !== 'standard') {
        const photo = await cam.takePhoto();
        if (photo) {
          const sameAspect = Math.abs(photo.width / photo.height - video.width / video.height) < 0.03;
          if (sameAspect) {
            shot = photo;
            quad = quadA ? scaleQuad(quadA, photo.width / frame.w, photo.height / frame.h) : null;
          } else {
            // Different field of view: detect again on the high-resolution photo.
            const det = await processing.detect(photo.blob);
            if (det.quad || !quadA) {
              shot = photo;
              quad = det.quad;
            }
          }
        }
      }
      if (!shot) {
        shot = await cam.captureVideoFrame();
        quad = quadA ? scaleQuad(quadA, shot.width / frame.w, shot.height / frame.h) : null;
      }
      // Refine the corners on a higher-resolution version of the capture when it agrees with
      // the live detection (the live analysis runs on a ~360 px frame).
      if (quad) {
        const refined = await processing.detect(shot.blob).catch(() => null);
        if (refined?.quad) {
          const diag = Math.hypot(shot.width, shot.height);
          const close = refined.quad.every((p, k) => Math.hypot(p.x - (quad as Quad)[k].x, p.y - (quad as Quad)[k].y) < diag * 0.03);
          if (close) quad = refined.quad;
        }
      }
      const m = getSession()?.mode ?? mode;
      await addCapture(lib, shot.blob, shot.width, shot.height, m === 'photo' ? null : quad);
      st.controller.notifyCaptured(performance.now());
      if (!multipage) navigate('/review', { replace: true });
    } catch (e) {
      toast(`Capture impossible : ${errorMessage(e)}`, 'error');
    } finally {
      st.busy = false;
      setCapturing(false);
    }
  };

  captureRef.current = capture;

  const importIntoSession = async (files: FileList | null) => {
    if (!files?.length) return;
    const lib = library();
    for (const f of [...files]) {
      if (!f.type.startsWith('image/')) continue;
      try {
        const det = await processing.detect(f);
        await addCapture(lib, f, det.width, det.height, det.quad);
      } catch (e) {
        toast(`${f.name} : ${errorMessage(e)}`, 'error');
      }
    }
    navigate('/review', { replace: true });
  };

  const count = session?.captures.length ?? 0;
  const last = session?.captures[count - 1];
  const r = Math.max(frameSize.w, frameSize.h) / 70;

  return (
    <div class="scanner">
      <video ref={videoRef} class="scanner-video" playsInline muted autoPlay aria-hidden="true" />
      <svg ref={svgRef} class="scanner-overlay" viewBox={`0 0 ${frameSize.w} ${frameSize.h}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <polygon ref={polyRef} class="live-quad" points="" style={{ strokeWidth: `${r / 2.2}px`, opacity: 0 }} />
        <g ref={handlesRef} class="live-handles" style={{ opacity: 0 }}>
          {[0, 1, 2, 3].map((i) => (
            <circle key={i} r={r} style={{ strokeWidth: `${r / 2.5}px` }} />
          ))}
        </g>
      </svg>
      {flash ? <div class="shutter-flash" aria-hidden="true" /> : null}

      <header class="scanner-top">
        <IconButton icon="close" label="Fermer le scanner" onClick={() => goBack('/')} />
        <div class={`scan-status tone-${status.tone}`} role="status" aria-live="polite" data-testid="scan-status">
          <Icon name={status.icon} size={18} />
          <span>{status.text}</span>
        </div>
        <div class="row">
          {caps.torch ? (
            <IconButton
              icon={torch ? 'flash' : 'flashOff'}
              label={torch ? 'Éteindre la lampe' : 'Allumer la lampe'}
              active={torch}
              onClick={async () => {
                const ok = await cameraRef.current?.setTorch(!torch);
                if (ok) setTorch(!torch);
              }}
            />
          ) : null}
          <IconButton icon="auto" label={s.autoCapture ? 'Capture automatique activée' : 'Capture automatique désactivée'} active={s.autoCapture} onClick={() => settings.set('autoCapture', !s.autoCapture)} />
        </div>
      </header>

      {phase === 'error' && error ? (
        <div class="scanner-error" role="alert">
          <Icon name="alert" size={40} />
          <h2>Caméra indisponible</h2>
          <p>{error.message}</p>
          <div class="row" style={{ justifyContent: 'center' }}>
            <label class="btn btn-primary btn-lg">
              <Icon name="image" />
              <span>Choisir des photos</span>
              <input type="file" accept="image/*" multiple class="visually-hidden" onChange={(e) => void importIntoSession((e.target as HTMLInputElement).files)} />
            </label>
            <Button size="lg" onClick={() => location.reload()}>
              Réessayer
            </Button>
          </div>
        </div>
      ) : null}

      <footer class="scanner-bottom">
        {!replacePageId ? (
          <div class="mode-strip" role="radiogroup" aria-label="Mode de numérisation">
            {SCAN_MODES.map((m) => (
              <button
                type="button"
                key={m.id}
                role="radio"
                aria-checked={m.id === mode}
                class={`mode-btn ${m.id === mode ? 'is-active' : ''}`}
                title={m.hint}
                onClick={() => void setMode(library(), m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
        ) : null}
        <div class="shutter-row">
          <button type="button" class="session-thumb" disabled={!count} onClick={() => navigate('/review')} aria-label={count ? `Vérifier les ${count} page(s) capturée(s)` : 'Aucune page capturée'}>
            {last ? <BlobImage id={last.blobId} alt="" /> : <Icon name="pages" />}
            {count ? <span class="badge">{count}</span> : null}
          </button>
          <button type="button" class={`shutter ${capturing ? 'is-busy' : ''}`} onClick={() => void capture(false)} disabled={phase !== 'running'} aria-label="Prendre la photo" data-testid="shutter">
            <svg viewBox="0 0 80 80" class="shutter-ring" aria-hidden="true">
              <circle cx="40" cy="40" r="36" class="ring-bg" />
              <circle cx="40" cy="40" r="36" class="ring-fg" style={{ strokeDashoffset: `${226 * (1 - progress)}` }} />
            </svg>
            <span class="shutter-core" />
          </button>
          {multipage && count ? (
            <button type="button" class="done-btn" onClick={() => navigate('/review')}>
              Terminer
            </button>
          ) : (
            <label class="gallery-btn" aria-label="Importer depuis la galerie" title="Importer depuis la galerie">
              <Icon name="image" />
              <input type="file" accept="image/*" multiple class="visually-hidden" onChange={(e) => void importIntoSession((e.target as HTMLInputElement).files)} />
            </label>
          )}
        </div>
      </footer>
    </div>
  );
}
