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

/**
 * Decide which view to mount on a cold load — **synchronously**, from the URL hash and a synchronous
 * "a workspace was previously open" signal. This is deliberately pure and IO-free: it must NOT await
 * `openDefaultWorkspaceFlow` (or any probe). That async gate is exactly what made the home overlay
 * fade in over an already-painted editor (#368); resolving the route up front, before first paint,
 * is what removes the race rather than patching it.
 *
 * Editor wins when the hash explicitly asks for it (`#/editor`) or a workspace was already open;
 * otherwise it's a pristine first load → Home.
 */
export function resolveInitialRoute(input: { hash: string; hasPersistedWorkspace: boolean }): Route {
  return routeFromHash(input.hash) === 'editor' || input.hasPersistedWorkspace ? 'editor' : 'home';
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
