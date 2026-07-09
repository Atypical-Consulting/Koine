import type { StoreApi } from 'zustand/vanilla';
import type { ReadableStore } from '@atypical/koine-ui';

/**
 * Adapts a Koine Studio Zustand `StoreApi<S>` + selector into the generic `ReadableStore<T>` contract
 * `koine-ui` components depend on (issue #944, "second tranche" of the #905/PR #932 extraction) — the
 * one and only place `AppState`-shaped state is allowed to cross into a `koine-ui` component's props.
 *
 * Mirrors what Zustand's own `useStore(store, selector)` does internally: subscribe once to the WHOLE
 * vanilla store (`StoreApi.subscribe` has no built-in per-selector filtering), but only forward a
 * notification to `koine-ui`'s `useReadableStore` when the SELECTED slice actually changed under
 * `isEqual` — so a component reading e.g. just `canUndo`/`canRedo` still re-renders only on that slice,
 * not on every unrelated store write, exactly like the pre-extraction `useStore(store, selector)` call
 * it replaces.
 *
 * `isEqual` defaults to `Object.is` (Zustand's own selector-equality default, and correct whenever the
 * selector returns a value that's reference-stable across unrelated writes — e.g. picking a single
 * immutable field straight off the state). Pass {@link shallowEqual} when the selector builds a fresh
 * object each call (e.g. `HistoryControls`'s `{ canUndo, canRedo }` slice) so two structurally-equal
 * calls don't spuriously notify.
 */
export function zustandToReadableStore<S, T>(
  store: StoreApi<S>,
  selector: (state: S) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): ReadableStore<T> {
  return {
    getState: () => selector(store.getState()),
    subscribe: (listener) => {
      let current = selector(store.getState());
      return store.subscribe((state) => {
        const next = selector(state);
        if (isEqual(current, next)) return;
        current = next;
        listener(next);
      });
    },
  };
}

/**
 * Shallow (one-level, own-enumerable-keys) equality for plain object slices — pass to
 * {@link zustandToReadableStore} when the selector returns a freshly built object each call (so its
 * identity is never stable) but its top-level fields are primitives that compare correctly with
 * `Object.is` (numbers, strings, booleans — NOT nested objects/arrays, which would still be compared by
 * reference).
 */
export function shallowEqual<T extends Record<string, unknown>>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.is(a[key], b[key]));
}
