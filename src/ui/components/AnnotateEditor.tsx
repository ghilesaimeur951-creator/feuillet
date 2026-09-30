import { useEffect, useRef, useState } from 'preact/hooks';
import type { Annotation, Page } from '../../core/docs/model';
import { newId } from '../../core/docs/model';
import { UndoStack } from '../../core/docs/pages';
import { library, promptDialog, toast } from '../../app/state';
import type { SavedSignature } from '../../services/signatures';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { SignatureSheet } from './SignatureSheet';
import { Button, IconButton, useBlobUrl } from './ui';

type Tool = 'select' | 'pen' | 'highlight' | 'text' | 'rect' | 'ellipse' | 'arrow';
const TOOLS: Array<{ id: Tool; icon: IconName; label: string }> = [
  { id: 'select', icon: 'drag', label: 'Sélectionner / déplacer' },
  { id: 'pen', icon: 'pen', label: 'Dessin libre' },
  { id: 'highlight', icon: 'highlighter', label: 'Surligner' },
  { id: 'text', icon: 'text', label: 'Texte' },
  { id: 'rect', icon: 'square', label: 'Rectangle' },
  { id: 'ellipse', icon: 'circle', label: 'Ellipse' },
  { id: 'arrow', icon: 'arrow', label: 'Flèche' },
];
const COLORS = ['#d7263d', '#1d4ed8', '#111111', '#15803d', '#f5c400'];
const WIDTHS = [0.003, 0.006, 0.012];

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function bbox(a: Annotation, aspect: number): Box {
  switch (a.type) {
    case 'ink': {
      const xs = a.points.map((p) => p.x);
      const ys = a.points.map((p) => p.y);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    case 'arrow':
      return { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
    case 'text': {
      const lines = a.text.split('\n');
      const w = Math.max(...lines.map((l) => l.length)) * a.size * 0.56;
      return { x: a.x, y: a.y, w, h: lines.length * a.size * 1.25 * aspect };
    }
    default:
      return { x: Math.min(a.x, a.x + a.w), y: Math.min(a.y, a.y + a.h), w: Math.abs(a.w), h: Math.abs(a.h) };
  }
}

function translate(a: Annotation, dx: number, dy: number): Annotation {
  switch (a.type) {
    case 'ink':
      return { ...a, points: a.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    case 'arrow':
      return { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy };
    default:
      return { ...a, x: a.x + dx, y: a.y + dy };
  }
}

function AnnotationImage({ a, W, H }: { a: Extract<Annotation, { type: 'image' }>; W: number; H: number }) {
  const url = useBlobUrl(a.blobId);
  return url ? <image href={url} x={a.x * W} y={a.y * H} width={a.w * W} height={a.h * H} preserveAspectRatio="none" /> : null;
}

/** Vector annotations, highlights, shapes, text, images and signatures over a page. */
export function AnnotateEditor({ page, onSave }: { page: Page; onSave: (a: Annotation[]) => Promise<void> }) {
  const W = page.width;
  const H = page.height;
  const aspect = W / H;
  const src = useBlobUrl(page.processedBlobId);
  const svgRef = useRef<SVGSVGElement>(null);
  const history = useRef(new UndoStack<Annotation[]>(page.annotations));
  const [items, setItems] = useState<Annotation[]>(page.annotations);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState(COLORS[0] as string);
  const [width, setWidth] = useState(WIDTHS[1] as number);
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [sigOpen, setSigOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const drag = useRef<{ mode: 'move' | 'resize' | 'draw'; start: { x: number; y: number }; orig?: Annotation } | null>(null);

  const commit = (next: Annotation[]) => {
    history.current.push(next);
    setItems(next);
  };

  const norm = (e: PointerEvent): { x: number; y: number } => {
    const ctm = svgRef.current?.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: Math.min(1, Math.max(0, p.x / W)), y: Math.min(1, Math.max(0, p.y / H)) };
  };

  const hit = (p: { x: number; y: number }): Annotation | undefined => {
    for (let i = items.length - 1; i >= 0; i--) {
      const a = items[i] as Annotation;
      const b = bbox(a, aspect);
      const m = 0.015;
      if (p.x >= b.x - m && p.x <= b.x + b.w + m && p.y >= b.y - m && p.y <= b.y + b.h + m) return a;
    }
    return undefined;
  };

  const onDown = async (e: PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const p = norm(e);
    if (tool === 'select') {
      const selected = sel ? items.find((a) => a.id === sel) : undefined;
      if (selected && selected.type !== 'ink' && selected.type !== 'arrow' && selected.type !== 'text') {
        const b = bbox(selected, aspect);
        if (Math.hypot((p.x - (b.x + b.w)) * aspect, p.y - (b.y + b.h)) < 0.03) {
          drag.current = { mode: 'resize', start: p, orig: selected };
          return;
        }
      }
      const h = hit(p);
      setSel(h?.id ?? null);
      if (h) drag.current = { mode: 'move', start: p, orig: h };
      return;
    }
    if (tool === 'text') {
      const text = await promptDialog('Ajouter un texte', { placeholder: 'Votre texte', confirmLabel: 'Ajouter' });
      if (text?.trim()) {
        const a: Annotation = { id: newId('a'), type: 'text', color, size: 0.03, x: p.x, y: p.y, text: text.trim() };
        commit([...items, a]);
        setSel(a.id);
      }
      return;
    }
    const id = newId('a');
    let a: Annotation;
    if (tool === 'pen') a = { id, type: 'ink', color, width, opacity: 1, points: [p] };
    else if (tool === 'highlight') a = { id, type: 'highlight', color: color === '#111111' ? '#f5c400' : color, x: p.x, y: p.y, w: 0, h: 0 };
    else if (tool === 'arrow') a = { id, type: 'arrow', color, width, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    else a = { id, type: tool, color, width, x: p.x, y: p.y, w: 0, h: 0 };
    setDraft(a);
    drag.current = { mode: 'draw', start: p };
  };

  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = norm(e);
    if (d.mode === 'draw' && draft) {
      if (draft.type === 'ink') setDraft({ ...draft, points: [...draft.points, p] });
      else if (draft.type === 'arrow') setDraft({ ...draft, x2: p.x, y2: p.y });
      else if (draft.type !== 'text' && draft.type !== 'image') setDraft({ ...draft, w: p.x - d.start.x, h: p.y - d.start.y });
    } else if (d.orig) {
      const dx = p.x - d.start.x;
      const dy = p.y - d.start.y;
      let next: Annotation;
      if (d.mode === 'move') next = translate(d.orig, dx, dy);
      else {
        const o = d.orig as Extract<Annotation, { w: number }>;
        let w = Math.max(0.02, o.w + dx);
        let h = Math.max(0.02, o.h + dy);
        if (o.type === 'image') h = (w * o.h) / o.w;
        if (o.type === 'image' && h < 0.02) {
          h = 0.02;
          w = (h * o.w) / o.h;
        }
        next = { ...o, w, h } as Annotation;
      }
      setItems(items.map((a) => (a.id === next.id ? next : a)));
    }
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.mode === 'draw' && draft) {
      const b = bbox(draft, aspect);
      const tiny = draft.type === 'ink' ? draft.points.length < 2 : b.w < 0.005 && b.h < 0.005;
      if (!tiny) {
        const fixed = draft.type === 'highlight' || draft.type === 'rect' || draft.type === 'ellipse' ? { ...draft, ...b } : draft;
        commit([...items, fixed]);
      }
      setDraft(null);
    } else if (d.orig) {
      history.current.push(items);
    }
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        commit(items.filter((a) => a.id !== sel));
        setSel(null);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const insertSignature = async (s: SavedSignature) => {
    setSigOpen(false);
    const lib = library();
    const blob = await lib.getBlob(s.blobId);
    if (!blob) return toast('Signature introuvable', 'error');
    // Each page gets its own copy (deleting a document never deletes a saved signature).
    const blobId = await lib.putBlob(blob);
    const w = 0.34;
    const h = (w * aspect * s.height) / s.width;
    const a: Annotation = { id: newId('a'), type: 'image', blobId, x: 0.58, y: Math.min(0.9 - h, 0.78), w, h, signature: true };
    commit([...items, a]);
    setSel(a.id);
    setTool('select');
    toast('Signature ajoutée : déplacez-la et redimensionnez-la (poignée en bas à droite)', 'info');
  };

  const insertImage = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const bmp = await createImageBitmap(f);
      const ratio = bmp.height / bmp.width;
      bmp.close();
      const blobId = await library().putBlob(f);
      const w = 0.4;
      const a: Annotation = { id: newId('a'), type: 'image', blobId, x: 0.3, y: 0.3, w, h: w * aspect * ratio };
      commit([...items, a]);
      setSel(a.id);
      setTool('select');
    };
    input.click();
  };

  const render = (a: Annotation, isDraft = false) => {
    const key = isDraft ? 'draft' : a.id;
    switch (a.type) {
      case 'ink':
        return <polyline key={key} points={a.points.map((p) => `${p.x * W},${p.y * H}`).join(' ')} fill="none" stroke={a.color} stroke-width={a.width * W} stroke-linecap="round" stroke-linejoin="round" opacity={a.opacity} />;
      case 'highlight': {
        const b = bbox(a, aspect);
        return <rect key={key} x={b.x * W} y={b.y * H} width={b.w * W} height={b.h * H} fill={a.color} opacity={0.38} style={{ mixBlendMode: 'multiply' }} />;
      }
      case 'rect':
      case 'ellipse': {
        const b = bbox(a, aspect);
        return a.type === 'rect' ? (
          <rect key={key} x={b.x * W} y={b.y * H} width={b.w * W} height={b.h * H} fill="none" stroke={a.color} stroke-width={a.width * W} />
        ) : (
          <ellipse key={key} cx={(b.x + b.w / 2) * W} cy={(b.y + b.h / 2) * H} rx={(b.w * W) / 2} ry={(b.h * H) / 2} fill="none" stroke={a.color} stroke-width={a.width * W} />
        );
      }
      case 'arrow': {
        const x1 = a.x1 * W;
        const y1 = a.y1 * H;
        const x2 = a.x2 * W;
        const y2 = a.y2 * H;
        const lw = a.width * W;
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const head = lw * 4;
        const pts = `${x2},${y2} ${x2 - head * Math.cos(ang - 0.45)},${y2 - head * Math.sin(ang - 0.45)} ${x2 - head * Math.cos(ang + 0.45)},${y2 - head * Math.sin(ang + 0.45)}`;
        return (
          <g key={key}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={a.color} stroke-width={lw} stroke-linecap="round" />
            <polygon points={pts} fill={a.color} />
          </g>
        );
      }
      case 'text':
        return (
          <text key={key} x={a.x * W} y={a.y * H} fill={a.color} font-size={a.size * W} dominant-baseline="hanging" font-family="system-ui, sans-serif">
            {a.text.split('\n').map((l, i) => (
              <tspan key={i} x={a.x * W} dy={i ? a.size * W * 1.25 : 0}>
                {l}
              </tspan>
            ))}
          </text>
        );
      case 'image':
        return <AnnotationImage key={key} a={a} W={W} H={H} />;
    }
  };

  const selected = sel ? items.find((a) => a.id === sel) : undefined;
  const sb = selected ? bbox(selected, aspect) : null;
  const handleR = Math.max(W, H) * 0.018;

  return (
    <div class="editor-split">
      <div class="editor-stage">
        <div class="annot-box" style={{ aspectRatio: `${W} / ${H}`, width: `min(100%, calc((100dvh - var(--crop-chrome, 240px)) * ${aspect.toFixed(4)}))` }}>
          {src ? <img src={src} alt="Page à annoter" draggable={false} /> : null}
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            class={`annot-svg tool-${tool}`}
            onPointerDown={(e) => void onDown(e)}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            role="application"
            aria-label="Zone d’annotation"
          >
            {items.map((a) => render(a))}
            {draft ? render(draft, true) : null}
            {sb ? (
              <g class="annot-selection">
                <rect x={sb.x * W - 4} y={sb.y * H - 4} width={sb.w * W + 8} height={sb.h * H + 8} fill="none" stroke-width={Math.max(2, W * 0.002)} stroke-dasharray={`${W * 0.01} ${W * 0.006}`} />
                {selected && selected.type !== 'ink' && selected.type !== 'arrow' && selected.type !== 'text' ? <circle cx={(sb.x + sb.w) * W} cy={(sb.y + sb.h) * H} r={handleR} /> : null}
              </g>
            ) : null}
          </svg>
        </div>
      </div>
      <div class="editor-panel">
        <div class="tool-row" role="toolbar" aria-label="Outils d’annotation">
          {TOOLS.map((t) => (
            <IconButton key={t.id} icon={t.icon} label={t.label} active={tool === t.id} onClick={() => setTool(t.id)} />
          ))}
        </div>
        <div class="row" role="group" aria-label="Couleur">
          {COLORS.map((c) => (
            <button type="button" key={c} class={`color-dot ${c === color ? 'is-active' : ''}`} style={{ background: c }} aria-label={`Couleur ${c}`} aria-pressed={c === color} onClick={() => setColor(c)} />
          ))}
          <span class="spacer" />
          {WIDTHS.map((w, i) => (
            <button type="button" key={w} class={`width-dot ${w === width ? 'is-active' : ''}`} aria-label={['Trait fin', 'Trait moyen', 'Trait épais'][i]} aria-pressed={w === width} onClick={() => setWidth(w)}>
              <span style={{ width: `${6 + i * 5}px`, height: `${6 + i * 5}px` }} />
            </button>
          ))}
        </div>
        <div class="row">
          <Button icon="signature" onClick={() => setSigOpen(true)}>
            Signature
          </Button>
          <Button icon="image" onClick={insertImage}>
            Image
          </Button>
          <IconButton icon="undo" label="Annuler" disabled={!history.current.canUndo} onClick={() => setItems(history.current.undo())} />
          <IconButton icon="redo" label="Rétablir" disabled={!history.current.canRedo} onClick={() => setItems(history.current.redo())} />
          <IconButton
            icon="trash"
            label="Supprimer l’élément sélectionné"
            disabled={!sel}
            onClick={() => {
              commit(items.filter((a) => a.id !== sel));
              setSel(null);
            }}
          />
        </div>
        <p class="muted small">
          <Icon name="info" size={14} /> Les annotations restent modifiables ; elles sont intégrées aux exports (PDF, images).
        </p>
        <Button
          variant="primary"
          icon="check"
          size="lg"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave(items);
            } finally {
              setSaving(false);
            }
          }}
        >
          Enregistrer
        </Button>
      </div>
      <SignatureSheet open={sigOpen} onClose={() => setSigOpen(false)} onPick={(s) => void insertSignature(s)} />
    </div>
  );
}
