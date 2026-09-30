import { useState } from 'preact/hooks';
import { goBack } from '../../app/router';
import { confirmDialog, toast, useLibrary } from '../../app/state';
import { TRASH_RETENTION_DAYS } from '../../services/library';
import { DocCard } from '../components/DocCard';
import { Icon } from '../components/Icon';
import { Button, EmptyState, IconButton } from '../components/ui';

/** Trash: restore or permanently delete documents and folders (auto-purge after 30 days). */
export function TrashScreen() {
  const lib = useLibrary();
  const docs = lib.trash();
  const folders = lib.trashedFolders();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const daysLeft = (ts: number) => Math.max(0, TRASH_RETENTION_DAYS - Math.floor((Date.now() - ts) / 86400_000));

  return (
    <div class="page">
      <header class="top-bar">
        <IconButton icon="back" label="Retour" onClick={() => goBack('/folders')} />
        <h1>Corbeille</h1>
        {docs.length || folders.length ? (
          <Button
            variant="ghost"
            icon="trash"
            onClick={async () => {
              if (await confirmDialog('Vider la corbeille ?', 'Les documents seront supprimés définitivement de cet appareil.', { confirmLabel: 'Vider', danger: true })) {
                await lib.emptyTrash();
                toast('Corbeille vidée', 'success');
              }
            }}
          >
            Vider
          </Button>
        ) : null}
      </header>
      <p class="muted small">Les éléments sont supprimés définitivement après {TRASH_RETENTION_DAYS} jours.</p>
      {folders.map((f) => (
        <div class="folder-chip" key={f.id} style={{ marginBottom: '8px' }}>
          <Icon name="folder" />
          <span class="folder-name">{f.name}</span>
          <span class="muted small">{f.deletedAt ? `${daysLeft(f.deletedAt)} j` : ''}</span>
          <Button size="sm" icon="restore" onClick={() => void lib.restoreFolder(f.id)}>
            Restaurer
          </Button>
        </div>
      ))}
      {!docs.length && !folders.length ? (
        <EmptyState icon="trash" title="La corbeille est vide" />
      ) : (
        <div class="doc-list">
          {docs.map((d) => (
            <DocCard
              key={d.id}
              doc={d}
              mode="list"
              selecting
              selected={selected.has(d.id)}
              extra={`Supprimé ${d.deletedAt ? `— encore ${daysLeft(d.deletedAt)} jour(s)` : ''}`}
              onOpen={() => undefined}
              onToggle={(x) =>
                setSelected((prev) => {
                  const n = new Set(prev);
                  if (n.has(x.id)) n.delete(x.id);
                  else n.add(x.id);
                  return n;
                })
              }
            />
          ))}
        </div>
      )}
      {selected.size ? (
        <div class="selection-bar" role="toolbar" aria-label="Actions">
          <strong style={{ flex: 1 }}>{selected.size} sélectionné(s)</strong>
          <IconButton
            icon="restore"
            label="Restaurer"
            onClick={async () => {
              await lib.restoreDocuments([...selected]);
              toast('Restauré', 'success');
              setSelected(new Set());
            }}
          />
          <IconButton
            icon="trash"
            label="Supprimer définitivement"
            onClick={async () => {
              if (await confirmDialog('Supprimer définitivement ?', 'Cette action est irréversible.', { confirmLabel: 'Supprimer', danger: true })) {
                await lib.purge([...selected]);
                setSelected(new Set());
              }
            }}
          />
          <IconButton icon="close" label="Annuler la sélection" onClick={() => setSelected(new Set())} />
        </div>
      ) : null}
    </div>
  );
}
