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
 *
 * Known tradeoff: `zustandToReadableStore`'s listener re-runs this selector (flatten + classify) on
 * EVERY app-store write, not just diagnostics ones — the ORIGINAL component selected the raw
 * `diagnosticsByUri` reference (near-zero cost) and only classified inside the render body, so it only
 * paid this cost on an actual diagnostics change. `shallowEqual` still prevents an unrelated write from
 * causing a re-render, but not the recomputation itself. Acceptable for this prototype's scale (a
 * per-write linear scan over the workspace's diagnostics); reconsider (e.g. gate the selector on a
 * cheap upstream reference check first) if a next-tranche panel's classification gets more expensive.
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
