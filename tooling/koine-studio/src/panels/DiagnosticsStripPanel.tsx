import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '../store/index';
import { useAppStore } from '../store/hooks';
import { diagnosticsSummary } from '../diagnosticsSummary';
import type { LspDiagnostic } from '../lsp';

// The editor's diagnostics strip (#diag-count + #diag-body) as a Preact panel (#193). It subscribes to
// the `diagnosticsByUri` slice and, via the injected `activeUri`, renders the ACTIVE file's diagnostics:
// the count summary + one clickable row per diagnostic. The count/label/row strings are ported
// BYTE-FOR-BYTE from editorSession's old imperative `renderStrip` (a `clean` state, `N error(s)` /
// `M warning(s)` joined with ` · `, an empty `No diagnostics.` body, and a `error|warn LINE:COL  CODE MSG`
// row), so the observable output is identical — only the renderer moved. The editor gutter paint and the
// status pill / #sb-validity mirror stay imperative in editorSession; this panel owns ONLY the strip.

/** Stable empty reference so the active-uri selector yields an `===`-equal value when a file is clean. */
const EMPTY_DIAGS: LspDiagnostic[] = [];

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
}) {
  // Subscribe to the ACTIVE file's diagnostics only: a push for any other file changes a different map
  // entry, so this selector returns the same array reference and the strip does not re-render (matching the
  // old `if (uri === activeUri())` gate in editorSession.renderDiagnostics).
  const diags = useAppStore(props.store, (s) => s.diagnosticsByUri[props.activeUri()]) ?? EMPTY_DIAGS;
  const { count, kind } = countText(diags);
  return (
    <div class="koi-diag-strip">
      <span data-role="diag-count" data-kind={kind}>
        {count}
      </span>
      <div data-role="diag-body">
        {diags.length === 0 ? (
          <span class="diag-empty">No diagnostics.</span>
        ) : (
          diags.map((d) => {
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
