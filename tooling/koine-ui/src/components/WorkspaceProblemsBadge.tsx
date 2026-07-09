import { useReadableStore, type ReadableStore } from '../host/store';

/**
 * The already-classified AND already-formatted slice `WorkspaceProblemsBadge` needs — not raw
 * diagnostics. Deliberately NOT Koine Studio's `LspDiagnostic[]`/`diagnosticsByUri` shape: severity
 * classification (which severity numbers count as an error vs. a warning) AND the count-string wording
 * (pluralisation, separator) are Koine Studio domain logic that stay owned by `@/lsp/severity` +
 * `@/diagnostics/diagnosticsSummary` — the single home issue #193 gave them, so they can't drift across
 * the strip/status-pill/badge call sites. The host's adapter selector calls that classifier and forwards
 * its `kind`/`parts` output UNCHANGED; this component only decides whether/how to render them, never
 * re-derives them.
 */
export interface WorkspaceProblemsSlice {
  /** `clean` when there are no errors or warnings anywhere in the workspace. */
  kind: 'clean' | 'warn' | 'error';
  /** Pre-formatted, pre-pluralised count fragments (e.g. `['2 errors', '1 warning']`), empty when clean. */
  parts: string[];
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
// this version takes its already-summarised `{ kind, parts, fileCount }` output instead, so the component
// never imports Zustand, `AppState`, or Koine Studio's `LspDiagnostic` type, AND never re-derives
// classification/pluralisation wording that could drift from the diagnostics strip / status pill. The
// host computes that summary in its `zustandToReadableStore` selector (reusing `diagnosticsSummary`
// directly), and the host adapter's equality check keeps the "re-render only when the summary actually
// changes" property the original's reference-stable `diagnosticsByUri` selector had.
export function WorkspaceProblemsBadge(props: { store: ReadableStore<WorkspaceProblemsSlice> }) {
  const { kind, parts, fileCount } = useReadableStore(props.store);
  if (kind === 'clean') return null;
  return (
    <span class="sb-item koi-problems-badge" data-role="workspace-problems" data-kind={kind}>
      {`${parts.join(' · ')} in ${fileCount} file${fileCount === 1 ? '' : 's'}`}
    </span>
  );
}
