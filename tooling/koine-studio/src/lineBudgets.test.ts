// Table-driven structural guard for Studio's oversized files (#981), generalizing the single-file
// ide.tsx ratchet that `src/shell/ide.budget.test.ts` (#757) proved out. Left unguarded, a file grows
// into a god-file silently — issue #180 carved the old 2,615-LOC `ide.ts` into tested modules but added
// no guard, so it silently regrew to ~2,451 LOC; #757 re-carved it to 1,307 LOC AND added the guard so
// it could not happen a third time. The 2026-07-02 audit found eight more files at or beyond god-file
// size with no guard at all — this table closes that gap for all nine at once.
//
// Each row reads the REAL file from disk (not a fixture) and asserts its total line count stays under a
// ceiling, counted like `wc -l` (total newline-terminated lines) so reformatting never flips the guard;
// only real growth does. When a guarded file crosses its ceiling this fails CI (`npm test`), pointing
// the contributor at the file's owning decomposition issue (or, for ide.tsx, at a controller to extend)
// instead of growing the file further.
//
// Ratchet discipline (carried forward from #757, now table-wide): ceilings only move DOWN — each
// decomposition issue in this arc lowers its row as it lands — or UP with a justification comment on
// the row, reviewed in the PR that raises it. Freezing a ceiling prevents regrowth; it does not force a
// split — the linked decomposition issues own the actual shrinking.
//
// Headroom rule: a freeze ceiling is `ceil(measured wc -l × 1.02)` — enough that a comment tweak or
// small legitimate wiring never trips the guard, small enough that a real feature landing in a frozen
// file does. ide.tsx is the one exception: its ceiling is the live #757 ratchet value, carried over
// verbatim rather than recomputed.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface LineBudget {
  /** Path relative to tooling/koine-studio (resolve(process.cwd(), file)). */
  readonly file: string;
  /** Inclusive ceiling, wc -l semantics. DOWN freely; UP only with a justification comment. */
  readonly maxLines: number;
}

const LINE_BUDGETS: readonly LineBudget[] = [
  // The #757 decomposition carved ide.tsx from 2,451 → 1,307 LOC across seven controllers
  // (commandWiring, layout, exportShare, overlays, panelHost, canvasWrite, lifecycleBoot). This is the
  // FINAL ratchet value: the end-state LOC plus a small headroom margin so a trivial edit doesn't trip
  // the guard, while the next feature that bloats init() (instead of extending a controller — see
  // ide.tsx's composition-root contract) fails CI. Lower it again only if ide.tsx is deliberately
  // shrunk further.
  // Raised 1320 → 1330: #746 added the Settings Esc-dismiss handler (legitimate composition-root
  // wiring) and #789 named it (+ onSaveKey + onHistoryKey) for proper teardown, together adding ~5 LOC
  // net.
  // Raised 1330 → 1340: #789's PR CI validated a ≤1330-line ide.tsx, but its squash-merge landed the
  // file at 1334 lines (4 over the ceiling it set in the same PR) — the squashed snapshot grew past the
  // one CI tested, so the guard has failed on main ever since. The 1334 lines are legitimate #789
  // teardown wiring, so ratchet the ceiling to its real end-state plus headroom rather than re-trimming
  // working code.
  // Raised 1340 → 1365: #923's chrome-v2 shell wires two new controls into init() — the emit-target
  // selector and the status-bar reactive panels. Both keep their logic in their own modules per the
  // contract (emitTargetControl.tsx, statusBar.tsx); only the composition-root wiring grew init() — the
  // two createX deps calls, the emit lookups, and the one-line store mirror in applyEffectiveScoped,
  // ~18 LOC net. Ratchet to the real end-state plus a little headroom.
  // carried over from #757's ratchet — normative, do not recompute via the +2% rule.
  { file: 'src/shell/ide.tsx', maxLines: 1365 },
  // Frozen 2026-07-02 at 2286 LOC (grown from the audit's 2266 @ fc83bcf5), ceil(2286 × 1.02) = 2332.
  // #985 ratchets this down as it decomposes inspectorController.tsx. Freezing prevents further
  // regrowth; it does not mandate the split — #985 owns that.
  { file: 'src/shell/inspectorController.tsx', maxLines: 2332 },
  // Frozen 2026-07-02 at 2205 LOC, ceil(2205 × 1.02) = 2250. #987 ratchets this down as it decomposes
  // prefs.ts. Freezing prevents further regrowth; it does not mandate the split — #987 owns that.
  { file: 'src/settings/prefs.ts', maxLines: 2250 },
  // Frozen 2026-07-02 at 1745 LOC, ceil(1745 × 1.02) = 1780. #986 ratchets this down as it decomposes
  // editor.ts. Freezing prevents further regrowth; it does not mandate the split — #986 owns that.
  { file: 'src/editor/editor.ts', maxLines: 1780 },
  // Frozen 2026-07-02 at 1354 LOC, ceil(1354 × 1.02) = 1382. #990 ratchets this down as it decomposes
  // aiPanel.ts. Freezing prevents further regrowth; it does not mandate the split — #990 owns that.
  { file: 'src/ai/aiPanel.ts', maxLines: 1382 },
  // Frozen 2026-07-02 at 1301 LOC (grown from the audit's 1284 @ fc83bcf5), ceil(1301 × 1.02) = 1328.
  // #989 ratchets this down as it decomposes explorer.ts. Freezing prevents further regrowth; it does
  // not mandate the split — #989 owns that.
  { file: 'src/shell/explorer.ts', maxLines: 1328 },
  // Frozen 2026-07-02 at 1173 LOC, ceil(1173 × 1.02) = 1197. #982 ratchets this down as it decomposes
  // workspaceController.ts. Freezing prevents further regrowth; it does not mandate the split — #982
  // owns that.
  { file: 'src/shell/workspaceController.ts', maxLines: 1197 },
  // Frozen 2026-07-02 at 1017 LOC, ceil(1017 × 1.02) = 1038. #988 ratchets this down as it decomposes
  // persistence.ts. Freezing prevents further regrowth; it does not mandate the split — #988 owns that.
  // Raised 1038 → 1099: #1005's Home resume card needs a persisted last-session snapshot — a new
  // LastSession interface plus its guarded getLastSession/setLastSession accessors (~60 LOC of genuine
  // new API, not regrowth). Ratchet to the real end-state (1077) plus the standard +2% headroom.
  { file: 'src/settings/persistence.ts', maxLines: 1099 },
  // Frozen 2026-07-02 at 890 LOC, ceil(890 × 1.02) = 908. Frozen pending its Preact-migration tranche.
  { file: 'src/welcome/welcome.ts', maxLines: 908 },
];

describe('line-budget guard', () => {
  it.each(LINE_BUDGETS)('keeps $file within its budget ($maxLines lines)', ({ file, maxLines }) => {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8');
    // Count total lines like `wc -l` (newline-terminated): the number of newline characters. Robust to
    // a missing trailing newline (split-then-trim) and indifferent to blank/whitespace lines.
    const lines = source.split('\n');
    const lineCount = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    expect(lineCount).toBeLessThanOrEqual(maxLines);
  });
});
