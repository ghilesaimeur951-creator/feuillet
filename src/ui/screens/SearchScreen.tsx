import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { KIND_LABELS } from '../../core/ocr/analysis';
import type { DocumentKind } from '../../core/ocr/analysis';
import { navigate } from '../../app/router';
import { useLibrary } from '../../app/state';
import { DocCard } from '../components/DocCard';
import { Icon } from '../components/Icon';
import { Chip, EmptyState, IconButton } from '../components/ui';

const PERIODS: Array<{ id: string; label: string; days: number | null }> = [
  { id: 'all', label: 'Toutes dates', days: null },
  { id: '7', label: '7 jours', days: 7 },
  { id: '30', label: '30 jours', days: 30 },
  { id: '365', label: '12 mois', days: 365 },
];

function Highlighted({ text, ranges }: { text: string; ranges: Array<[number, number]> }) {
  const parts: Array<string | preact.JSX.Element> = [];
  let last = 0;
  ranges.forEach(([s, e], i) => {
    if (s < last) return;
    parts.push(text.slice(last, s));
    parts.push(<mark key={i}>{text.slice(s, e)}</mark>);
    last = e;
  });
  parts.push(text.slice(last));
  return <>{parts}</>;
}

/** Full-text search over titles, folders, tags, notes, OCR text, type and date. */
export function SearchScreen({ initial }: { initial: string }) {
  const lib = useLibrary();
  const [q, setQ] = useState(initial);
  const [debounced, setDebounced] = useState(initial);
  const [kind, setKind] = useState<DocumentKind | ''>('');
  const [period, setPeriod] = useState('all');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 140);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const qs = debounced ? `?q=${encodeURIComponent(debounced)}` : '';
    history.replaceState(history.state, '', `#/search${qs}`);
  }, [debounced]);

  const days = PERIODS.find((p) => p.id === period)?.days ?? null;
  const hits = useMemo(() => {
    if (!debounced.trim() && !kind && !days) return [];
    return lib.search(debounced, { ...(kind ? { type: KIND_LABELS[kind] } : {}), ...(days ? { from: Date.now() - days * 86400_000 } : {}) });
  }, [debounced, kind, days, lib.documents().length, lib]);
  const kinds = [...new Set(lib.documents().map((d) => d.kind).filter((k): k is DocumentKind => !!k))];

  return (
    <div class="page">
      <header class="top-bar">
        <label class="search-field" style={{ flex: 1 }}>
          <Icon name="search" />
          <input ref={input} type="search" value={q} placeholder="Ex. « facture EDF », « bail 2023 »…" aria-label="Rechercher" onInput={(e) => setQ((e.target as HTMLInputElement).value)} enterKeyHint="search" />
          {q ? <IconButton icon="close" label="Effacer la recherche" onClick={() => setQ('')} /> : null}
        </label>
      </header>
      <div class="chips" role="group" aria-label="Période">
        {PERIODS.map((p) => (
          <Chip key={p.id} active={period === p.id} onClick={() => setPeriod(p.id)}>
            {p.label}
          </Chip>
        ))}
      </div>
      {kinds.length ? (
        <div class="chips" role="group" aria-label="Type de document">
          <Chip active={!kind} onClick={() => setKind('')}>
            Tous types
          </Chip>
          {kinds.map((k) => (
            <Chip key={k} active={kind === k} onClick={() => setKind(kind === k ? '' : k)}>
              {KIND_LABELS[k]}
            </Chip>
          ))}
        </div>
      ) : null}

      {!debounced.trim() && !kind && !days ? (
        <EmptyState icon="search" title="Recherche plein texte">
          La recherche porte sur les titres, dossiers, étiquettes, notes, dates et le texte reconnu par l’OCR — sans tenir compte des accents ni des majuscules. Utilisez des guillemets pour une expression exacte.
        </EmptyState>
      ) : hits.length === 0 ? (
        <EmptyState icon="search" title="Aucun résultat">
          Vérifiez l’orthographe ou lancez l’OCR sur vos documents pour rechercher dans leur contenu.
        </EmptyState>
      ) : (
        <>
          <p class="muted small" role="status">
            {hits.length} résultat{hits.length > 1 ? 's' : ''}
          </p>
          <div class="doc-list search-hit">
            {hits.map((h) => (
              <div key={h.id}>
                <DocCard doc={h.doc} mode="list" onOpen={(d) => navigate(`/doc/${d.id}`)} {...(h.doc.folderId ? { extra: `Dossier : ${lib.folderPath(h.doc.folderId)}` } : {})} />
                {h.snippet ? (
                  <p class="snippet" style={{ margin: '4px 12px 8px' }}>
                    <Highlighted text={h.snippet} ranges={h.highlights} />
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
