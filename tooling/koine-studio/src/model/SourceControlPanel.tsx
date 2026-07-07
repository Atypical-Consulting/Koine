import { useEffect, useRef, useState } from 'preact/hooks';
import type { GitFile, GitLogEntry, GitStatus, Platform } from '@/host/types';
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
// crashes. After every mutation (stage / unstage / commit / checkout) it RE-FETCHES status (and the log
// after a commit) so the groups and recent-commit list track the repository.

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
  | 'gitStage'
  | 'gitUnstage'
  | 'gitCommit'
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

/** Best-effort `+added / −removed` line counts parsed from a unified diff's hunk bodies (everything
 *  after the first `@@`), so the file-header lines are skipped by position rather than by a text guard.
 *  `GitFile` carries no line counts and `gitDiff` is lazy (per-row), so a row can only show real counts
 *  once ITS diff is open and parsed — otherwise the row falls back to a neutral placeholder rather than a
 *  misleading `+0`. Eager numstat is a tracked follow-up. */
function diffStat(text: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  // Count only inside the hunk body (after the first `@@` header). The file header lines (`--- a/…`,
  // `+++ b/…`, `diff --git`, `index …`) live before it, so skipping them by position — rather than by a
  // `startsWith('---'/'+++')` text guard — avoids miscounting a genuinely deleted/added source line that
  // itself begins with `--`/`++` (e.g. a removed `-- comment`, which renders as `--- comment`).
  let inHunk = false;
  for (const line of text.split('\n')) {
    if (!inHunk) {
      if (line.startsWith('@@')) inHunk = true;
      continue;
    }
    // Within the body: `+`/`-` prefixed lines are additions/deletions; a later `@@` starts a new hunk and
    // isn't a `+`/`-` line, so it's skipped naturally.
    if (line.startsWith('+')) add += 1;
    else if (line.startsWith('-')) del += 1;
  }
  return { add, del };
}

/** Which file's inline diff is open, keyed by (relPath, area) so the staged and unstaged rows of one path
 *  toggle independently — the same (file, area) identity git's diff is taken against. */
interface OpenDiff {
  relPath: string;
  staged: boolean;
}

