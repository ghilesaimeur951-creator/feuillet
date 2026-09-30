import { useMemo, useState } from 'preact/hooks';
import type { DocumentRecord } from '../../core/docs/model';
import { moveFlow, openImportPicker, scanTo, trashWithUndo } from '../../app/actions';
import { navigate } from '../../app/router';
import { toast, useLibrary, useSettings, withBusy } from '../../app/state';
import { settings } from '../../services/settings';
import { mergeDocuments } from '../../services/doc-tools';
import { DocCard } from '../components/DocCard';
import { Icon } from '../components/Icon';
import { Logo } from '../components/Logo';
import { Button, Chip, EmptyState, IconButton } from '../components/ui';

export function sortDocuments(docs: DocumentRecord[], by: 'date' | 'name' | 'size' | 'type'): DocumentRecord[] {
  const out = docs.slice();
  switch (by) {
    case 'name':
      return out.sort((a, b) => a.title.localeCompare(b.title, 'fr', { numeric: true }));
    case 'size':
      return out.sort((a, b) => b.sizeBytes - a.sizeBytes);
    case 'type':
      return out.sort((a, b) => a.source.localeCompare(b.source) || b.updatedAt - a.updatedAt);
    default:
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

const SORTS: Array<{ id: 'date' | 'name' | 'size' | 'type'; label: string }> = [
  { id: 'date', label: 'Date' },
  { id: 'name', label: 'Nom' },
  { id: 'size', label: 'Taille' },
  { id: 'type', label: 'Type' },
];

/** Home: recent documents, filters, folders shortcut, grid/list with multi-selection. */
export function LibraryScreen({ view }: { view: string }) {
  const lib = useLibrary();
  const s = useSettings();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selecting = selected.size > 0;
  const all = lib.documents();
  const docs = useMemo(() => {
    let d = all;
    if (view === 'favorites') d = d.filter((x) => x.favorite);
    if (view === 'root') d = d.filter((x) => x.folderId === null);
    return sortDocuments(d, s.sortBy);
  }, [all, view, s.sortBy]);
  const recent = lib.recent(10);
  const folders = lib.subfolders(null);

  const toggle = (d: DocumentRecord) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(d.id)) n.delete(d.id);
      else n.add(d.id);
      return n;
    });
  const open = (d: DocumentRecord) => navigate(`/doc/${d.id}`);
  const ids = [...selected];

  return (
    <div class="page">
      <header class="top-bar">
        <Logo />
        <IconButton icon="upload" label="Importer des fichiers" onClick={() => openImportPicker()} />
        <IconButton icon="settings" label="Paramètres" class="hide-desktop" onClick={() => navigate('/settings')} />
        <IconButton
          icon={s.viewMode === 'grid' ? 'list' : 'grid'}
          label={s.viewMode === 'grid' ? 'Affichage en liste' : 'Affichage en grille'}
          onClick={() => settings.set('viewMode', s.viewMode === 'grid' ? 'list' : 'grid')}
        />
      </header>
      <a class="search-field" href="#/search" aria-label="Rechercher dans les documents">
        <Icon name="search" />
        <span>Rechercher un document, un mot du texte…</span>
      </a>

      {all.length === 0 ? (
        <EmptyState
          icon="scan"
          title="Aucun document pour l’instant"
          actions={
            <>
              <Button variant="primary" icon="scan" size="lg" onClick={() => scanTo()}>
                Scanner un document
              </Button>
              <Button icon="upload" size="lg" onClick={() => openImportPicker()}>
                Importer des fichiers
              </Button>
            </>
          }
        >
          Photographiez une feuille : ses bords sont détectés automatiquement, la perspective est corrigée et le texte devient recherchable. Tout
          reste sur votre appareil.
        </EmptyState>
      ) : (
        <>
          {view === 'all' && recent.length > 2 && !selecting ? (
            <section aria-labelledby="recent-title">
              <h2 class="section-title" id="recent-title">
                Récents
              </h2>
              <div class="recent-strip">
                {recent.map((d) => (
                  <DocCard key={d.id} doc={d} mode="strip" onOpen={open} />
                ))}
              </div>
            </section>
          ) : null}

          {folders.length && view === 'all' && !selecting ? (
            <section aria-labelledby="folders-title">
              <h2 class="section-title" id="folders-title">
                <span>Dossiers</span>
                <a href="#/folders" class="small">
                  Tout voir
                </a>
              </h2>
              <div class="folder-grid">
                {folders.slice(0, 6).map((f) => (
                  <a key={f.id} class="folder-chip" href={`#/folders/${f.id}`}>
                    <Icon name="folder" />
                    <span class="folder-name">{f.name}</span>
                    <span class="muted small">{lib.documentsInFolder(f.id).length}</span>
                  </a>
                ))}
              </div>
            </section>
          ) : null}

          <h2 class="section-title">
            <span>{view === 'favorites' ? 'Favoris' : 'Tous les documents'}</span>
            <span class="muted small">{docs.length}</span>
          </h2>
          <div class="row" style={{ marginBottom: '12px' }}>
            <div class="chips" role="group" aria-label="Filtrer">
              <Chip active={view === 'all'} onClick={() => navigate('/', { replace: true })}>
                Tous
              </Chip>
              <Chip active={view === 'favorites'} icon="star" onClick={() => navigate('/?view=favorites', { replace: true })}>
                Favoris
              </Chip>
              <Chip active={view === 'root'} onClick={() => navigate('/?view=root', { replace: true })}>
                Hors dossier
              </Chip>
            </div>
            <span class="spacer" />
            <label class="row small muted">
              <Icon name="sort" size={18} />
              <span class="visually-hidden">Trier par</span>
              <select
                class="select"
                style={{ minHeight: '38px', width: 'auto' }}
                value={s.sortBy}
                onChange={(e) => settings.set('sortBy', (e.target as HTMLSelectElement).value as typeof s.sortBy)}
              >
                {SORTS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {docs.length === 0 ? (
            <EmptyState icon={view === 'favorites' ? 'star' : 'doc'} title={view === 'favorites' ? 'Aucun favori' : 'Aucun document ici'}>
              {view === 'favorites' ? 'Ajoutez un document aux favoris depuis son menu pour le retrouver ici.' : null}
            </EmptyState>
          ) : (
            <div class={s.viewMode === 'grid' ? 'doc-grid' : 'doc-list'}>
              {docs.map((d) => (
                <DocCard
                  key={d.id}
                  doc={d}
                  mode={s.viewMode}
                  selected={selected.has(d.id)}
                  selecting={selecting}
                  onOpen={open}
                  onToggle={toggle}
                  onLongPress={toggle}
                />
              ))}
            </div>
          )}
        </>
      )}

      {selecting ? (
        <div class="selection-bar" role="toolbar" aria-label="Actions sur la sélection">
          <strong style={{ flex: 1 }}>{selected.size} sélectionné(s)</strong>
          <IconButton icon="check" label="Tout sélectionner" onClick={() => setSelected(new Set(docs.map((d) => d.id)))} />
          <IconButton icon="folder" label="Déplacer" onClick={() => void moveFlow(ids).then(() => setSelected(new Set()))} />
          <IconButton
            icon="merge"
            label="Fusionner en un document"
            disabled={selected.size < 2}
            onClick={async () => {
              const ordered = docs.filter((d) => selected.has(d.id));
              const merged = await withBusy('Fusion des documents…', () =>
                mergeDocuments(
                  lib,
                  ordered.map((d) => d.id),
                ),
              );
              if (merged) {
                setSelected(new Set());
                toast('Documents fusionnés', 'success');
                navigate(`/doc/${merged.id}`);
              }
            }}
          />
          <IconButton
            icon="trash"
            label="Supprimer"
            onClick={() => {
              void trashWithUndo(ids);
              setSelected(new Set());
            }}
          />
          <IconButton icon="close" label="Annuler la sélection" onClick={() => setSelected(new Set())} />
        </div>
      ) : null}
    </div>
  );
}
