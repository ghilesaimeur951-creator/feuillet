import { useMemo, useState } from 'preact/hooks';
import { openImportPicker, ocrFlow, scanTo } from '../../app/actions';
import { goBack, navigate } from '../../app/router';
import { chooseDialog, confirmDialog, library, promptDialog, toast, useLibrary, withBusy } from '../../app/state';
import { findDuplicatePages, mergeDocuments } from '../../services/doc-tools';
import type { DuplicateGroup } from '../../services/doc-tools';
import { downloadBlob } from '../../services/exporter';
import { toArrayBuffer } from '../../core/util/bytes';
import { Icon } from '../components/Icon';
import type { IconName } from '../components/Icon';
import { SignatureSheet } from '../components/SignatureSheet';
import { BlobImage, EmptyState, IconButton } from '../components/ui';

function Tool({ icon, title, text, onClick }: { icon: IconName; title: string; text: string; onClick: () => void }) {
  return (
    <button type="button" class="tool-card" onClick={onClick}>
      <span class="tool-icon">
        <Icon name={icon} />
      </span>
      <span>
        <strong>{title}</strong>
        <small>{text}</small>
      </span>
    </button>
  );
}

async function pickDocuments(title: string, min = 1): Promise<string[] | null> {
  const lib = library();
  const docs = lib.documents().sort((a, b) => b.updatedAt - a.updatedAt);
  if (docs.length < min) {
    toast(min > 1 ? `Il faut au moins ${min} documents` : 'Aucun document', 'info');
    return null;
  }
  const picked: string[] = [];
  for (;;) {
    const remaining = docs.filter((d) => !picked.includes(d.id));
    const options = remaining.slice(0, 60).map((d) => ({ value: d.id, label: d.title, hint: `${d.pages.length} page(s)` }));
    if (picked.length >= min) options.unshift({ value: '__done', label: `✓ Terminer (${picked.length} sélectionné(s))`, hint: picked.map((id) => lib.get(id)?.title).join(' → ') });
    const c = await chooseDialog(`${title} — document ${picked.length + 1}`, options);
    if (c === null) return null;
    if (c === '__done') return picked;
    picked.push(c);
    if (!remaining.length) return picked;
  }
}

