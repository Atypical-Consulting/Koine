import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import { diagnosticsSummary } from '@/diagnostics/diagnosticsSummary';
import { shallowEqual, zustandToReadableStore } from '@/store/readableStoreAdapter';

// The concrete `ReadableStore<T>` adapters for the koine-ui host-adapter components (issues #944 and
// #1244) — kept out of ide.tsx (the line-budget-guarded call site, `lineBudgets.test.ts`) as their own
// small, independently testable module, matching the file's existing decomposition pattern (see e.g.
// `workspaceBuffers.ts`/`workspaceMutations.ts`).

/** Adapts the app store's history slice to `HistoryControls`' generic `ReadableStore<HistoryControlsSlice>`. */
export function createHistoryControlsStore(store: StoreApi<AppState>) {
  return zustandToReadableStore(store, (s) => ({ canUndo: s.canUndo, canRedo: s.canRedo }), shallowEqual);
}

/**
 * Adapts the workspace slice's buffer Map to `UnsavedIndicator`'s generic
 * `ReadableStore<UnsavedIndicatorSlice>`, counting the dirty buffers down to one primitive so the
 * component never sees Koine Studio's `Buffer` shape. Counting from the SNAPSHOT the listener receives
 * (not via the slice's own `dirtyCount()` method, which closes over the store's live `get`) keeps each
 * notification consistent with the state that produced it. `shallowEqual` doubles as the "only notify
 * when the total actually changed" gate the pre-extraction component kept with its own `last` check —
 * the common no-op buffer write (e.g. a text edit on an already-dirty file) never repaints the pill.
 */
export function createUnsavedIndicatorStore(store: StoreApi<AppState>) {
  return zustandToReadableStore(
    store,
    (s) => {
      let dirtyCount = 0;
      for (const b of s.buffers.values()) if (b.dirty) dirtyCount++;
      return { dirtyCount };
    },
    shallowEqual,
  );
}

/**
 * Adapts the app store's diagnostics slice to `WorkspaceProblemsBadge`'s generic
 * `ReadableStore<WorkspaceProblemsSlice>`, forwarding the shared `diagnosticsSummary`'s `kind`/`parts`
 * output UNCHANGED (issue #193's single home for that classification AND its count-string wording) so
 * the badge's rendered text can never drift from the diagnostics strip or status pill, and this adapter
 * never re-derives pluralisation logic of its own.
 *
 * Uses a dedicated equality check, not the generic `shallowEqual` (zustand's `shallow`): `shallow` only
 * compares one level deep — a per-field `Object.is` — so its `parts` field (a freshly built array on
 * every selector call) would never compare equal by content, defeating the "don't re-render on an
 * unrelated store write" property this adapter exists to preserve. `parts` needs an actual element-wise
 * comparison, which `problemsSliceEqual` below does explicitly.
 *
 * Known tradeoff: `zustandToReadableStore`'s listener re-runs this selector (flatten + classify) on
 * EVERY app-store write, not just diagnostics ones — the ORIGINAL component selected the raw
 * `diagnosticsByUri` reference (near-zero cost) and only classified inside the render body, so it only
 * paid this cost on an actual diagnostics change. The equality check still prevents an unrelated write
 * from causing a re-render, but not the recomputation itself. Acceptable for this prototype's scale (a
 * per-write linear scan over the workspace's diagnostics); reconsider (e.g. gate the selector on a cheap
 * upstream reference check first) if a next-tranche panel's classification gets more expensive.
 */
export function createWorkspaceProblemsStore(store: StoreApi<AppState>) {
  return zustandToReadableStore(
    store,
    (s) => {
      const byUri = s.diagnosticsByUri;
      const { kind, parts } = diagnosticsSummary(Object.values(byUri).flat());
      const fileCount = Object.values(byUri).filter((d) => d.length > 0).length;
      return { kind, parts, fileCount };
    },
    problemsSliceEqual,
  );
}

interface ProblemsSlice {
  kind: 'clean' | 'warn' | 'error';
  parts: string[];
  fileCount: number;
}

/** Element-wise `parts` comparison plus `Object.is` on `kind`/`fileCount` — see the doc comment above. */
function problemsSliceEqual(a: ProblemsSlice, b: ProblemsSlice): boolean {
  return (
    a.kind === b.kind &&
    a.fileCount === b.fileCount &&
    a.parts.length === b.parts.length &&
    a.parts.every((part, i) => part === b.parts[i])
  );
}
