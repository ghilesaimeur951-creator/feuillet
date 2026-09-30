import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { library } from '../../app/state';

export function Button({
  children,
  variant = 'secondary',
  icon,
  size = 'md',
  class: cls = '',
  ...rest
}: { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; icon?: IconName; size?: 'sm' | 'md' | 'lg' } & JSX.IntrinsicElements['button']) {
  return (
    <button type="button" class={`btn btn-${variant} btn-${size} ${cls}`} {...rest}>
      {icon ? <Icon name={icon} size={size === 'sm' ? 18 : 20} /> : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

export function IconButton({ icon, label, active, class: cls = '', badge, ...rest }: { icon: IconName; label: string; active?: boolean; badge?: string | number } & JSX.IntrinsicElements['button']) {
  return (
    <button type="button" class={`icon-btn ${active ? 'is-active' : ''} ${cls}`} aria-label={label} title={label} aria-pressed={active === undefined ? undefined : active} {...rest}>
      <Icon name={icon} />
      {badge !== undefined && badge !== '' ? <span class="badge">{badge}</span> : null}
    </button>
  );
}

/** Modal bottom sheet (mobile) / centered dialog (desktop) with focus management and Escape. */
export function Sheet({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ComponentChildren; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('input, select, textarea, button:not(.sheet-close), [tabindex="0"]');
    (first ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Tab' && el) {
        const items = [...el.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea, [tabindex="0"]')];
        if (!items.length) return;
        const a = items[0] as HTMLElement;
        const b = items[items.length - 1] as HTMLElement;
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault();
          b.focus();
        } else if (!e.shiftKey && document.activeElement === b) {
          e.preventDefault();
          a.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class={`sheet ${wide ? 'sheet-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}>
        <div class="sheet-grip" aria-hidden="true" />
        <header class="sheet-head">
          <h2>{title}</h2>
          <IconButton icon="close" label="Fermer" class="sheet-close" onClick={onClose} />
        </header>
        <div class="sheet-body">{children}</div>
      </div>
    </div>
  );
}

export interface MenuItem {
  icon: IconName;
  label: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export function ActionList({ items, onDone }: { items: MenuItem[]; onDone?: () => void }) {
  return (
    <ul class="action-list" role="menu">
      {items.map((it) => (
        <li role="none" key={it.label}>
          <button
            type="button"
            role="menuitem"
            class={`action-item ${it.danger ? 'is-danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              onDone?.();
              it.onSelect();
            }}
          >
            <Icon name={it.icon} />
            <span class="action-text">
              <span>{it.label}</span>
              {it.hint ? <small>{it.hint}</small> : null}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label class={`switch-row ${disabled ? 'is-disabled' : ''}`}>
      <span class="switch-text">
        <span>{label}</span>
        {hint ? <small>{hint}</small> : null}
      </span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      <span class="switch-track" aria-hidden="true">
        <span class="switch-thumb" />
      </span>
    </label>
  );
}

export function Slider({ label, value, min, max, step = 1, onInput, format }: { label: string; value: number; min: number; max: number; step?: number; onInput: (v: number) => void; format?: (v: number) => string }) {
  return (
    <label class="slider-row">
      <span class="slider-label">
        <span>{label}</span>
        <output>{format ? format(value) : value > 0 ? `+${value}` : String(value)}</output>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onInput={(e) => onInput(Number((e.target as HTMLInputElement).value))} />
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string; icon?: IconName }>; onChange: (v: T) => void; label: string }) {
  return (
    <div class="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button type="button" role="radio" aria-checked={o.value === value} class={o.value === value ? 'is-active' : ''} key={o.value} onClick={() => onChange(o.value)}>
          {o.icon ? <Icon name={o.icon} size={18} /> : null}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Chip({ children, active, onClick, icon }: { children: ComponentChildren; active?: boolean; onClick?: () => void; icon?: IconName }) {
  return (
    <button type="button" class={`chip ${active ? 'is-active' : ''}`} aria-pressed={active} onClick={onClick}>
      {icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </button>
  );
}

export function EmptyState({ icon, title, children, actions }: { icon: IconName; title: string; children?: ComponentChildren; actions?: ComponentChildren }) {
  return (
    <div class="empty-state">
      <div class="empty-icon">
        <Icon name={icon} size={40} />
      </div>
      <h2>{title}</h2>
      {children ? <p>{children}</p> : null}
      {actions ? <div class="empty-actions">{actions}</div> : null}
    </div>
  );
}

export function Skeleton({ count = 6, variant = 'card' }: { count?: number; variant?: 'card' | 'row' }) {
  return (
    <div class={variant === 'card' ? 'doc-grid' : 'doc-list'} aria-busy="true" aria-label="Chargement">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} class={`skeleton skeleton-${variant}`} />
      ))}
    </div>
  );
}

export function Progress({ value, label }: { value?: number; label?: string }) {
  return (
    <div class="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === undefined ? undefined : Math.round(value * 100)}>
      <div class={`progress-bar ${value === undefined ? 'is-indeterminate' : ''}`} style={value === undefined ? undefined : { width: `${Math.round(value * 100)}%` }} />
    </div>
  );
}

// ---------- Blob-backed images with an LRU object-URL cache ----------

const urlCache = new Map<string, string>();
const MAX_URLS = 400;

export async function blobUrl(id: string): Promise<string | null> {
  const hit = urlCache.get(id);
  if (hit) {
    urlCache.delete(id);
    urlCache.set(id, hit);
    return hit;
  }
  const blob = await library().getBlob(id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(id, url);
  while (urlCache.size > MAX_URLS) {
    const [k, v] = urlCache.entries().next().value as [string, string];
    URL.revokeObjectURL(v);
    urlCache.delete(k);
  }
  return url;
}

export function useBlobUrl(id: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(id ? (urlCache.get(id) ?? null) : null);
  useEffect(() => {
    let alive = true;
    if (!id) {
      setUrl(null);
      return undefined;
    }
    void blobUrl(id).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [id]);
  return url;
}

export function BlobImage({ id, alt, class: cls = '', ...rest }: { id: string | null | undefined; alt: string } & Omit<JSX.IntrinsicElements['img'], 'src'>) {
  const url = useBlobUrl(id);
  return url ? <img src={url} alt={alt} class={cls} loading="lazy" decoding="async" draggable={false} {...rest} /> : <div class={`img-placeholder ${cls}`} role="img" aria-label={alt} />;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2).replace('.', ',')} Go`;
}

export function formatDate(ts: number, withTime = false): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return `Aujourd’hui ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) });
}
