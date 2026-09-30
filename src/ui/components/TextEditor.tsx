import { useMemo, useState } from 'preact/hooks';
import type { DocumentRecord, Page } from '../../core/docs/model';
import { normalize } from '../../core/search/text';
import { exportFileName } from '../../core/security/validate';
import { ocrFlow } from '../../app/actions';
import { library, toast } from '../../app/state';
import { downloadBlob } from '../../services/exporter';
import { saveEditedText } from '../../services/ocr-runner';
import { settings } from '../../services/settings';
import { OCR_LANGUAGES } from '../../services/config';
import { Icon } from './Icon';
import { BlobImage, Button, EmptyState } from './ui';

/** Recognised text of a page: run OCR, read, search, edit, copy and export. */
export function TextEditor({ doc, page }: { doc: DocumentRecord; page: Page }) {
  const text = page.ocr?.text ?? page.text ?? '';
  const [draft, setDraft] = useState(text);
  const [editing, setEditing] = useState(false);
  const [find, setFind] = useState('');
  const langs = settings.get('ocrLanguages');

  const matches = useMemo(() => {
    const n = normalize(find);
    if (!n) return 0;
    return normalize(text).split(n).length - 1;
  }, [find, text]);

  const highlighted = useMemo(() => {
    const n = find.trim();
    if (!n) return [text];
    const re = new RegExp(`(${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
  }, [find, text]);

  if (!text && !page.ocr) {
    return (
      <div class="editor-split">
        <div class="editor-stage">
          <BlobImage id={page.processedBlobId} alt="Page" class="preview-img" />
        </div>
        <div class="editor-panel">
          <EmptyState icon="text" title="Pas encore de texte">
            La reconnaissance (OCR) s’exécute entièrement sur votre appareil (
            {langs.map((l) => OCR_LANGUAGES.find((x) => x.code === l)?.label ?? l).join(', ')}). Aucune donnée n’est envoyée.
          </EmptyState>
          <Button variant="primary" icon="text" size="lg" onClick={() => void ocrFlow(doc.id, [page.id], true)}>
            Reconnaître le texte
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div class="editor-split">
      <div class="editor-stage">
        <BlobImage id={page.processedBlobId} alt="Page" class="preview-img" />
      </div>
      <div class="editor-panel">
        <div class="row">
          {page.ocr ? (
            <span class="pill pill-primary">
              OCR {page.ocr.language} · confiance {Math.round(page.ocr.confidence)} %{page.ocr.edited ? ' · corrigé' : ''}
            </span>
          ) : (
            <span class="pill">Texte importé</span>
          )}
        </div>
        {editing ? (
          <>
            <textarea
              class="text-input ocr-text"
              value={draft}
              onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
              aria-label="Texte reconnu (modifiable)"
            />
            <div class="row">
              <Button variant="ghost" onClick={() => (setDraft(text), setEditing(false))}>
                Annuler
              </Button>
              <Button
                variant="primary"
                icon="check"
                onClick={async () => {
                  await saveEditedText(library(), doc.id, page.id, draft);
                  setEditing(false);
                  toast('Texte enregistré — la recherche en tient compte', 'success');
                }}
              >
                Enregistrer
              </Button>
            </div>
          </>
        ) : (
          <>
            <label class="search-field">
              <Icon name="search" />
              <input
                value={find}
                placeholder="Rechercher dans le texte"
                aria-label="Rechercher dans le texte de la page"
                onInput={(e) => setFind((e.target as HTMLInputElement).value)}
              />
              {find ? <span class="small">{matches} résultat(s)</span> : null}
            </label>
            <pre class="ocr-text ocr-view search-hit" tabIndex={0} aria-label="Texte reconnu">
              {highlighted}
            </pre>
            <div class="row">
              <Button
                icon="copy"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(text);
                    toast('Texte copié', 'success');
                  } catch {
                    toast('Copie impossible : sélectionnez le texte manuellement', 'error');
                  }
                }}
              >
                Copier
              </Button>
              <Button icon="pen" onClick={() => (setDraft(text), setEditing(true))}>
                Modifier
              </Button>
              <Button
                icon="download"
                onClick={() =>
                  downloadBlob(new Blob([`\ufeff${text}`], { type: 'text/plain;charset=utf-8' }), exportFileName(`${doc.title} - page`, 'txt'))
                }
              >
                .txt
              </Button>
              <Button variant="ghost" icon="reset" onClick={() => void ocrFlow(doc.id, [page.id], true)}>
                Relancer l’OCR
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
