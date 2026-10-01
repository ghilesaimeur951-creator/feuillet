import { useMemo, useState } from 'preact/hooks';
import type { DocumentRecord } from '../../core/docs/model';
import { estimatePdfSize, QUALITY_PROFILES } from '../../core/pdf/layout';
import type { OrientationId, PageSizeId, QualityProfile } from '../../core/pdf/layout';
import { exportFileName } from '../../core/security/validate';
import { defaultExportOptions } from '../../app/actions';
import { errorMessage, library, toast, withBusy } from '../../app/state';
import { canShareFiles, downloadBlob, exportDocx, exportImages, exportPdf, exportText, printPdf, shareBlob } from '../../services/exporter';
import { Button, formatBytes, Segmented, Sheet, Slider, Switch } from './ui';

type Format = 'pdf' | 'jpeg' | 'png' | 'txt' | 'docx' | 'original';

/** Export / share / print sheet with real PDF options and a size estimate. */
export function ExportSheet({
  doc,
  open,
  onClose,
  pageIds,
  preset,
}: {
  doc: DocumentRecord;
  open: boolean;
  onClose: () => void;
  pageIds?: string[];
  preset?: 'small' | 'protect';
}) {
  const d = defaultExportOptions();
  const [format, setFormat] = useState<Format>('pdf');
  const [pageSize, setPageSize] = useState<PageSizeId>(d.pageSize);
  const [orientation, setOrientation] = useState<OrientationId>(d.orientation);
  const [quality, setQuality] = useState<QualityProfile['id']>(preset === 'small' ? 'small' : d.quality);
  const [margin, setMargin] = useState(d.margin);
  const [searchable, setSearchable] = useState(d.searchable);
  const [pageNumbers, setPageNumbers] = useState(d.pageNumbers);
  const [watermark, setWatermark] = useState('');
  const [protect, setProtect] = useState(preset === 'protect');
  const [password, setPassword] = useState('');
  const [docxImages, setDocxImages] = useState(true);
  const shareable = canShareFiles();
  const pages = pageIds?.length ? doc.pages.filter((p) => pageIds.includes(p.id)) : doc.pages;
  const hasText = pages.some((p) => (p.ocr?.text ?? p.text ?? '').trim());
  const hasWords = pages.some((p) => (p.ocr?.words.length ?? 0) > 0 || (p.textWords?.length ?? 0) > 0);
  const profile = QUALITY_PROFILES.find((p) => p.id === quality) as QualityProfile;
  const estimate = useMemo(
    () =>
      estimatePdfSize(
        pages.map((p) => ({ width: p.width, height: p.height, grayscale: p.filter === 'bw' || p.filter === 'grayscale' })),
        profile,
      ),
    [pages, profile],
  );

  const build = async (): Promise<{ blob: Blob; filename: string } | undefined> => {
    const lib = library();
    return withBusy('Préparation de l’export…', async (progress) => {
      switch (format) {
        case 'pdf': {
          if (protect && password.length < 4) throw new Error('Le mot de passe doit contenir au moins 4 caractères');
          const blob = await exportPdf(
            lib,
            doc,
            {
              pageSize,
              orientation,
              quality,
              margin,
              searchable,
              pageNumbers,
              ...(watermark.trim() ? { watermark } : {}),
              ...(protect ? { password } : {}),
              ...(pageIds?.length ? { pageIds } : {}),
            },
            (done, total) => progress(done / total, `Page ${done}/${total}…`),
          );
          return { blob, filename: exportFileName(doc.title, 'pdf') };
        }
        case 'jpeg':
        case 'png':
          return exportImages(lib, doc, format, pageIds);
        case 'txt':
          return exportText(doc);
        case 'docx':
          return exportDocx(lib, doc, docxImages);
        case 'original': {
          const f = doc.originalFile;
          const blob = f ? await lib.getBlob(f.blobId) : undefined;
          if (!f || !blob) throw new Error('Fichier original indisponible');
          return { blob, filename: f.name };
        }
      }
    });
  };

  const log = (what: string) => void library().log('exported', doc, what);

  const download = async () => {
    const r = await build();
    if (!r) return;
    downloadBlob(r.blob, r.filename);
    log(`${r.filename} (${formatBytes(r.blob.size)})`);
    toast(`${r.filename} — ${formatBytes(r.blob.size)}`, 'success');
    onClose();
  };

  const share = async () => {
    const r = await build();
    if (!r) return;
    try {
      const res = await shareBlob(r.blob, r.filename, doc.title);
      if (res === 'unsupported') {
        downloadBlob(r.blob, r.filename);
        toast('Partage non disponible : fichier téléchargé', 'info');
      } else if (res === 'shared') log(`Partagé : ${r.filename}`);
      onClose();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const print = async () => {
    const blob = await withBusy('Préparation de l’impression…', () =>
      exportPdf(library(), doc, {
        pageSize,
        orientation,
        quality: 'high',
        margin,
        searchable: false,
        pageNumbers,
        ...(pageIds?.length ? { pageIds } : {}),
      }),
    );
    if (blob) {
      printPdf(blob, exportFileName(doc.title, 'pdf'));
      log('Impression');
    }
  };

  const formats: Array<{ value: Format; label: string }> = [
    { value: 'pdf', label: 'PDF' },
    { value: 'jpeg', label: 'JPG' },
    { value: 'png', label: 'PNG' },
    { value: 'docx', label: 'Word' },
    { value: 'txt', label: 'Texte' },
  ];
  if (doc.originalFile) formats.push({ value: 'original', label: 'Original' });

  return (
    <Sheet open={open} onClose={onClose} title={`Exporter ${pageIds?.length ? `${pageIds.length} page(s)` : `« ${doc.title} »`}`} wide>
      <div class="field">
        <span>Format</span>
        <Segmented label="Format d’export" value={format} options={formats} onChange={setFormat} />
      </div>

      {format === 'pdf' ? (
        <>
          <div class="field">
            <span>Qualité et taille</span>
            <Segmented
              label="Profil de compression"
              value={quality}
              options={QUALITY_PROFILES.map((p) => ({ value: p.id, label: p.label }))}
              onChange={setQuality}
            />
            <small class="muted">
              Taille estimée : <strong>≈ {formatBytes(estimate)}</strong> · {pages.length} page(s) · {profile.maxSide} px max
            </small>
          </div>
          <div class="row" style={{ gap: '12px', alignItems: 'flex-start' }}>
            <label class="field" style={{ flex: 1, minWidth: '140px' }}>
              <span>Format de page</span>
              <select class="select" value={pageSize} onChange={(e) => setPageSize((e.target as HTMLSelectElement).value as PageSizeId)}>
                <option value="A4">A4</option>
                <option value="Letter">Letter (US)</option>
                <option value="auto">Automatique (taille de l’image)</option>
              </select>
            </label>
            <label class="field" style={{ flex: 1, minWidth: '140px' }}>
              <span>Orientation</span>
              <select
                class="select"
                value={orientation}
                disabled={pageSize === 'auto'}
                onChange={(e) => setOrientation((e.target as HTMLSelectElement).value as OrientationId)}
              >
                <option value="auto">Automatique</option>
                <option value="portrait">Portrait</option>
                <option value="landscape">Paysage</option>
              </select>
            </label>
          </div>
          <Slider
            label="Marges"
            value={margin}
            min={0}
            max={72}
            step={6}
            onInput={setMargin}
            format={(v) => (v ? `${Math.round(v / 2.835)} mm` : 'aucune')}
          />
          <Switch
            checked={searchable && hasWords}
            disabled={!hasWords}
            onChange={setSearchable}
            label="PDF recherchable"
            hint={
              hasWords
                ? 'Couche de texte invisible (OCR) : sélection et recherche dans tout lecteur PDF'
                : 'Lancez l’OCR du document pour activer cette option'
            }
          />
          <Switch checked={pageNumbers} onChange={setPageNumbers} label="Numéroter les pages" />
          <label class="field">
            <span>Filigrane (facultatif)</span>
            <input
              class="text-input"
              value={watermark}
              maxLength={40}
              placeholder="ex. COPIE, CONFIDENTIEL"
              onInput={(e) => setWatermark((e.target as HTMLInputElement).value)}
            />
          </label>
          <Switch
            checked={protect}
            onChange={setProtect}
            label="Protéger par mot de passe"
            hint="Chiffrement AES-256 : le PDF ne s’ouvre qu’avec ce mot de passe"
          />
          {protect ? (
            <label class="field">
              <span>Mot de passe</span>
              <input
                class="text-input"
                type="password"
                autoComplete="new-password"
                value={password}
                onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
              />
            </label>
          ) : null}
        </>
      ) : null}
      {format === 'docx' ? (
        <Switch
          checked={docxImages}
          onChange={setDocxImages}
          label="Inclure les images des pages"
          hint={hasText ? 'Le texte reconnu est ajouté sous chaque page' : 'Aucun texte reconnu : seules les images seront incluses'}
        />
      ) : null}
      {(format === 'txt' || (format === 'docx' && !docxImages)) && !hasText ? (
        <p class="banner banner-info">Ce document n’a pas encore de texte : lancez l’OCR d’abord.</p>
      ) : null}
      {format === 'jpeg' || format === 'png' ? (
        <p class="muted small">
          {pages.length > 1 ? `${pages.length} images réunies dans une archive ZIP.` : 'Une image.'} Annotations et signatures incluses.
        </p>
      ) : null}

      <div class="dialog-actions" style={{ flexWrap: 'wrap' }}>
        {format === 'pdf' ? (
          <Button icon="print" variant="ghost" onClick={() => void print()}>
            Imprimer
          </Button>
        ) : null}
        {shareable ? (
          <Button icon="share" onClick={() => void share()}>
            Partager
          </Button>
        ) : null}
        <Button icon="download" variant="primary" onClick={() => void download()} data-testid="export-download">
          Télécharger
        </Button>
      </div>
    </Sheet>
  );
}
