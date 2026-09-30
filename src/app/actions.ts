import type { DocumentRecord } from '../core/docs/model';
import { importFiles } from '../services/importer';
import { runOcr } from '../services/ocr-runner';
import { settings } from '../services/settings';
import { navigate } from './router';
import { chooseDialog, confirmDialog, errorMessage, library, promptDialog, setBusy, toast, withBusy } from './state';

/** High-level user actions shared by several screens. */

let fileInput: HTMLInputElement | null = null;
let pendingFolder: string | null = null;

export const IMPORT_ACCEPT = 'image/*,application/pdf,.pdf,.docx,.xlsx,.pptx,.txt,.doc,.xls,.ppt,text/plain';

function ensureInput(): HTMLInputElement {
  if (!fileInput) {
    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.accept = IMPORT_ACCEPT;
    fileInput.style.display = 'none';
    fileInput.setAttribute('data-testid', 'import-input');
    fileInput.addEventListener('change', () => {
      const files = fileInput?.files ? [...fileInput.files] : [];
      if (fileInput) fileInput.value = '';
      if (files.length) void importFlow(files, pendingFolder);
    });
    document.body.appendChild(fileInput);
  }
  return fileInput;
}

export function openImportPicker(folderId: string | null = null): void {
  pendingFolder = folderId;
  ensureInput().click();
}

/** Imports files with progress, password prompts and a summary; opens the document if only one. */
export async function importFlow(files: File[], folderId: string | null = null): Promise<DocumentRecord[]> {
  const lib = library();
  let merge = false;
  const images = files.filter((f) => f.type.startsWith('image/'));
  if (images.length > 1 && images.length === files.length) {
    const choice = await chooseDialog(`${images.length} photos sélectionnées`, [
      { value: 'merge', label: 'Un seul document multipage', hint: 'Les photos deviennent les pages d’un même document' },
      { value: 'separate', label: 'Un document par photo' },
    ]);
    if (choice === null) return [];
    merge = choice === 'merge';
  }
  setBusy({ label: 'Import en cours…', progress: 0 });
  try {
    const out = await importFiles(lib, files, {
      folderId,
      mergeImages: merge,
      onProgress: (p) => setBusy({ label: p.file ? `${p.file} — ${p.step}` : p.step, progress: p.value }),
      askPassword: async (name, wrong) => {
        setBusy(null);
        const pw = await promptDialog(wrong ? 'Mot de passe incorrect' : 'PDF protégé', {
          message: `« ${name} » est protégé. Saisissez son mot de passe pour l’importer.`,
          inputType: 'password',
          confirmLabel: 'Déverrouiller',
        });
        setBusy({ label: 'Import en cours…' });
        return pw;
      },
    });
    for (const e of out.errors) toast(`${e.file} : ${e.message}`, 'error');
    for (const w of out.warnings.slice(0, 3)) toast(w, 'info');
    if (out.created.length) {
      toast(out.created.length === 1 ? 'Document importé' : `${out.created.length} documents importés`, 'success');
      if (out.created.length === 1) navigate(`/doc/${(out.created[0] as DocumentRecord).id}`);
    }
    return out.created;
  } catch (e) {
    toast(errorMessage(e), 'error');
    return [];
  } finally {
    setBusy(null);
  }
}

/** Moves documents to the trash with an "Undo" action. */
export async function trashWithUndo(ids: string[]): Promise<void> {
  const lib = library();
  await lib.trashDocuments(ids);
  toast(ids.length === 1 ? 'Document placé dans la corbeille' : `${ids.length} documents placés dans la corbeille`, 'info', {
    label: 'Annuler',
    run: () => void lib.restoreDocuments(ids),
  });
}

export async function renameFlow(doc: DocumentRecord): Promise<void> {
  const title = await promptDialog('Renommer', { value: doc.title, confirmLabel: 'Renommer' });
  if (title === null) return;
  try {
    await library().rename(doc.id, title);
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

export async function moveFlow(ids: string[]): Promise<void> {
  const lib = library();
  const options = [{ value: '__root', label: 'Racine (aucun dossier)' }, ...lib.folders().map((f) => ({ value: f.id, label: lib.folderPath(f.id) }))];
  options.push({ value: '__new', label: '＋ Nouveau dossier…' });
  const choice = await chooseDialog('Déplacer vers…', options);
  if (choice === null) return;
  let target: string | null = choice === '__root' ? null : choice;
  if (choice === '__new') {
    const name = await promptDialog('Nouveau dossier', { placeholder: 'Nom du dossier', confirmLabel: 'Créer' });
    if (!name) return;
    try {
      target = (await lib.createFolder(name)).id;
    } catch (e) {
      toast(errorMessage(e), 'error');
      return;
    }
  }
  await lib.moveDocuments(ids, target);
  toast(target ? `Déplacé dans « ${lib.folderPath(target)} »` : 'Déplacé à la racine', 'success');
}

export async function ocrFlow(docId: string, pageIds?: string[], force = false): Promise<void> {
  const lib = library();
  const doc = lib.get(docId);
  if (!doc) return;
  const count = pageIds?.length ?? doc.pages.filter((p) => force || !p.ocr).length;
  if (count === 0) {
    const redo = await confirmDialog('Texte déjà reconnu', 'Toutes les pages ont déjà été traitées. Relancer la reconnaissance ?', {
      confirmLabel: 'Relancer',
    });
    if (!redo) return;
    return ocrFlow(docId, undefined, true);
  }
  const r = await withBusy('Reconnaissance du texte (OCR local)…', (progress) =>
    runOcr(lib, docId, {
      ...(pageIds ? { pageIds } : {}),
      force,
      onProgress: (done, total, p) =>
        progress(done / Math.max(1, total), p ? `Page ${Math.min(total, Math.floor(done) + 1)}/${total} — ${p.status}` : undefined),
    }),
  );
  if (r) toast(`Texte reconnu sur ${count} page(s)`, 'success');
}

export function scanTo(target: { docId?: string; replacePageId?: string; folderId?: string | null } = {}): void {
  const q = new URLSearchParams();
  if (target.docId) q.set('doc', target.docId);
  if (target.replacePageId) q.set('replace', target.replacePageId);
  if (target.folderId) q.set('folder', target.folderId);
  const qs = q.toString();
  navigate(`/scan${qs ? `?${qs}` : ''}`);
}

export function defaultExportOptions() {
  return {
    pageSize: settings.get('exportPageSize'),
    orientation: settings.get('exportOrientation'),
    quality: settings.get('exportQuality'),
    margin: settings.get('exportMargin'),
    searchable: settings.get('searchablePdf'),
    pageNumbers: settings.get('pageNumbers'),
  };
}
