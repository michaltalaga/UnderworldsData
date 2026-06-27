import { useEffect, useState } from 'react';

export type AppView = 'warscrolls' | 'rivals' | 'overview';

export interface Route {
  view: AppView;
  warband: string | null;
  deck: string | null;
}

/** Parse a location hash like "#/warbands/mollogs-mob" into a Route. */
export function parseHash(hash: string): Route {
  const clean = hash.replace(/^#/, '').replace(/^\//, '');
  const [segment, slug] = clean.split('/');

  if (segment === 'rivals') return { view: 'rivals', warband: null, deck: slug || null };
  if (segment === 'pairings' || segment === 'overview') {
    return { view: 'overview', warband: null, deck: null };
  }
  if (segment === 'warbands') return { view: 'warscrolls', warband: slug || null, deck: null };
  return { view: 'warscrolls', warband: null, deck: null };
}

export function warbandHref(slug: string): string {
  return `#/warbands/${slug}`;
}

export function deckHref(slug: string): string {
  return `#/rivals/${slug}`;
}

export function viewHref(view: AppView): string {
  if (view === 'overview') return '#/pairings';
  if (view === 'rivals') return '#/rivals';
  return '#/warbands';
}

/** Navigate programmatically (updates the hash, which fires `hashchange`). */
export function navigate(href: string): void {
  if (window.location.hash !== href.replace(/^#?/, '#')) {
    window.location.hash = href;
  }
}

/** Reactive current route, kept in sync with browser back/forward via `hashchange`. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
