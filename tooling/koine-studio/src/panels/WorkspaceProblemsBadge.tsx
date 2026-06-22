import type { StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { AppState } from '@/store/index';
import { diagnosticsSummary } from '@/diagnosticsSummary';

// The workspace-wide problems rollup in the status bar (#193 follow-up). The status bar's #sb-validity
// only ever describes the ACTIVE file; this badge reads the WHOLE diagnostics slice so a broken context
// in an unopened file is visible at a glance instead of discovered by accident. It reuses the shared
// `diagnosticsSummary` classifier so its wording can never drift from the editor's diagnostics strip.
//
// It renders nothing while the workspace is clean (the absence IS the "all good" signal, and #sb-validity
// already states the active file's health), so it only ever draws attention when something is actually
// wrong. Selecting the raw `diagnosticsByUri` reference is intentional: every mutator spreads it
// immutably, so the selector is reference-stable until a real push and the badge re-renders only then —
// no `useShallow` needed.
export function WorkspaceProblemsBadge(props: { store: StoreApi<AppState> }) {
  const byUri = useStore(props.store, (s) => s.diagnosticsByUri);
  const { kind, parts } = diagnosticsSummary(Object.values(byUri).flat());
  if (kind === 'clean') return null;
  const fileCount = Object.values(byUri).filter((d) => d.length > 0).length;
  return (
    <span class="sb-item koi-problems-badge" data-role="workspace-problems" data-kind={kind}>
      {`${parts.join(' · ')} in ${fileCount} file${fileCount === 1 ? '' : 's'}`}
    </span>
  );
}
