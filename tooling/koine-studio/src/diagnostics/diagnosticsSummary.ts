import type { LspDiagnostic } from '@/lsp/lsp';
import { severityCategory } from '@/lsp/severity';

// The single home for classifying a diagnostics set and building its count strings (issue #193). Three
// call sites used to duplicate this: DiagnosticsStripPanel's count text, editorSession.renderStrip's
// #diag-count badge, and editorSession.updateStatus's status pill. They differ ONLY in the separator
// they join `parts` with (` · ` for the strip + #diag-count, ` / ` for the status pill) and in how they
// treat the empty/clean state — so this helper returns the shared pieces (counts, kind, parts) and each
// caller keeps its own join and clean/sentinel handling, preserving the observable strings byte-for-byte.

export interface DiagnosticsSummary {
  /** Errors: severity 1, or unset severity (treated as an error). */
  errors: number;
  /** Warnings: severity 2. */
  warnings: number;
  /** `clean` when empty, else `error` if any errors else `warn` (matches the old #diag-count data-kind). */
  kind: 'clean' | 'warn' | 'error';
  /** Pluralised count fragments, e.g. `['2 errors', '1 warning']`. Empty when clean. Caller picks the join. */
  parts: string[];
}

/**
 * Classify a diagnostics set and build its pluralised count fragments. The severity classification
 * (severity 1 / unset ⇒ error, severity 2 ⇒ warning) and the `${n} error${n===1?'':'s'}` /
 * `${n} warning${...}` pluralisation live HERE so the strip and the status pill share them; callers
 * join `parts` with their own separator and apply their own clean/sentinel wording.
 */
export function diagnosticsSummary(diags: LspDiagnostic[]): DiagnosticsSummary {
  // Errors = severity 1 / unset (the `error` category); warnings = severity 2. The `info`/`hint`
  // categories (severity 3/4) are intentionally counted as neither — see lsp/severity.ts.
  const errors = diags.filter((d) => severityCategory(d.severity) === 'error').length;
  const warnings = diags.filter((d) => severityCategory(d.severity) === 'warning').length;
  const parts: string[] = [];
  if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  if (warnings) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  const kind: DiagnosticsSummary['kind'] = !errors && !warnings ? 'clean' : errors ? 'error' : 'warn';
  return { errors, warnings, kind, parts };
}
