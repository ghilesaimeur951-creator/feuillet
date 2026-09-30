import { useEffect, useState } from 'preact/hooks';

/**
 * Hash router: works on any static host (GitHub Pages, Netlify…) without rewrite rules.
 * Routes: #/  #/search  #/scan  #/doc/:id  #/folders/:id?  #/tools  #/settings  #/trash  #/history
 */
export interface Route {
  path: string;
  segments: string[];
  query: URLSearchParams;
}

function parse(): Route {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path = '/', qs = ''] = raw.split('?');
  return { path, segments: path.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(qs) };
}

/** Number of in-app entries we can safely go back to. */
let depth = 0;

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const hash = `#${to.startsWith('/') ? to : `/${to}`}`;
  if (location.hash === hash) return;
  if (opts.replace) history.replaceState(history.state, '', hash);
  else {
    history.pushState(history.state, '', hash);
    depth++;
  }
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/** Goes back when the previous entry belongs to the app, otherwise to `fallback`. */
export function goBack(fallback = '/'): void {
  if (depth > 0) history.back();
  else navigate(fallback, { replace: true });
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    const pop = () => {
      depth = Math.max(0, depth - 1);
      setRoute(parse());
    };
    window.addEventListener('hashchange', on);
    window.addEventListener('popstate', pop);
    return () => {
      window.removeEventListener('hashchange', on);
      window.removeEventListener('popstate', pop);
    };
  }, []);
  return route;
}
