import { createStore, type StoreApi } from 'zustand/vanilla';
import { createSelectionSlice, type SelectionSlice } from './slices/selection';

// The single Koine Studio state store: typed slices composed into one vanilla Zustand store. Vanilla
// (not the React hook) so the imperative islands (CodeMirror, diagrams) can subscribe directly; Preact
// panels read it via the `zustand` React hook (under preact/compat). New slices are added here.
export type AppState = SelectionSlice;

export function createAppStore(): StoreApi<AppState> {
  return createStore<AppState>((set, get) => ({
    ...createSelectionSlice(set, get),
  }));
}

/** The app-wide singleton store; tests build their own with createAppStore(). */
export const appStore = createAppStore();
