import type { StoreApi } from 'zustand/vanilla';
import type { StartupView } from '@/settings/persistence';

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
 * Decide which view to mount on a cold load — **synchronously**, pure and IO-free. The resolver must
 * NOT read storage directly; its inputs are passed in so it remains trivially testable and the
 * IO-free contract (what removed the #368 home-over-editor flash) is preserved.
 *
 * Priority (highest first):
 * 1. An explicit `#/editor` deep-link (or a same-tab refresh while in the editor) → editor.
 * 2. A `#model=…` share link is short-circuited **upstream** in `main.ts` before this resolver runs.
 * 3. If `opts.startupView === 'lastWorkspace'` AND `opts.hasWorkspace` → editor (opt-in auto-resume,
 *    #770 "approach B"). Never opens the editor when there is no workspace to restore — that would
 *    strand the user on a blank editor.
 * 4. Everything else (`''`, `#/`, unknown hashes, or the default `'home'` setting) → home.
 *
 * Callers that omit `opts` get the same always-Home behaviour as before #770, so existing callers
 * and tests are unaffected.
 *
 * @param hash      The current `location.hash` value.
 * @param opts      Optional startup-policy inputs. Omit to reproduce the always-Home behaviour.
 * @param opts.startupView   The persisted preference (`loadSettings().startupView`).
 * @param opts.hasWorkspace  Whether a workspace was previously opened (`hasPersistedWorkspace()`).
 */
export function resolveInitialRoute(
  hash: string,
  opts?: { startupView?: StartupView; hasWorkspace?: boolean },
): Route {
  // Rule 1: an explicit #/editor deep-link always wins.
  if (routeFromHash(hash) === 'editor') return 'editor';
  // Rule 3: opt-in auto-resume — only when a workspace exists (never strand on a blank editor).
  if (opts?.startupView === 'lastWorkspace' && opts.hasWorkspace) return 'editor';
  // Rule 4: default → home.
  return 'home';
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
