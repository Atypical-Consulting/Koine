import type { StoreApi } from 'zustand/vanilla';

// Studio's two top-level destinations. Home is the start console; Editor is the IDE proper. They are
// distinct, hash-backed routes so exactly one view mounts on load — which is what removes the historic
// IDE→Home flash (the home overlay used to fade in over an already-painted editor). See issue #368.
export type Route = 'home' | 'editor';

export interface RouteSlice {
  /** The view that should currently be mounted. Seeded synchronously at boot; never both at once. */
  route: Route;
  /** Switch to a route: update the store and reflect it in `location.hash` (refresh/back-forward safe). */
  navigate(route: Route): void;
}

// The hash vocabulary. Only `#/editor` is the editor; everything else (``, `#/`, anything unknown)
// is Home — an unknown hash should never strand the user on a blank editor.
const EDITOR_HASH = '#/editor';
const HOME_HASH = '#/';

/** Map a `location.hash` to a route. Unknown / empty hashes resolve to Home. Pure. */
export function routeFromHash(hash: string): Route {
  return hash === EDITOR_HASH ? 'editor' : 'home';
}

/** Map a route back to its canonical `location.hash`. Pure (inverse of {@link routeFromHash}). */
export function hashFromRoute(route: Route): string {
  return route === 'editor' ? EDITOR_HASH : HOME_HASH;
}

export function createRouteSlice(
  set: StoreApi<RouteSlice>['setState'],
  _get: StoreApi<RouteSlice>['getState'],
): RouteSlice {
  return {
    route: 'home',
    navigate: (route) => {
      set({ route });
      // Reflect the route in the URL so a refresh or browser back/forward lands on the same view.
      // Guard the assignment so navigating to the route we're already on doesn't spawn a redundant
      // `hashchange` (which initRouteSync would otherwise re-apply).
      const hash = hashFromRoute(route);
      if (typeof location !== 'undefined' && location.hash !== hash) location.hash = hash;
    },
  };
}

/**
 * Seed the store's route from the current `location.hash` and keep it in sync with manual hash edits
 * and browser back/forward. Call once at boot, after the slice is registered. Returns nothing — the
 * `hashchange` listener lives for the page lifetime (Studio is a single long-lived page).
 */
export function initRouteSync(store: StoreApi<RouteSlice>): void {
  store.setState({ route: routeFromHash(location.hash) });
  window.addEventListener('hashchange', () => {
    store.setState({ route: routeFromHash(location.hash) });
  });
}
