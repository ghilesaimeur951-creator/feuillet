import { useEffect, useState } from 'preact/hooks';
import type { Annotation, DocumentRecord, Page } from '../../core/docs/model';
import { rotatePage, setFilter } from '../../core/docs/pages';
import type { Quad } from '../../core/geometry/geometry';
import { fullFrameQuad, isConvex } from '../../core/geometry/geometry';
import type { Adjustments, FilterId } from '../../core/imaging/filters';
import { goBack, navigate } from '../../app/router';
import { errorMessage, library, toast, useLibrary, withBusy } from '../../app/state';
import { annotatedThumb, rerenderPage } from '../../services/pages';
import { processing } from '../../services/processing/client';
import { AnnotateEditor } from '../components/AnnotateEditor';
import { CropEditor } from '../components/CropEditor';
import { FilterEditor } from '../components/FilterEditor';
import { TextEditor } from '../components/TextEditor';
import { Button, EmptyState, IconButton, Segmented, useBlobUrl } from '../components/ui';

type Tab = 'filter' | 'crop' | 'text' | 'annotate';

async function savePages(doc: DocumentRecord, pages: Page[], detail: string): Promise<void> {
  await library().saveDocument({ ...doc, pages }, 'modified', detail);
}

function CropTab({ doc, page }: { doc: DocumentRecord; page: Page }) {
  const url = useBlobUrl(page.originalBlobId);
  const [quad, setQuad] = useState<Quad>(page.quad ?? fullFrameQuad(page.originalWidth, page.originalHeight));
  const [rotation, setRotation] = useState(page.rotation);
  const valid = isConvex(quad);
  const save = async () => {
    const r = await withBusy('Redressement de la page…', () => rerenderPage(library(), page, { quad, rotation }));
    if (r) {
      await savePages(
        doc,
        doc.pages.map((p) => (p.id === page.id ? r : p)),
        'Recadrage',
      );
      toast('Recadrage appliqué', 'success');
      goBack(`/doc/${doc.id}`);
    }
  };
  return (
    <div class="editor-split">
      <div class="editor-stage">
        {url ? (
          <CropEditor src={url} width={page.originalWidth} height={page.originalHeight} quad={quad} onChange={setQuad} />
        ) : (
          <div class="spinner" />
        )}
      </div>
      <div class="editor-panel">
        <p class="muted small">
          Déplacez les quatre coins sur les bords du document. La perspective est recalculée à partir de ces points (homographie).
        </p>
        <div class="row">
          <Button
            icon="wand"
            onClick={async () => {
              const blob = await library().getBlob(page.originalBlobId);
              if (!blob) return;
              const det = await processing.detect(blob);
              if (det.quad) setQuad(det.quad);
              else toast('Aucun document détecté automatiquement', 'info');
            }}
          >
            Auto
          </Button>
          <Button icon="crop" onClick={() => setQuad(fullFrameQuad(page.originalWidth, page.originalHeight))}>
            Image entière
          </Button>
          <Button icon="reset" onClick={() => setQuad(page.quad ?? fullFrameQuad(page.originalWidth, page.originalHeight))}>
            Réinitialiser
          </Button>
        </div>
        <div class="row">
          <Button icon="rotateCcw" onClick={() => setRotation(rotatePage({ ...page, rotation }, 3).rotation)}>
            Pivoter à gauche
          </Button>
          <Button icon="rotateCw" onClick={() => setRotation(rotatePage({ ...page, rotation }, 1).rotation)}>
            Pivoter à droite
          </Button>
          <span class="muted small">{rotation * 90}°</span>
        </div>
        {page.annotations.length ? <p class="banner banner-info small">Les annotations gardent leur position relative sur la page.</p> : null}
        <Button variant="primary" icon="check" size="lg" disabled={!valid} onClick={() => void save()}>
          Appliquer
        </Button>
      </div>
    </div>
  );
}

