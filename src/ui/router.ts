import { useEffect, useState } from 'react';

// Minimal hash router. Extension pages have no server, so hash routes keep
// deep links (e.g. app.html#/runs/abc) working.

export type Route =
  | { name: 'dashboard' }
  | { name: 'new'; template?: string }
  | { name: 'editor'; id: string }
  | { name: 'run'; id: string }
  | { name: 'templates' }
  | { name: 'history' }
  | { name: 'recorder' }
  | { name: 'settings' }
  | { name: 'privacy' }
  | { name: 'notFound' };

export function parseHash(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(query);
  switch (parts[0]) {
    case undefined:
      return { name: 'dashboard' };
    case 'new':
      return { name: 'new', template: params.get('template') ?? undefined };
    case 'workflows':
      return parts[1] ? { name: 'editor', id: parts[1] } : { name: 'dashboard' };
    case 'runs':
      return parts[1] ? { name: 'run', id: parts[1] } : { name: 'history' };
    case 'templates':
    case 'history':
    case 'recorder':
    case 'settings':
    case 'privacy':
      return { name: parts[0] };
    default:
      return { name: 'notFound' };
  }
}

type Guard = () => boolean;
let guard: Guard | null = null;

/** Registers a check (e.g. unsaved changes) that can veto in-app navigation. */
export function setNavigationGuard(next: Guard | null): void {
  guard = next;
}

export function navigate(path: string, opts: { replace?: boolean; force?: boolean } = {}): boolean {
  if (!opts.force && guard && !guard()) return false;
  const hash = `#${path}`;
  if (opts.replace) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  return true;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onChange);
    window.addEventListener('popstate', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
      window.removeEventListener('popstate', onChange);
    };
  }, []);
  return route;
}
