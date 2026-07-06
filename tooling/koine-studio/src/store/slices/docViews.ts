import type { StoreApi } from 'zustand/vanilla';

export type DocViewKey =
  | 'preview'
  | 'model'
  | 'glossary'
  | 'diagrams'
  | 'events'
  | 'relationships'
  | 'contextmap'
  | 'syntax-tree';
export interface DocView {
  /** True once a fetch for the CURRENT token has rendered. */
  loaded: boolean;
  /** Monotonic stale-token: bumped by invalidate(); a loader captures it and discards if it changed. */
  token: number;
}

export interface DocViewsSlice {
  docViews: Record<DocViewKey, DocView>;
  isStale(key: DocViewKey): boolean;
  currentToken(key: DocViewKey): number;
  markLoaded(key: DocViewKey, token: number): void;
  /**
   * Mark surfaces stale by bumping their token (and clearing `loaded`). With no argument: every key —
   * the model-edit path, so all model-derived surfaces refetch on their next show. With a single key:
   * just that surface — the targeted invalidations (a theme flip touches only the diagram; a
   * destination-language switch touches only the preview) that must NOT make every other surface stale.
   */
  invalidate(key?: DocViewKey): void;
  /** Store-owned 350ms doc-edit debounce (moved out of inspectorController). */
  scheduleRefresh(fn: () => void): void;
}

const KEYS: DocViewKey[] = [
  'preview',
  'model',
  'glossary',
  'diagrams',
  'events',
  'relationships',
  'contextmap',
  'syntax-tree',
];
const EDIT_DEBOUNCE_MS = 350;

export function createDocViewsSlice(
  set: StoreApi<DocViewsSlice>['setState'],
  get: StoreApi<DocViewsSlice>['getState'],
): DocViewsSlice {
  // The debounce timer is closure-local (per store instance) — never in serialized state.
  let editTimer: ReturnType<typeof setTimeout> | undefined;
  const fresh = (): Record<DocViewKey, DocView> =>
    Object.fromEntries(KEYS.map((k) => [k, { loaded: false, token: 0 }])) as Record<DocViewKey, DocView>;

  return {
    docViews: fresh(),
    isStale: (key) => !get().docViews[key].loaded,
    currentToken: (key) => get().docViews[key].token,
    markLoaded: (key, token) => {
      const view = get().docViews[key];
      if (token !== view.token) return; // superseded loader — discard
      set({ docViews: { ...get().docViews, [key]: { loaded: true, token: view.token } } });
    },
    invalidate: (key) => {
      const cur = get().docViews;
      if (key !== undefined) {
        set({ docViews: { ...cur, [key]: { loaded: false, token: cur[key].token + 1 } } });
        return;
      }
      const next = Object.fromEntries(
        KEYS.map((k) => [k, { loaded: false, token: cur[k].token + 1 }]),
      ) as Record<DocViewKey, DocView>;
      set({ docViews: next });
    },
    scheduleRefresh: (fn) => {
      clearTimeout(editTimer);
      editTimer = setTimeout(fn, EDIT_DEBOUNCE_MS);
    },
  };
}