/** Per-page editing: filters & adjustments, crop, recognised text, annotations & signature. */
export function PageScreen({ docId, pageId, tab }: { docId: string; pageId: string; tab: string }) {
  const lib = useLibrary();
  const doc = lib.get(docId);
  const index = doc?.pages.findIndex((p) => p.id === pageId) ?? -1;
  const page = index >= 0 ? doc?.pages[index] : undefined;
  const [current, setCurrent] = useState<Tab>((['filter', 'crop', 'text', 'annotate'].includes(tab) ? tab : 'filter') as Tab);
  useEffect(() => setCurrent((['filter', 'crop', 'text', 'annotate'].includes(tab) ? tab : 'filter') as Tab), [tab]);

  if (!doc || !page) {
    return (
      <div class="page">
        <EmptyState icon="doc" title="Page introuvable" actions={<Button onClick={() => navigate('/')}>Bibliothèque</Button>} />
      </div>
    );
  }

  const saveFilter = async (filter: FilterId, adjustments: Adjustments, all: boolean) => {
    const targets = all ? doc.pages : [page];
    const updated = await withBusy('Application du filtre…', async (progress) => {
      const map = new Map<string, Page>();
      for (const [i, p] of targets.entries()) {
        const target = setFilter([p], 'all', filter, adjustments)[0] as Page;
        map.set(p.id, await rerenderPage(library(), p, { filter: target.filter, adjustments: target.adjustments }));
        progress((i + 1) / targets.length, `Page ${i + 1}/${targets.length}…`);
      }
      return map;
    });
    if (!updated) return;
    await savePages(
      doc,
      doc.pages.map((p) => updated.get(p.id) ?? p),
      'Filtre',
    );
    toast(all ? 'Filtre appliqué à toutes les pages' : 'Filtre appliqué', 'success');
    goBack(`/doc/${doc.id}`);
  };

  const saveAnnotations = async (annotations: Annotation[]) => {
    try {
      const next: Page = { ...page, annotations };
      next.thumbBlobId = await library().putBlob(await annotatedThumb(library(), next));
      await savePages(
        doc,
        doc.pages.map((p) => (p.id === page.id ? next : p)),
        'Annotations',
      );
      toast('Annotations enregistrées', 'success');
      goBack(`/doc/${doc.id}`);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const go = (d: number) => {
    const p = doc.pages[index + d];
    if (p) navigate(`/doc/${doc.id}/page/${p.id}?tab=${current}`, { replace: true });
  };

  return (
    <div class="page-editor">
      <header class="editor-top">
        <IconButton icon="back" label="Retour au document" onClick={() => goBack(`/doc/${doc.id}`)} />
        <div class="editor-title">
          <strong>
            Page {index + 1} / {doc.pages.length}
          </strong>
          <small>{doc.title}</small>
        </div>
        <IconButton icon="back" label="Page précédente" disabled={index === 0} onClick={() => go(-1)} />
        <IconButton icon="back" class="flip" label="Page suivante" disabled={index === doc.pages.length - 1} onClick={() => go(1)} />
      </header>
      <div class="editor-tabs">
        <Segmented
          label="Outil"
          value={current}
          onChange={(t) => navigate(`/doc/${doc.id}/page/${page.id}?tab=${t}`, { replace: true })}
          options={[
            { value: 'filter', label: 'Filtres', icon: 'wand' },
            { value: 'crop', label: 'Recadrer', icon: 'crop' },
            { value: 'text', label: 'Texte', icon: 'text' },
            { value: 'annotate', label: 'Annoter', icon: 'signature' },
          ]}
        />
      </div>
      {current === 'filter' ? <FilterEditor key={page.id} page={page} onSave={saveFilter} /> : null}
      {current === 'crop' ? <CropTab key={page.id} doc={doc} page={page} /> : null}
      {current === 'text' ? <TextEditor key={`${page.id}-${page.ocr?.createdAt ?? 0}`} doc={doc} page={page} /> : null}
      {current === 'annotate' ? <AnnotateEditor key={page.id} page={page} onSave={saveAnnotations} /> : null}
    </div>
  );
}
