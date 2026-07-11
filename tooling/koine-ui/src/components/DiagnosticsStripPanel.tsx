import { useReadableStore, type ReadableStore } from '../host/store';

/** A diagnostic's source range in 0-based LSP positions — structurally compatible with the host's
 *  LSP `Range` type, declared here so this package never imports Koine Studio's `@/lsp` module. */
export interface DiagnosticsStripRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/** One renderable strip row. The host's adapter pre-classifies the severity (Koine Studio's
 *  `severityErrorOrWarning`, the single home for severity-number bucketing) and pre-formats the
 *  cross-file `label` (its relPath/basename), so this component never re-derives either. */
export interface DiagnosticsStripRow {
  /** The row's source file — handed back to {@link DiagnosticsStripPanel}'s `onOpen` on a scoped click. */
  uri: string;
  /** Pre-formatted file label for a scoped, cross-file row; absent on active-file rows. */
  label?: string;
  /** Host-classified severity bucket (only `warning` renders as a warn row; anything else is an error). */
  severity: 'error' | 'warning';
  range: DiagnosticsStripRange;
  message: string;
  /** Optional diagnostic code, rendered as a `CODE: ` prefix before the message. */
  code?: string | number;
}

/**
 * The slice `DiagnosticsStripPanel` needs from a host's diagnostics state — already scoped, ordered,
 * classified AND counted. Deliberately NOT the host's raw `diagnosticsByUri` map: which files belong to
 * the active bounded context (Koine Studio's `.koi`-stem convention), which severities count as errors
 * vs. warnings, and the count-string wording (pluralisation, the ` · ` join) are Koine Studio domain
 * logic that stay owned by `@/model/activeContext`, `@/lsp/severity` and `@/diagnostics/diagnosticsSummary`
 * — the single homes issue #193 gave them. The host's adapter selector (koine-studio's
 * `createDiagnosticsStripStore`) applies them and forwards the results; this component only renders.
 */
export interface DiagnosticsStripSlice {
  /** True when the host is scoping the strip to the active bounded context (ADR 0009 / #1188):
   *  rows then span that context's files, are file-labelled, and open their file on click. */
  scoped: boolean;
  /** The diagnostics to render, one row each — the active file's (unscoped) or the context's (scoped). */
  rows: DiagnosticsStripRow[];
  /** Pre-formatted count summary: the literal `clean` sentinel, or e.g. `2 errors · 1 warning`. */
  count: string;
  kind: 'clean' | 'warn' | 'error';
}

// The editor's diagnostics strip (#diag-count + #diag-body) as a Preact panel (#193). It renders the
// host slice's rows: the count summary + one clickable row per diagnostic. The count/label/row strings
// are ported BYTE-FOR-BYTE from editorSession's old imperative `renderStrip` (a `clean` state,
// `N error(s)` / `M warning(s)` joined with ` · `, an empty `No diagnostics.` body, and a
// `error|warn LINE:COL  CODE MSG` row), so the observable output is identical — only the renderer moved.
// The editor gutter paint and the status-bar counts stay imperative in editorSession;
// this panel owns ONLY the strip rendering.
//
// The Problems tab count pill (#diag-count) is mirrored host-side from the same adapted store (#1406):
// the host adapter (editorSession's `renderDiagPill`) reads the same memoized slice and updates the
// pill element, so pill and strip stay in lock-step from one computation. The status-bar problem
// counts (#sb-problems-errors/-warnings) deliberately stay active-file, in editorSession.
//
// Moved from `koine-studio/src/diagnostics/DiagnosticsStripPanel.tsx` (issue #1244, third-tranche
// extraction): the component used to run three `useAppStore` selectors (activeContext + the active
// file's diagnostics + the whole map while scoped) and derive scoping/rows/count itself; it now depends
// on `ReadableStore<DiagnosticsStripSlice>` (issue #944's host-adapter contract), so that derivation —
// and the "don't re-render on an unrelated store write" gate — live in the host's adapter instead.
export function DiagnosticsStripPanel(props: {
  store: ReadableStore<DiagnosticsStripSlice>;
  /** Jump within the active file — an unscoped row's click (1-based line/col, the editor's convention). */
  onGoto: (line: number, col: number) => void;
  /** Open a scoped row's file and jump to `range` (0-based LSP positions). Required whenever the host's
   *  adapter can yield `scoped: true` slices (i.e. it was built with scope-to-context support). */
  onOpen?: (uri: string, range: DiagnosticsStripRange) => void;
}) {
  // Subscribe for host-notified changes (diagnostics pushes, scope switches)…
  useReadableStore(props.store);
  // …but RENDER from a fresh getState() read: the host (editorSession's paintActive) re-renders this
  // mounted panel synchronously on an active-file switch, a change the adapter's selector observes via
  // its live `activeUri()` closure WITHOUT a store notification. Reading during render (the same
  // semantics `useSyncExternalStore` + a render-time selector had pre-extraction) keeps that top-level
  // render fresh; `useReadableStore`'s cached copy alone would serve the previous file's slice until the
  // next notification.
  const { scoped, rows, count, kind } = props.store.getState();

  return (
    <div class="koi-diag-strip">
      <span data-role="diag-count" data-kind={kind}>
        {count}
      </span>
      <div data-role="diag-body">
        {rows.length === 0 ? (
          <span class="diag-empty">No diagnostics.</span>
        ) : (
          rows.map((row) => {
            const line = row.range.start.line + 1;
            const col = row.range.start.character + 1;
            const code = row.code != null ? `${row.code}: ` : '';
            const sev = row.severity === 'warning' ? 'warn' : 'error';
            // A scoped row prefixes its file so a cross-file problem is attributable, and opens that
            // file; an unscoped row jumps within the active file, byte-for-byte the old strip row.
            return (
              <button
                type="button"
                class={row.severity === 'warning' ? 'diag diag-warn' : 'diag diag-err'}
                onClick={() => (scoped ? props.onOpen?.(row.uri, row.range) : props.onGoto(line, col))}
              >
                {`${scoped ? `${row.label ?? row.uri}  ` : ''}${sev} ${line}:${col}  ${code}${row.message}`}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
