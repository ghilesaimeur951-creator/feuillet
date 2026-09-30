import type { DocumentRecord, Page } from '../core/docs/model';
import { classifyDocument, extractInvoiceData } from '../core/ocr/analysis';
import { parseDocx } from '../core/office/docx';
import type { ExtractedDocument } from '../core/office/model';
import { parsePptx, parseTxt } from '../core/office/pptx';
import { parseXlsx } from '../core/office/xlsx';
import { classifyImport, DEFAULT_IMPORT_LIMITS, ImportError, ooxmlKindFromContentTypes, sanitizeFileName } from '../core/security/validate';
import { toArrayBuffer } from '../core/util/bytes';
import { ZipArchive } from '../core/zip/zip';
import type { Library } from './library';
import { renderExtractedDocument } from './office-render';
import { createPage } from './pages';
import { PdfPasswordError, renderPdf } from './pdfjs';
import { processing } from './processing/client';
import { settings } from './settings';

export interface ImportProgress {
  file: string;
  step: string;
  /** 0..1 over all files. */
  value: number;
}

export interface ImportOptions {
  folderId?: string | null;
  /** Several photos → one multi-page document (otherwise one document per photo). */
  mergeImages?: boolean;
  onProgress?: (p: ImportProgress) => void;
  /** Called when a PDF is password-protected; resolve null to skip the file. */
  askPassword?: (fileName: string, wrong: boolean) => Promise<string | null>;
}

export interface ImportOutcome {
  created: DocumentRecord[];
  errors: Array<{ file: string; message: string }>;
  warnings: string[];
}

function baseName(name: string): string {
  const clean = sanitizeFileName(name);
  const i = clean.lastIndexOf('.');
  return i > 0 ? clean.slice(0, i) : clean;
}

function mimeFor(kind: string, fallback: string): string {
  return (
    (
      {
        pdf: 'application/pdf',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        txt: 'text/plain',
      } as Record<string, string>
    )[kind] ?? fallback
  );
}

