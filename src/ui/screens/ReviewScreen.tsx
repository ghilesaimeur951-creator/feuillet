import { useEffect, useState } from 'preact/hooks';
import type { DocumentRecord, Page } from '../../core/docs/model';
import type { Quad } from '../../core/geometry/geometry';
import { fullFrameQuad, isConvex } from '../../core/geometry/geometry';
import { goBack, navigate } from '../../app/router';
import { confirmDialog, errorMessage, library, toast, withBusy } from '../../app/state';
import { runOcr } from '../../services/ocr-runner';
import { createPage, splitDoublePage } from '../../services/pages';
import { processing } from '../../services/processing/client';
import { discardSession, getSession, modeDefaults, moveCapture, removeCapture, SCAN_MODES, subscribeSession, updateCapture } from '../../services/scan-session';
import type { Capture, ScanSession } from '../../services/scan-session';
import { settings } from '../../services/settings';
import { CropEditor } from '../components/CropEditor';
import { Icon } from '../components/Icon';
import { BlobImage, Button, EmptyState, IconButton, useBlobUrl } from '../components/ui';

function scanTitle(): string {
  const d = new Date();
  return `Scan du ${d.toLocaleDateString('fr-FR')} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
}

/** Turns the session captures into document pages (new document, append or replace). */
async function finalizeSession(session: ScanSession, progress: (v: number, label?: string) => void): Promise<DocumentRecord> {
  const lib = library();
  const { filter, snap } = modeDefaults(session.mode, settings.get('defaultFilter'));
  let pages: Page[] = [];
  for (const [i, c] of session.captures.entries()) {
    progress(i / session.captures.length, `Traitement de la page ${i + 1}/${session.captures.length}…`);
    const original = await lib.getBlob(c.blobId);
    if (!original) continue;
    const page = await createPage(lib, {
      original,
      originalBlobId: c.blobId,
      width: c.width,
      height: c.height,
      quad: session.mode === 'photo' ? null : c.quad,
      filter,
      rotation: c.rotation,
      snapRatio: snap,
    });
    if (session.mode === 'book') pages.push(...(await splitDoublePage(lib, page)));
    else pages.push(page);
  }
  if (!pages.length) throw new Error('Aucune page à enregistrer');
  let doc: DocumentRecord;
  const target = session.target;
  const existing = target.docId ? lib.get(target.docId) : undefined;
  if (existing && target.replacePageId) {
    const replacement = pages[0] as Page;
    pages = existing.pages.map((p) => (p.id === target.replacePageId ? replacement : p));
    doc = await lib.saveDocument({ ...existing, pages }, 'modified', 'Page rescannée');
  } else if (existing) {
    doc = await lib.saveDocument({ ...existing, pages: [...existing.pages, ...pages] }, 'modified', `${pages.length} page(s) ajoutée(s)`);
  } else {
    doc = await lib.createDocument({ title: scanTitle(), pages, source: 'scan', folderId: target.folderId ?? null });
  }
  await discardSession(lib, true);
  return doc;
}

/** Review of captured pages: manual four-corner crop, rotation, reordering, validation. */
export function ReviewScreen() {
  const [session, setSession] = useState<ScanSession | null>(getSession());
  const [index, setIndex] = useState(0);
  const [quad, setQuad] = useState<Quad | null>(null);
  useEffect(() => subscribeSession(() => setSession(getSession())), []);

  const captures = session?.captures ?? [];
  const i = Math.min(index, Math.max(0, captures.length - 1));
  const cur: Capture | undefined = captures[i];
  const url = useBlobUrl(cur?.blobId);
  useEffect(() => setQuad(cur?.quad ?? null), [cur?.id]);

  if (!session || !cur) {
    return (
      <div class="page">
        <header class="top-bar">
          <IconButton icon="back" label="Retour" onClick={() => goBack('/')} />
          <h1>Vérification</h1>
        </header>
        <EmptyState icon="scan" title="Aucune page capturée" actions={<Button variant="primary" icon="scan" onClick={() => navigate('/scan', { replace: true })}>Scanner</Button>} />
      </div>
    );
  }

  const lib = library();
  const modeInfo = SCAN_MODES.find((m) => m.id === session.mode);
  const crop = session.mode !== 'photo';
  const q = quad ?? fullFrameQuad(cur.width, cur.height);
  const valid = isConvex(q);

  const persistQuad = (next: Quad | null) => {
    setQuad(next);
    void updateCapture(lib, cur.id, { quad: next });
  };

  const autoDetect = async () => {
    if (cur.autoQuad) {
      persistQuad(cur.autoQuad);
      return;
    }
    const blob = await lib.getBlob(cur.blobId);
    if (!blob) return;
    const det = await processing.detect(blob);
    if (det.quad) persistQuad(det.quad);
    else toast('Aucun document détecté automatiquement : ajustez les coins manuellement.', 'info');
  };

  const finish = async () => {
    if (!valid) {
      toast('Le recadrage est invalide : les coins doivent former un quadrilatère convexe.', 'error');
      return;
    }
    await updateCapture(lib, cur.id, { quad });
    const s = getSession();
    if (!s) return;
    const doc = await withBusy('Redressement et amélioration…', (p) => finalizeSession(s, p));
    if (!doc) return;
    toast(s.target.replacePageId ? 'Page remplacée' : 'Document enregistré', 'success');
    navigate(`/doc/${doc.id}`, { replace: true });
    if (settings.get('autoOcr')) {
      const targets = s.target.replacePageId ? doc.pages.filter((p) => !p.ocr).map((p) => p.id) : undefined;
      runOcr(lib, doc.id, targets ? { pageIds: targets } : {})
        .then((d) => toast(`Texte reconnu${d.kind === 'facture' || d.kind === 'recu' ? ' — données de facture extraites' : ''}`, 'success'))
        .catch((e) => toast(`OCR : ${errorMessage(e)}`, 'error'));
    }
  };

  const retake = () => {
    const t = session.target;
    const qs = new URLSearchParams();
    if (t.docId) qs.set('doc', t.docId);
    if (t.replacePageId) qs.set('replace', t.replacePageId);
    navigate(`/scan${qs.toString() ? `?${qs}` : ''}`, { replace: true });
  };

  return (
    <div class="review">
      <header class="review-top">
        <IconButton
          icon="close"
          label="Abandonner ce scan"
          onClick={async () => {
            if (await confirmDialog('Abandonner le scan ?', `${captures.length} page(s) capturée(s) seront supprimées.`, { confirmLabel: 'Abandonner', danger: true })) {
              await discardSession(lib);
              goBack('/');
            }
          }}
        />
        <div class="review-title">
          <strong>
            Page {i + 1} / {captures.length}
          </strong>
          <small>{modeInfo?.label}</small>
        </div>
        <Button variant="primary" icon="check" onClick={() => void finish()} disabled={!valid} data-testid="review-validate">
          Valider
        </Button>
      </header>

      <div class="review-stage">
        {url ? (
          crop ? (
            <CropEditor src={url} width={cur.width} height={cur.height} quad={q} onChange={persistQuad} />
          ) : (
            <img class="review-photo" src={url} alt="Photo capturée" />
          )
        ) : (
          <div class="spinner" />
        )}
      </div>

      <div class="review-tools" role="toolbar" aria-label="Outils de recadrage">
        {crop ? (
          <>
            <Button variant="ghost" icon="wand" onClick={() => void autoDetect()}>
              Auto
            </Button>
            <Button variant="ghost" icon="crop" onClick={() => persistQuad(fullFrameQuad(cur.width, cur.height))}>
              Image entière
            </Button>
            <Button variant="ghost" icon="reset" onClick={() => persistQuad(cur.autoQuad)}>
              Réinitialiser
            </Button>
          </>
        ) : null}
        <Button variant="ghost" icon="rotateCw" onClick={() => void updateCapture(lib, cur.id, { rotation: ((cur.rotation + 1) % 4) as Capture['rotation'] })}>
          Pivoter{cur.rotation ? ` (${cur.rotation * 90}°)` : ''}
        </Button>
        <Button
          variant="ghost"
          icon="trash"
          onClick={async () => {
            await removeCapture(lib, cur.id);
            setIndex(Math.max(0, i - 1));
          }}
        >
          Supprimer
        </Button>
      </div>

      <div class="review-strip">
        {captures.map((c, k) => (
          <button type="button" key={c.id} class={`strip-item ${k === i ? 'is-active' : ''}`} onClick={() => setIndex(k)} aria-label={`Page ${k + 1}`} aria-current={k === i}>
            <BlobImage id={c.blobId} alt="" />
            <span class="strip-num">{k + 1}</span>
          </button>
        ))}
        {!session.target.replacePageId ? (
          <button type="button" class="strip-item strip-add" onClick={retake} aria-label="Ajouter une page">
            <Icon name="plus" />
          </button>
        ) : (
          <button type="button" class="strip-item strip-add" onClick={retake} aria-label="Reprendre la photo">
            <Icon name="scan" />
          </button>
        )}
        {captures.length > 1 ? (
          <div class="strip-move">
            <IconButton icon="back" label="Déplacer la page vers la gauche" disabled={i === 0} onClick={() => void moveCapture(lib, i, i - 1).then(() => setIndex(i - 1))} />
            <IconButton icon="back" class="flip" label="Déplacer la page vers la droite" disabled={i === captures.length - 1} onClick={() => void moveCapture(lib, i, i + 1).then(() => setIndex(i + 1))} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
