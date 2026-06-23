import type { LspDiagnostic } from '@/lsp/lsp';
import { severityErrorOrWarning } from '@/lsp/severity';

// A per-uri error/warning-count gate for the file-tree badges. The LSP republishes diagnostics for a
// file on every keystroke, and ide.ts used to `renderTree()` on EVERY push — rebuilding the whole
// explorer even when a file's badge counts were unchanged. The only diagnostics-driven tree output is
// the per-file `tree-badge-err` / `tree-badge-warn` count, so a push that doesn't change a file's
// (errors, warnings) pair produces an identical tree: the gate lets the caller skip that rebuild.
//
// IMPORTANT: the counts MUST be classified exactly as the tree badge classifies them — the badge
// (ide.ts `diagCounts`) treats ONLY severity 2 as a warning and everything else (severity 1, info/hint
// 3/4, or unset) as an error. So the gate shares `badgeCounts` with that badge; using the status-bar
// `diagnosticsSummary` instead (which ignores severity 3/4) would let an info/hint-only change slip
// past the gate while the badge wanted to update. A never-seen uri counts as zero/zero, so a clean
// file's first push (the common didOpen case) is correctly NOT a change.
//
// The `last` map is a cache of what each file's badge currently shows. It MUST be invalidated whenever
// the diagnostics slice is cleared/dropped out from under it (reset/forget), or a file that reopens
// with the same counts as before would have its badge rebuild suppressed and the badge would go stale.

interface Counts {
  errors: number;
  warnings: number;
}

/** Count a diagnostics set the way the file-tree badge does: severity 2 ⇒ warning, all else ⇒ error. */
export function badgeCounts(diags: LspDiagnostic[]): Counts {
  let errors = 0;
  let warnings = 0;
  for (const d of diags) {
    if (severityErrorOrWarning(d.severity) === 'warning') warnings++;
    else errors++; // severity 1, info/hint (3/4), or unset ⇒ error
  }
  return { errors, warnings };
}

export interface DiagCountGate {
  /**
   * Record the badge counts for `uri` derived from `diags`; return true iff they differ from the counts
   * last seen for that uri (a never-seen uri counts as zero/zero). When true, the caller should re-render
   * the file tree; when false, the badge is unchanged and the rebuild can be skipped.
   */
  changed(uri: string, diags: LspDiagnostic[]): boolean;
  /** Forget a single uri's remembered counts — call on dropDiagnostics / renameDiagnostics(oldUri). */
  forget(uri: string): void;
  /** Forget every uri — call when the whole diagnostics slice is cleared (folder reopen / new model). */
  reset(): void;
}

export function createDiagCountGate(): DiagCountGate {
  const last = new Map<string, Counts>();
  return {
    changed(uri, diags) {
      const { errors, warnings } = badgeCounts(diags);
      const prev = last.get(uri) ?? { errors: 0, warnings: 0 };
      if (prev.errors === errors && prev.warnings === warnings) return false;
      last.set(uri, { errors, warnings });
      return true;
    },
    forget(uri) {
      last.delete(uri);
    },
    reset() {
      last.clear();
    },
  };
}
