import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { DocumentRecord, Page } from '../../core/docs/model';
import { KIND_LABELS } from '../../core/ocr/analysis';
import { movePage, removePages, rotatePage, setFilter, UndoStack } from '../../core/docs/pages';
import { FILTERS } from '../../core/imaging/filters';
import type { FilterId } from '../../core/imaging/filters';
import { moveFlow, ocrFlow, renameFlow, scanTo, trashWithUndo } from '../../app/actions';
import { goBack, navigate } from '../../app/router';
import { chooseDialog, confirmDialog, errorMessage, library, promptDialog, toast, useLibrary, withBusy } from '../../app/state';
import { blankPageIds, extractPages, mergeDocuments, parsePageRanges, splitDocument } from '../../services/doc-tools';
import { copyPage, createPage, rerenderPage } from '../../services/pages';
import { processing } from '../../services/processing/client';
import { settings } from '../../services/settings';
import { DocDetailsSheet, InvoiceCard } from '../components/DocDetailsSheet';
import { ExportSheet } from '../components/ExportSheet';
import { Icon } from '../components/Icon';
import { PageGrid } from '../components/PageGrid';
import { ActionList, Button, EmptyState, formatBytes, formatDate, IconButton, Sheet } from '../components/ui';
import type { MenuItem } from '../components/ui';