function Duplicates() {
  const lib = useLibrary();
  const groups = useMemo<DuplicateGroup[]>(() => findDuplicatePages(lib), [lib.documents().length]);
  return (
    <div class="page">
      <header class="top-bar">
        <IconButton icon="back" label="Retour" onClick={() => goBack('/tools')} />
        <h1>Doublons</h1>
      </header>
      {!groups.length ? (
        <EmptyState icon="check" title="Aucun doublon détecté">
          Les pages sont comparées par empreinte visuelle (et par leur texte lorsqu’il existe).
        </EmptyState>
      ) : (
        groups.map((g) => (
          <section class="card" key={g.hash} style={{ marginBottom: '12px' }}>
            <h3 class="small muted">{g.items.length} pages identiques</h3>
            <div class="row" style={{ alignItems: 'flex-start' }}>
              {g.items.map((it) => (
                <a key={it.page.id} href={`#/doc/${it.doc.id}`} class="dup-item">
                  <BlobImage id={it.page.thumbBlobId} alt="" />
                  <span class="small">
                    {it.doc.title} · p. {it.index + 1}
                  </span>
                </a>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

/** PDF & document tools, backup and restore. */
export function ToolsScreen({ tool }: { tool: string | null }) {
  const lib = useLibrary();
  const [sig, setSig] = useState(false);
  if (tool === 'duplicates') return <Duplicates />;

  const merge = async () => {
    const ids = await pickDocuments('Fusionner', 2);
    if (!ids || ids.length < 2) return;
    const title = await promptDialog('Nom du document fusionné', { value: `Fusion de ${ids.length} documents`, confirmLabel: 'Fusionner' });
    if (title === null) return;
    const d = await withBusy('Fusion…', () => mergeDocuments(lib, ids, title || undefined));
    if (d) navigate(`/doc/${d.id}`);
  };

  const openFor = async (label: string, then: (id: string) => void) => {
    const ids = await pickDocuments(label, 1);
    const first = ids?.[0];
    if (first) then(first);
  };

  const backup = async () => {
    const bytes = await withBusy('Création de la sauvegarde…', () => lib.exportBackup());
    if (!bytes) return;
    const d = new Date().toISOString().slice(0, 10);
    downloadBlob(new Blob([toArrayBuffer(bytes)], { type: 'application/zip' }), `feuillet-sauvegarde-${d}.zip`);
    toast('Sauvegarde téléchargée. Conservez-la en lieu sûr : elle contient tous vos documents.', 'success');
  };

  const restore = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      if (!(await confirmDialog('Restaurer cette sauvegarde ?', 'Les documents de la sauvegarde seront ajoutés ; les documents existants plus récents sont conservés.', { confirmLabel: 'Restaurer' }))) return;
      const r = await withBusy('Restauration…', async () => lib.importBackup(new Uint8Array(await f.arrayBuffer())));
      if (r) toast(`${r.documents} document(s) et ${r.folders} dossier(s) restaurés`, 'success');
    };
    input.click();
  };

  const batchOcr = async () => {
    const pending = lib.documents().filter((d) => d.pages.some((p) => !p.ocr && !p.text));
    if (!pending.length) return toast('Tous les documents ont déjà du texte', 'info');
    if (!(await confirmDialog(`OCR de ${pending.length} document(s)`, 'La reconnaissance s’exécute localement et peut prendre plusieurs minutes.', { confirmLabel: 'Lancer' }))) return;
    for (const d of pending) await ocrFlow(d.id);
  };

  return (
    <div class="page">
      <header class="top-bar">
        <h1>Outils</h1>
      </header>
      <h2 class="section-title">Créer</h2>
      <div class="tool-grid">
        <Tool icon="scan" title="Scanner" text="Caméra avec détection automatique des bords" onClick={() => scanTo()} />
        <Tool icon="upload" title="Importer" text="Photos, PDF, Word, Excel, PowerPoint, texte" onClick={() => openImportPicker()} />
        <Tool icon="signature" title="Mes signatures" text="Dessiner ou importer une signature" onClick={() => setSig(true)} />
      </div>
      <h2 class="section-title">PDF et documents</h2>
      <div class="tool-grid">
        <Tool icon="merge" title="Fusionner" text="Assembler plusieurs documents en un seul" onClick={() => void merge()} />
        <Tool icon="split" title="Diviser / extraire" text="Séparer un document ou en extraire des pages" onClick={() => void openFor('Diviser', (id) => navigate(`/doc/${id}?menu=1`))} />
        <Tool icon="pdf" title="Compresser" text="Exporter un PDF « Petite taille »" onClick={() => void openFor('Compresser', (id) => navigate(`/doc/${id}?export=small`))} />
        <Tool icon="lock" title="Protéger un PDF" text="Mot de passe AES-256 à l’export" onClick={() => void openFor('Protéger', (id) => navigate(`/doc/${id}?export=protect`))} />
        <Tool icon="text" title="OCR par lot" text="Reconnaître le texte de tous les documents" onClick={() => void batchOcr()} />
        <Tool icon="layers" title="Doublons" text="Retrouver les pages scannées plusieurs fois" onClick={() => navigate('/tools/duplicates')} />
      </div>
      <h2 class="section-title">Données</h2>
      <div class="tool-grid">
        <Tool icon="download" title="Sauvegarder" text="Tous les documents dans une archive ZIP" onClick={() => void backup()} />
        <Tool icon="restore" title="Restaurer" text="Réimporter une sauvegarde Feuillet" onClick={restore} />
        <Tool icon="clock" title="Historique" text="Documents créés, ouverts, modifiés, exportés" onClick={() => navigate('/history')} />
        <Tool icon="trash" title="Corbeille" text={`${lib.trash().length} élément(s) — purge après 30 jours`} onClick={() => navigate('/trash')} />
      </div>
      <SignatureSheet open={sig} onClose={() => setSig(false)} onPick={() => (setSig(false), toast('Signature prête : insérez-la depuis « Annoter / signer » sur une page', 'info'))} />
      <p class="muted small" style={{ marginTop: '20px' }}>
        <Icon name="shield" size={14} /> Tous les traitements (détection, filtres, OCR, PDF) s’exécutent sur cet appareil. Aucun document n’est envoyé à un serveur.
      </p>
    </div>
  );
}
