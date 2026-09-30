import { useEffect, useRef, useState } from 'preact/hooks';
import { errorMessage, library, toast } from '../../app/state';
import { cleanSignatureImage, deleteSignature, listSignatures, saveSignature } from '../../services/signatures';
import type { SavedSignature } from '../../services/signatures';
import { Icon } from './Icon';
import { BlobImage, Button, IconButton, Segmented, Sheet } from './ui';

interface Stroke {
  points: Array<{ x: number; y: number; p: number }>;
}

/** Signature creation (finger / mouse / stylus, with pressure) or import, and saved signatures. */
export function SignatureSheet({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (s: SavedSignature) => void }) {
  const [tab, setTab] = useState<'saved' | 'draw' | 'import'>('saved');
  const [saved, setSaved] = useState<SavedSignature[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Stroke[]>([]);
  const current = useRef<Stroke | null>(null);
  const [color, setColor] = useState('#15233b');
  const [, redraw] = useState(0);

  const reload = async () => {
    const list = await listSignatures(library());
    setSaved(list);
    if (!list.length) setTab('draw');
  };
  useEffect(() => {
    if (open) void reload();
  }, [open]);

  const paint = () => {
    const c = canvasRef.current;
    if (!c) return;
    const g = c.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, c.width, c.height);
    g.strokeStyle = color;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const s of [...strokes.current, ...(current.current ? [current.current] : [])]) {
      const pts = s.points;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1] as Stroke['points'][number];
        const b = pts[i] as Stroke['points'][number];
        g.lineWidth = 2.2 + 3.2 * ((a.p + b.p) / 2);
        g.beginPath();
        if (i >= 2) {
          const z = pts[i - 2] as Stroke['points'][number];
          g.moveTo((z.x + a.x) / 2, (z.y + a.y) / 2);
          g.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
        } else {
          g.moveTo(a.x, a.y);
          g.lineTo(b.x, b.y);
        }
        g.stroke();
      }
    }
  };

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || tab !== 'draw') return undefined;
    const dpr = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    c.width = Math.round(rect.width * dpr);
    c.height = Math.round(rect.height * dpr);
    c.getContext('2d')?.setTransform(1, 0, 0, 1, 0, 0);
    paint();
    const pos = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      return {
        x: ((e.clientX - r.left) / r.width) * c.width,
        y: ((e.clientY - r.top) / r.height) * c.height,
        p: e.pressure > 0 && e.pointerType === 'pen' ? e.pressure : 0.5,
      };
    };
    const down = (e: PointerEvent) => {
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      current.current = { points: [pos(e)] };
    };
    const move = (e: PointerEvent) => {
      if (!current.current) return;
      e.preventDefault();
      for (const ce of e.getCoalescedEvents?.() ?? [e]) current.current.points.push(pos(ce));
      paint();
    };
    const up = () => {
      if (current.current && current.current.points.length > 1) strokes.current.push(current.current);
      current.current = null;
      paint();
      redraw((v) => v + 1);
    };
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    return () => {
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
      c.removeEventListener('pointercancel', up);
    };
  }, [tab, open, color]);

  const saveDrawing = async () => {
    const c = canvasRef.current;
    if (!c || !strokes.current.length) return;
    // Crop to the drawn area.
    const pts = strokes.current.flatMap((s) => s.points);
    const pad = 10;
    const minX = Math.max(0, Math.min(...pts.map((p) => p.x)) - pad);
    const minY = Math.max(0, Math.min(...pts.map((p) => p.y)) - pad);
    const maxX = Math.min(c.width, Math.max(...pts.map((p) => p.x)) + pad);
    const maxY = Math.min(c.height, Math.max(...pts.map((p) => p.y)) + pad);
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(maxX - minX));
    out.height = Math.max(1, Math.round(maxY - minY));
    out.getContext('2d')?.drawImage(c, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
    const blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/png'));
    if (!blob) return;
    const sig = await saveSignature(library(), blob, out.width, out.height);
    strokes.current = [];
    toast('Signature enregistrée sur cet appareil', 'success');
    onPick(sig);
  };

  const importImage = async (file: File | undefined) => {
    if (!file) return;
    try {
      const r = await cleanSignatureImage(file);
      const sig = await saveSignature(library(), r.blob, r.width, r.height);
      toast('Signature importée (fond rendu transparent)', 'success');
      onPick(sig);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Signature" wide>
      <Segmented
        label="Source de la signature"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'saved', label: `Enregistrées (${saved.length})` },
          { value: 'draw', label: 'Dessiner' },
          { value: 'import', label: 'Importer' },
        ]}
      />
      {tab === 'saved' ? (
        saved.length ? (
          <div class="sig-grid">
            {saved.map((s) => (
              <div class="sig-item" key={s.id}>
                <button type="button" class="sig-pick" onClick={() => onPick(s)} aria-label="Insérer cette signature">
                  <BlobImage id={s.blobId} alt="Signature enregistrée" />
                </button>
                <IconButton
                  icon="trash"
                  label="Supprimer cette signature"
                  onClick={async () => {
                    await deleteSignature(library(), s.id);
                    await reload();
                  }}
                />
              </div>
            ))}
          </div>
        ) : (
          <p class="muted">Aucune signature enregistrée.</p>
        )
      ) : tab === 'draw' ? (
        <>
          <div class="sig-pad-wrap">
            <canvas ref={canvasRef} class="sig-pad" aria-label="Zone de signature : dessinez avec le doigt, la souris ou un stylet" />
            <span class="sig-line" aria-hidden="true" />
          </div>
          <div class="row">
            {['#15233b', '#1d4ed8', '#000000'].map((c) => (
              <button
                type="button"
                key={c}
                class={`color-dot ${c === color ? 'is-active' : ''}`}
                style={{ background: c }}
                aria-label={`Couleur ${c === '#1d4ed8' ? 'bleue' : c === '#000000' ? 'noire' : 'bleu nuit'}`}
                onClick={() => setColor(c)}
              />
            ))}
            <span class="spacer" />
            <Button
              variant="ghost"
              icon="undo"
              onClick={() => {
                strokes.current.pop();
                paint();
                redraw((v) => v + 1);
              }}
            >
              Annuler
            </Button>
            <Button
              variant="ghost"
              icon="eraser"
              onClick={() => {
                strokes.current = [];
                paint();
                redraw((v) => v + 1);
              }}
            >
              Effacer
            </Button>
            <Button variant="primary" icon="check" disabled={!strokes.current.length} onClick={() => void saveDrawing()}>
              Utiliser
            </Button>
          </div>
        </>
      ) : (
        <div class="empty-state">
          <Icon name="image" size={36} />
          <p>Photographiez ou choisissez une image de votre signature sur fond blanc : le fond sera rendu transparent.</p>
          <label class="btn btn-primary btn-lg">
            <Icon name="upload" />
            <span>Choisir une image</span>
            <input
              type="file"
              accept="image/*"
              class="visually-hidden"
              onChange={(e) => void importImage((e.target as HTMLInputElement).files?.[0])}
            />
          </label>
        </div>
      )}
    </Sheet>
  );
}
