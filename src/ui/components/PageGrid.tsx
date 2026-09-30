import { useEffect, useRef, useState } from 'preact/hooks';
import type { Page } from '../../core/docs/model';
import { Icon } from './Icon';
import { BlobImage } from './ui';

export interface PageGridProps {
  pages: readonly Page[];
  selected: ReadonlySet<string>;
  onOpen: (p: Page, index: number) => void;
  onToggle: (p: Page) => void;
  onMove: (from: number, to: number) => void;
  selecting: boolean;
}

/**
 * Page thumbnails with drag-and-drop reordering (mouse, touch after a short press, and keyboard:
 * Alt+←/→ or the move buttons in the page menu).
 */
export function PageGrid({ pages, selected, onOpen, onToggle, onMove, selecting }: PageGridProps) {
  const gridRef = useRef<HTMLOListElement>(null);
  const [drag, setDrag] = useState<{ from: number; over: number; x: number; y: number; w: number; h: number; ox: number; oy: number } | null>(null);
  const pending = useRef<{
    index: number;
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout> | null;
    pointer: string;
    el: HTMLElement;
  } | null>(null);
  const suppressClick = useRef(false);

  const targetIndex = (x: number, y: number): number => {
    const items = [...(gridRef.current?.querySelectorAll<HTMLElement>('.page-tile') ?? [])];
    let best = drag?.over ?? 0;
    let bestD = Infinity;
    items.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const d = Math.hypot(r.left + r.width / 2 - x, r.top + r.height / 2 - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };

  const begin = (index: number, x: number, y: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    suppressClick.current = true;
    setDrag({ from: index, over: index, x, y, w: r.width, h: r.height, ox: x - r.left, oy: y - r.top });
    navigator.vibrate?.(15);
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = pending.current;
      if (!drag && p) {
        const dist = Math.hypot(e.clientX - p.x, e.clientY - p.y);
        if (p.pointer === 'mouse' && dist > 6) {
          begin(p.index, e.clientX, e.clientY, p.el);
          pending.current = null;
        } else if (p.pointer !== 'mouse' && dist > 10) {
          // Finger moved before the long press: it's a scroll.
          if (p.timer) clearTimeout(p.timer);
          pending.current = null;
        }
        return;
      }
      if (!drag) return;
      e.preventDefault();
      setDrag((d) => (d ? { ...d, x: e.clientX, y: e.clientY, over: targetIndex(e.clientX, e.clientY) } : d));
    };
    const up = () => {
      if (pending.current?.timer) clearTimeout(pending.current.timer);
      pending.current = null;
      if (drag) {
        if (drag.over !== drag.from) onMove(drag.from, drag.over);
        setDrag(null);
        setTimeout(() => (suppressClick.current = false), 50);
      }
    };
    // While dragging with a finger, stop the page from scrolling.
    const blockScroll = (e: TouchEvent) => {
      if (drag) e.preventDefault();
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('touchmove', blockScroll, { passive: false });
    return () => {
      window.removeEventListener('touchmove', blockScroll);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [drag, onMove]);

  // Visual order while dragging.
  const order = pages.map((_, i) => i);
  if (drag) {
    const [m] = order.splice(drag.from, 1);
    order.splice(drag.over, 0, m as number);
  }

  return (
    <>
      <ol class={`page-grid ${drag ? 'is-dragging' : ''}`} ref={gridRef} aria-label="Pages du document">
        {order.map((pi, pos) => {
          const p = pages[pi] as Page;
          const isDragged = drag?.from === pi;
          return (
            <li key={p.id} class={`page-tile ${selected.has(p.id) ? 'is-selected' : ''} ${isDragged ? 'is-placeholder' : ''}`}>
              <button
                type="button"
                class="page-btn"
                aria-label={`Page ${pos + 1}${selected.has(p.id) ? ', sélectionnée' : ''}${p.ocr ? ', texte reconnu' : ''}`}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  const el = e.currentTarget as HTMLElement;
                  const entry = {
                    index: pi,
                    x: e.clientX,
                    y: e.clientY,
                    timer: null as ReturnType<typeof setTimeout> | null,
                    pointer: e.pointerType,
                    el,
                  };
                  if (e.pointerType !== 'mouse')
                    entry.timer = setTimeout(() => {
                      if (pending.current === entry) {
                        begin(pi, entry.x, entry.y, el);
                        pending.current = null;
                      }
                    }, 380);
                  pending.current = entry;
                }}
                onClick={() => {
                  if (suppressClick.current) return;
                  if (selecting) onToggle(p);
                  else onOpen(p, pi);
                }}
                onContextMenu={(e) => e.preventDefault()}
                onKeyDown={(e) => {
                  if (e.altKey && e.key === 'ArrowLeft' && pi > 0) {
                    e.preventDefault();
                    onMove(pi, pi - 1);
                  } else if (e.altKey && e.key === 'ArrowRight' && pi < pages.length - 1) {
                    e.preventDefault();
                    onMove(pi, pi + 1);
                  } else if (e.key === ' ' && e.shiftKey) {
                    e.preventDefault();
                    onToggle(p);
                  }
                }}
              >
                <div class="page-thumb" style={{ aspectRatio: `${p.width} / ${p.height}` }}>
                  <BlobImage id={p.thumbBlobId} alt="" />
                </div>
                <span class="page-num">{pos + 1}</span>
                {p.ocr ? (
                  <span class="page-flag" title="Texte reconnu">
                    <Icon name="text" size={14} />
                  </span>
                ) : null}
                {p.blank ? <span class="page-flag page-flag-warn">vide ?</span> : null}
                {selecting ? <span class="doc-select">{selected.has(p.id) ? <Icon name="check" size={16} /> : null}</span> : null}
              </button>
            </li>
          );
        })}
      </ol>
      {drag ? (
        <div
          class="drag-ghost"
          style={{ left: `${drag.x - drag.ox}px`, top: `${drag.y - drag.oy}px`, width: `${drag.w}px`, height: `${drag.h}px` }}
          aria-hidden="true"
        >
          <BlobImage id={(pages[drag.from] as Page).thumbBlobId} alt="" />
        </div>
      ) : null}
    </>
  );
}
