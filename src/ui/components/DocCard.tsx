import type { DocumentRecord } from '../../core/docs/model';
import { documentFormatLabel } from '../../core/docs/model';
import { KIND_LABELS } from '../../core/ocr/analysis';
import { Icon } from './Icon';
import { BlobImage, formatBytes, formatDate } from './ui';

export interface DocCardProps {
  doc: DocumentRecord;
  mode: 'grid' | 'list' | 'strip';
  selected?: boolean;
  selecting?: boolean;
  onOpen: (d: DocumentRecord) => void;
  onToggle?: (d: DocumentRecord) => void;
  onLongPress?: (d: DocumentRecord) => void;
  extra?: string;
}

/** Document tile (grid / horizontal strip) or row (list), with selection and long-press. */
export function DocCard({ doc, mode, selected, selecting, onOpen, onToggle, onLongPress, extra }: DocCardProps) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let long = false;
  const start = () => {
    long = false;
    if (!onLongPress) return;
    timer = setTimeout(() => {
      long = true;
      onLongPress(doc);
    }, 480);
  };
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const click = (e: MouseEvent) => {
    if (long) {
      e.preventDefault();
      return;
    }
    if (selecting || e.ctrlKey || e.metaKey) onToggle?.(doc);
    else onOpen(doc);
  };
  const first = doc.pages[0];
  const meta = `${formatDate(doc.updatedAt)} · ${doc.pages.length} p.${mode === 'list' ? ` · ${formatBytes(doc.sizeBytes)}` : ''}`;
  const label = `${doc.title}, ${doc.pages.length} page${doc.pages.length > 1 ? 's' : ''}, modifié ${formatDate(doc.updatedAt)}${doc.favorite ? ', favori' : ''}${selected ? ', sélectionné' : ''}`;
  const common = {
    onPointerDown: start,
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e: MouseEvent) => {
      if (onLongPress) {
        e.preventDefault();
        onLongPress(doc);
      }
    },
    onClick: click,
    'aria-label': label,
    'aria-pressed': selecting ? !!selected : undefined,
  };
  const badges = (
    <div class="doc-badges">
      <span class="pill">{documentFormatLabel(doc)}</span>
      {doc.kind ? <span class="pill pill-accent">{KIND_LABELS[doc.kind]}</span> : null}
      {doc.pages.some((p) => p.ocr) ? (
        <span class="pill pill-primary" title="Texte reconnu (OCR)">
          OCR
        </span>
      ) : null}
    </div>
  );
  if (mode === 'list') {
    return (
      <button type="button" class={`doc-row ${selected ? 'is-selected' : ''}`} {...common}>
        <div class="doc-thumb">
          <BlobImage id={first?.thumbBlobId} alt="" />
        </div>
        <div class="doc-meta">
          <span class="doc-title">{doc.title}</span>
          <span class="doc-sub">
            {documentFormatLabel(doc)}
            {doc.kind ? ` · ${KIND_LABELS[doc.kind]}` : ''} · {meta}
          </span>
          {extra ? <span class="doc-sub">{extra}</span> : null}
        </div>
        {doc.favorite ? <Icon name="star" filled size={18} class="fav-inline" /> : null}
        {selecting ? <Icon name={selected ? 'check' : 'circle'} /> : null}
      </button>
    );
  }
  return (
    <button type="button" class={`doc-card ${selected ? 'is-selected' : ''}`} {...common}>
      <div class="doc-thumb">
        <BlobImage id={first?.thumbBlobId} alt="" />
        {mode === 'grid' ? badges : null}
        {doc.favorite ? (
          <span class="doc-fav">
            <Icon name="star" filled size={20} />
          </span>
        ) : null}
        {selecting ? <span class="doc-select">{selected ? <Icon name="check" size={16} /> : null}</span> : null}
      </div>
      <div class="doc-meta">
        <span class="doc-title">{doc.title}</span>
        <span class="doc-sub">{meta}</span>
      </div>
    </button>
  );
}
