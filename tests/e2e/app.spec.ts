import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const FIX = join(HERE, '..', 'fixtures');

async function freshApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Aucun document pour l’instant' })).toBeVisible();
}

async function thumbSources(page: Page): Promise<string[]> {
  return page.locator('.page-grid .page-thumb img').evaluateAll((els) => els.map((e) => (e as HTMLImageElement).src));
}

test.describe('Definition of Done — parcours principal', () => {
  test('scanner → coins → recadrage → filtre → multipage → PDF → bibliothèque → dossier → OCR → recherche', async ({ page }) => {
    await freshApp(page);

    // 1-2. Open the scanner (camera permission granted by the test context).
    await page.locator('.scan-fab').click();
    await expect(page).toHaveURL(/#\/scan/);

    // Manual mode for this test: disable auto-capture and use multipage mode.
    await page.getByRole('button', { name: /Capture automatique activée/ }).click();
    await page.getByRole('radio', { name: 'Multipage' }).click();

    // 3-5. The four corners are detected in real time and drawn over the video.
    const status = page.getByTestId('scan-status');
    await expect(status).toContainText('Document détecté');
    const points = await page.locator('.live-quad').getAttribute('points');
    expect(points?.trim().split(/\s+/)).toHaveLength(4);
    await expect(page.locator('.live-quad')).toHaveCSS('opacity', '1');

    // 6. Manual captures (two pages).
    await page.getByTestId('shutter').click();
    await expect(page.locator('.session-thumb .badge')).toHaveText('1');
    await page.waitForTimeout(1700); // auto-capture cooldown also applies to manual shots
    await page.getByTestId('shutter').click();
    await expect(page.locator('.session-thumb .badge')).toHaveText('2');
    await page.getByRole('button', { name: 'Terminer' }).click();

    // 7. Review: the detected quad is editable; move P1 with the keyboard.
    await expect(page).toHaveURL(/#\/review/);
    const p1 = page.getByRole('slider', { name: /Coin supérieur gauche/ });
    await expect(p1).toBeVisible();
    const before = await p1.getAttribute('cx');
    await p1.focus();
    await page.keyboard.press('ArrowRight');
    expect(Number(await p1.getAttribute('cx'))).toBeGreaterThan(Number(before));
    await page.getByRole('button', { name: 'Réinitialiser' }).click();

    // 8. Validate: perspective correction + default filter → document with 2 pages.
    await page.getByTestId('review-validate').click();
    await expect(page).toHaveURL(/#\/doc\//, { timeout: 30_000 });
    await expect(page.locator('.page-grid .page-tile')).toHaveCount(2);

    // 11. Reorder pages (keyboard drag-and-drop equivalent).
    const order1 = await thumbSources(page);
    await page.locator('.page-grid .page-btn').nth(1).focus();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect.poll(() => thumbSources(page)).toEqual([order1[1], order1[0]]);

    // 9. Apply a filter to page 1.
    await page.locator('.page-grid .page-btn').first().click();
    await page.getByRole('menuitem', { name: /Filtres et réglages/ }).click();
    await expect(page.locator('.preview-img')).toBeVisible();
    await page.getByRole('radio', { name: 'N&B' }).click();
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page).toHaveURL(/#\/doc\/[^/]+$/, { timeout: 30_000 });

    // 17. OCR runs automatically after the scan (local Tesseract).
    await expect(page.getByText('OCR 2/2')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Facture');

    // 12-13. Real PDF export and download.
    await page.getByTestId('export-open').click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-download').click()]);
    const path = await download.path();
    const fs = await import('node:fs');
    const pdf = fs.readFileSync(path as string);
    const text = new TextDecoder('latin1').decode(pdf);
    expect(text.slice(0, 8)).toBe('%PDF-1.7');
    expect(text.match(/\/Type \/Page\b/g)?.length).toBe(2);
    // Searchable PDF: the invisible OCR text layer is extractable by standard tools.
    const { spawnSync } = await import('node:child_process');
    const extracted = spawnSync('pdftotext', [path as string, '-'], { encoding: 'utf8' });
    if (extracted.status === 0) expect(extracted.stdout).toMatch(/4471/);
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);

    // 15. Close and reopen the application: the document is still there.
    const docUrl = page.url();
    await page.goto('about:blank');
    await page.goto('/');
    await expect(page.locator('.doc-card').first()).toBeVisible();
    await page.goto(docUrl);
    await expect(page.locator('.page-grid .page-tile')).toHaveCount(2);

    // 16. File the document in a new folder.
    await page.getByRole('button', { name: 'Plus d’actions' }).click();
    await page.getByRole('menuitem', { name: 'Déplacer dans un dossier' }).click();
    await page.getByRole('button', { name: /Nouveau dossier/ }).click();
    await page.getByRole('textbox').fill('Énergie');
    await page.getByRole('button', { name: 'Créer' }).click();
    await expect(page.locator('.doc-summary')).toContainText('Énergie');

    // 18. Full-text search on the OCR content (the title does not contain these words).
    await page.goto('/#/search');
    await page.getByRole('searchbox', { name: 'Rechercher' }).fill('numero client 4471');
    await expect(page.locator('.doc-row')).toHaveCount(1);
    await expect(page.locator('.snippet mark').first()).toBeVisible();
    await page.getByRole('searchbox', { name: 'Rechercher' }).fill('energie');
    await expect(page.locator('.doc-row')).toHaveCount(1);
  });

  test('capture automatique en mode document', async ({ page }) => {
    await freshApp(page);
    await page.goto('/#/scan');
    // Auto-capture is on by default: the page goes to the review screen by itself.
    await expect(page).toHaveURL(/#\/review/, { timeout: 20_000 });
    await expect(page.getByRole('slider', { name: /Coin inférieur droit/ })).toBeVisible();
  });
});

test.describe('import et conversions', () => {
  test('PDF, DOCX, XLSX, PPTX, TXT importés ; ancien .doc refusé avec explication', async ({ page }) => {
    await freshApp(page);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Importer des fichiers' }).first().click();
    const fc = await chooser;
    await fc.setFiles(['sample.pdf', 'sample.docx', 'releve.xlsx', 'deck.pptx', 'notes.txt', 'legacy.doc'].map((f) => join(FIX, 'office', f)));
    await expect(page.getByText(/ancien format binaire Microsoft Office/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('5 documents importés')).toBeVisible({ timeout: 60_000 });
    await page.goto('/');
    await expect(page.locator('.doc-grid .doc-card')).toHaveCount(5);

    // Imported text is searchable without OCR.
    await page.goto('/#/search?q=prévisionnel');
    await expect(page.locator('.doc-row')).toHaveCount(1);
    await page.getByRole('searchbox').fill('Rapport trimestriel');
    await expect(page.locator('.doc-row')).toHaveCount(2); // DOCX + its PDF version
  });

  test('glisser-déposer de plusieurs photos → un document multipage', async ({ page }) => {
    await freshApp(page);
    const fs = await import('node:fs');
    const files = ['white-on-dark.png', 'strong-perspective.png'].map((f) => ({
      name: f,
      data: fs.readFileSync(join(FIX, 'cv', f)).toString('base64'),
    }));
    await page.evaluate(async (list) => {
      const dt = new DataTransfer();
      for (const f of list) {
        const bin = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
        dt.items.add(new File([bin], f.name, { type: 'image/png' }));
      }
      for (const type of ['dragenter', 'dragover', 'drop'])
        window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, files);
    await page.getByRole('button', { name: /Un seul document multipage/ }).click();
    await expect(page).toHaveURL(/#\/doc\//, { timeout: 30_000 });
    await expect(page.locator('.page-grid .page-tile')).toHaveCount(2);
  });
});

test.describe('organisation', () => {
  test('corbeille, restauration, favoris, thème sombre et accessibilité de base', async ({ page }) => {
    await freshApp(page);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Importer des fichiers' }).first().click();
    await (await chooser).setFiles([join(FIX, 'office', 'notes.txt')]);
    await expect(page).toHaveURL(/#\/doc\//, { timeout: 30_000 });
    await page.getByRole('button', { name: 'Ajouter aux favoris' }).click();
    await page.getByRole('button', { name: 'Plus d’actions' }).click();
    await page.getByRole('menuitem', { name: 'Mettre à la corbeille' }).click();
    await expect(page).toHaveURL(/#\/$/);
    await page.goto('/#/trash');
    await expect(page.locator('.doc-row')).toHaveCount(1);
    await page.locator('.doc-row').click();
    await page.getByRole('button', { name: 'Restaurer' }).click();
    await page.goto('/#/?view=favorites');
    await expect(page.locator('.doc-card')).toHaveCount(1);

    await page.goto('/#/settings');
    await page.getByRole('radio', { name: 'Sombre' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // Every interactive control has an accessible name.
    for (const route of ['/', '/#/search', '/#/folders', '/#/tools', '/#/settings']) {
      await page.goto(route);
      const unnamed = await page.$$eval('button, a[href], input, select, textarea', (els) =>
        els
          .filter((e) => {
            const el = e as HTMLElement;
            if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
            const label =
              el.getAttribute('aria-label') ||
              el.textContent?.trim() ||
              el.getAttribute('title') ||
              (el.id && document.querySelector(`label[for="${el.id}"]`)) ||
              el.closest('label')?.textContent?.trim() ||
              el.getAttribute('placeholder');
            return !label;
          })
          .map((e) => e.outerHTML.slice(0, 120)),
      );
      expect(unnamed, `contrôles sans nom accessible sur ${route}`).toEqual([]);
    }
  });
});

test.describe('édition et exports', () => {
  test('signature dessinée insérée sur une page, exports Word, JPG et PDF protégé', async ({ page }) => {
    await freshApp(page);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Importer des fichiers' }).first().click();
    await (await chooser).setFiles([join(FIX, 'office', 'sample.docx')]);
    await expect(page).toHaveURL(/#\/doc\//, { timeout: 30_000 });
    const thumbBefore = await page.locator('.page-grid .page-thumb img').first().getAttribute('src');

    // Draw a signature and place it on the page.
    await page.locator('.page-grid .page-btn').first().click();
    await page.getByRole('menuitem', { name: 'Annoter / signer' }).click();
    await page.getByRole('button', { name: 'Signature' }).click();
    await page.getByRole('radio', { name: 'Dessiner' }).click();
    const pad = page.locator('canvas.sig-pad');
    const box = await pad.boundingBox();
    if (!box) throw new Error('zone de signature introuvable');
    await page.mouse.move(box.x + 30, box.y + box.height * 0.6);
    await page.mouse.down();
    for (let i = 0; i <= 20; i++) await page.mouse.move(box.x + 30 + i * 12, box.y + box.height * (0.6 - 0.25 * Math.sin(i / 2)));
    await page.mouse.up();
    await page.getByRole('button', { name: 'Utiliser' }).click();
    await expect(page.locator('.annot-svg image')).toHaveCount(1);
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page).toHaveURL(/#\/doc\/[^/]+$/);
    await expect.poll(async () => page.locator('.page-grid .page-thumb img').first().getAttribute('src')).not.toBe(thumbBefore);

    const fs = await import('node:fs');
    const exportAs = async (format: string, setup?: () => Promise<void>) => {
      await page.getByTestId('export-open').click();
      await page.getByRole('radio', { name: format, exact: true }).click();
      if (setup) await setup();
      const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-download').click()]);
      return { name: dl.suggestedFilename(), bytes: fs.readFileSync((await dl.path()) as string) };
    };

    const docx = await exportAs('Word');
    expect(docx.name).toMatch(/\.docx$/);
    expect(new TextDecoder('latin1').decode(docx.bytes.subarray(0, 2))).toBe('PK');
    expect(new TextDecoder('latin1').decode(docx.bytes)).toContain('word/document.xml');

    const jpg = await exportAs('JPG');
    expect(jpg.name).toMatch(/\.jpg$/);
    expect([jpg.bytes[0], jpg.bytes[1]]).toEqual([0xff, 0xd8]);

    const pdf = await exportAs('PDF', async () => {
      await page.getByText('Protéger par mot de passe').click();
      await page.getByLabel('Mot de passe', { exact: true }).fill('secret-1234');
    });
    const text = new TextDecoder('latin1').decode(pdf.bytes);
    expect(text).toContain('/Encrypt');
    expect(text).toContain('/V 5 /R 6');
    expect(text).not.toContain('Rapport trimestriel');
  });
});
