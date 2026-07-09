import { useReadableStore, type ReadableStore } from '../host/store';

/**
 * The already-classified slice `WorkspaceProblemsBadge` needs — plain counts, not raw diagnostics.
 * Deliberately NOT Koine Studio's `LspDiagnostic[]`/`diagnosticsByUri` shape: severity classification
 * (which severity numbers count as an error vs. a warning) is Koine Studio domain logic that stays owned
 * by `@/lsp/severity` + `@/diagnostics/diagnosticsSummary` — the single home issue #193 gave it, so it
 * can't drift across the strip/status-pill/badge call sites. The host's adapter selector calls that
 * classifier and hands this component only the resulting numbers; this component's only job is
 * formatting them, exactly the same pluralisation/join it always did.
 */
export interface WorkspaceProblemsSlice {
  errors: number;
  warnings: number;
  /** Count of files that currently have at least one diagnostic (error or warning). */
  fileCount: number;
}

// The workspace-wide problems rollup in the status bar (#193 follow-up). The status bar's #sb-validity
// only ever describes the ACTIVE file; this badge reads the WHOLE diagnostics slice (via the host) so a
// broken context in an unopened file is visible at a glance instead of discovered by accident.
//
// It renders nothing while the workspace is clean (the absence IS the "all good" signal, and #sb-validity
// already states the active file's health), so it only ever draws attention when something is actually
// wrong.
//
// Moved from `koine-studio/src/diagnostics/WorkspaceProblemsBadge.tsx` (issue #944, second-tranche
// extraction): the original read the raw `diagnosticsByUri` map and called `diagnosticsSummary` itself;
// this version takes the already-summarised `{ errors, warnings, fileCount }` numbers instead, so the
// component never imports Zustand, `AppState`, or Koine Studio's `LspDiagnostic` type. The host computes
// those numbers in its `zustandToReadableStore` selector (reusing the same `diagnosticsSummary`
// classifier the strip/status-pill still use directly), and the host adapter's shallow-equal check keeps
// the "re-render only when the counts actually change" property the original's reference-stable
// `diagnosticsByUri` selector had.
export function WorkspaceProblemsBadge(props: { store: ReadableStore<WorkspaceProblemsSlice> }) {
  const { errors, warnings, fileCount } = useReadableStore(props.store);
  if (!errors && !warnings) return null;
  const kind = errors ? 'error' : 'warn';
  const parts: string[] = [];
  if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  if (warnings) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  return (
    <span class="sb-item koi-problems-badge" data-role="workspace-problems" data-kind={kind}>
      {`${parts.join(' · ')} in ${fileCount} file${fileCount === 1 ? '' : 's'}`}
    </span>
  );
}