/** Multi-page document editor: reorder, rotate, filters, crop, OCR, export, organisation. */
export function DocumentScreen({ id, preset, openMenu }: { id: string; preset?: string | null; openMenu?: boolean }) {
  const lib = useLibrary();
  const doc = lib.get(id);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pageMenu, setPageMenu] = useState<{ page: Page; index: number } | null>(null);
  const [menu, setMenu] = useState(!!openMenu);
  const [exportOpen, setExportOpen] = useState<{ pageIds?: string[] } | null>(preset ? {} : null);
  const [details, setDetails] = useState(false);
  const [filterAll, setFilterAll] = useState(false);
  const undo = useRef<UndoStack<Page[]> | null>(null);
  const [, bump] = useState(0);

  useEffect(() => {
    if (doc) {
      void lib.markOpened(doc.id);
      undo.current = new UndoStack<Page[]>(doc.pages);
    }
  }, [id]);

  // Keyboard: Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, Delete for the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') || document.querySelector('.sheet-backdrop')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        void (e.shiftKey ? redo() : undoOp());
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        void redo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size) {
        e.preventDefault();
        void deletePages([...selected]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const invoice = useMemo(() => doc?.invoice, [doc?.invoice]);

  if (!doc || doc.deletedAt !== undefined) {
    return (
      <div class="page">
        <header class="top-bar">
          <IconButton icon="back" label="Retour" onClick={() => goBack('/')} />
          <h1>Document</h1>
        </header>
        <EmptyState icon="doc" title={doc ? 'Ce document est dans la corbeille' : 'Document introuvable'} actions={doc ? <Button onClick={() => void lib.restoreDocuments([doc.id])}>Restaurer</Button> : <Button onClick={() => navigate('/')}>Bibliothèque</Button>} />
      </div>
    );
  }

  /** Applies a page-list change: saves the document and records it for undo. */
  const commit = async (pages: Page[], detail?: string, record = true): Promise<DocumentRecord | undefined> => {
    const current = library().get(id);
    if (!current) return undefined;
    if (record) {
      undo.current?.sync(current.pages);
      undo.current?.push(pages);
    }
    bump((v) => v + 1);
    return library().saveDocument({ ...current, pages }, 'modified', detail);
  };

  const undoOp = async () => {
    if (!undo.current?.canUndo) return;
    await commit(undo.current.undo(), 'Annuler', false);
  };
  const redo = async () => {
    if (!undo.current?.canRedo) return;
    await commit(undo.current.redo(), 'Rétablir', false);
  };

  const deletePages = async (ids: string[]) => {
    if (ids.length >= doc.pages.length) {
      if (await confirmDialog('Supprimer le document ?', 'Toutes les pages seraient supprimées : le document sera placé dans la corbeille.', { confirmLabel: 'Mettre à la corbeille', danger: true })) {
        await trashWithUndo([doc.id]);
        navigate('/', { replace: true });
      }
      return;
    }
    await commit(removePages(doc.pages, ids), `${ids.length} page(s) supprimée(s)`);
    setSelected(new Set());
    toast(`${ids.length} page(s) supprimée(s)`, 'info', { label: 'Annuler', run: () => void undoOp() });
  };

  const rotate = async (ids: string[], turns: number) => {
    const next = await withBusy('Rotation…', async () => {
      const out: Page[] = [];
      for (const p of doc.pages) {
        if (!ids.includes(p.id)) out.push(p);
        else {
          const rotated = rotatePage(p, turns);
          out.push(await rerenderPage(library(), p, { rotation: rotated.rotation }));
        }
      }
      return out;
    });
    if (next) await commit(next, 'Rotation');
  };

  const applyFilterTo = async (ids: string[] | 'all', filter: FilterId) => {
    const targets = setFilter(doc.pages, ids, filter);
    const next = await withBusy('Application du filtre…', async (progress) => {
      const out: Page[] = [];
      let k = 0;
      const total = ids === 'all' ? doc.pages.length : ids.length;
      for (const [i, p] of targets.entries()) {
        const before = doc.pages[i] as Page;
        if (p.filter === before.filter && ids !== 'all' && !ids.includes(p.id)) out.push(before);
        else {
          out.push(await rerenderPage(library(), before, { filter: p.filter, adjustments: p.adjustments }));
          progress(++k / total, `Page ${k}/${total}…`);
        }
      }
      return out;
    });
    if (next) await commit(next, `Filtre ${FILTERS.find((f) => f.id === filter)?.label ?? filter}`);
  };

  const duplicate = async (p: Page, index: number) => {
    const copy = await withBusy('Duplication…', () => copyPage(library(), p));
    if (copy) await commit([...doc.pages.slice(0, index + 1), copy, ...doc.pages.slice(index + 1)], 'Page dupliquée');
  };

  const replaceWithImage = async (p: Page) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const page = await withBusy('Remplacement…', async () => {
        const det = await processing.detect(f);
        return createPage(library(), { original: f, width: det.width, height: det.height, quad: det.quad, filter: det.quad ? settings.get('defaultFilter') : 'original' });
      });
      if (page) await commit(doc.pages.map((x) => (x.id === p.id ? page : x)), 'Page remplacée');
    };
    input.click();
  };

  const addImages = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = async () => {
      const files = [...(input.files ?? [])];
      if (!files.length) return;
      const added = await withBusy('Ajout des images…', async (progress) => {
        const out: Page[] = [];
        for (const [i, f] of files.entries()) {
          const det = await processing.detect(f);
          out.push(await createPage(library(), { original: f, width: det.width, height: det.height, quad: det.quad, filter: det.quad ? settings.get('defaultFilter') : 'original' }));
          progress((i + 1) / files.length);
        }
        return out;
      });
      if (added?.length) await commit([...doc.pages, ...added], `${added.length} page(s) ajoutée(s)`);
    };
    input.click();
  };

  const selIds = [...selected];
  const toggle = (p: Page) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(p.id)) n.delete(p.id);
      else n.add(p.id);
      return n;
    });

  const pageItems = (p: Page, index: number): MenuItem[] => [
    { icon: 'wand', label: 'Filtres et réglages', onSelect: () => navigate(`/doc/${doc.id}/page/${p.id}?tab=filter`) },
    { icon: 'crop', label: 'Recadrer', hint: 'Ajuster les quatre coins', onSelect: () => navigate(`/doc/${doc.id}/page/${p.id}?tab=crop`) },
    { icon: 'rotateCw', label: 'Pivoter à droite', onSelect: () => void rotate([p.id], 1) },
    { icon: 'rotateCcw', label: 'Pivoter à gauche', onSelect: () => void rotate([p.id], 3) },
    { icon: 'signature', label: 'Annoter / signer', onSelect: () => navigate(`/doc/${doc.id}/page/${p.id}?tab=annotate`) },
    { icon: 'text', label: p.ocr || p.text ? 'Texte de la page' : 'Reconnaître le texte (OCR)', onSelect: () => navigate(`/doc/${doc.id}/page/${p.id}?tab=text`) },
    { icon: 'copy', label: 'Dupliquer', onSelect: () => void duplicate(p, index) },
    { icon: 'scan', label: 'Rescanner cette page', onSelect: () => scanTo({ docId: doc.id, replacePageId: p.id }) },
    { icon: 'image', label: 'Remplacer par une image', onSelect: () => void replaceWithImage(p) },
    { icon: 'split', label: 'Extraire dans un nouveau document', onSelect: async () => {
      const d = await withBusy('Extraction…', () => extractPages(library(), doc.id, [index]));
      if (d) toast('Page extraite', 'success', { label: 'Ouvrir', run: () => navigate(`/doc/${d.id}`) });
    } },
    { icon: 'back', label: 'Déplacer avant', disabled: index === 0, onSelect: () => void commit(movePage(doc.pages, index, index - 1), 'Réorganisation') },
    { icon: 'back', label: 'Déplacer après', disabled: index === doc.pages.length - 1, onSelect: () => void commit(movePage(doc.pages, index, index + 1), 'Réorganisation') },
    { icon: 'trash', label: 'Supprimer la page', danger: true, onSelect: () => void deletePages([p.id]) },
  ];

  const docItems: MenuItem[] = [
    { icon: 'pen', label: 'Renommer', onSelect: () => void renameFlow(doc) },
    { icon: 'star', label: doc.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris', onSelect: () => void lib.toggleFavorite(doc.id) },
    { icon: 'folder', label: 'Déplacer dans un dossier', onSelect: () => void moveFlow([doc.id]) },
    { icon: 'tag', label: 'Étiquettes, notes et informations', onSelect: () => setDetails(true) },
    { icon: 'text', label: 'Reconnaître le texte (OCR)', hint: 'Traitement local, hors ligne', onSelect: () => void ocrFlow(doc.id) },
    { icon: 'wand', label: 'Même filtre pour toutes les pages', onSelect: () => setFilterAll(true) },
    { icon: 'copy', label: 'Dupliquer le document', onSelect: async () => {
      const d = await withBusy('Duplication…', () => lib.duplicate(doc.id));
      if (d) toast('Document dupliqué', 'success', { label: 'Ouvrir', run: () => navigate(`/doc/${d.id}`) });
    } },
    { icon: 'merge', label: 'Fusionner avec un autre document…', onSelect: async () => {
      const others = lib.documents().filter((d) => d.id !== doc.id);
      if (!others.length) return toast('Aucun autre document à fusionner', 'info');
      const pick = await chooseDialog('Ajouter à la fin les pages de…', others.slice(0, 50).map((d) => ({ value: d.id, label: d.title, hint: `${d.pages.length} page(s) · ${formatDate(d.updatedAt)}` })));
      if (!pick) return;
      const merged = await withBusy('Fusion…', () => mergeDocuments(lib, [doc.id, pick], doc.title));
      if (merged) {
        toast('Nouveau document fusionné créé (les originaux sont conservés)', 'success');
        navigate(`/doc/${merged.id}`);
      }
    } },
    { icon: 'split', label: 'Diviser le document…', disabled: doc.pages.length < 2, onSelect: async () => {
      const v = await promptDialog('Diviser', { message: 'Pages où commence chaque nouvelle partie (ex. « 3, 6 »), ou « tous les N » (ex. « tous les 2 »).', placeholder: '3, 6', confirmLabel: 'Diviser' });
      if (!v) return;
      const every = /tous\s+les\s+(\d+)/i.exec(v);
      const parts = await withBusy('Division…', () => splitDocument(lib, doc.id, every ? { every: Number(every[1]) } : { startsAt: v.split(/[,; ]+/).map(Number).filter(Boolean) }));
      if (parts) toast(`${parts.length} documents créés`, 'success');
    } },
    { icon: 'pages', label: 'Extraire des pages…', onSelect: async () => {
      const v = await promptDialog('Extraire des pages', { message: `Pages à copier dans un nouveau document (1 à ${doc.pages.length}), ex. « 1-3, 5 ».`, confirmLabel: 'Extraire' });
      if (!v) return;
      try {
        const idx = parsePageRanges(v, doc.pages.length);
        const d = await withBusy('Extraction…', () => extractPages(lib, doc.id, idx));
        if (d) toast('Pages extraites', 'success', { label: 'Ouvrir', run: () => navigate(`/doc/${d.id}`) });
      } catch (e) {
        toast(errorMessage(e), 'error');
      }
    } },
    { icon: 'eraser', label: 'Supprimer les pages blanches', onSelect: async () => {
      const ids = blankPageIds(doc);
      if (!ids.length) return toast('Aucune page blanche détectée', 'info');
      if (await confirmDialog(`${ids.length} page(s) blanche(s) détectée(s)`, 'Les supprimer du document ?', { confirmLabel: 'Supprimer', danger: true })) await deletePages(ids);
    } },
    { icon: 'trash', label: 'Mettre à la corbeille', danger: true, onSelect: async () => {
      await trashWithUndo([doc.id]);
      navigate('/', { replace: true });
    } },
  ];

  const ocrCount = doc.pages.filter((p) => p.ocr).length;

  return (
    <div class="page doc-page">
      <header class="top-bar">
        <IconButton icon="back" label="Retour" onClick={() => goBack('/')} />
        <h1>
          <button type="button" class="title-btn" onClick={() => void renameFlow(doc)} title="Renommer">
            {doc.title}
          </button>
        </h1>
        <IconButton icon="star" label={doc.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'} active={doc.favorite} onClick={() => void lib.toggleFavorite(doc.id)} />
        <IconButton icon="more" label="Plus d’actions" onClick={() => setMenu(true)} />
      </header>

      <div class="doc-summary">
        <span>{doc.pages.length} page{doc.pages.length > 1 ? 's' : ''}</span>
        <span>{formatBytes(doc.sizeBytes)}</span>
        {doc.folderId ? (
          <a href={`#/folders/${doc.folderId}`}>
            <Icon name="folder" size={15} /> {lib.folderPath(doc.folderId)}
          </a>
        ) : null}
        {doc.kind ? <span class="pill pill-accent">{KIND_LABELS[doc.kind]}</span> : null}
        {ocrCount ? <span class="pill pill-primary">OCR {ocrCount}/{doc.pages.length}</span> : null}
        {doc.tags.map((t) => (
          <span class="pill" key={t}>
            #{t}
          </span>
        ))}
      </div>

      {invoice ? <InvoiceCard invoice={invoice} /> : null}

      <div class="doc-actions">
        <Button variant="primary" icon="share" onClick={() => setExportOpen({})} data-testid="export-open">
          Exporter
        </Button>
        <Button icon="text" onClick={() => void ocrFlow(doc.id)}>
          {ocrCount === doc.pages.length ? 'Texte reconnu' : 'OCR'}
        </Button>
        <Button icon="scan" onClick={() => scanTo({ docId: doc.id })}>
          Ajouter
        </Button>
        <IconButton icon="image" label="Ajouter des images" onClick={addImages} />
        <IconButton icon="undo" label="Annuler (Ctrl+Z)" disabled={!undo.current?.canUndo} onClick={() => void undoOp()} />
        <IconButton icon="redo" label="Rétablir (Ctrl+Y)" disabled={!undo.current?.canRedo} onClick={() => void redo()} />
        <IconButton icon="check" label={selected.size ? 'Terminer la sélection' : 'Sélectionner des pages'} active={selected.size > 0} onClick={() => setSelected(selected.size ? new Set() : new Set([doc.pages[0]?.id ?? '']))} />
      </div>
      <p class="muted small hint-line">Touchez une page pour la modifier. Maintenez-la puis glissez pour la déplacer.</p>

      <PageGrid
        pages={doc.pages}
        selected={selected}
        selecting={selected.size > 0}
        onToggle={toggle}
        onOpen={(page, index) => setPageMenu({ page, index })}
        onMove={(from, to) => void commit(movePage(doc.pages, from, to), 'Réorganisation')}
      />

      {selected.size ? (
        <div class="selection-bar" role="toolbar" aria-label="Actions sur les pages sélectionnées">
          <strong style={{ flex: 1 }}>{selected.size} page(s)</strong>
          <IconButton icon="rotateCw" label="Pivoter" onClick={() => void rotate(selIds, 1)} />
          <IconButton icon="wand" label="Filtre" onClick={async () => {
            const f = await chooseDialog('Filtre pour la sélection', FILTERS.map((x) => ({ value: x.id, label: x.label, hint: x.description })));
            if (f) await applyFilterTo(selIds, f as FilterId);
          }} />
          <IconButton icon="text" label="OCR" onClick={() => void ocrFlow(doc.id, selIds, true)} />
          <IconButton icon="share" label="Exporter la sélection" onClick={() => setExportOpen({ pageIds: doc.pages.filter((p) => selected.has(p.id)).map((p) => p.id) })} />
          <IconButton icon="trash" label="Supprimer" onClick={() => void deletePages(selIds)} />
          <IconButton icon="close" label="Annuler la sélection" onClick={() => setSelected(new Set())} />
        </div>
      ) : null}

      <Sheet open={!!pageMenu} onClose={() => setPageMenu(null)} title={pageMenu ? `Page ${pageMenu.index + 1}` : ''}>
        {pageMenu ? <ActionList items={pageItems(pageMenu.page, pageMenu.index)} onDone={() => setPageMenu(null)} /> : null}
      </Sheet>
      <Sheet open={menu} onClose={() => setMenu(false)} title={doc.title}>
        <ActionList items={docItems} onDone={() => setMenu(false)} />
      </Sheet>
      <Sheet open={filterAll} onClose={() => setFilterAll(false)} title="Filtre pour toutes les pages">
        <ActionList
          items={FILTERS.map((f) => ({ icon: 'wand' as const, label: f.label, hint: f.description, onSelect: () => void applyFilterTo('all', f.id) }))}
          onDone={() => setFilterAll(false)}
        />
      </Sheet>
      {exportOpen ? (
        <ExportSheet
          doc={doc}
          open
          onClose={() => setExportOpen(null)}
          {...(exportOpen.pageIds ? { pageIds: exportOpen.pageIds } : {})}
          {...(preset === 'small' || preset === 'protect' ? { preset } : {})}
        />
      ) : null}
      {details ? <DocDetailsSheet doc={doc} open onClose={() => setDetails(false)} /> : null}
    </div>
  );
}
