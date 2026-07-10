import type { StoreApi } from 'zustand/vanilla';
import type { DiagnosticsStripRow, DiagnosticsStripSlice } from '@atypical/koine-ui';
import type { AppState } from '@/store/index';
import { diagnosticsSummary } from '@/diagnostics/diagnosticsSummary';
import { isAllContexts } from '@/model/activeContext';
import { severityErrorOrWarning } from '@/lsp/severity';
import type { LspDiagnostic } from '@/lsp/lsp';
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

/**
 * Adapts the workspace slice's `folderRootToken` (the primary root, set atomically with `roots` so
 * folder-derived consumers keep firing on a change — see slices/workspace.ts) to `DocsPanelHost`'s
 * generic `ReadableStore<DocsPanelHostSlice>`. The token is one immutable string, but the selector
 * wraps it in a fresh object each call, so `shallowEqual` supplies the "only notify on a REAL folder
 * change" gate that keeps the folder-derived docs pages from reloading on unrelated writes.
 */
export function createDocsPanelHostStore(store: StoreApi<AppState>) {
  return zustandToReadableStore(store, (s) => ({ folderRootToken: s.folderRootToken }), shallowEqual);
}

/** The bounded context a source file denotes — its `.koi` stem, lowercased — or null for a non-`.koi`
 *  uri. One `.koi` file is one bounded context (the stem convention the Files-tree scope emphasis uses).
 *  Moved here from DiagnosticsStripPanel.tsx with the #1244 extraction: which files belong to a context
 *  is Koine Studio domain logic, so it lives in this adapter, not in the koine-ui panel. */
function koiStemOfUri(uri: string): string | null {
  const slash = uri.lastIndexOf('/');
  const base = (slash >= 0 ? uri.slice(slash + 1) : uri).toLowerCase();
  return base.endsWith('.koi') ? base.slice(0, -'.koi'.length) : null;
}

/**
 * Adapts the app store's diagnostics + active-context slices to `DiagnosticsStripPanel`'s generic
 * `ReadableStore<DiagnosticsStripSlice>` — already scoped, ordered, classified and counted, so the
 * panel never sees `LspDiagnostic`, the `.koi`-stem context convention, or severity numbers.
 *
 * Scope-to-context (#1188 / ADR 0009): pass `scope` and the slice follows the active bounded context —
 * when a REAL context is active, `rows` span that context's files' diagnostics (matched by `.koi` stem,
 * in first-seen uri order — the slice preserves it), each pre-labelled via `scope.uriLabel` for the
 * panel's cross-file row prefix. Absent `scope`, or under *All contexts*, the slice is the ACTIVE
 * file's diagnostics, byte-for-byte the old active-file strip.
 *
 * `activeUri` is read LIVE inside the selector (it's editor wiring, not store state): a `getState()`
 * after a file switch reflects the new file even without a store write — which is what lets
 * editorSession's paintActive re-render the mounted panel synchronously on a switch (the panel re-reads
 * `getState()` during render). Row classification goes through `severityErrorOrWarning` (the shared
 * severity bucketing, which the strip's row colour always used: only severity 2 is a warn row) while
 * the COUNT goes through `diagnosticsSummary` (which drops info/hint) joined with the strip's ` · ` —
 * exactly the pre-extraction pairing.
 *
 * Same known tradeoff as `createWorkspaceProblemsStore` above: the adapter's listener re-runs this
 * selector on EVERY app-store write; `stripSliceEqual`'s element-wise rows comparison (fresh array of
 * fresh row objects per call — the #944 `parts` footgun again) still keeps unrelated writes from
 * notifying, but not from recomputing. Acceptable at this scale (a linear scan of one file's — or one
 * context's — diagnostics per write).
 */
export function createDiagnosticsStripStore(
  store: StoreApi<AppState>,
  opts: {
    /** The editor's live active-file uri (editorSession's `deps.activeUri` — not store state). */
    activeUri: () => string;
    /** Scope-to-context support (#1188 / ADR 0009). Absent → the slice never scopes. */
    scope?: {
      /** A short file label for a scoped, cross-file row (its relPath / basename). */
      uriLabel: (uri: string) => string;
    };
  },
) {
  const row = (uri: string, d: LspDiagnostic, label?: string): DiagnosticsStripRow => ({
    uri,
    label,
    severity: severityErrorOrWarning(d.severity),
    range: d.range,
    message: d.message,
    code: d.code,
  });
  return zustandToReadableStore(
    store,
    (s): DiagnosticsStripSlice => {
      const scoped = opts.scope != null && !isAllContexts(s.activeContext);
      const rows: DiagnosticsStripRow[] = [];
      const diags: LspDiagnostic[] = [];
      if (scoped) {
        const context = s.activeContext.toLowerCase();
        for (const [uri, ds] of Object.entries(s.diagnosticsByUri)) {
          if (koiStemOfUri(uri) !== context) continue;
          for (const d of ds) {
            rows.push(row(uri, d, opts.scope!.uriLabel(uri)));
            diags.push(d);
          }
        }
      } else {
        const uri = opts.activeUri();
        for (const d of s.diagnosticsByUri[uri] ?? []) {
          rows.push(row(uri, d));
          diags.push(d);
        }
      }
      const { kind, parts } = diagnosticsSummary(diags);
      // Clean ⇒ the literal 'clean' sentinel; otherwise join the shared parts with ' · ' (the strip's join).
      return { scoped, rows, count: kind === 'clean' ? 'clean' : parts.join(' · '), kind };
    },
    stripSliceEqual,
  );
}

/** Element-wise rows comparison (`range` by reference — diagnostics are reference-stable in the store
 *  until re-pushed) plus `Object.is` on the scalars — same rationale as `problemsSliceEqual` above. */
function stripSliceEqual(a: DiagnosticsStripSlice, b: DiagnosticsStripSlice): boolean {
  return (
    a.scoped === b.scoped &&
    a.kind === b.kind &&
    a.count === b.count &&
    a.rows.length === b.rows.length &&
    a.rows.every((r, i) => {
      const o = b.rows[i];
      return (
        r.uri === o.uri &&
        r.label === o.label &&
        r.severity === o.severity &&
        r.range === o.range &&
        r.message === o.message &&
        r.code === o.code
      );
    })
  );
}