/** Imports images, PDF, DOCX, XLSX, PPTX and TXT files after validating their real content. */
export async function importFiles(lib: Library, files: readonly File[], opts: ImportOptions = {}): Promise<ImportOutcome> {
  const outcome: ImportOutcome = { created: [], errors: [], warnings: [] };
  const imagePages: Page[] = [];
  const imageNames: string[] = [];
  const total = files.length;
  const report = (i: number, file: string, step: string, frac = 0) => opts.onProgress?.({ file, step, value: (i + frac) / Math.max(1, total) });

  for (const [i, file] of files.entries()) {
    try {
      report(i, file.name, 'Vérification');
      if (file.size > DEFAULT_IMPORT_LIMITS.maxPdfBytes) throw new ImportError(`« ${file.name} » est trop volumineux.`, 'too-large');
      const bytes = new Uint8Array(await file.arrayBuffer());
      let zipKind: 'docx' | 'xlsx' | 'pptx' | null = null;
      let zip: ZipArchive | null = null;
      if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
        try {
          zip = ZipArchive.open(bytes);
          zipKind = zip.has('[Content_Types].xml') ? ooxmlKindFromContentTypes(await zip.readText('[Content_Types].xml')) : null;
        } catch (e) {
          throw new ImportError(`Archive illisible : ${e instanceof Error ? e.message : String(e)}`, 'unsupported');
        }
      }
      const kind = classifyImport(file.name, bytes, zipKind);
      const title = baseName(file.name);

      if (kind === 'image') {
        report(i, file.name, 'Analyse de l’image', 0.3);
        const blob = new Blob([toArrayBuffer(bytes)], { type: file.type || 'image/jpeg' });
        const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(() => {
          throw new ImportError(`Image « ${file.name} » illisible.`, 'unsupported');
        });
        const size = { width: bmp.width, height: bmp.height };
        bmp.close();
        if (size.width * size.height > DEFAULT_IMPORT_LIMITS.maxImagePixels)
          throw new ImportError('Image trop grande (plus de 60 mégapixels).', 'too-large');
        const det = settings.get('importAutoCrop') ? await processing.detect(blob) : { quad: null };
        report(i, file.name, 'Traitement', 0.6);
        const page = await createPage(lib, {
          original: blob,
          width: size.width,
          height: size.height,
          quad: det.quad,
          filter: det.quad ? settings.get('defaultFilter') : 'original',
        });
        if (opts.mergeImages) {
          imagePages.push(page);
          imageNames.push(title);
        } else {
          outcome.created.push(await lib.createDocument({ title, pages: [page], source: 'image', folderId: opts.folderId ?? null }, 'imported'));
        }
        continue;
      }

      if (kind === 'pdf') {
        let password: string | undefined;
        let rendered: Awaited<ReturnType<typeof renderPdf>> | null = null;
        for (let attempt = 0; attempt < 4 && !rendered; attempt++) {
          try {
            rendered = await renderPdf(bytes, {
              ...(password ? { password } : {}),
              onProgress: (d, t) => report(i, file.name, `Page ${d}/${t}`, (d / t) * 0.6),
            });
          } catch (e) {
            if (!(e instanceof PdfPasswordError) || !opts.askPassword) throw e;
            const pw = await opts.askPassword(file.name, e.wrong);
            if (pw === null) break;
            password = pw;
          }
        }
        if (!rendered) {
          outcome.errors.push({ file: file.name, message: 'Import annulé (mot de passe requis).' });
          continue;
        }
        const pages: Page[] = [];
        for (const [pi, rp] of rendered.pages.entries()) {
          report(i, file.name, `Enregistrement ${pi + 1}/${rendered.pages.length}`, 0.6 + (0.4 * pi) / rendered.pages.length);
          pages.push(
            await createPage(lib, {
              original: rp.image,
              width: rp.width,
              height: rp.height,
              quad: null,
              filter: 'original',
              text: rp.text,
              textWords: rp.words,
              snapRatio: false,
            }),
          );
        }
        if (!pages.length) throw new ImportError('Ce PDF ne contient aucune page.', 'empty');
        const originalBlobId = await lib.putBlob(new Blob([toArrayBuffer(bytes)], { type: 'application/pdf' }));
        outcome.created.push(
          await finalize(lib, {
            title: rendered.title && rendered.title.length > 2 ? rendered.title : title,
            pages,
            source: 'pdf',
            folderId: opts.folderId ?? null,
            originalFile: { blobId: originalBlobId, name: sanitizeFileName(file.name), mime: 'application/pdf', size: bytes.length },
          }),
        );
        continue;
      }

      // Office and text documents: parse → lay out → render real pages.
      report(i, file.name, 'Conversion', 0.2);
      let extracted: ExtractedDocument;
      if (kind === 'txt') extracted = parseTxt(bytes);
      else if (kind === 'docx') extracted = await parseDocx(zip as ZipArchive);
      else if (kind === 'xlsx') extracted = await parseXlsx(zip as ZipArchive);
      else extracted = await parsePptx(zip as ZipArchive);
      outcome.warnings.push(...extracted.warnings.map((w) => `${file.name} : ${w}`));
      const rendered = await renderExtractedDocument(extracted, (d, t) => report(i, file.name, `Mise en page ${d}/${t}`, 0.2 + (d / t) * 0.4));
      const pages: Page[] = [];
      for (const [pi, rp] of rendered.entries()) {
        report(i, file.name, `Enregistrement ${pi + 1}/${rendered.length}`, 0.6 + (0.4 * pi) / rendered.length);
        pages.push(
          await createPage(lib, {
            original: rp.image,
            width: rp.width,
            height: rp.height,
            quad: null,
            filter: 'original',
            text: rp.text,
            textWords: rp.words,
            snapRatio: false,
          }),
        );
      }
      const originalBlobId = await lib.putBlob(new Blob([toArrayBuffer(bytes)], { type: mimeFor(kind, file.type) }));
      outcome.created.push(
        await finalize(lib, {
          title: extracted.title && extracted.title.length > 2 ? extracted.title : title,
          pages,
          source: kind,
          folderId: opts.folderId ?? null,
          originalFile: { blobId: originalBlobId, name: sanitizeFileName(file.name), mime: mimeFor(kind, file.type), size: bytes.length },
        }),
      );
    } catch (e) {
      outcome.errors.push({ file: file.name, message: e instanceof Error ? e.message : String(e) });
    }
  }

  if (imagePages.length) {
    const title = imagePages.length === 1 ? (imageNames[0] as string) : `Import du ${new Date().toLocaleDateString('fr-FR')}`;
    outcome.created.push(await lib.createDocument({ title, pages: imagePages, source: 'image', folderId: opts.folderId ?? null }, 'imported'));
  }
  opts.onProgress?.({ file: '', step: 'Terminé', value: 1 });
  return outcome;
}

async function finalize(lib: Library, input: Parameters<Library['createDocument']>[0]): Promise<DocumentRecord> {
  const text = input.pages.map((p) => p.text ?? '').join('\n');
  const { kind } = classifyDocument(text);
  const invoice = kind === 'facture' || kind === 'recu' ? extractInvoiceData(text) : undefined;
  return lib.createDocument({ ...input, ...(kind ? { kind } : {}), ...(invoice ? { invoice } : {}) }, 'imported');
}
