import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import type { DocumentRecord } from '../../core/docs/model';
import { documentFormatLabel } from '../../core/docs/model';
import { KIND_LABELS } from '../../core/ocr/analysis';
import type { DocumentKind, InvoiceData } from '../../core/ocr/analysis';
import { errorMessage, library, toast } from '../../app/state';
import { documentWordCount } from '../../services/doc-tools';
import { Icon } from './Icon';
import { Button, formatBytes, formatDate, Sheet } from './ui';

function money(v: number | undefined, cur?: string): string {
  if (v === undefined) return '—';
  try {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: cur ?? 'EUR' }).format(v);
  } catch {
    return v.toFixed(2);
  }
}

export function InvoiceCard({ invoice }: { invoice: InvoiceData }) {
  const rows: Array<[string, string]> = [];
  if (invoice.company) rows.push(['Entreprise', invoice.company]);
  if (invoice.number) rows.push(['N° de facture', invoice.number]);
  if (invoice.date) rows.push(['Date', new Date(invoice.date).toLocaleDateString('fr-FR')]);
  if (invoice.totalHT !== undefined) rows.push(['Montant HT', money(invoice.totalHT, invoice.currency)]);
  if (invoice.vat !== undefined) rows.push(['TVA', money(invoice.vat, invoice.currency)]);
  if (invoice.totalTTC !== undefined) rows.push(['Montant TTC', money(invoice.totalTTC, invoice.currency)]);
  if (!rows.length) return null;
  return (
    <section class="card invoice-card" aria-label="Données extraites de la facture">
      <h3 class="row">
        <Icon name="receipt" size={18} /> Données extraites
      </h3>
      <dl class="kv">
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </Fragment>
        ))}
      </dl>
      <small class="muted">Extraction automatique depuis l’OCR : vérifiez les valeurs.</small>
    </section>
  );
}

/** Tags, notes, classification and technical information of a document. */
export function DocDetailsSheet({ doc, open, onClose }: { doc: DocumentRecord; open: boolean; onClose: () => void }) {
  const lib = library();
  const [tagInput, setTagInput] = useState('');
  const [notes, setNotes] = useState(doc.notes);
  const suggestions = lib.allTags().filter((t) => !doc.tags.includes(t) && (!tagInput || t.startsWith(tagInput.toLowerCase()))).slice(0, 8);

  const addTag = async (t: string) => {
    const v = t.trim().toLowerCase();
    if (!v) return;
    await lib.setTags(doc.id, [...doc.tags, v]);
    setTagInput('');
  };

  return (
    <Sheet open={open} onClose={onClose} title="Détails du document">
      <div class="field">
        <span>Étiquettes</span>
        <div class="tag-list">
          {doc.tags.map((t) => (
            <span class="tag" key={t}>
              {t}
              <button type="button" aria-label={`Retirer l’étiquette ${t}`} onClick={() => void lib.setTags(doc.id, doc.tags.filter((x) => x !== t))}>
                <Icon name="close" size={14} />
              </button>
            </span>
          ))}
          {!doc.tags.length ? <span class="muted small">Aucune étiquette</span> : null}
        </div>
        <form
          class="row"
          onSubmit={(e) => {
            e.preventDefault();
            void addTag(tagInput);
          }}
        >
          <input class="text-input" style={{ flex: 1 }} value={tagInput} placeholder="Ajouter une étiquette" aria-label="Nouvelle étiquette" onInput={(e) => setTagInput((e.target as HTMLInputElement).value)} />
          <Button type="submit" icon="plus">
            Ajouter
          </Button>
        </form>
        {suggestions.length ? (
          <div class="chips">
            {suggestions.map((t) => (
              <button type="button" key={t} class="chip" onClick={() => void addTag(t)}>
                {t}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <label class="field">
        <span>Type de document</span>
        <select
          class="select"
          value={doc.kind ?? ''}
          onChange={async (e) => {
            const v = (e.target as HTMLSelectElement).value as DocumentKind | '';
            const next = { ...doc };
            if (v) next.kind = v;
            else delete next.kind;
            try {
              await lib.saveDocument(next, null);
            } catch (err) {
              toast(errorMessage(err), 'error');
            }
          }}
        >
          <option value="">Non classé</option>
          {(Object.keys(KIND_LABELS) as DocumentKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </label>

      <label class="field">
        <span>Notes</span>
        <textarea class="text-input" style={{ fontFamily: 'inherit', minHeight: '90px' }} value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} onBlur={() => notes !== doc.notes && void lib.setNotes(doc.id, notes)} placeholder="Notes personnelles (incluses dans la recherche)" />
      </label>

      {doc.invoice ? <InvoiceCard invoice={doc.invoice} /> : null}

      <dl class="kv" style={{ marginTop: '14px' }}>
        <dt>Format</dt>
        <dd>{documentFormatLabel(doc)}</dd>
        <dt>Pages</dt>
        <dd>{doc.pages.length}</dd>
        <dt>Taille stockée</dt>
        <dd>{formatBytes(doc.sizeBytes)}</dd>
        <dt>Dossier</dt>
        <dd>{doc.folderId ? lib.folderPath(doc.folderId) : 'Racine'}</dd>
        <dt>Créé</dt>
        <dd>{formatDate(doc.createdAt, true)}</dd>
        <dt>Modifié</dt>
        <dd>{formatDate(doc.updatedAt, true)}</dd>
        <dt>Texte</dt>
        <dd>{documentWordCount(doc)} mots</dd>
        {doc.originalFile ? (
          <>
            <dt>Fichier source</dt>
            <dd>
              {doc.originalFile.name} ({formatBytes(doc.originalFile.size)})
            </dd>
          </>
        ) : null}
        <dt>Identifiant</dt>
        <dd class="small muted">{doc.id}</dd>
      </dl>
    </Sheet>
  );
}
