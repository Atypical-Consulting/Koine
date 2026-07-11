import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { GitFile, GitLogEntry, GitNumstatEntry, GitStatus, Platform } from '@/host/types';
import { koiConfirm, createFloatingMenu, type FloatingMenu, type FloatingMenuItem } from '@atypical/koine-ui';

// The Source Control panel (issue #272): the right-rail git surface — a branch header + switcher, the
// changed files grouped into Staged / Changes / Untracked with per-row Stage/Unstage + inline diff, a
// commit box, and the recent-commit log. It mirrors the other model panels (a Preact functional
// component with preact/hooks; the project's `koi-…` class vocabulary, no Tailwind), but unlike them it
// owns its own async fetch: git state lives on disk, not in the joined model index, so the panel pulls it
// straight from the {@link GitSurface} it's handed.
//
// The whole git surface is CAPABILITY-GATED. The browser host reports `canUseGit === false` and its git
// methods reject (see {@link Platform}); the desktop host runs a real `git`, but a non-repo folder makes
// `gitStatus` REJECT. The panel handles both: `canUseGit === false` paints a "desktop only" empty state
// and makes NO git calls, and a rejected status paints a "not a git repository" empty state — neither
// crashes. After every mutation (stage / unstage / discard / commit / checkout) it RE-FETCHES status
// (and the log after a commit) so the groups and recent-commit list track the repository.

/**
 * The slice of {@link Platform} the panel calls — narrowed to the git surface so a test can hand it a
 * small fake object (no full Platform needed). The right-rail controller passes the real `platform`,
 * which structurally satisfies this.
 */
export type GitSurface = Pick<
  Platform,
  | 'canUseGit'
  | 'gitStatus'
  | 'gitDiff'
  | 'gitNumstat'
  | 'gitStage'
  | 'gitUnstage'
  | 'gitDiscard'
  | 'gitCommit'
  | 'gitPush'
  | 'gitPull'
  | 'gitFetch'
  | 'gitBranches'
  | 'gitCheckout'
  | 'gitLog'
  | 'gitInit'
>;

/** A single-letter glyph per change kind (the gutter letter git itself uses), shown on each file row. */
const STATUS_GLYPH: Record<GitFile['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U',
  conflicted: '!',
};

/** The spelled-out change kind, rendered screen-reader-only beside the glyph so AT users hear it. */
const STATUS_LABEL: Record<GitFile['status'], string> = {
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  untracked: 'untracked',
  conflicted: 'conflicted',
};

/** The Recent-commits section's label — also its collapse key in the shared `collapsedGroups` set and
 *  its `aria-label` landmark, so it lives in one place to keep the three uses in lockstep. */
const RECENT_COMMITS_LABEL = 'Recent commits';

/** The changed-file group labels. Each is a section `aria-label` landmark AND its collapse key in
 *  `collapsedGroups` AND the key the ⋮ "Collapse all groups" action toggles — so the render, the per-group
 *  chevron, and the menu action stay in lockstep off one constant apiece (mirrors {@link RECENT_COMMITS_LABEL}). */
const STAGED_CHANGES_LABEL = 'Staged Changes';
const CHANGES_LABEL = 'Changes';
const UNTRACKED_LABEL = 'Untracked';

/** The `YYYY-MM-DD` calendar day of an ISO-8601 commit date (timezone-stable, locale-free), else the raw
 *  value — the same deterministic formatting the inspector's change-history rows use. */
function formatDate(date: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(date);
  return m ? m[1] : date;
}

/** 1–2 uppercase initials for a commit author's avatar. A multi-word name takes the first letter of its
 *  first + last words ("Philippe Matray" → "PM"); a single word takes its first two letters ("Ada" →
 *  "AD"); a blank/whitespace name falls back to "?". Purely decorative — the avatar is `aria-hidden`, so
 *  these letters never pollute the reading order (the author's full name stays in the row's meta text). */
