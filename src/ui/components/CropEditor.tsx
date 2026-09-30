import { useEffect, useRef, useState } from 'preact/hooks';
import type { Point, Quad } from '../../core/geometry/geometry';
import { fullFrameQuad, isConvex, orderQuad } from '../../core/geometry/geometry';

const CORNER_NAMES = ['Coin supérieur gauche (P1)', 'Coin supérieur droit (P2)', 'Coin inférieur droit (P3)', 'Coin inférieur gauche (P4)'];

export interface CropEditorProps {
  src: string;
  width: number;
  height: number;
  quad: Quad | null;
  onChange: (q: Quad) => void;
}

/**
 * Manual crop: four independent corner handles (+ edge handles), live polygon, darkened outside,
 * magnifier while dragging, keyboard support (arrow keys; Shift = larger steps).
 */
export function CropEditor({ src, width, height, quad, onChange }: CropEditorProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      el.style.setProperty('--img-w', `${el.clientWidth}px`);
      el.style.setProperty('--img-h', `${el.clientHeight}px`);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [drag, setDrag] = useState<{ kind: 'corner' | 'edge'; index: number; point: Point } | null>(null);
  const q: Quad = quad ?? fullFrameQuad(width, height);
  const valid = isConvex(q);
  const r = Math.max(width, height) / 55;

  const toImage = (clientX: number, clientY: number): Point | null => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const pt = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: Math.min(width, Math.max(0, pt.x)), y: Math.min(height, Math.max(0, pt.y)) };
  };

  const setCorner = (i: number, p: Point) => {
    const next = q.map((c, k) => (k === i ? p : c)) as unknown as Quad;
    onChange(next);
  };

  const moveEdge = (i: number, delta: Point) => {
    const a = i;
    const b = (i + 1) % 4;
    const clamp = (p: Point) => ({ x: Math.min(width, Math.max(0, p.x)), y: Math.min(height, Math.max(0, p.y)) });
    onChange(q.map((c, k) => (k === a || k === b ? clamp({ x: c.x + delta.x, y: c.y + delta.y }) : c)) as unknown as Quad);
  };

  useEffect(() => {
    if (!drag) return undefined;
    const move = (e: PointerEvent) => {
      e.preventDefault();
      const p = toImage(e.clientX, e.clientY);
      if (!p) return;
      if (drag.kind === 'corner') setCorner(drag.index, p);
      else {
        moveEdge(drag.index, { x: p.x - drag.point.x, y: p.y - drag.point.y });
        setDrag({ ...drag, point: p });
        return;
      }
      setDrag({ ...drag, point: p });
    };
    const up = () => {
      setDrag(null);
      // Normalise the order after a drag that crossed other corners.
      if (isConvex(q)) {
        const o = orderQuad(q);
        if (o.some((p, k) => p !== q[k])) onChange(o);
      }
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [drag, q]);

  const onKey = (i: number, e: KeyboardEvent) => {
    const step = (e.shiftKey ? 0.05 : 0.01) * Math.max(width, height);
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    const c = q[i] as Point;
    setCorner(i, { x: Math.min(width, Math.max(0, c.x + (d[0] as number))), y: Math.min(height, Math.max(0, c.y + (d[1] as number))) });
  };

  const pts = q.map((p) => `${p.x},${p.y}`).join(' ');
  const outside = `M0,0 H${width} V${height} H0 Z M${q.map((p) => `${p.x},${p.y}`).join(' L')} Z`;
  const loupeSize = 128;
  const zoom = 2.2;

  // Magnifier position in % of the image, displayed away from the finger.
  let loupe = null;
  if (drag && drag.kind === 'corner') {
    const p = drag.point;
    const left = p.x < width / 2;
    loupe = (
      <div
        class={`loupe ${left ? 'loupe-right' : 'loupe-left'}`}
        aria-hidden="true"
        style={{
          width: `${loupeSize}px`,
          height: `${loupeSize}px`,
          backgroundImage: `url("${src}")`,
          backgroundSize: `calc(var(--img-w) * ${zoom}) calc(var(--img-h) * ${zoom})`,
          backgroundPosition: `calc(${loupeSize / 2}px - var(--img-w) * ${zoom} * ${p.x / width}) calc(${loupeSize / 2}px - var(--img-h) * ${zoom} * ${p.y / height})`,
        }}
      >
        <span class="loupe-cross" />
      </div>
    );
  }

  return (
    <div
      class="crop-editor"
      ref={boxRef}
      style={{ aspectRatio: `${width} / ${height}`, width: `min(100%, calc((100dvh - var(--crop-chrome, 240px)) * ${(width / height).toFixed(4)}))` }}
    >
      <img src={src} alt="Image à recadrer" draggable={false} />
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        class="crop-svg"
        role="group"
        aria-label="Zone conservée — déplacez les quatre coins"
      >
        <path d={outside} fill-rule="evenodd" class="crop-outside" />
        <polygon points={pts} class={`crop-poly ${valid ? '' : 'is-invalid'}`} style={{ strokeWidth: `${r / 3}px` }} />
        {q.map((p, i) => {
          const n = q[(i + 1) % 4] as Point;
          const mx = (p.x + n.x) / 2;
          const my = (p.y + n.y) / 2;
          return (
            <rect
              key={`e${i}`}
              class="crop-edge"
              x={mx - r * 0.9}
              y={my - r * 0.9}
              width={r * 1.8}
              height={r * 1.8}
              rx={r * 0.5}
              onPointerDown={(e) => {
                e.preventDefault();
                (e.target as Element).setPointerCapture?.(e.pointerId);
                const pt = toImage(e.clientX, e.clientY);
                if (pt) setDrag({ kind: 'edge', index: i, point: pt });
              }}
            />
          );
        })}
        {q.map((p, i) => (
          <g key={`c${i}`}>
            <circle
              cx={p.x}
              cy={p.y}
              r={r * 2.4}
              class="crop-hit"
              onPointerDown={(e) => {
                e.preventDefault();
                (e.target as Element).setPointerCapture?.(e.pointerId);
                setDrag({ kind: 'corner', index: i, point: p });
              }}
            />
            <circle
              cx={p.x}
              cy={p.y}
              r={r}
              class={`crop-handle ${drag?.index === i && drag.kind === 'corner' ? 'is-active' : ''}`}
              style={{ strokeWidth: `${r / 2.5}px` }}
              tabindex={0}
              role="slider"
              aria-label={CORNER_NAMES[i]}
              aria-valuetext={`x ${Math.round((p.x / width) * 100)} %, y ${Math.round((p.y / height) * 100)} %`}
              onKeyDown={(e) => onKey(i, e)}
              onPointerDown={(e) => {
                e.preventDefault();
                (e.target as Element).setPointerCapture?.(e.pointerId);
                setDrag({ kind: 'corner', index: i, point: p });
              }}
            />
          </g>
        ))}
      </svg>
      {loupe}
      {!valid ? (
        <p class="crop-warning" role="alert">
          Les quatre coins doivent former un quadrilatère convexe.
        </p>
      ) : null}
    </div>
  );
}
