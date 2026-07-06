import { createStore, type StoreApi } from 'zustand/vanilla';
import { createSelectionSlice, type SelectionSlice } from '@/store/slices/selection';
import { createActiveContextSlice, type ActiveContextSlice } from '@/store/slices/activeContext';
import { createDiagnosticsSlice, type DiagnosticsSlice } from '@/store/slices/diagnostics';
import { createDocViewsSlice, type DocViewsSlice } from '@/store/slices/docViews';
import { createWorkspaceSlice, type WorkspaceSlice } from '@/store/slices/workspace';
import { createUiChromeSlice, type UiChromeSlice } from '@/store/slices/uiChrome';
import { createHistorySlice, type HistorySlice } from '@/store/slices/history';
import { createRouteSlice, type RouteSlice } from '@/store/slices/route';
import { createEmitTargetSlice, type EmitTargetSlice } from '@/store/slices/emitTarget';
import { createDocsCoverageSlice, type DocsCoverageSlice } from '@/store/slices/docsCoverage';
import { createCursorSlice, type CursorSlice } from '@/store/slices/cursor';

// The single Koine Studio state store: typed slices composed into one vanilla Zustand store. Vanilla
// (not the React hook) so the imperative islands (CodeMirror, diagrams) can subscribe directly; Preact
// panels read it via the `zustand` React hook (under preact/compat). New slices are added here.
export type AppState = SelectionSlice &
  ActiveContextSlice &
  DiagnosticsSlice &
  DocViewsSlice &
  WorkspaceSlice &
  UiChromeSlice &
  HistorySlice &
  RouteSlice &
  EmitTargetSlice &
  DocsCoverageSlice &
  CursorSlice;

export function createAppStore(): StoreApi<AppState> {
  return createStore<AppState>((set, get) => ({
    ...createSelectionSlice(set, get),
    ...createActiveContextSlice(set, get),
    ...createDiagnosticsSlice(set, get),
    ...createDocViewsSlice(set, get),
    ...createWorkspaceSlice(set, get),
    ...createUiChromeSlice(set, get),
    ...createHistorySlice(set, get),
    ...createRouteSlice(set, get),
    ...createEmitTargetSlice(set),
    ...createDocsCoverageSlice(set),
    ...createCursorSlice(set),
  }));
}

/** The app-wide singleton store; tests build their own with createAppStore(). */
export const appStore = createAppStore();
