import type { StoreApi } from 'zustand/vanilla';
import { useLayoutEffect } from 'preact/hooks';
import type { AppState } from '@/store/index';
import { useAppStore } from '@/store/hooks';
import { diagnosticsSummary } from '@/diagnostics/diagnosticsSummary';
import { isAllContexts } from '@/model/activeContext';
import type { LspDiagnostic, Range } from '@/lsp/lsp';

// The editor's diagnostics strip (#diag-count + #diag-body) as a Preact panel (#193). It subscribes to
// the `diagnosticsByUri` slice and, via the injected `activeUri`, renders the ACTIVE file's diagnostics:
// the count summary + one clickable row per diagnostic. The count/label/row strings are ported
// BYTE-FOR-BYTE from editorSession's old imperative `renderStrip` (a `clean` state, `N error(s)` /
// `M warning(s)` joined with ` · `, an empty `No diagnostics.` body, and a `error|warn LINE:COL  CODE MSG`
// row), so the observable output is identical — only the renderer moved. The editor gutter paint and the
// status pill / #sb-validity mirror stay imperative in editorSession; this panel owns ONLY the strip.
//
// Scope-to-context (#1188 / ADR 0009): when a `scope` is supplied AND a real bounded context is active,
// the strip obeys the active-context spine — it shows THAT context's files' diagnostics (matched by `.koi`
// stem) instead of only the active file's, so "Context: Billing" narrows Problems too. Each scoped row is
// prefixed with its file and opens it on click. Absent `scope`, or the *All contexts* view, is the
// active-file strip above, byte-for-byte — so the default (and every existing caller) is unchanged.
//
// The Problems tab count pill (#diag-count) mirrors THIS panel's count (#1203): the host passes the pill
// element as `countEl` and the panel writes the SAME text + data-kind it renders in its own count span —
// so the pill is scoped exactly when the strip is scoped, from one computation. The status-bar problem
// counts (#sb-problems-errors/-warnings) deliberately stay active-file, in editorSession.

/** Stable empty reference so the active-uri selector yields an `===`-equal value when a file is clean. */
const EMPTY_DIAGS: LspDiagnostic[] = [];
/** Stable empty map so the whole-slice selector below only re-renders on other files' pushes while SCOPED. */
const EMPTY_BY_URI: Record<string, LspDiagnostic[]> = {};

/** The bounded context a source file denotes — its `.koi` stem, lowercased — or null for a non-`.koi` uri.
 *  One `.koi` file is one bounded context (the stem convention the Files-tree scope emphasis uses). */
function koiStemOfUri(uri: string): string | null {
  const slash = uri.lastIndexOf('/');
  const base = (slash >= 0 ? uri.slice(slash + 1) : uri).toLowerCase();
  return base.endsWith('.koi') ? base.slice(0, -'.koi'.length) : null;
}

/** The strip count summary + its data-kind, matching editorSession.renderStrip's #diag-count writes. */
function countText(diags: LspDiagnostic[]): { count: string; kind: string } {
  const { kind, parts } = diagnosticsSummary(diags);
  // Clean ⇒ the literal 'clean' sentinel; otherwise join the shared parts with ' · ' (the strip's join).
  return { count: kind === 'clean' ? 'clean' : parts.join(' · '), kind };
}

