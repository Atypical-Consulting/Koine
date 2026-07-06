import type { StoreApi } from 'zustand/vanilla';

// The active editor's caret position (issue #890), mirrored into the store so surfaces beyond the
// status-bar readout can react to caret moves. Published by editorSession's `onCursor` on every edit /
// selection move (in addition to the status-bar "Ln x, Col y" write); read by the inspector controller,
// which — while the Syntax Tree right view is active — hands the panel a `caret` prop so it highlights the
// DEEPEST node whose span contains the caret (the source → tree half of #890's bidirectional navigation).
// `null` before the first caret report. One reactive value so the highlight can't drift from the caret;
// modelled after the sibling one-value UI mirrors (emitTarget / docsCoverage).
export interface CursorSlice {
  /** The active editor's caret, 1-based line/column, or `null` before the first report. */
  cursor: { line: number; column: number } | null;
  /** Mirror the caret position into the store (called from editorSession's onCursor). */
  setCursor(line: number, column: number): void;
}

export function createCursorSlice(set: StoreApi<CursorSlice>['setState']): CursorSlice {
  return {
    cursor: null,
    // No-op when the caret hasn't actually moved: onCursor fires on every edit too, and a redundant
    // report would otherwise notify subscribers → a debounced panel re-render + full-tree caret walk for
    // nothing. Returning the SAME state object skips zustand's notification (Object.is short-circuit).
    setCursor: (line, column) =>
      set((s) => (s.cursor && s.cursor.line === line && s.cursor.column === column ? s : { cursor: { line, column } })),
  };
}
