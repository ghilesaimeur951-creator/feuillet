import { render } from 'preact';
import { App } from './app/App';
import { initLibrary, toast } from './app/state';
import { restoreSession, sessionBlobIds } from './services/scan-session';
import { listSignatures } from './services/signatures';
import { navigate } from './app/router';
import { appUrl } from './services/config';
import { isAndroidApp, takeSharedFiles } from './services/native';
import { importFlow } from './app/actions';
import './ui/styles.css';
import './ui/editor.css';

async function boot() {
  const root = document.getElementById('app');
  if (!root) return;
  try {
    const lib = await initLibrary();
    // Crash recovery: an interrupted scan session is offered back to the user.
    const session = await restoreSession(lib);
    // Remove orphan blobs from previous sessions (never those of a pending scan or saved signatures).
    const keep = sessionBlobIds();
    for (const sig of await listSignatures(lib)) keep.add(sig.blobId);
    void lib.collectGarbage(keep);
    // Ask the browser not to evict our data under storage pressure — only once the user has
    // documents to protect (Firefox shows a permission prompt for this request).
    const persist = () => void navigator.storage?.persist?.().catch(() => false);
    if (lib.documents().length) persist();
    else {
      const off = lib.subscribe(() => {
        if (lib.documents().length) {
          off();
          persist();
        }
      });
    }
    root.innerHTML = '';
    render(<App />, root);
    // Android app: files shared to Feuillet (at start-up, or later while it runs).
    if (isAndroidApp()) {
      const receive = async () => {
        const files = await takeSharedFiles();
        if (files.length) await importFlow(files);
      };
      (window as { __feuilletShared?: () => void }).__feuilletShared = () => void receive();
      void receive();
    }
    if (session && !location.hash.startsWith('#/review') && !location.hash.startsWith('#/scan')) {
      toast(
        `Un scan interrompu (${session.captures.length} page${session.captures.length > 1 ? 's' : ''}) peut être repris.`,
        'info',
        { label: 'Reprendre', run: () => navigate('/review') },
        12000,
      );
    }
  } catch (e) {
    root.innerHTML = `<div class="fatal"><h1>Impossible de démarrer Feuillet</h1><p>${e instanceof Error ? e.message.replace(/[<>&]/g, '') : 'Erreur inconnue'}</p></div>`;
  }
  // The Android app serves its files from the APK itself: no service worker needed there.
  if (!isAndroidApp() && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register(appUrl('sw.js')).catch(() => undefined);
  }
}

void boot();
