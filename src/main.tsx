import { render } from 'preact';
import { App } from './app/App';
import { initLibrary, toast } from './app/state';
import { restoreSession, sessionBlobIds } from './services/scan-session';
import { listSignatures } from './services/signatures';
import { navigate } from './app/router';
import { appUrl } from './services/config';
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
    // Ask the browser not to evict our data under storage pressure.
    void navigator.storage?.persist?.().catch(() => false);
    root.innerHTML = '';
    render(<App />, root);
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
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register(appUrl('sw.js')).catch(() => undefined);
  }
}

void boot();
