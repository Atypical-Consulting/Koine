import { useEffect, useState } from 'preact/hooks';

/**
 * A generic, host-agnostic read/subscribe contract for store-coupled UI components (issue #944 —
 * "second tranche" of the `@atypical/koine-ui` extraction that PR #932 / issue #905 started).
 *
 * `koine-ui` stays store-free by design (issue #905's original split): no Zustand, or any other
 * concrete state-management library, may be imported under `tooling/koine-ui/src`. `ReadableStore<T>`
 * is the seam a `koine-ui` component depends on INSTEAD of a concrete store type — any host (Koine
 * Studio's Zustand `StoreApi<AppState>` today, a future embedding tomorrow) can satisfy it by handing
 * back the already-selected slice `T` plus a way to be notified when that slice changes. The concrete
 * host owns translating its real store down to this shape at each call site — e.g. Koine Studio's
 * `zustandToReadableStore(store, selector)` adapter (`tooling/koine-studio/src/store/readableStoreAdapter.ts`)
 * — so `koine-ui` never sees `AppState`, `Platform`, or any other Koine-Studio-specific type.
 *
 * Deliberately minimal: just enough surface for a component to read the current slice and react to
 * changes. It intentionally does NOT prescribe how a host computes equality/memoizes `T` between
 * notifications — that's the adapter's job (see `zustandToReadableStore`'s doc comment for how the
 * Zustand adapter narrows a whole-store subscription down to one slice).
 */
export interface ReadableStore<T> {
  /** The current value of the slice this store exposes. */
  getState(): T;
  /**
   * Subscribe to changes in the slice. The listener is called with the new value whenever the host
   * considers the slice to have changed. Returns an unsubscribe function.
   */
  subscribe(listener: (state: T) => void): () => void;
}

/**
 * Preact hook that subscribes a component to a {@link ReadableStore}'s slice and re-renders it on every
 * change — the `koine-ui`-side counterpart to Zustand's `useStore(store, selector)`, without importing
 * Zustand (or knowing it exists).
 *
 * Implemented with `useState`/`useEffect` rather than `useSyncExternalStore`: `preact/hooks` doesn't
 * export that hook (only `preact/compat`'s React-18 shim does), and pulling in the compat layer just for
 * this one hook would be a bigger dependency footprint than this package needs for two small prototype
 * components. The effect re-reads `getState()` before subscribing so a change that happens between the
 * initial render and the effect committing (a real, if narrow, race for any external store) is not
 * missed — the same reason React's own `useSyncExternalStore` resyncs on mount.
 */
export function useReadableStore<T>(store: ReadableStore<T>): T {
  const [state, setState] = useState(() => store.getState());
  useEffect(() => {
    // The store (or its slice) may have changed between the render above and this effect committing —
    // resync before subscribing so that window can't drop an update.
    setState(store.getState());
    return store.subscribe(setState);
  }, [store]);
  return state;
}
