import type { StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { AppState } from '../store/index';
import type { LspDiagnostic } from '../lsp';

// The editor's diagnostics strip (#diag-count + #diag-body) as a Preact panel (#193). It subscribes to
// the `diagnosticsByUri` slice and, via the injected `activeUri`, renders the ACTIVE file's diagnostics:
// the count summary + one clickable row per diagnostic. The count/label/row strings are ported
// BYTE-FOR-BYTE from editorSession's old imperative `renderStrip` (a `clean` state, `N error(s)` /
// `M warning(s)` joined with ` · `, an empty `No diagnostics.` body, and a `error|warn LINE:COL  CODE MSG`
// row), so the observable output is identical — only the renderer moved. The editor gutter paint and the
// status pill / #sb-validity mirror stay imperative in editorSession; this panel owns ONLY the strip.

/** The strip count summary + its data-kind, matching editorSession.renderStrip's #diag-count writes. */
function countText(diags: LspDiagnostic[]): { count: string; kind: string } {
  const errors = diags.filter((d) => d.severity === 1 || d.severity == null).length;
  const warnings = diags.filter((d) => d.severity === 2).length;
  if (!errors && !warnings) return { count: 'clean', kind: 'clean' };
  const parts: string[] = [];
  if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  if (warnings) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  return { count: parts.join(' · '), kind: errors ? 'error' : 'warn' };
}

export function DiagnosticsStripPanel(props: {
  store: StoreApi<AppState>;
  activeUri: () => string;
  onGoto: (line: number, col: number) => void;
}) {
  // Subscribe to exactly the per-uri diagnostics cache; an unrelated slice change leaves the strip alone.
  const byUri = useStore(props.store, (s) => s.diagnosticsByUri);
  const diags = byUri[props.activeUri()] ?? [];
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
