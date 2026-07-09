import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import { diagnosticsSummary } from '@/diagnostics/diagnosticsSummary';
import { shallowEqual, zustandToReadableStore } from '@/store/readableStoreAdapter';

// The concrete `ReadableStore<T>` adapters for the two koine-ui host-adapter prototype targets (issue
// #944) — kept out of ide.tsx (the line-budget-guarded call site, `lineBudgets.test.ts`) as their own
// small, independently testable module, matching the file's existing decomposition pattern (see e.g.
// `workspaceBuffers.ts`/`workspaceMutations.ts`).

/** Adapts the app store's history slice to `HistoryControls`' generic `ReadableStore<HistoryControlsSlice>`. */
export function createHistoryControlsStore(store: StoreApi<AppState>) {
  return zustandToReadableStore(store, (s) => ({ canUndo: s.canUndo, canRedo: s.canRedo }), shallowEqual);
}

/**
 * Adapts the app store's diagnostics slice to `WorkspaceProblemsBadge`'s generic
 * `ReadableStore<WorkspaceProblemsSlice>`, classifying via the shared `diagnosticsSummary` (issue #193's
 * single home for that classification) so the badge's counts can never drift from the diagnostics strip
 * or status pill.
 */
export function createWorkspaceProblemsStore(store: StoreApi<AppState>) {
  return zustandToReadableStore(
    store,
    (s) => {
      const byUri = s.diagnosticsByUri;
      const { errors, warnings } = diagnosticsSummary(Object.values(byUri).flat());
      const fileCount = Object.values(byUri).filter((d) => d.length > 0).length;
      return { errors, warnings, fileCount };
    },
    shallowEqual,
  );
}
