import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import { appStore, type AppState } from '@/store/index';

// Preact-facing binding for the vanilla app store. `useStore` (from `zustand`, resolved to its React
// entry under the preact/compat alias) subscribes a component to exactly the slice the selector
// returns, so an unrelated slice change never re-renders the component. The two-argument overload lets
// a test inject its own store (createAppStore()) instead of the singleton.

/** Subscribe a Preact component to a slice of the app store (the singleton). */
export function useAppStore<T>(selector: (s: AppState) => T): T;
/** Subscribe to a slice of an injected store (tests pass their own createAppStore()). */
export function useAppStore<T>(store: StoreApi<AppState>, selector: (s: AppState) => T): T;
export function useAppStore<T>(
  a: StoreApi<AppState> | ((s: AppState) => T),
  b?: (s: AppState) => T,
): T {
  // Resolve the (store, selector) pair from the overloaded arguments FIRST, then subscribe with a single
  // unconditional `useStore` call — a hook must run in the same order every render (react-hooks/rules-of-
  // hooks). Behavior is identical to the previous per-branch calls: 1-arg → the singleton; 2-arg → the
  // injected store. Pinned by hooks.test.tsx.
  const store = typeof a === 'function' ? appStore : a;
  const selector = typeof a === 'function' ? a : b!;
  return useStore(store, selector);
}