export function SourceControlPanel(props: {
  git: GitSurface;
  folderToken: string;
  /** Bumped by the controller to force a re-fetch (e.g. on a workspace folder switch); optional. */
  refreshNonce?: number;
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
        // The log + branch list are best-effort companions to the status; a failure in either leaves
        // that section empty rather than collapsing the whole panel.
        const [lg, br] = await Promise.all([
          git.gitLog(folderToken).catch(() => [] as GitLogEntry[]),
          git.gitBranches(folderToken).catch(() => [] as string[]),
        ]);
        if (!alive) return;
        // Clear `busy` in the SAME state flush as the data, so the rows never paint a frame disabled
        // between "status arrived" and "no longer busy" — a click on a row action would otherwise no-op.
        setStatus(st);
        setLog(lg);
        setBranches(br);
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
        // Git commits what's on disk, so unsaved editor buffers would be silently excluded. With unsaved
        // work, prompt a Save-all first (#470) so the commit reflects what the editor shows. Declining
        // aborts the commit (the draft survives); a failed save propagates and `mutate` surfaces it — so we
        // never commit a half-saved tree. No unsaved work (or props omitted) → straight to gitCommit.
        const unsaved = props.dirtyCount ?? 0;
        if (unsaved > 0 && props.onSaveAll) {
          const ok = await koiConfirm({
            title: 'Save changes before committing?',
            message: `You have ${unsaved} unsaved file${unsaved === 1 ? '' : 's'}. Git commits what's saved to disk — save all first so this commit includes your latest edits.`,
            confirmLabel: 'Save all & commit',
            cancelLabel: 'Cancel',
          });
          if (!ok) return; // declined — abort without committing a stale tree
          await props.onSaveAll();
        }
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

  // Build + toggle the ⋮ overflow menu (#1153). The LIVE items are already backed by the panel's existing
  // handlers/data (Refresh, Stage/Unstage all over the grouped paths, collapse/expand, reveal-all-commits);
  // the DEFERRED items render disabled because their Platform git op doesn't exist yet — each is a tracked
  // sibling follow-up of #1146/#1142: Discard-all/revert, and the pull/push/fetch sync ops the ahead/behind
  // readout also awaits. Disabled (never a live-but-inert no-op) matches the panel's placeholder convention.
  const openOverflowMenu = (e: MouseEvent) => {
    const trigger = e.currentTarget as HTMLElement;
    const unstagedPaths = [...unstaged, ...untracked].map((f) => f.relPath);
    const stagedPaths = staged.map((f) => f.relPath);
    // Every present, collapsible section label — the non-empty file groups plus the Recent-commits log.
    const groupLabels = [
      ...(staged.length ? ['Staged Changes'] : []),
      ...(unstaged.length ? ['Changes'] : []),
      ...(untracked.length ? ['Untracked'] : []),
      ...(log.length ? [RECENT_COMMITS_LABEL] : []),
    ];
    const allCollapsed = groupLabels.length > 0 && groupLabels.every((l) => collapsedGroups.has(l));
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
      { id: 'view-all-commits', label: 'View all commits', disabled: log.length === 0, run: revealAllCommits },
      { id: 'discard-all', label: 'Discard all changes', disabled: true, run: () => {} },
      { id: 'pull', label: 'Pull', disabled: true, run: () => {} },
      { id: 'push', label: 'Push', disabled: true, run: () => {} },
      { id: 'fetch', label: 'Fetch', disabled: true, run: () => {} },
    ];
    overflowMenuRef.current!.toggle({ trigger, items, align: 'right' });
  };

  // Build + toggle the split-commit caret menu (#1153). Both items are DEFERRED placeholders: Amend needs a
  // new `git commit --amend` Platform op, and Commit & Push depends on the same push op the ahead/behind
  // sync readout is waiting on — each a tracked sibling follow-up. They render disabled (never a live-but-
  // inert no-op); the plain Commit action stays the split button itself. The caret is openable so the menu
  // is discoverable, disabled only while the composer is busy (the same gate the message box uses).
  const openCaretMenu = (e: MouseEvent) => {
    const trigger = e.currentTarget as HTMLElement;
    const items: FloatingMenuItem[] = [
      { id: 'amend', label: 'Amend last commit', disabled: true, run: () => {} },
      { id: 'commit-push', label: 'Commit & Push', disabled: true, run: () => {} },
    ];
    caretMenuRef.current!.toggle({ trigger, items, align: 'right' });
  };

  // One file row: a status glyph, a path button that toggles the inline diff, a best-effort +/− stat
  // (swapped for the hover/focus action cluster), then the inline diff below when open. The path button's
  // visible label is split into basename + muted dir, but its accessible name is pinned to
  // `{relPath} {status}` so each row stays uniquely addressable and AT users hear the full path + kind.
  const fileRow = (f: GitFile) => {
    const expanded = openDiff?.relPath === f.relPath && openDiff?.staged === f.staged;
    // Real +/− counts are only knowable once THIS row's diff is open and loaded (GitFile has none);
    // otherwise a neutral placeholder, never a fake `+0`. See {@link diffStat}.
    const stat = expanded && diffText ? diffStat(diffText) : null;
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
          {/* Row actions, revealed on row hover / keyboard focus. Open changes + Stage/Unstage are wired;
              Discard is a disabled placeholder — the Platform git surface exposes no discard/revert op, so
              wiring it is a tracked follow-up (see the panel's design handoff). */}
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
            <button
              type="button"
              class="koi-sc-ract danger"
              title="Discard changes (coming soon)"
              aria-label={`Discard ${f.relPath} changes (coming soon)`}
              disabled
            >
              <svg class="koi-sc-ico" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M11.5 4.5 8 8m0 0L4.5 4.5M8 8l3.5 3.5M8 8l-3.5 3.5" />
              </svg>
            </button>
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
  // Stage all / Unstage all are wired through `mutate`; Discard all is a disabled placeholder (the git
  // surface exposes no discard/revert op — wiring it is a tracked follow-up).
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
                {/* Discard has no backing Platform git op — render it as a disabled placeholder for visual
                    fidelity; wiring Discard/Revert is a tracked follow-up (see the panel's design handoff). */}
                <button
                  type="button"
                  class="koi-sc-gact danger"
                  title="Discard all changes (coming soon)"
                  aria-label="Discard all changes (coming soon)"
                  disabled
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

  return (
    <div class="koi-sc">
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
        {/* Overflow menu (#1153): a live createFloatingMenu trigger. aria-expanded is owned by the engine
            (it sets it on open/close), so it's intentionally NOT declared here — declaring it would let a
            Preact re-render clobber the engine's value while the menu is open. */}
        <button
          type="button"
          class="koi-sc-hdr-ico"
          title="Views and more actions"
          aria-label="Views and more actions"
          aria-haspopup="menu"
          onClick={openOverflowMenu}
        >
          <svg class="koi-sc-ico" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="3.5" r="1.1" fill="currentColor" stroke="none" />
            <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
            <circle cx="8" cy="12.5" r="1.1" fill="currentColor" stroke="none" />
          </svg>
        </button>
      </div>

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
        {/* Best-effort ahead/behind READOUT — GitStatus carries no upstream counts, so it reads 0/0 until
            real sync wiring lands (a follow-up). A non-interactive readout (not a button): there is no
            push action to invoke, so a labelled button would announce a dead control to AT users. The
            compact ↑/↓ glyphs are aria-hidden; an sr-only sentence carries the meaning. */}
        <div class="koi-sc-sync" title={`0 ahead · 0 behind origin/${status?.branch ?? 'main'}`}>
          <span class="koi-sr-only">0 commits ahead of, 0 behind origin/{status?.branch ?? 'main'}</span>
          <span class="ahead" aria-hidden="true">
            <i>↑</i>0
          </span>
          <span class="sep" aria-hidden="true">
            ·
          </span>
          <span class="behind" aria-hidden="true">
            <i>↓</i>0
          </span>
          <svg class="koi-sc-ico" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M13 8a5 5 0 1 1-1.5-3.6" />
            <path d="M13 2.5V5h-2.5" />
          </svg>
        </div>
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
                    surface is live. Disabled only while the composer is busy; aria-expanded is owned by the
                    createFloatingMenu engine (declaring it here would let a Preact re-render clobber it). */}
                <button
                  type="button"
                  class="koi-sc-commit-caret"
                  title="Commit options"
                  aria-label="Commit options"
                  aria-haspopup="menu"
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

          {fileGroup('Staged Changes', staged)}
          {fileGroup('Changes', unstaged)}
          {fileGroup('Untracked', untracked)}

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
                  onClick={() => setShowAllCommits((v) => !v)}
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
                  <li key={c.sha} class="koi-sc-log-item">
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