function initials(author: string): string {
  const parts = author.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Which file's inline diff is open, keyed by (relPath, area) so the staged and unstaged rows of one path
 *  toggle independently — the same (file, area) identity git's diff is taken against. */
interface OpenDiff {
  relPath: string;
  staged: boolean;
}

/**
 * A focus request from the Spotlight launcher (issue #1165): reveal a SPECIFIC target inside the panel
 * rather than just opening it. `file` is a workspace-relative path (opens that file's inline diff);
 * `commit` is a full sha (highlights + scrolls to that commit in the recent log). Exactly one is set.
 */
export type SourceControlFocus = { file: string } | { commit: string };

export function SourceControlPanel(props: {
  git: GitSurface;
  folderToken: string;
  /** Bumped by the controller to force a re-fetch (e.g. on a workspace folder switch); optional. */
  refreshNonce?: number;
  /**
   * A launcher focus target (issue #1165) — a file's diff to open, or a commit to highlight. Applied
   * once per {@link focusNonce} bump (so re-fetches / dirty-count repaints don't re-trigger it). Optional.
   */
  focus?: SourceControlFocus;
  /** Bumped by the controller each time a NEW {@link focus} is requested, so the panel re-applies it. */
  focusNonce?: number;
  /**
   * How many open editor buffers have unsaved changes (#470). When > 0, **Commit** first prompts a
   * Save-all (via {@link onSaveAll}) so the commit reflects what the editor shows rather than the
   * stale on-disk state. Optional — omitted (or 0) keeps the original "commit what's on disk" behavior,
   * so the existing component test and any non-shell mount are unaffected.
   */
  dirtyCount?: number;
  /**
   * Persist every dirty editor buffer (#109's Save-all). Awaited before {@link git}'s `gitCommit` when
   * {@link dirtyCount} > 0; a rejection aborts the commit (the unsaved tree is never half-committed).
   * Optional — paired with {@link dirtyCount}.
   */
  onSaveAll?: () => Promise<void>;
}) {
  const { git, folderToken } = props;

  const [status, setStatus] = useState<GitStatus | null>(null);
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  // A commit-in-flight latch (#470). The save-all-before-commit path awaits onSaveAll(), whose save
  // fires the controller's live refresh — a nonce bump that re-runs the fetch effect and can momentarily
  // clear `busy` WHILE the commit is still in flight. This latch keeps the Commit button disabled across
  // the whole commit so that transient `busy=false` window can't admit a second (duplicate) commit.
  const [committing, setCommitting] = useState(false);
  // `null` while loading or healthy; `'not-a-repo'` once gitStatus rejects (non-git folder / git failure).
  const [error, setError] = useState<'not-a-repo' | null>(null);
  // A surfaced failure from a mutation (stage/unstage/commit/checkout) — shown as an alert, then cleared
  // on the next action; distinct from `error`, which swaps the whole panel for the empty state.
  const [actionError, setActionError] = useState<string | null>(null);
  const [openDiff, setOpenDiff] = useState<OpenDiff | null>(null);
  const [diffText, setDiffText] = useState('');
  // Eager per-(file, area) line counts (#1152), keyed `${staged}:${relPath}` — computed once per refresh by
  // gitNumstat so each row shows its churn WITHOUT opening its diff. Empty when numstat is unavailable (a
  // failed fetch), where every row falls back to the neutral `·`.
  const [numstat, setNumstat] = useState<Map<string, GitNumstatEntry>>(() => new Map());
  // An internal tick: every refresh (the button, a post-mutation reload, the folder-switch nonce) bumps
  // it, and the fetch effect lists it as a dependency — so all refreshes funnel through the one effect,
  // each guarded against an unmount-stale resolve.
  const [reloadTick, setReloadTick] = useState(0);
  const reload = () => setReloadTick((t) => t + 1);
  // Purely presentational: the Refresh glyph flips this on each click so a toggled class spins it 360°
  // (a CSS transition). It carries no git state — the actual refresh is `reload()`.
  const [spin, setSpin] = useState(false);
  // Whether the Recent-commits log shows its full history rather than the capped 10 newest (#1153). Flipped
  // by the "View all" button and the ⋮ menu's "View all commits" item; resets to capped on remount.
  const [showAllCommits, setShowAllCommits] = useState(false);
  // The launcher-focused commit sha (issue #1165), highlighted + scrolled to; null when nothing is focused.
  const [focusedCommit, setFocusedCommit] = useState<string | null>(null);
  // The panel root, so a focus request can scroll its target (file row / commit row) into view.
  const hostRef = useRef<HTMLDivElement>(null);
  // The last focusNonce actually applied — so a focus fires ONCE per request, not on every re-fetch /
  // dirty-count repaint (which re-run the apply effect with the same, already-handled nonce).
  const appliedFocusNonce = useRef(0);
  // Which file groups are collapsed, keyed by label. Purely presentational + local — groups default to
  // expanded (empty set); the toggle just hides that group's file list via a CSS `collapsed` class.
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const toggleGroup = (label: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });

  // The header ⋮ / split-commit caret menus (#1153) reuse the design-synced createFloatingMenu engine
  // (role="menu"/menuitem, roving Arrow/Home/End focus, Escape via the overlay Esc-stack, aria-expanded on
  // the trigger) — the same primitive the toolbar/explorer/domain-navigator menus consume. It is imperative
  // DOM, so these refs bridge it into the Preact panel: each instance is created once, then torn down on
  // unmount so a closed panel never leaves an orphaned menu on document.body. Items are built lazily at open
  // time (inside the click handler) so they always read the panel's current state.
  const overflowMenuRef = useRef<FloatingMenu | null>(null);
  overflowMenuRef.current ??= createFloatingMenu({
    menuClass: 'koi-sc-menu',
    itemClass: 'koi-sc-menu-item',
    ariaLabel: 'Source control actions',
  });
  const caretMenuRef = useRef<FloatingMenu | null>(null);
  caretMenuRef.current ??= createFloatingMenu({
    menuClass: 'koi-sc-menu',
    itemClass: 'koi-sc-menu-item',
    ariaLabel: 'Commit options',
  });
  useEffect(
    () => () => {
      overflowMenuRef.current?.close(false);
      caretMenuRef.current?.close(false);
    },
    [],
  );

  // The single fetch path: pull status (+ log + branches) for the workspace folder whenever the host,
  // folder, an explicit refresh, or the nonce changes. Browser hosts (no git) never fetch. A rejected
  // status (non-repo folder) drops into the not-a-repo empty state rather than throwing.
  useEffect(() => {
    if (!git.canUseGit) return;
    let alive = true;
    setBusy(true);
    void Promise.resolve()
      .then(() => git.gitStatus(folderToken))
      .then(async (st) => {
        if (!alive) return;
        // The log + branch list + numstat are best-effort companions to the status; a failure in any
        // one leaves that section empty (numstat → every row shows `·`) rather than collapsing the panel.
        const [lg, br, ns] = await Promise.all([
          git.gitLog(folderToken).catch(() => [] as GitLogEntry[]),
          git.gitBranches(folderToken).catch(() => [] as string[]),
          git.gitNumstat(folderToken).catch(() => [] as GitNumstatEntry[]),
        ]);
        if (!alive) return;
        // Clear `busy` in the SAME state flush as the data, so the rows never paint a frame disabled
        // between "status arrived" and "no longer busy" — a click on a row action would otherwise no-op.
        setStatus(st);
        setLog(lg);
        setBranches(br);
        setNumstat(new Map(ns.map((e) => [`${e.staged}:${e.relPath}`, e])));
        setError(null);
        setBusy(false);
      })
      .catch(() => {
        if (!alive) return;
        setStatus(null);
        setError('not-a-repo');
        setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [git, folderToken, props.refreshNonce, reloadTick]);

  // Run a mutation, then re-fetch through the effect so the groups + log reflect the new repository state.
  // Buttons stay disabled (busy) from the start of the op until the follow-up fetch settles.
  async function mutate(op: () => Promise<void>): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await op();
      reload();
    } catch (e) {
      setBusy(false);
      setActionError(String(e));
    }
  }

  const onStage = (relPath: string) => void mutate(() => git.gitStage(folderToken, [relPath]));
  const onUnstage = (relPath: string) => void mutate(() => git.gitUnstage(folderToken, [relPath]));

  // Discard is DESTRUCTIVE — `git restore`/`git clean` throw the working-tree bytes away for good — so
  // both Discard controls (per-row and group Discard-all, #1151) route through an explicit confirm;
  // declining aborts with no git call. Discard is offered only for NON-STAGED rows/groups (the staged
  // group header withholds Discard-all, and the per-row control mirrors that). The copy adapts to what
  // actually happens: a tracked change is REVERTED, but an untracked file has no index/HEAD state to
  // revert to — discarding it DELETES it from disk, and the dialog must say so. The panel already knows
  // each row's tracked/untracked split (`f.status`), so it hands the host the two buckets EXPLICITLY —
  // tracked paths go to `git restore --worktree`, untracked ones to `git clean -f`, with no host-side
  // re-derivation that could mis-bucket a path (see {@link Platform.gitDiscard}). A confirmed discard
  // runs through the same mutate() reload as every other mutation, so the groups re-derive from the
  // post-discard repository and a git failure lands in the existing actionError alert.
  //
  // The tracked/untracked split is derived from `files` itself (`hasTracked`/`hasUntracked`) rather than
  // taken as a caller-supplied flag (code review, #1401): the per-row and per-group call sites are always
  // homogeneous (one file, or a whole group that's either all-tracked or all-untracked), so deriving it
  // reproduces their exact prior copy — but the ⋮ "Discard all changes" aggregate spans BOTH unstaged and
  // untracked files at once, and a caller-supplied `untracked: false` there used to always paint the
  // tracked-only "reverts… can't be undone" copy even when the batch also permanently deletes untracked
  // files. Deriving the split means every call site — including a future mixed one — gets accurate copy
  // for free.
  const onDiscard = (files: GitFile[], opts: { group?: string } = {}) => {
    if (files.length === 0) return; // defensive — an empty group renders no Discard-all at all
    const trackedPaths = files.filter((f) => f.status !== 'untracked').map((f) => f.relPath);
    const untrackedPaths = files.filter((f) => f.status === 'untracked').map((f) => f.relPath);
    const paths = files.map((f) => f.relPath);
    const single = paths.length === 1;
    const hasTracked = trackedPaths.length > 0;
    const hasUntracked = untrackedPaths.length > 0;
    const copy =
      hasTracked && hasUntracked
        ? {
            // A mixed batch (⋮ "Discard all changes" over unstaged + untracked at once): neither binary
            // copy is accurate alone, so this variant names both consequences explicitly.
            title: 'Discard all changes?',
            message:
              `Discard ${paths.length} changes in ${opts.group}? This reverts ${trackedPaths.length} tracked ` +
              `file${trackedPaths.length === 1 ? '' : 's'} (can't be undone) and permanently deletes ` +
              `${untrackedPaths.length} untracked file${untrackedPaths.length === 1 ? '' : 's'}.`,
            confirmLabel: 'Discard all',
          }
        : hasUntracked
          ? {
              title: single ? 'Delete untracked file?' : 'Delete untracked files?',
              message: single
                ? `Delete ${paths[0]}? This untracked file will be permanently removed.`
                : `Delete all ${paths.length} untracked files in ${opts.group}? Each file will be permanently removed.`,
              confirmLabel: single ? 'Delete file' : 'Delete all',
            }
          : {
              title: 'Discard changes?',
              message: single
                ? `Discard changes to ${paths[0]}? This reverts your edits and can't be undone.`
                : `Discard all ${paths.length} changes in ${opts.group}? This reverts every listed file and can't be undone.`,
              confirmLabel: single ? 'Discard changes' : 'Discard all',
            };
    void (async () => {
      const ok = await koiConfirm({ ...copy, cancelLabel: 'Cancel', danger: true });
      if (!ok) return; // declined — the working tree survives untouched
      await mutate(() => git.gitDiscard(folderToken, trackedPaths, untrackedPaths));
    })();
  };
  // Push through the same mutate() path every other op uses: the follow-up reload re-reads status, so
  // the ahead count tracks the pushed repository, and a git refusal (non-fast-forward, auth, offline)
  // lands in the existing actionError alert.
  const onPush = () => void mutate(() => git.gitPush(folderToken));

  // Publish branch (#1401): the sync bar's live replacement for the old "No upstream" dead end — a push
  // that also sets the tracking ref (`git push -u origin <branch>`), so it succeeds even though there's
  // no upstream yet. Same mutate() path as every other mutation, so a refusal (auth, offline) lands in
  // the existing actionError alert rather than a silent no-op.
  const onPublish = () => void mutate(() => git.gitPush(folderToken, { setUpstream: true }));

  // Pull (#1401): a fast-forward-only merge of the upstream into the checked-out branch. Same mutate()
  // path as Push — a local/remote divergence (git refuses a non-ff merge) surfaces through the existing
  // actionError alert rather than silently rewriting history.
  const onPull = () => void mutate(() => git.gitPull(folderToken));

  // Fetch (#1401): refreshes the remote-tracking refs without touching the checked-out branch — useful
  // even with no upstream (it just needs a remote), so unlike Pull/Push it is never upstream-gated.
  const onFetch = () => void mutate(() => git.gitFetch(folderToken));

  // Save-all-before-commit guard (#470), shared by every commit-shaped action (Commit / Amend / Commit &
  // Push — factored out during #1401 code review: Amend and Commit & Push originally called gitCommit
  // directly and skipped this guard, so an unsaved editor buffer would be silently excluded from an
  // amend or a commit-that-then-gets-pushed). Git commits what's on disk, so with unsaved work this
  // prompts a Save-all first (via {@link onSaveAll}) so the commit reflects what the editor shows.
  // Returns `false` (abort — the caller must not proceed to gitCommit) when the user declines the
  // prompt; a failed save propagates so the caller's `mutate()` surfaces it. No unsaved work (or the
  // props omitted) resolves `true` immediately — the original "commit what's on disk" behavior.
  async function ensureSaved(): Promise<boolean> {
    const unsaved = props.dirtyCount ?? 0;
    if (unsaved > 0 && props.onSaveAll) {
      const ok = await koiConfirm({
        title: 'Save changes before committing?',
        message: `You have ${unsaved} unsaved file${unsaved === 1 ? '' : 's'}. Git commits what's saved to disk — save all first so this commit includes your latest edits.`,
        confirmLabel: 'Save all & commit',
        cancelLabel: 'Cancel',
      });
      if (!ok) return false; // declined — abort without touching a stale tree
      await props.onSaveAll();
    }
    return true;
  }

  // Amend last commit (#1401): rewrites the tip commit with whatever's currently in the composer
  // textarea. An EMPTY message reuses the previous commit's message unchanged (gitCommit's `opts.amend`
  // contract, `--no-edit`), so leaving the box blank amends without touching the message. Requires an
  // existing commit to rewrite — gated on the log being non-empty, not on staged/dirty state. Routes
  // through the shared ensureSaved() guard first (code review) so an unsaved buffer never gets silently
  // excluded from the rewritten commit.
  const onAmend = () => {
    void mutate(async () => {
      if (!(await ensureSaved())) return;
      await git.gitCommit(folderToken, message.trim(), { amend: true });
      setMessage('');
    });
  };

  // Commit & Push (#1401): one compound mutate() — commit the staged changes, then push. Routes through
  // the shared ensureSaved() guard first (code review) so an unsaved buffer never gets silently excluded
  // from a commit that's about to be pushed. A rejected commit (nothing staged / git failure) throws
  // before the push ever runs, so the push is skipped entirely and the failure surfaces through the same
  // actionError alert every other mutation uses. A successful commit conditionally publishes: with no
  // upstream tracked yet a bare push would itself be rejected, so `{ setUpstream: true }` is passed ONLY
  // in that case — an already-tracked branch keeps the plain push every other Push control uses.
  const onCommitAndPush = () => {
    void mutate(async () => {
      if (!(await ensureSaved())) return;
      const msg = message.trim();
      await git.gitCommit(folderToken, msg);
      setMessage('');
      if (upstream) {
        await git.gitPush(folderToken);
      } else {
        await git.gitPush(folderToken, { setUpstream: true });
      }
    });
  };

  const onCheckout = (branch: string) => {
    if (!status || branch === status.branch) return;
    void mutate(() => git.gitCheckout(folderToken, branch));
  };

  function onCommit(): void {
    const msg = message.trim();
    if (!msg) return;
    setCommitting(true);
    void mutate(async () => {
      try {
        // Git commits what's on disk, so unsaved editor buffers would be silently excluded — routes
        // through the shared ensureSaved() guard (#470; factored out during #1401 code review so
        // Amend/Commit & Push get the exact same guard). Declining aborts the commit (the draft
        // survives); a failed save propagates and `mutate` surfaces it — so we never commit a
        // half-saved tree. No unsaved work (or props omitted) → straight to gitCommit.
        if (!(await ensureSaved())) return;
        await git.gitCommit(folderToken, msg);
        setMessage('');
      } finally {
        setCommitting(false);
      }
    });
  }

  // The latest diff toggle's identity. `diffText` is one shared slot, so a slow gitDiff resolve from a
  // previously-clicked row must be discarded — only the fetch that is STILL the open row may commit.
  const diffReq = useRef<OpenDiff | null>(null);

  async function onToggleDiff(f: GitFile): Promise<void> {
    if (openDiff && openDiff.relPath === f.relPath && openDiff.staged === f.staged) {
      diffReq.current = null;
      setOpenDiff(null);
      return;
    }
    const req: OpenDiff = { relPath: f.relPath, staged: f.staged };
    diffReq.current = req;
    setOpenDiff(req);
    setDiffText(''); // never show the previous row's diff while this row's fetch is in flight
    let text = '';
    try {
      text = await git.gitDiff(folderToken, f.relPath, f.staged);
    } catch {
      text = '';
    }
    if (diffReq.current === req) setDiffText(text);
  }

  // Apply a launcher focus request (#1165) once its target is actually present: open the targeted file's
  // inline diff, or highlight + scroll to the targeted commit. Re-runs when the nonce bumps AND when
  // status/log resolve — the target rows don't exist until the async fetch lands, and on a re-open the
  // re-fetch replaces a STALE snapshot, so the nonce is marked applied only once the target is FOUND
  // (not on a not-found pass against stale data); `appliedFocusNonce` then makes each request fire once.
  useEffect(() => {
    const focus = props.focus;
    const nonce = props.focusNonce ?? 0;
    if (!focus || nonce === 0 || nonce === appliedFocusNonce.current) return;

    if ('file' in focus) {
      if (!status) return; // status still loading — a later status update re-runs this effect
      const target = status.files.find((f) => f.relPath === focus.file);
      if (!target) return; // not (yet) a changed file — retry when a fresher status arrives, else no-op
      appliedFocusNonce.current = nonce; // found → apply exactly once
      if (!(openDiff && openDiff.relPath === target.relPath && openDiff.staged === target.staged)) {
        void onToggleDiff(target);
      }
      requestAnimationFrame(() =>
        hostRef.current?.querySelector(`[data-relpath="${target.relPath}"]`)?.scrollIntoView({ block: 'nearest' }),
      );
    } else {
      if (!log.length) return; // log still loading
      if (!log.some((c) => c.sha === focus.commit)) return; // not in the log yet — retry on a fresher log
      appliedFocusNonce.current = nonce; // found → apply exactly once
      setShowAllCommits(true); // lift the capped list so the target is rendered even if it's older
      setFocusedCommit(focus.commit);
      requestAnimationFrame(() =>
        hostRef.current?.querySelector(`[data-sha="${focus.commit}"]`)?.scrollIntoView({ block: 'nearest' }),
      );
    }
    // props.focus is stable per nonce; status/log gate the apply until the target rows exist.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focusNonce, status, log]);

  // The commit highlight is a transient "you landed here" flash (#1165), not a persistent selection: the
  // panel stays mounted across re-opens, so without this the ring would linger and reappear on a later
  // focus-less open. Clear it after a beat (cleared on unmount / re-focus so no timer leaks past teardown).
  useEffect(() => {
    if (!focusedCommit) return;
    const id = setTimeout(() => setFocusedCommit(null), 2600);
    return () => clearTimeout(id);
  }, [focusedCommit]);

  // --- empty states (after the hooks, so the hook order is stable) ----------
  if (!git.canUseGit) {
    return (
      <div class="koi-sc koi-sc-empty">
        <div class="koi-rview-empty">
          <h3 class="koi-rview-empty-title">Source control</h3>
          <p class="muted">Source control is available in the desktop app — Git is unavailable in the browser.</p>
        </div>
      </div>
    );
  }

  if (error === 'not-a-repo') {
    return (
      <div class="koi-sc koi-sc-empty">
        <div class="koi-rview-empty">
          <h3 class="koi-rview-empty-title">Source control</h3>
          <p class="muted">This folder isn’t a git repository yet.</p>
          <button
            type="button"
            class="koi-sc-act"
            disabled={busy}
            onClick={() => void mutate(() => git.gitInit(folderToken))}
          >
            Initialize Repository
          </button>
          {actionError && (
            <p class="koi-sc-error" role="alert">
              {actionError}
            </p>
          )}
        </div>
      </div>
    );
  }

  const files = status?.files ?? [];
  const staged = files.filter((f) => f.staged);
  const unstaged = files.filter((f) => !f.staged && f.status !== 'untracked');
  const untracked = files.filter((f) => !f.staged && f.status === 'untracked');
  const hasStaged = staged.length > 0;
  const branch = status?.branch ?? 'main';
  // The split Commit button (and the ⌘⏎ shortcut) are live only with a staged file, a non-empty
  // message, and no commit/refresh in flight — the same latch the original single button used.
  const commitDisabled = busy || committing || message.trim().length === 0 || !hasStaged;
  // Surface the current branch even when it isn't in the local list (detached HEAD / fresh branch).
  const branchOptions = status && !branches.includes(status.branch) ? [status.branch, ...branches] : branches;
  // The branch's upstream-tracking data (#1150): the tracked ref + real ahead/behind counts, or null
  // when the branch has no upstream (detached HEAD / fresh branch / no remote) — the panel keys the
  // whole sync readout + push affordance off this DATA, never off the platform kind.
  const upstream = status?.upstream ?? null;
  // The recent-commit log is collapsible through the same `collapsedGroups`/`toggleGroup` infra the file
  // groups use — its section carries `collapsed` when its label is in the set (the CSS hides the list).
  const logCollapsed = collapsedGroups.has(RECENT_COMMITS_LABEL);
  // The recent log shows the 10 newest by default; "View all" lifts that cap to the whole fetched `log`.
  // The cap only bites past 10 commits, so with ≤ 10 there's nothing more to reveal (the toggle disables).
  const RECENT_COMMITS_CAP = 10;
  const hasMoreCommits = log.length > RECENT_COMMITS_CAP;
  const shownLog = showAllCommits ? log : log.slice(0, RECENT_COMMITS_CAP);

  // Reveal the full commit history in place (#1153): un-collapse the Recent-commits section if it's collapsed
  // AND lift the 10-row display cap, so the whole already-fetched `log` shows — no new git op. Shared by the
  // ⋮ menu's "View all commits" item and (as the "expand" direction) the "View all" button.
  const revealAllCommits = () => {
    setCollapsedGroups((prev) => {
      if (!prev.has(RECENT_COMMITS_LABEL)) return prev;
      const next = new Set(prev);
      next.delete(RECENT_COMMITS_LABEL);
      return next;
    });
    setShowAllCommits(true);
  };

  // Build + toggle the ⋮ overflow menu (#1153). Every item is now backed by a real git op (#1401
  // finishes the wiring the menu shipped with): Refresh, Stage/Unstage all over the grouped paths,
  // collapse/expand, reveal-all-commits, Discard all changes / Push (wired to the same onDiscard/onPush
  // the per-row and group controls already use), and Pull/Fetch (onPull/onFetch, the new #1401 ops).
  const openOverflowMenu = (e: MouseEvent) => {
    const trigger = e.currentTarget as HTMLElement;
    // Every unstaged (tracked) + untracked file — the same candidate set the per-group Discard-all
    // controls draw from; staged rows are never included (mirrors the fileGroup/fileRow invariant: a
    // staged row's discard would silently revert only the worktree delta, not the staged change itself).
    const discardCandidates = [...unstaged, ...untracked];
    const unstagedPaths = discardCandidates.map((f) => f.relPath);
    const stagedPaths = staged.map((f) => f.relPath);
    // Every present, collapsible section label — the non-empty file groups plus the Recent-commits log.
    const groupLabels = [
      ...(staged.length ? [STAGED_CHANGES_LABEL] : []),
      ...(unstaged.length ? [CHANGES_LABEL] : []),
      ...(untracked.length ? [UNTRACKED_LABEL] : []),
      ...(log.length ? [RECENT_COMMITS_LABEL] : []),
    ];
    const allCollapsed = groupLabels.length > 0 && groupLabels.every((l) => collapsedGroups.has(l));
    // Pull and Push (#1401) share the identical gate — busy, or no upstream to sync against — factored
    // into one named const (matching `commitDisabled` below) instead of the same inline expression twice.
    const syncDisabled = busy || !upstream;
    const items: FloatingMenuItem[] = [
      { id: 'refresh', label: 'Refresh', disabled: busy, run: () => { setSpin((s) => !s); reload(); } },
      {
        id: 'stage-all',
        label: 'Stage all changes',
        disabled: busy || unstagedPaths.length === 0,
        run: () => void mutate(() => git.gitStage(folderToken, unstagedPaths)),
      },
      {
        id: 'unstage-all',
        label: 'Unstage all changes',
        disabled: busy || stagedPaths.length === 0,
        run: () => void mutate(() => git.gitUnstage(folderToken, stagedPaths)),
      },
      {
        id: 'collapse-all',
        label: allCollapsed ? 'Expand all groups' : 'Collapse all groups',
        disabled: groupLabels.length === 0,
        run: () => setCollapsedGroups(allCollapsed ? new Set() : new Set(groupLabels)),
      },
      // Enabled only when the 10-row cap actually hides commits (matches the "View all" button's gate), so
      // the item is never a live-but-inert no-op when everything already shows.
      { id: 'view-all-commits', label: 'View all commits', disabled: !hasMoreCommits, run: revealAllCommits },
      // Discard all changes (#1401): the same confirm-gated onDiscard the per-row/group controls use,
      // over every non-staged candidate — disabled when busy or when there's nothing to discard (matches
      // the "never a live-but-inert no-op" rule the empty-group Discard-all controls already follow).
      {
        id: 'discard-all',
        label: 'Discard all changes',
        disabled: busy || discardCandidates.length === 0,
        run: () => onDiscard(discardCandidates, { group: 'the working tree' }),
      },
      // Pull (#1401): a fast-forward-only merge from the upstream — disabled while busy or when the
      // branch has no upstream to pull from (there's nothing to fast-forward against).
      { id: 'pull', label: 'Pull', disabled: syncDisabled, run: onPull },
      // Push (#1401): the same onPush the branch-bar push button uses — disabled while busy or when the
      // branch has no upstream to push to (mirrors that button's own gate, since there's nothing to push).
      { id: 'push', label: 'Push', disabled: syncDisabled, run: onPush },
      // Fetch (#1401): refreshes the remote-tracking refs only — never upstream-gated (it just needs a
      // remote), so it stays enabled even on a branch that doesn't track one yet.
      { id: 'fetch', label: 'Fetch', disabled: busy, run: onFetch },
    ];
    overflowMenuRef.current!.toggle({ trigger, items, align: 'right' });
  };

  // Build + toggle the split-commit caret menu (#1153). Both items are wired (#1401): Amend rewrites the
  // tip commit (onAmend) — needs an existing commit to rewrite, so it's disabled on an empty log; Commit
  // & Push (onCommitAndPush) runs the plain Commit flow then a push in one op — it commits the composer's
  // message just like the plain Commit button does, so it reuses `commitDisabled` directly (busy /
  // committing / empty-message / no staged files — code review: the ad-hoc `busy || !hasStaged` it
  // originally shipped with omitted the empty-message check the primary Commit button already enforces).
  const openCaretMenu = (e: MouseEvent) => {
    const trigger = e.currentTarget as HTMLElement;
    const items: FloatingMenuItem[] = [
      { id: 'amend', label: 'Amend last commit', disabled: busy || log.length === 0, run: onAmend },
      { id: 'commit-push', label: 'Commit & Push', disabled: commitDisabled, run: onCommitAndPush },
    ];
    caretMenuRef.current!.toggle({ trigger, items, align: 'right' });
  };

  // One file row: a status glyph, a path button that toggles the inline diff, a best-effort +/− stat
  // (swapped for the hover/focus action cluster), then the inline diff below when open. The path button's
  // visible label is split into basename + muted dir, but its accessible name is pinned to
  // `{relPath} {status}` so each row stays uniquely addressable and AT users hear the full path + kind.
  const fileRow = (f: GitFile) => {
    const expanded = openDiff?.relPath === f.relPath && openDiff?.staged === f.staged;
    // Real +/− counts come solely from eager numstat (#1152) — every row shows its churn at rest, no diff
    // opened, and consistently whether or not the diff is expanded. A binary file's counts are null, and an
    // untracked file (absent from `git diff`) or a failed numstat fetch leaves no entry — all three render
    // the neutral `·`, never a misleading `+0`.
    const ns = numstat.get(`${f.staged}:${f.relPath}`);
    const stat = ns && ns.added !== null && ns.removed !== null ? { add: ns.added, del: ns.removed } : null;
    const slash = f.relPath.lastIndexOf('/');
    const name = slash >= 0 ? f.relPath.slice(slash + 1) : f.relPath;
    const dir = slash >= 0 ? f.relPath.slice(0, slash) : '';
    return (
      <li key={`${f.staged ? 's' : 'w'}:${f.relPath}`} class="koi-sc-file" data-relpath={f.relPath}>
        <div class="koi-sc-file-row">
          <span class={`koi-sc-glyph koi-sc-glyph-${f.status}`} aria-hidden="true">
            {STATUS_GLYPH[f.status]}
          </span>
          <button
            type="button"
            class="koi-sc-file-open"
            aria-label={`${f.relPath} ${STATUS_LABEL[f.status]}`}
            aria-expanded={expanded}
            onClick={() => void onToggleDiff(f)}
          >
            <span class="koi-sc-name" aria-hidden="true">
              {name}
            </span>
            {dir && (
              <span class="koi-sc-dir" aria-hidden="true">
                {dir}
              </span>
            )}
          </button>
          {/* Decorative +/− stat (mono); hidden on row hover to reveal the action cluster below. */}
          <span class="koi-sc-stat" aria-hidden="true">
            {stat ? (
              <>
                <span class="add">+{stat.add}</span>
                <span class="del">−{stat.del}</span>
              </>
            ) : (
              <span class="none">·</span>
            )}
          </span>
          {/* Row actions, revealed on row hover / keyboard focus: Open changes, the confirm-gated
              Discard (#1151 — destructive, so it always asks first), and Stage/Unstage. */}
          <div class="koi-sc-row-actions">
            <button
              type="button"
              class="koi-sc-ract"
              title="Open changes"
              aria-label={`Open changes ${f.relPath}`}
              onClick={() => void onToggleDiff(f)}
            >
              <svg class="koi-sc-ico" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4Z" />
                <circle cx="8" cy="8" r="1.8" />
              </svg>
            </button>
            {/* Discard only on NON-STAGED rows — mirroring the group headers, where the staged group
                withholds Discard-all. A staged row's "discard" would silently revert only the worktree
                delta (not the staged change the row actually shows) — a data-loss trap, so no control. */}
            {!f.staged && (
              <button
                type="button"
                class="koi-sc-ract danger"
                title="Discard changes"
                aria-label={`Discard ${f.relPath} changes`}
                disabled={busy}
                onClick={() => onDiscard([f])}
              >
                <svg class="koi-sc-ico" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M11.5 4.5 8 8m0 0L4.5 4.5M8 8l3.5 3.5M8 8l-3.5 3.5" />
                </svg>
              </button>
            )}
            {f.staged ? (
              <button
                type="button"
                class="koi-sc-ract"
                title="Unstage changes"
                aria-label={`Unstage ${f.relPath}`}
                disabled={busy}
                onClick={() => onUnstage(f.relPath)}
              >
                <svg class="koi-sc-ico" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4 8h8" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                class="koi-sc-ract stage"
                title="Stage changes"
                aria-label={`Stage ${f.relPath}`}
                disabled={busy}
                onClick={() => onStage(f.relPath)}
              >
                <svg class="koi-sc-ico" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 4v8M4 8h8" />
                </svg>
              </button>
            )}
          </div>
        </div>
        {expanded && (
          <pre class="koi-sc-diff" aria-label={`Diff for ${f.relPath}`}>
            {diffText || 'No changes to show.'}
          </pre>
        )}
      </li>
    );
  };

  // A named group landmark (`<section aria-label>`) for one bucket of files, omitted entirely when empty
  // so the rail doesn't carry hollow headers — the test relies on this to prove a file moved groups. Its
  // head is a collapse toggle (chevron + label + count pill) plus a hover/focus-revealed action cluster:
  // Stage all / Unstage all are wired through `mutate`; Discard all (#1151) passes the whole group's
  // files through the confirm-gated onDiscard (which splits them into tracked/untracked buckets).
  const fileGroup = (label: string, list: GitFile[]) => {
    if (list.length === 0) return null;
    const isStaged = list.every((f) => f.staged);
    const collapsed = collapsedGroups.has(label);
    const paths = list.map((f) => f.relPath);
    return (
      <section
        class={`koi-sc-group${isStaged ? ' staged' : ''}${collapsed ? ' collapsed' : ''}`}
        aria-label={label}
      >
        <div class="koi-sc-group-head">
          <button
            type="button"
            class="koi-sc-group-toggle"
            aria-expanded={!collapsed}
            onClick={() => toggleGroup(label)}
          >
            <svg class="koi-sc-ico chev" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 6.5 8 10 12 6.5" />
            </svg>
            {label}
            <span class="cnt">{list.length}</span>
          </button>
          <div class="koi-sc-group-actions">
            {isStaged ? (
              <button
                type="button"
                class="koi-sc-gact"
                title="Unstage all"
                aria-label="Unstage all"
                disabled={busy}
                onClick={() => void mutate(() => git.gitUnstage(folderToken, paths))}
              >
                <svg class="koi-sc-ico" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4 8h8" />
                </svg>
              </button>
            ) : (
              <>
                {/* Group discard (#1151): every path of this group through the confirm-gated onDiscard —
                    destructive, so it always asks before touching the working tree. */}
                <button
                  type="button"
                  class="koi-sc-gact danger"
                  title="Discard all changes"
                  aria-label="Discard all changes"
                  disabled={busy}
                  onClick={() => onDiscard(list, { group: label })}
                >
                  <svg class="koi-sc-ico" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M6.5 3h3M3.5 4.5h9M11.5 4.5l-.5 8a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1l-.5-8" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="koi-sc-gact"
                  title="Stage all"
                  aria-label="Stage all"
                  disabled={busy}
                  onClick={() => void mutate(() => git.gitStage(folderToken, paths))}
                >
                  <svg class="koi-sc-ico" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M8 4v8M4 8h8" />
                  </svg>
                </button>
              </>
            )}
          </div>
        </div>
        <ul class="koi-sc-files">{list.map(fileRow)}</ul>
      </section>
    );
  };

  // Refresh + the ⋮ overflow trigger (#1153): portaled into the shell's shared #right-header-actions slot
  // so they sit beside the "Source Control" title instead of a separate row in the panel body — the same
  // header every right-rail view shares (see centerDeckController's selectRightView, which shows/hides the
  // slot per active view). Falls back to rendering inline when that host isn't present (Storybook /
  // component tests that mount the panel standalone, without the shell chrome around it).
  const headerActions = (
    <div class="koi-sc-actions" role="toolbar" aria-label="Source control actions">
      <button
        type="button"
        class={`koi-sc-hdr-ico${spin ? ' is-spinning' : ''}`}
        title="Refresh"
        aria-label="Refresh"
        disabled={busy}
        onClick={() => {
          setSpin((s) => !s);
          reload();
        }}
      >
        <svg class="koi-sc-ico" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M13 8a5 5 0 1 1-1.5-3.6" />
          <path d="M13 2.5V5h-2.5" />
        </svg>
      </button>
      {/* Overflow menu (#1153): a live createFloatingMenu trigger. The initial aria-expanded="false"
          matches the WAI-ARIA menu-button pattern and the engine's other consumers (toolbarOverflow,
          domainNavigator); the engine flips it on open/close via setAttribute, and Preact never clobbers
          that runtime value because this static `false` prop is unchanged across re-renders. */}
      <button
        type="button"
        class="koi-sc-hdr-ico"
        title="Views and more actions"
        aria-label="Views and more actions"
        aria-haspopup="menu"
        aria-expanded={false}
        onClick={openOverflowMenu}
      >
        <svg class="koi-sc-ico" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="3.5" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="8" cy="12.5" r="1.1" fill="currentColor" stroke="none" />
        </svg>
      </button>
    </div>
  );
  const headerActionsHost = document.getElementById('right-header-actions'); // eslint-disable-line no-restricted-properties -- guarded portal target; falls back to inline rendering when absent

  return (
    <div class="koi-sc" ref={hostRef}>
      {headerActionsHost ? createPortal(headerActions, headerActionsHost) : headerActions}

      <div class="koi-sc-branchbar">
        {branchOptions.length > 0 ? (
          <select
            class="koi-sc-branch"
            aria-label="Current branch — switch branch"
            value={status?.branch ?? ''}
            disabled={busy}
            onChange={(e) => onCheckout((e.currentTarget as HTMLSelectElement).value)}
          >
            {branchOptions.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        ) : (
          <span class="koi-sc-branch koi-sc-branch-name">{status?.branch ?? '…'}</span>
        )}
        {/* Ahead/behind sync readout + push (#1150), driven by status.upstream: real counts and a live
            push button when the branch tracks an upstream; a plain "No upstream" hint — never fake 0/0
            counts, never a dead disabled button announced to AT users — when it doesn't. The compact
            ↑/↓ glyphs are aria-hidden; an sr-only sentence carries the meaning. Rendered only once
            status resolves so the loading frame shows neither counts nor a misleading hint. */}
        {status &&
          (upstream ? (
            <>
              <div class="koi-sc-sync" title={`${upstream.ahead} ahead · ${upstream.behind} behind ${upstream.ref}`}>
                <span class="koi-sr-only">
                  {upstream.ahead} commits ahead of, {upstream.behind} behind {upstream.ref}
                </span>
                <span class="ahead" aria-hidden="true">
                  <i>↑</i>
                  {upstream.ahead}
                </span>
                <span class="sep" aria-hidden="true">
                  ·
                </span>
                <span class="behind" aria-hidden="true">
                  <i>↓</i>
                  {upstream.behind}
                </span>
              </div>
              <button
                type="button"
                class={`koi-sc-push${upstream.ahead > 0 ? ' has-ahead' : ''}`}
                title={`Push to ${upstream.ref}`}
                aria-label={`Push to ${upstream.ref}`}
                disabled={busy}
                onClick={onPush}
              >
                <svg class="koi-sc-ico" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 12.5v-8M4.5 8 8 4.5 11.5 8" />
                </svg>
              </button>
            </>
          ) : (
            <>
              <div class="koi-sc-sync koi-sc-sync-none" title="This branch isn’t tracking an upstream">
                No upstream
              </div>
              {/* Publish branch (#1401): replaces the old dead end — a live action that pushes AND sets
                  the tracking ref in one step (`git push -u origin <branch>`), so a branch with no
                  upstream yet is no longer a conversational cul-de-sac. Only offered once the branch
                  actually has a commit to publish — an empty repo's branch has no tip to push, so the
                  plain "No upstream" hint stays the sole (inert) control rather than a live-but-pointless
                  button. */}
              {log.length > 0 && (
                <button
                  type="button"
                  class="koi-sc-act"
                  title="Publish branch"
                  aria-label="Publish branch"
                  disabled={busy}
                  onClick={onPublish}
                >
                  Publish branch
                </button>
              )}
            </>
          ))}
      </div>

      {actionError && (
        <p class="koi-sc-error" role="alert">
          {actionError}
        </p>
      )}

      {status === null ? (
        <p class="koi-docs-empty">Loading changes…</p>
      ) : (
        <>
          <div class="koi-sc-composer">
            <textarea
              class="koi-sc-composer-input"
              aria-label="Commit message"
              rows={2}
              placeholder="Message (what changed and why)"
              value={message}
              disabled={busy}
              onInput={(e) => setMessage((e.currentTarget as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                // ⌘⏎ / Ctrl+⏎ commits straight from the message box — but only when the Commit
                // button would itself be enabled, so the shortcut can never bypass the guards.
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  if (!commitDisabled) onCommit();
                }
              }}
            />
            <div class="koi-sc-composer-foot">
              <div class={`koi-sc-commit-split${commitDisabled ? ' is-disabled' : ''}`}>
                <button type="button" class="koi-sc-commit-btn" disabled={commitDisabled} onClick={onCommit}>
                  <span class="koi-sc-commit-lbl">
                    Commit {staged.length} {staged.length === 1 ? 'file' : 'files'} to {branch}
                  </span>
                  {/* Keyboard hint, aria-hidden so the button's accessible name stays "Commit N files…". */}
                  <span class="koi-sc-kbd" aria-hidden="true">
                    <kbd>⌘</kbd>
                    <kbd class="ret">
                      <svg class="koi-sc-ico" viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M12.4 4.6v2.7a1.6 1.6 0 0 1-1.6 1.6H4.6M6.9 6.9 4.4 9l2.5 2.1" />
                      </svg>
                    </kbd>
                  </span>
                </button>
                {/* Split caret (#1153): opens the commit-options menu (Amend / Commit & Push). Those two
                    items are disabled placeholders — their git ops are sibling follow-ups — but the menu
                    surface is live. Disabled only while the composer is busy; the initial aria-expanded is
                    "false" (the engine flips it on open/close, and the static prop never clobbers it). */}
                <button
                  type="button"
                  class="koi-sc-commit-caret"
                  title="Commit options"
                  aria-label="Commit options"
                  aria-haspopup="menu"
                  aria-expanded={false}
                  disabled={busy}
                  onClick={openCaretMenu}
                >
                  <svg class="koi-sc-ico" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M4 6.5 8 10 12 6.5" />
                  </svg>
                </button>
              </div>
            </div>
          </div>

          {fileGroup(STAGED_CHANGES_LABEL, staged)}
          {fileGroup(CHANGES_LABEL, unstaged)}
          {fileGroup(UNTRACKED_LABEL, untracked)}

          {files.length === 0 && <p class="koi-docs-empty">No changes — the working tree is clean.</p>}

          {/* Recent commits — the same collapsible group head as the file groups (chevron toggle reusing
              toggleGroup), with a "View all" placeholder as the header action (a full-history surface is a
              follow-up). Each row is a mono initials avatar beside a message + SHA·author·date meta line. */}
          <section
            class={`koi-sc-group${logCollapsed ? ' collapsed' : ''}`}
            aria-label={RECENT_COMMITS_LABEL}
          >
            <div class="koi-sc-group-head">
              <button
                type="button"
                class="koi-sc-group-toggle"
                aria-expanded={!logCollapsed}
                onClick={() => toggleGroup(RECENT_COMMITS_LABEL)}
              >
                <svg class="koi-sc-ico chev" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4 6.5 8 10 12 6.5" />
                </svg>
                {RECENT_COMMITS_LABEL}
              </button>
              {/* Full commit-history surface (#1153): an in-panel expansion over the already-fetched `log`
                  (no new git op). Rendered only when there are commits, and openable only when the 10-row
                  cap actually hides some — with ≤ 10 everything already shows, so the toggle is disabled
                  rather than a live-but-inert control. */}
              {log.length > 0 && (
                <button
                  type="button"
                  class="koi-sc-viewall"
                  aria-label={showAllCommits ? 'Show fewer commits' : 'View all commits'}
                  title={hasMoreCommits ? undefined : 'All commits are shown'}
                  disabled={!hasMoreCommits}
                  // Expand via revealAllCommits so it ALSO un-collapses the section (the collapse class hides
                  // the list) — matching the ⋮ "View all commits" item; collapsing back just re-caps to 10.
                  onClick={() => (showAllCommits ? setShowAllCommits(false) : revealAllCommits())}
                >
                  {showAllCommits ? 'Show less' : 'View all'}
                </button>
              )}
            </div>
            {log.length === 0 ? (
              <p class="koi-docs-empty">No commits yet.</p>
            ) : (
              <ul class="koi-sc-log">
                {shownLog.map((c) => (
                  <li
                    key={c.sha}
                    class="koi-sc-log-item"
                    data-sha={c.sha}
                    data-focused={focusedCommit === c.sha ? 'true' : undefined}
                    // Programmatic cue so AT users know which commit the launcher's "View commit" landed on,
                    // not just the visual accent ring (WCAG 2.1 AA).
                    aria-current={focusedCommit === c.sha ? 'true' : undefined}
                  >
                    {/* Decorative accent-tinted initials avatar; aria-hidden — the author is in the meta. */}
                    <span class="koi-sc-avatar" aria-hidden="true">
                      {initials(c.author)}
                    </span>
                    <div class="koi-sc-log-main">
                      <span class="koi-sc-log-msg">{c.message}</span>
                      <span class="koi-sc-log-meta">
                        <code>{c.sha.slice(0, 7)}</code>
                        <span class="sep" aria-hidden="true">
                          ·
                        </span>
                        {c.author}
                        <span class="sep" aria-hidden="true">
                          ·
                        </span>
                        {formatDate(c.date)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
