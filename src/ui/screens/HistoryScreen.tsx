import { useState } from 'preact/hooks';
import type { HistoryAction } from '../../core/docs/model';
import { goBack } from '../../app/router';
import { useLibrary } from '../../app/state';
import { Icon } from '../components/Icon';
import type { IconName } from '../components/Icon';
import { Chip, EmptyState, formatDate, IconButton } from '../components/ui';

const LABELS: Record<HistoryAction, { label: string; icon: IconName }> = {
  created: { label: 'Créé', icon: 'plus' },
  opened: { label: 'Ouvert', icon: 'eye' },
  modified: { label: 'Modifié', icon: 'pen' },
  imported: { label: 'Importé', icon: 'upload' },
  exported: { label: 'Exporté', icon: 'share' },
  deleted: { label: 'Supprimé', icon: 'trash' },
  restored: { label: 'Restauré', icon: 'restore' },
  ocr: { label: 'Texte reconnu', icon: 'text' },
  moved: { label: 'Déplacé', icon: 'folder' },
  renamed: { label: 'Renommé', icon: 'pen' },
};

const FILTERS: Array<{ id: HistoryAction | 'all'; label: string }> = [
  { id: 'all', label: 'Tout' },
  { id: 'created', label: 'Créés' },
  { id: 'opened', label: 'Ouverts' },
  { id: 'modified', label: 'Modifiés' },
  { id: 'imported', label: 'Importés' },
  { id: 'exported', label: 'Exportés' },
];

/** Activity history: documents recently created, opened, modified, imported, exported. */
export function HistoryScreen() {
  const lib = useLibrary();
  const [filter, setFilter] = useState<HistoryAction | 'all'>('all');
  const entries = lib.history(300).filter((e) => filter === 'all' || e.action === filter);
  return (
    <div class="page">
      <header class="top-bar">
        <IconButton icon="back" label="Retour" onClick={() => goBack('/tools')} />
        <h1>Historique</h1>
      </header>
      <div class="chips">
        {FILTERS.map((f) => (
          <Chip key={f.id} active={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label}
          </Chip>
        ))}
      </div>
      {!entries.length ? (
        <EmptyState icon="clock" title="Aucune activité" />
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {entries.map((e) => {
            const exists = lib.get(e.docId);
            const meta = LABELS[e.action];
            return (
              <li class="history-item" key={e.id}>
                <span class="tool-icon">
                  <Icon name={meta.icon} size={18} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  {exists && exists.deletedAt === undefined ? <a href={`#/doc/${e.docId}`}>{exists.title}</a> : <span>{e.title}</span>}
                  <small class="muted" style={{ display: 'block' }}>
                    {meta.label}
                    {e.detail ? ` — ${e.detail}` : ''}
                  </small>
                </span>
                <small class="muted">{formatDate(e.at, true)}</small>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