export function DiagnosticsStripPanel(props: {
  store: StoreApi<AppState>;
  activeUri: () => string;
  onGoto: (line: number, col: number) => void;
  /** Optional scope-to-context support (#1188 / ADR 0009). When present AND a real bounded context is
   *  active, the strip shows THAT context's files' diagnostics (matched by `.koi` stem), each row labelled
   *  with its file and opening it on click via {@link onOpen}. Absent (or *All contexts*) → the active-file
   *  strip, byte-for-byte unchanged. */
  scope?: {
    /** A short file label for a scoped, cross-file row (its relPath / basename). */
    uriLabel: (uri: string) => string;
    /** Open a scoped row's file and jump to `range` (0-based LSP positions). */
    onOpen: (uri: string, range: Range) => void;
  };
  /** Optional external count badge — the Problems tab pill (#diag-count) — mirrored from this panel's
   *  own count (#1203): same text + data-kind, scoped exactly when the strip is scoped. The status-bar
   *  problem counts are NOT this mirror; they stay active-file (editorSession). */
  countEl?: HTMLElement;
}) {
  // The active scope decides the mode; a primitive read, so it re-renders the strip on a scope change.
  const activeContext = useAppStore(props.store, (s) => s.activeContext);
  const scoping = props.scope != null && !isAllContexts(activeContext);
  // Unscoped: subscribe to the ACTIVE file's diagnostics only — a push for any OTHER file changes a
  // different map entry, so this selector returns the same array reference and the strip does not
  // re-render (the old `if (uri === activeUri())` gate). Scoped: this stays EMPTY (the whole-map selector
  // below drives the render), so the two subscriptions never both churn.
  const activeDiags = useAppStore(props.store, (s) => (scoping ? EMPTY_DIAGS : s.diagnosticsByUri[props.activeUri()])) ?? EMPTY_DIAGS;
  // Scoped: subscribe to the WHOLE diagnostics slice so any file in the context repaints the strip. Only
  // while scoping — otherwise the stable EMPTY_BY_URI keeps the active-file-only optimisation above.
  const byUri = useAppStore(props.store, (s) => (scoping ? s.diagnosticsByUri : EMPTY_BY_URI));

  // Every diagnostic across the active context's `.koi` files, in first-seen uri order (the slice
  // preserves it). Only populated while scoping — the unscoped strip never reads it.
  const rows: { uri: string; d: LspDiagnostic }[] = [];
  if (scoping) {
    const context = activeContext.toLowerCase();
    for (const [uri, diags] of Object.entries(byUri)) {
      if (koiStemOfUri(uri) !== context) continue;
      for (const d of diags) rows.push({ uri, d });
    }
  }
  // ONE count computation feeds both the strip's own count span and the external #diag-count pill —
  // scoped and unscoped agree by construction (#1203).
  const { count, kind } = countText(scoping ? rows.map((r) => r.d) : activeDiags);

  // Mirror the count into the Problems tab pill (#diag-count). A layout effect so a synchronous
  // top-level render (editorSession's paintActive) lands the pill write before the caller returns,
  // matching the old imperative renderStrip timing.
  const { countEl } = props;
  useLayoutEffect(() => {
    if (!countEl) return;
    countEl.textContent = count;
    countEl.dataset.kind = kind;
  }, [countEl, count, kind]);

  if (scoping) {
    return (
      <div class="koi-diag-strip">
        <span data-role="diag-count" data-kind={kind}>
          {count}
        </span>
        <div data-role="diag-body">
          {rows.length === 0 ? (
            <span class="diag-empty">No diagnostics.</span>
          ) : (
            rows.map(({ uri, d }) => {
              const line = d.range.start.line + 1;
              const col = d.range.start.character + 1;
              const code = d.code != null ? `${d.code}: ` : '';
              // A scoped row prefixes its file so a cross-file problem is attributable, and opens that file.
              return (
                <button
                  type="button"
                  class={d.severity === 2 ? 'diag diag-warn' : 'diag diag-err'}
                  onClick={() => props.scope!.onOpen(uri, d.range)}
                >
                  {`${props.scope!.uriLabel(uri)}  ${d.severity === 2 ? 'warn' : 'error'} ${line}:${col}  ${code}${d.message}`}
                </button>
              );
            })
          )}
        </div>
      </div>
    );
  }

  return (
    <div class="koi-diag-strip">
      <span data-role="diag-count" data-kind={kind}>
        {count}
      </span>
      <div data-role="diag-body">
        {activeDiags.length === 0 ? (
          <span class="diag-empty">No diagnostics.</span>
        ) : (
          activeDiags.map((d) => {
            const line = d.range.start.line + 1;
            const col = d.range.start.character + 1;
            const code = d.code != null ? `${d.code}: ` : '';
            return (
              <button
                type="button"
                class={d.severity === 2 ? 'diag diag-warn' : 'diag diag-err'}
                onClick={() => props.onGoto(line, col)}
              >
                {`${d.severity === 2 ? 'warn' : 'error'} ${line}:${col}  ${code}${d.message}`}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
