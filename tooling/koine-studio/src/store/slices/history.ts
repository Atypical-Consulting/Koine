import type { StoreApi } from 'zustand/vanilla';

export interface HistorySlice {
  /** True when there is at least one undo step (drives the top-bar Undo button). */
  canUndo: boolean;
  /** True when there is at least one redo step (drives the top-bar Redo button). */
  canRedo: boolean;
  /** Replace the reactive button state; the historyController calls this on every change. */
  setHistoryState(s: { canUndo: boolean; canRedo: boolean }): void;
}

export function createHistorySlice(
  set: StoreApi<HistorySlice>['setState'],
  _get: StoreApi<HistorySlice>['getState'],
): HistorySlice {
  return {
    canUndo: false,
    canRedo: false,
    setHistoryState: (s) => set({ canUndo: s.canUndo, canRedo: s.canRedo }),
  };
}
