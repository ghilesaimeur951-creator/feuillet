import type { Folder } from '../../core/docs/model';
import { openImportPicker, scanTo } from '../../app/actions';
import { navigate } from '../../app/router';
import { chooseDialog, confirmDialog, errorMessage, promptDialog, toast, useLibrary, useSettings } from '../../app/state';
import { DocCard } from '../components/DocCard';
import { Icon } from '../components/Icon';
import { ActionList, Button, EmptyState, IconButton, Sheet } from '../components/ui';
import { useState } from 'preact/hooks';
import { sortDocuments } from './LibraryScreen';

/** Folder tree browsing: subfolders, documents, create / rename / move / delete. */
export function FoldersScreen({ folderId }: { folderId: string | null }) {
  const lib = useLibrary();
  const s = useSettings();
  const folder = folderId ? lib.folder(folderId) : undefined;
  const [menu, setMenu] = useState<Folder | null>(null);
  const subs = lib.subfolders(folderId);
  const docs = sortDocuments(lib.documentsInFolder(folderId), s.sortBy);
  const trashCount = lib.trash().length;

  // Breadcrumb from the root.
  const crumbs: Folder[] = [];
  let cur = folder;
  while (cur) {
    crumbs.unshift(cur);
    cur = cur.parentId ? lib.folder(cur.parentId) : undefined;
  }

  const create = async () => {
    const name = await promptDialog(folder ? `Nouveau sous-dossier de « ${folder.name} »` : 'Nouveau dossier', { placeholder: 'Nom du dossier', confirmLabel: 'Créer' });
    if (!name) return;
    try {
      await lib.createFolder(name, folderId);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const folderActions = (f: Folder) => [
    {
      icon: 'pen' as const,
      label: 'Renommer',
      onSelect: async () => {
        const n = await promptDialog('Renommer le dossier', { value: f.name, confirmLabel: 'Renommer' });
        if (n) await lib.renameFolder(f.id, n).catch((e: unknown) => toast(errorMessage(e), 'error'));
      },
    },
    {
      icon: 'folder' as const,
      label: 'Déplacer',
      onSelect: async () => {
        const options = [{ value: '__root', label: 'Racine' }, ...lib.folders().filter((x) => x.id !== f.id).map((x) => ({ value: x.id, label: lib.folderPath(x.id) }))];
        const c = await chooseDialog(`Déplacer « ${f.name} » vers…`, options);
        if (c) await lib.moveFolder(f.id, c === '__root' ? null : c).catch((e: unknown) => toast(errorMessage(e), 'error'));
      },
    },
    {
      icon: 'trash' as const,
      label: 'Supprimer le dossier',
      danger: true,
      onSelect: async () => {
        const n = lib.documentsInFolder(f.id).length;
        if (await confirmDialog(`Supprimer « ${f.name} » ?`, `Le dossier, ses sous-dossiers et leurs documents (${n} ici) iront dans la corbeille. Vous pourrez les restaurer pendant 30 jours.`, { confirmLabel: 'Mettre à la corbeille', danger: true })) {
          await lib.trashFolder(f.id);
          toast('Dossier placé dans la corbeille', 'info', { label: 'Annuler', run: () => void lib.restoreFolder(f.id) });
          if (f.id === folderId) navigate(f.parentId ? `/folders/${f.parentId}` : '/folders', { replace: true });
        }
      },
    },
  ];

  return (
    <div class="page">
      <header class="top-bar">
        {folder ? <IconButton icon="back" label="Dossier parent" onClick={() => navigate(folder.parentId ? `/folders/${folder.parentId}` : '/folders')} /> : null}
        <h1>{folder ? folder.name : 'Dossiers'}</h1>
        {folder ? <IconButton icon="more" label="Actions du dossier" onClick={() => setMenu(folder)} /> : null}
        <IconButton icon="folderPlus" label="Nouveau dossier" onClick={() => void create()} />
      </header>
      {crumbs.length ? (
        <nav class="breadcrumb small" aria-label="Fil d’Ariane">
          <a href="#/folders">Dossiers</a>
          {crumbs.map((c) => (
            <span key={c.id}>
              {' / '}
              {c.id === folderId ? <strong aria-current="page">{c.name}</strong> : <a href={`#/folders/${c.id}`}>{c.name}</a>}
            </span>
          ))}
        </nav>
      ) : null}

      {!folder ? (
        <a class="folder-chip" href="#/trash" style={{ marginBottom: '12px' }}>
          <Icon name="trash" />
          <span class="folder-name">Corbeille</span>
          <span class="muted small">{trashCount}</span>
        </a>
      ) : null}

      {subs.length ? (
        <div class="folder-grid" style={{ marginBottom: '16px' }}>
          {subs.map((f) => (
            <div class="folder-chip" key={f.id} role="group" aria-label={f.name}>
              <a href={`#/folders/${f.id}`} class="row" style={{ flex: 1, minWidth: 0, textDecoration: 'none', color: 'inherit' }}>
                <Icon name="folder" />
                <span class="folder-name">{f.name}</span>
                <span class="muted small">{lib.documentsInFolder(f.id).length + lib.subfolders(f.id).length}</span>
              </a>
              <IconButton icon="more" label={`Actions pour ${f.name}`} onClick={() => setMenu(f)} />
            </div>
          ))}
        </div>
      ) : null}

      {docs.length ? (
        <div class={s.viewMode === 'grid' ? 'doc-grid' : 'doc-list'}>
          {docs.map((d) => (
            <DocCard key={d.id} doc={d} mode={s.viewMode} onOpen={(x) => navigate(`/doc/${x.id}`)} />
          ))}
        </div>
      ) : !subs.length ? (
        <EmptyState
          icon="folder"
          title={folder ? 'Dossier vide' : 'Aucun dossier'}
          actions={
            <>
              <Button icon="folderPlus" onClick={() => void create()}>
                Créer un dossier
              </Button>
              {folder ? (
                <>
                  <Button icon="scan" variant="primary" onClick={() => scanTo({ folderId: folder.id })}>
                    Scanner ici
                  </Button>
                  <Button icon="upload" onClick={() => openImportPicker(folder.id)}>
                    Importer ici
                  </Button>
                </>
              ) : null}
            </>
          }
        >
          {folder ? 'Scannez ou importez un document directement dans ce dossier, ou déplacez-y des documents existants.' : 'Classez vos documents par thème : Administratif, Banque, Santé…'}
        </EmptyState>
      ) : null}

      <Sheet open={!!menu} onClose={() => setMenu(null)} title={menu?.name ?? ''}>
        {menu ? <ActionList items={folderActions(menu)} onDone={() => setMenu(null)} /> : null}
      </Sheet>
    </div>
  );
}
