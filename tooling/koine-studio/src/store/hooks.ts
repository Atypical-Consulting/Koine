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
  if (typeof a === 'function') return useStore(appStore, a);
  return useStore(a, b!);
}
