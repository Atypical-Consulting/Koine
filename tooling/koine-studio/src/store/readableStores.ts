import type { StoreApi } from 'zustand/vanilla';
import type { DiagnosticsStripRow, DiagnosticsStripSlice, RelationshipsPanelSlice } from '@atypical/koine-ui';
import type { AppState } from '@/store/index';
import { diagnosticsSummary } from '@/diagnostics/diagnosticsSummary';
import { isAllContexts, scopeGraph } from '@/model/activeContext';
import { extractRelationships } from '@/model/modelTables';
import { severityErrorOrWarning } from '@/lsp/severity';
import type { DiagramGraph, LspDiagnostic } from '@/lsp/lsp';
import { shallowEqual, zustandToReadableStore } from '@/store/readableStoreAdapter';
import { koiStem } from '@/shell/explorerModel';
import { basename } from '@/shared/path';

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
 * Unlike `createWorkspaceProblemsStore` above (which recomputes on every store write and relies solely
 * on its equality gate), this selector is wrapped in a 3-key reference memo: the last
 * (`s.diagnosticsByUri`, `s.activeContext`, live `activeUri()` value) triple is cached alongside its
 * slice, and while all three are unchanged the cached slice is returned as-is — no rows rebuild, no
 * re-classification on unrelated store writes. `diagnosticsByUri` is replaced immutably on every
 * diagnostics mutation (see slices/diagnostics.ts), so its reference is a sound key; keying on the
 * live `activeUri()` VALUE preserves the paintActive synchronous-fresh-read contract above — a file
 * switch changes the key and recomputes on the very next `getState()`. `stripSliceEqual` stays as the
 * notification gate for the recompute paths.
 *
 * Known narrow edge of the memo: a `scope.uriLabel` output change with all three keys unchanged (e.g.
 * a workspace-root change that re-derives relPath labels without any diagnostics push) would serve the
 * cached slice with the old labels — pre-memo, the recompute-per-write meant the equality gate noticed
 * the label diff on the next store write and notified. `opts` carries no root/label-version token to
 * fold into the key today; in practice a root change is followed by diagnostics re-pushes (a new
 * `diagnosticsByUri` reference), which recompute anyway. Fold a label-version key in if that ever
 * stops holding.
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
  // The 3-key reference memo — see the doc comment above for why these three keys are sound (and the
  // one known uriLabel edge they don't cover).
  let memo:
    | {
        byUri: Record<string, LspDiagnostic[]>;
        context: string;
        activeUri: string;
        slice: DiagnosticsStripSlice;
      }
    | undefined;
  return zustandToReadableStore(
    store,
    (s): DiagnosticsStripSlice => {
      const activeUri = opts.activeUri();
      if (
        memo != null &&
        memo.byUri === s.diagnosticsByUri &&
        memo.context === s.activeContext &&
        memo.activeUri === activeUri
      ) {
        return memo.slice;
      }
      const scoped = opts.scope != null && !isAllContexts(s.activeContext);
      const rows: DiagnosticsStripRow[] = [];
      const diags: LspDiagnostic[] = [];
      if (scoped) {
        const context = s.activeContext.toLowerCase();
        for (const [uri, ds] of Object.entries(s.diagnosticsByUri)) {
          // Which files belong to a context is Koine Studio domain logic (one `.koi` file is one
          // bounded context): route through the canonical `koiStem` over the uri's trailing segment,
          // the same stem convention the Files-tree scope emphasis matches against.
          if (koiStem(basename(uri)) !== context) continue;
          for (const d of ds) {
            rows.push(row(uri, d, opts.scope!.uriLabel(uri)));
            diags.push(d);
          }
        }
      } else {
        for (const d of s.diagnosticsByUri[activeUri] ?? []) {
          rows.push(row(activeUri, d));
          diags.push(d);
        }
      }
      const { kind, parts } = diagnosticsSummary(diags);
      // Clean ⇒ the literal 'clean' sentinel; otherwise join the shared parts with ' · ' (the strip's join).
      const slice: DiagnosticsStripSlice = {
        scoped,
        rows,
        count: kind === 'clean' ? 'clean' : parts.join(' · '),
        kind,
      };
      memo = { byUri: s.diagnosticsByUri, context: s.activeContext, activeUri, slice };
      return slice;
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

/**
 * Adapts the controller-fetched merged diagram graph + the active-context slice to `RelationshipsPanel`'s
 * generic `ReadableStore<RelationshipsPanelSlice>` — already scoped to the active bounded context and
 * extracted to plain structural rows (issue #1408, fourth-tranche host-adapter migration), so the panel
 * never sees `DiagramGraph`, `scopeGraph`, or `extractRelationships` (those classifiers stay in their
 * owning Studio modules). `graph` is fixed for this adapter instance (the controller re-creates the
 * adapter per livingDocs fetch — see surfaceLoaders' bottomGraph), so only `s.activeContext` varies: the
 * selector is memoised on it (rows rebuild only on a real scope change, not on unrelated store writes),
 * with `relationshipsSliceEqual` as the notification gate for the rebuild — the freshly built rows array
 * would never compare equal by reference. "All contexts" is scopeGraph's identity, so it yields every row.
 */
export function createRelationshipsPanelStore(store: StoreApi<AppState>, graph: DiagramGraph) {
  let memo: { context: string; slice: RelationshipsPanelSlice } | undefined;
  return zustandToReadableStore(
    store,
    (s): RelationshipsPanelSlice => {
      if (memo != null && memo.context === s.activeContext) return memo.slice;
      const slice: RelationshipsPanelSlice = { rows: extractRelationships(scopeGraph(graph, s.activeContext)) };
      memo = { context: s.activeContext, slice };
      return slice;
    },
    relationshipsSliceEqual,
  );
}

/** Element-wise rows comparison (`span` by reference — a scoped graph's node spans are reference-stable for
 *  this adapter instance) plus element-wise `contexts` — same rationale as `stripSliceEqual` above. */
function relationshipsSliceEqual(a: RelationshipsPanelSlice, b: RelationshipsPanelSlice): boolean {
  return (
    a.rows.length === b.rows.length &&
    a.rows.every((r, i) => {
      const o = b.rows[i];
      return (
        r.source === o.source &&
        r.relation === o.relation &&
        r.target === o.target &&
        r.span === o.span &&
        r.contexts.length === o.contexts.length &&
        r.contexts.every((c, j) => c === o.contexts[j])
      );
    })
  );
}
