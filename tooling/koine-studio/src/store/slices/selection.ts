import type { StoreApi } from 'zustand/vanilla';
import type { SelectedElement } from '@/selection';

export interface SelectionSlice {
  /** The currently-selected domain element, or null. */
  selection: SelectedElement | null;
  /** Replace the selection (or clear with null). */
  setSelection(el: SelectedElement | null): void;
}

export function createSelectionSlice(
  set: StoreApi<SelectionSlice>['setState'],
  _get: StoreApi<SelectionSlice>['getState'],
): SelectionSlice {
  return {
    selection: null,
    setSelection: (el) => set({ selection: el }),
  };
}
