import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { importFlow, openImportPicker, scanTo } from './actions';
import { navigate, useRoute } from './router';
import { storageWarning, useSettings, vault } from './state';
import { nativeBridge } from '../services/native';
import { Icon } from '../ui/components/Icon';
import type { IconName } from '../ui/components/Icon';
import { Overlays } from '../ui/components/Overlays';
import { Logo } from '../ui/components/Logo';
import { LibraryScreen } from '../ui/screens/LibraryScreen';
import { SearchScreen } from '../ui/screens/SearchScreen';
import { ScannerScreen } from '../ui/screens/ScannerScreen';
import { ReviewScreen } from '../ui/screens/ReviewScreen';
import { DocumentScreen } from '../ui/screens/DocumentScreen';
import { PageScreen } from '../ui/screens/PageScreen';
import { FoldersScreen } from '../ui/screens/FoldersScreen';
import { ToolsScreen } from '../ui/screens/ToolsScreen';
import { SettingsScreen } from '../ui/screens/SettingsScreen';
import { TrashScreen } from '../ui/screens/TrashScreen';
import { HistoryScreen } from '../ui/screens/HistoryScreen';

const NAV: Array<{ to: string; label: string; icon: IconName; match: (p: string) => boolean }> = [
  { to: '/', label: 'Documents', icon: 'home', match: (p) => p === '/' || p.startsWith('/doc') },
  { to: '/search', label: 'Recherche', icon: 'search', match: (p) => p.startsWith('/search') },
  { to: '/folders', label: 'Dossiers', icon: 'folder', match: (p) => p.startsWith('/folders') || p.startsWith('/trash') },
  { to: '/tools', label: 'Outils', icon: 'tools', match: (p) => p.startsWith('/tools') || p.startsWith('/history') },
  { to: '/settings', label: 'Paramètres', icon: 'settings', match: (p) => p.startsWith('/settings') },
];

function applyTheme(theme: 'system' | 'light' | 'dark') {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#10161d' : '#f6f4ef');
  nativeBridge()?.setSystemBars(dark ? '#10161d' : '#f6f4ef', dark);
}

export function App() {
  const route = useRoute();
  const s = useSettings();
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    applyTheme(s.theme);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => applyTheme(s.theme);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [s.theme]);

  // Desktop drag-and-drop import anywhere in the window.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      const folder = location.hash.match(/#\/folders\/([^/?]+)/)?.[1] ?? null;
      if (files.length) void importFlow(files, folder ? decodeURIComponent(folder) : null);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  // Desktop keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.sheet-backdrop')) return;
      if (e.key === '/') {
        e.preventDefault();
        navigate('/search');
      } else if (e.key === 'n') scanTo();
      else if (e.key === 'i') openImportPicker();
      else if (e.key === 'g') navigate('/');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const p = route.path;
  const seg = route.segments;

  // Temporarily opened locked documents are locked again when the user leaves them (scan and
  // review flows keep them open: they add pages to the document) or after a minute in background.
  const keepOpen = seg[0] === 'doc' ? (seg[1] ?? null) : seg[0] === 'scan' || seg[0] === 'review' ? '*' : null;
  useEffect(() => {
    if (keepOpen !== '*') void vault().relockAll(keepOpen);
  }, [keepOpen]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onVis = () => {
      if (timer) clearTimeout(timer);
      timer = document.visibilityState === 'hidden' ? setTimeout(() => void vault().relockAll(null), 60_000) : null;
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  const fullscreen = p.startsWith('/scan') || p.startsWith('/review') || (seg[0] === 'doc' && seg[2] === 'page');
  let screen: ComponentChildren;
  if (p === '/' || p === '') screen = <LibraryScreen view={route.query.get('view') ?? 'all'} />;
  else if (seg[0] === 'search') screen = <SearchScreen initial={route.query.get('q') ?? ''} />;
  else if (seg[0] === 'scan') screen = <ScannerScreen query={route.query} />;
  else if (seg[0] === 'review') screen = <ReviewScreen />;
  else if (seg[0] === 'doc' && seg[1] && seg[2] === 'page' && seg[3])
    screen = <PageScreen docId={seg[1]} pageId={seg[3]} tab={route.query.get('tab') ?? 'filter'} />;
  else if (seg[0] === 'doc' && seg[1])
    screen = <DocumentScreen id={seg[1]} preset={route.query.get('export')} openMenu={route.query.get('menu') === '1'} />;
  else if (seg[0] === 'folders') screen = <FoldersScreen folderId={seg[1] ?? null} />;
  else if (seg[0] === 'tools') screen = <ToolsScreen tool={seg[1] ?? null} />;
  else if (seg[0] === 'settings') screen = <SettingsScreen />;
  else if (seg[0] === 'trash') screen = <TrashScreen />;
  else if (seg[0] === 'history') screen = <HistoryScreen />;
  else screen = <LibraryScreen view="all" />;

  return (
    <div class={`app ${fullscreen ? 'is-fullscreen' : ''}`}>
      <a class="skip-link" href="#main">
        Aller au contenu
      </a>
      {!fullscreen ? (
        <nav class="side-nav" aria-label="Navigation principale">
          <div class="side-brand">
            <Logo />
          </div>
          <button type="button" class="side-scan" onClick={() => scanTo()}>
            <Icon name="scan" />
            <span>Scanner</span>
          </button>
          <button type="button" class="side-import" onClick={() => openImportPicker()}>
            <Icon name="upload" />
            <span>Importer</span>
          </button>
          {NAV.map((n) => (
            <a key={n.to} href={`#${n.to}`} class={`side-link ${n.match(p) ? 'is-active' : ''}`} aria-current={n.match(p) ? 'page' : undefined}>
              <Icon name={n.icon} />
              <span>{n.label}</span>
            </a>
          ))}
        </nav>
      ) : null}
      <main id="main" class="main" tabIndex={-1}>
        {storageWarning && !fullscreen ? (
          <div class="banner banner-warning" role="alert">
            <Icon name="alert" size={18} /> {storageWarning}
          </div>
        ) : null}
        {screen}
      </main>
      {!fullscreen ? (
        <nav class="bottom-nav" aria-label="Navigation">
          {NAV.slice(0, 2).map((n) => (
            <a key={n.to} href={`#${n.to}`} class={`bottom-link ${n.match(p) ? 'is-active' : ''}`} aria-current={n.match(p) ? 'page' : undefined}>
              <Icon name={n.icon} />
              <span>{n.label}</span>
            </a>
          ))}
          <button type="button" class="scan-fab" onClick={() => scanTo()} aria-label="Scanner un document">
            <Icon name="scan" size={28} />
          </button>
          {NAV.slice(2, 4).map((n) => (
            <a key={n.to} href={`#${n.to}`} class={`bottom-link ${n.match(p) ? 'is-active' : ''}`} aria-current={n.match(p) ? 'page' : undefined}>
              <Icon name={n.icon} />
              <span>{n.label}</span>
            </a>
          ))}
        </nav>
      ) : null}
      {dragging ? (
        <div class="drop-overlay" aria-hidden="true">
          <Icon name="upload" size={48} />
          <p>Déposez vos fichiers pour les importer</p>
          <small>Images, PDF, DOCX, XLSX, PPTX, TXT</small>
        </div>
      ) : null}
      <Overlays />
    </div>
  );
}
