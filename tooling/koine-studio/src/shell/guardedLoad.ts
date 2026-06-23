import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import type { DocViewKey } from '@/store/slices/docViews';

export interface GuardedLoad<T> {
  store: StoreApi<AppState>;
  /** The docViews surface this load fetches — keys both the stale-token check and markLoaded. */
  key: DocViewKey;
  /** Show the loading placeholder, run once before the fetch. Optional (some loaders keep prior content). */
  loading?: () => void;
  /** Fetch the view's data. */
  fetch: () => Promise<T>;
  /** Paint the data — called ONLY if the load is still current (not superseded by an edit mid-fetch). */
  render: (data: T) => void;
  /** Surface a fetch error — called ONLY if the load is still current. */
  onError: (error: unknown) => void;
}

/**
 * Run a lazily-loaded, model-derived view fetch under the docViews slice's stale-token discipline:
 * capture the view's token before the await; if an edit bumped it while the fetch was in flight, DISCARD
 * the result — no render, no markLoaded — so a superseded load can never paint stale data; otherwise
 * render and mark the view loaded for the token it fetched. A rejected fetch is likewise dropped when
 * superseded. This is the protocol the glossary and bottom-strip (events / relationships / context map)
 * loaders share. The diagram and preview loaders deliberately do NOT use it: they gate on a local monotonic
 * seq instead, because a theme flip / destination-language switch re-renders WITHOUT bumping the token.
 */
export async function guardedLoad<T>(opts: GuardedLoad<T>): Promise<void> {
  const { store, key } = opts;
  const token = store.getState().currentToken(key);
  opts.loading?.();
  try {
    const data = await opts.fetch();
    if (token !== store.getState().currentToken(key)) return; // superseded by an edit — discard
    opts.render(data);
    store.getState().markLoaded(key, token);
  } catch (error) {
    if (token !== store.getState().currentToken(key)) return; // superseded — drop the error too
    opts.onError(error);
  }
}
