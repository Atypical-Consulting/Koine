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
  // Lowered 1365 → 1364: #982 inverted workspace ownership — ide.tsx lost the refreshDirtyIndicator
  // projection glue + the two setFolderRootToken pushes (Tasks 2/3) and the four on* seam registrations
  // (Task 4), but the single consolidated seq subscription that replaced them roughly offset the savings
  // (net −1 LOC). Ratchet to the measured end-state.
  // Raised 1364 → 1377: #1017 exported the "New model" seed constant (BLANK) so main.ts can reuse it
  // to seed a first file when a user opts to open a cloned-but-empty folder anyway, plus a new
  // onOpenRecentSucceeded IdeHooks seam (openRecentFolder now reports a successful open, not just a
  // failed one, so the boot layer's one-shot "just cloned" tracking can clear on success too instead of
  // staying pinned to a path forever); measured end-state.
  // Raised 1377 → 1401: #1143 wires the Spotlight launcher into the composition root — the four new
  // CommandWiringDeps seams in the createCommandWiring() call (modelIndex / canUseGit / gitLog /
  // revealLocation) plus the `revealLocation` open-file-and-reveal nav helper (a sibling of
  // navigateToDefinition that opens an unopened file first), ~24 LOC of composition-root wiring for the
  // launcher's go-to actions. Measured end-state.
  // Raised 1401 → 1408: concept-7 "Flush" builds the Output file-rail scaffold inside #view-preview and
  // mounts the CodeMirror OutputView into its `.out-code` slot (ensureOutputScaffold + the import), plus a
  // one-line initInstantTooltip() boot call, ~7 LOC of composition-root wiring. Measured end-state.
  // Raised 1408 → 1411: #1188 (ADR 0009) wires the Files-tree scope emphasis into the composition root —
  // the one `scopeFiles` dep forwarding the controller's scope fan-out to `explorer.setActiveContext`,
  // ~3 LOC. Measured end-state.
  // Raised 1411 → 1457: #1165 wires the Spotlight launcher's degraded quick actions into the composition
  // root — the shared open-file-then-act helper `activateFileThen` (go-to / find-usages / rename reuse it),
  // `revertCommitFromLauncher`, the reveal-in-file-manager thunk, and the five CommandWiringDeps seam
  // registrations (findReferences / renameSymbol / gitRevert / canRevealInFileManager / revealPath). A
  // code-review DRY pass collapsed three near-identical activate helpers into one. Measured post-merge + 2.
  { file: 'src/shell/ide.tsx', maxLines: 1459 },
  // Frozen 2026-07-02 at 2286 LOC (grown from the audit's 2266 @ fc83bcf5), ceil(2286 × 1.02) = 2332.
  // #985 ratchets this down as it decomposes inspectorController.tsx. Freezing prevents further
  // regrowth; it does not mandate the split — #985 owns that.
  // Raised 2332 → 2355: #890 wires the new Syntax Tree right-rail view (RightView) into the controller —
  // a self-fetching panel mirroring the sibling Source Control view that already lives here (the
  // #rview-syntax-tree host lookup + renderSyntaxTree/loadSyntaxTree pair + the rightViews/label map
  // entries + the selectRightView branch + the debounced doc-changed reload), ~23 LOC of legitimate
  // composition-root wiring. Raised 2355 → 2393: #890's bidirectional source↔tree navigation adds the
  // renderSyntaxTree onNodeClick/caret props + the debounced cursor-slice subscription (caret → panel
  // highlight) with its dispose cleanup, ~38 LOC of the same wiring. Measured end-state (2393), no
  // headroom — the next feature here should ratchet again rather than inherit slack; #985 owns the split.
  // Raised 2393 → 2402: merging main into #890 brought in #983/#1086's view-chrome consolidation, which
  // re-homes railAxis + diagCollapsed onto the uiChrome slice — the setAxis/applyDiagCollapsed paths here
  // become thin slice writers + seed-then-subscribe wiring (guarded readRaw/writeRaw helpers), net +9 LOC
  // of legitimate composition-root glue. Measured end-state (2402), no headroom; #985 owns the split.
  // Raised 2402 → 2444: concept-7 "Flush" turns the Generated preview from one concatenated blob into a
  // per-file rail — loadPreview keeps res.files as a list and drives a single-file viewer via the new
  // showOutputFile/clearOutput/targetLabel helpers + the outputRail import (the rail/crumb DOM rendering
  // itself lives in the extracted src/shell/outputRail.ts, not here), ~42 LOC. Measured end-state; #985
  // owns the split.
  // Raised 2444 → 2482: #146 makes the status-bar Context segment a clickable scope picker — the
  // canonical scope control after #1180 removed the top-bar breadcrumb <select>. The controller gains a
  // createFloatingMenu instance + the scopeMenuItems/toggleScopeMenu pair + the #sb-context click wiring
  // and its dispose cleanup, ~38 LOC of composition-root glue reusing the existing applyScope/
  // setActiveContext/`contexts` machinery. Measured end-state (2482), no headroom; #985 owns the split.
  // Raised 2482 → 2491: ADR 0009 makes the Output rail obey the active scope by EMPHASIS — a paintOutputRail
  // helper reads the scope and the `activeContext` fan-out repaints the rail's emphasis without a re-emit
  // (#1188). ~9 LOC of glue over the extracted outputRail renderer. Measured end-state (2491); #985 owns the split.
  // Raised 2491 → 2503: #1188 (ADR 0009) also extends the same scope fan-out to the SOURCE side — the new
  // `scopeFiles` dep (interface + JSDoc) and its call inside rerenderScopedSurfaces that points the Files
  // tree at the active context, ~10 LOC of glue reusing the existing activeContext/`isAllContexts`
  // machinery (measured after merging the Output-rail slice in). Measured end-state (2503); #985 owns the split.
  // Raised 2503 → 2547: #1165 threads two launcher focus targets into the right-rail. Source Control gets
  // the sourceControlFocus/nonce pair + two <SourceControlPanel> focus props + the selectRight focus arg;
  // the glossary gets a cached-model + renderGlossaryPanel helper + the selectDocsTab term arg (incl. the
  // code-review one-shot-clear so a remount can't re-scroll to a stale term) — both reuse the existing
  // load/render machinery. Measured post-merge end-state + 2; #985 owns the split.
  { file: 'src/shell/inspectorController.tsx', maxLines: 2551 },
  // Frozen 2026-07-02 at 2205 LOC, ceil(2205 × 1.02) = 2250. #987 ratchets this down as it decomposes
  // prefs.ts. Freezing prevents further regrowth; it does not mandate the split — #987 owns that.
  { file: 'src/settings/prefs.ts', maxLines: 2250 },
  // Frozen 2026-07-02 at 1745 LOC, ceil(1745 × 1.02) = 1780. #986 ratchets this down as it decomposes
  // editor.ts. Freezing prevents further regrowth; it does not mandate the split — #986 owns that.
  { file: 'src/editor/editor.ts', maxLines: 1780 },
  // Frozen 2026-07-02 at 1354 LOC, ceil(1354 × 1.02) = 1382. #990 ratchets this down as it decomposes
  // aiPanel.ts. Freezing prevents further regrowth; it does not mandate the split — #990 owns that.
  // Raised 1382 → 1424: #984 Task 4 rewires the change-set sub-panel onto the chat slice's state
  // machine — the closure state (accepted Set / applied / invalidated / inFlight booleans) becomes a
  // state-driven repaint + one panel-level store subscription, with per-dispatch stale-set guards
  // replacing the old flags. Behavior-preserving but structurally larger (~+50 LOC of consumer wiring,
  // not feature growth). Measured end-state, no headroom — #990's decomposition (ChangeSetPanel et al.)
  // ratchets this back down.
  // Lowered 1424 → 1309: #990 Task 1 extracts the pure prompt builders (formatDomainIndex/buildSystem/
  // buildExplainPrompt/buildRepairPrompt + WORKSPACE_EDIT_GUIDE + the DomainIndex/AssistantContext
  // types) to aiPrompts.ts, leaving re-exports. Measured end-state, no headroom — the remaining #990
  // tasks keep ratcheting down.
  // Lowered 1309 → 865: #990 Task 6 retires the imperative DOM panel — rendering moved to the
  // declarative AssistantChat composition (Transcript/ChangeSetPanel/Composer over the chat slice),
  // leaving only the host factory (the send effect, grammar-constraint/repair loop, apply-gate, and
  // change-set apply flow). Measured end-state, no headroom.
  // Raised 865 → 905: #472 Task 2 keys the workspace snapshot by opaque session key — the documented
  // WorkspaceFilesSnapshot shape ({files, displayPath}), the liveTextFor display-map resolution behind
  // the drift check, and the relPath-keyed before-map derivation at stageChangeSet, ~40 LOC of
  // multi-root wiring (not regrowth of the retired DOM panel). Measured end-state, no headroom.
  // Raised 905 → 919: #472 Task 3 addresses the change-set apply by opaque key — the shared
  // snapshotKeyFor reverse-lookup (relPath → snapshot key, also backing liveTextFor) and the payload
  // mint that resolves a revision's buffer uri / mints a brand-new file's `new:<relPath>` key, ~14 LOC
  // of multi-root wiring. Measured end-state, no headroom.
  // Lowered 919 → 910: #472 Task 4 rounds the key through the review rows — the apply payload uses
  // each row's own key, so the snapshotKeyFor/liveTextFor reverse lookups are deleted and drift
  // resolves per key against one fresh snapshot. Measured end-state, no headroom.
  // Raised 910 → 926: code-review fixes on the #984/#990/#472 arc — applyChangeSet derives the
  // accepted list from the store (not the panel's render-time argument), the drift partition becomes
  // a single pass with a once-per-apply display-path Set, and send()'s finally flushes a synchronous
  // rerender() before focusComposer() so focus lands on an ENABLED textarea; correctness wiring plus
  // its comments, not feature growth. Measured end-state, no headroom.
  // Raised 926 → 939: review-label fix on the same arc — the staging branch now carries the TOOL
  // layer's display labels onto the staged rows (buildDisplayIndex over the turn's session → the
  // stageChangeSet display map), so colliding-twin review rows can never swap relative to the paths
  // the model addressed (#472); ~13 LOC of wiring plus its comments, and ChangeSetPanel.tsx DELETED
  // its row-order label re-derivation in exchange. Measured end-state, no headroom.
  // Raised 939 → 953: review perf fix on the same arc — streamed deltas now coalesce into ONE
  // appendStreamingText per animation frame (the batcher itself lives in textCoalescer.ts; this is
  // only its wiring: the per-send coalescer + the synchronous flushNow() at each semantic boundary —
  // tool-call start, commit, abort — with their ordering comments), and the `files(n)` pluralizer
  // moved to its single home in ChangeSetPanel.tsx. Measured end-state, no headroom.
  { file: 'src/ai/aiPanel.ts', maxLines: 953 },
  // Frozen 2026-07-02 at 1301 LOC (grown from the audit's 1284 @ fc83bcf5), ceil(1301 × 1.02) = 1328.
  // #989 ratchets this down as it decomposes explorer.ts. Freezing prevents further regrowth; it does
  // not mandate the split — #989 owns that.
  // Raised 1328 → 1387: #1188 (ADR 0009) makes the Files tree obey the active-context scope by emphasis —
  // the `setActiveContext` public API + its Explorer-interface JSDoc, the render-pass `activeContext`
  // field, the `scopeMatch` analysis flag (so a scope naming no `.koi` is a no-op), the buildItem
  // emphasis branch, the boot-flash guard in setActiveContext, and the `koiStem` stem→context helper,
  // ~59 LOC (comment-heavy, matching the file's house style). Measured end-state, no headroom; #989 owns
  // the split.
  { file: 'src/shell/explorer.ts', maxLines: 1387 },
  // #982 decomposed workspaceController.ts into a thin facade + three sibling modules
  // (workspaceBuffers / workspaceMutations / workspaceSave). The facade measured 775 LOC post-split.
  // Raised 791 → 849: #1005 re-homes its Home resume/recents capture onto the facade after the #982 merge
  // — the rememberLastSession snapshot helper (reading the store slice), the folder-open branch/language
  // capture, and the save/dirty facade wraps — 832 LOC, ceil(832 × 1.02) = 849. The three modules stay
  // frozen at their post-split sizes so no single one regrows toward a god-file.
  { file: 'src/shell/workspaceController.ts', maxLines: 849 },
  // Raised 158 → 165: #1081 guards applyFileEdit's post-write lsp.didSave() against a write that went
  // stale before the freshness check (the same stillFresh gate its markSaved call already used) —
  // 161 LOC, ceil(161 × 1.02) = 165.
  // Raised 165 → 173: #472 Task 3 re-keys applyFileEdit by the opaque session key — the O(1)
  // buffers.get resolution, the `new:<relPath>` create-under-primary-root branch, and the
  // unknown-key → null guard — 169 LOC, ceil(169 × 1.02) = 173.
  { file: 'src/shell/workspaceBuffers.ts', maxLines: 173 },
  { file: 'src/shell/workspaceMutations.ts', maxLines: 179 },
  // Raised 178 → 195: #1009 guards saveActive/saveAllDirty's post-write lsp.didSave() against a
  // buffer switch during the write/format await AND a mid-write keystroke re-dirtying the saved
  // buffer (savedUris tracking gated on the same freshness check as markSaved, plus an active-uri
  // check) — 191 LOC, ceil(191 × 1.02) = 195.
  // Raised 195 → 209: #1055 closes the sibling gap (the active buffer's own write failing, with no
  // switch, must also skip didSave) and extracts the shared shouldNotifyDidSave eligibility guard used
  // by both saveActive and saveAllDirty — 204 LOC, ceil(204 × 1.02) = 209.
  { file: 'src/shell/workspaceSave.ts', maxLines: 209 },
  // Frozen 2026-07-02 at 1017 LOC, ceil(1017 × 1.02) = 1038. #988 ratchets this down as it decomposes
  // persistence.ts. Freezing prevents further regrowth; it does not mandate the split — #988 owns that.
  // Raised 1038 → 1099: #1005's Home resume card needs a persisted last-session snapshot — a new
  // LastSession interface plus its guarded getLastSession/setLastSession accessors (~60 LOC of genuine
  // new API, not regrowth). Ratchet to the real end-state (1077) plus the standard +2% headroom.
  { file: 'src/settings/persistence.ts', maxLines: 1099 },
  // Raised 908 → 1012: #1005 Home redesign — imperative-DOM growth; will tighten to real end-state LOC.
  // The full-bleed shell (top bar + brand + split grid), the multi-target emit caption and the
  // relocated colophon all add real imperative construction to welcome.ts; ceil(992 × 1.02) = 1012.
  // Raised 1012 → 1105: #1005 resume card — the rich last-session card (play tile + ping dot + project ·
  // file + relative time + unsaved count) plus the timeAgo/prefersReducedMotion helpers; ceil(1083 × 1.02) = 1105.
  // Raised 1105 → 1197: #1005 dense recents — the compact recent rows (teal monogram + name/language tag +
  // git branch + relative time) with a header count pill, an always-available filter and a View all/Show
  // less collapse, split into a buildRecentRow helper; ceil(1173 × 1.02) = 1197.
  // Raised 1197 → 1342: #1005 clone row — the "Clone repository" Start row + its inline URL form (monospace
  // input, validated Clone button, busy/error states, stopPropagation guard) plus the onClone callback and
  // canClone plumbing; ceil(1315 × 1.02) = 1342.
  // Raised 1342 → 1442: #1005 keycaps — per-action shortcut keycaps (the KEYCAP_* glyphs + appendKeycap
  // helper) plus the document-level Home keydown handler (mod+N/E, ⇧mod+O/C, focused-field guard) and its
  // destroy() teardown; ceil(1413 × 1.02) = 1442.
  // Raised 1442 → 1513: #1005 hi-fi visual-fidelity pass — single-line recent rows (side group) + shortLang
  // codes, header-mounted filter (magnifier wrap), resume chevron, boxed per-key keycaps (keys/key), sun/moon
  // theme icon and text-only colophon; net imperative-DOM growth to 1483 LOC, ceil(1483 × 1.02) = 1513.
  // Raised 1513 → 1522: #1017 cloned-empty recovery — the notifyClonedEmpty seam (mirrors dead-recent
  // recover()) plus its HomeHandle/WelcomeCallbacks doc comments; measured end-state, no headroom needed
  // (the next feature here should ratchet again rather than inherit slack).
  { file: 'src/welcome/welcome.ts', maxLines: 1522 },
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
