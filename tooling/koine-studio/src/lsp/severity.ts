// The one canonical classification of an LSP DiagnosticSeverity number. Keep ALL severity-number
// comparisons here so the diagnostics consumers can't silently drift apart (issue: three+ sites used to
// hard-code `=== 2` / `=== 1 || == null`). The consumers intentionally bucket info/hint differently:
//
//   • diagnosticsSummary (status bar / strip / workspace badge) keeps an info/hint tier and DROPS it —
//     it counts only `error` and `warning` categories.
//   • the file-tree badge, the CodeMirror gutter and the AI context have no info/hint tier, so they
//     surface anything that isn't a warning as an error — that collapse is `severityErrorOrWarning`.
//
// Routing both through this module makes that divergence explicit and impossible to break by accident.

export type SeverityCategory = 'error' | 'warning' | 'info' | 'hint';

/** The LSP DiagnosticSeverity mapping: 1→error, 2→warning, 3→info, 4→hint. Unset/out-of-range → error. */
export function severityCategory(severity?: number): SeverityCategory {
  switch (severity) {
    case 2:
      return 'warning';
    case 3:
      return 'info';
    case 4:
      return 'hint';
    default:
      return 'error'; // severity 1, unset, or any out-of-range value
  }
}

/**
 * Coarse error|warning bucketing for consumers with no info/hint tier (the file-tree badge, the
 * CodeMirror gutter, the AI context): only severity 2 is a warning; everything else is an error.
 * NOTE: the status-bar `diagnosticsSummary` deliberately does NOT use this — it drops info/hint.
 */
export function severityErrorOrWarning(severity?: number): 'error' | 'warning' {
  return severityCategory(severity) === 'warning' ? 'warning' : 'error';
}
