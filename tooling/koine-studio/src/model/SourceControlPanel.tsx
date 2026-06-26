import { useEffect, useState } from 'preact/hooks';
import type { GitFile, GitLogEntry, GitStatus, Platform } from '@/host/types';
import { koiConfirm } from '@/shared/overlay';

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

/** The `YYYY-MM-DD` calendar day of an ISO-8601 commit date (timezone-stable, locale-free), else the raw
 *  value — the same deterministic formatting the inspector's change-history rows use. */
function formatDate(date: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(date);
  return m ? m[1] : date;
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
    void mutate(async () => {
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
    });
  }

  async function onToggleDiff(f: GitFile): Promise<void> {
    if (openDiff && openDiff.relPath === f.relPath && openDiff.staged === f.staged) {
      setOpenDiff(null);
      return;
    }
    setOpenDiff({ relPath: f.relPath, staged: f.staged });
    try {
      setDiffText(await git.gitDiff(folderToken, f.relPath, f.staged));
    } catch {
      setDiffText('');
    }
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
          <p class="muted">
            This folder isn’t a git repository. Initialize one with <code>git init</code> to track changes
            here.
          </p>
        </div>
      </div>
    );
  }

  const files = status?.files ?? [];
  const staged = files.filter((f) => f.staged);
  const unstaged = files.filter((f) => !f.staged && f.status !== 'untracked');
  const untracked = files.filter((f) => !f.staged && f.status === 'untracked');
  const hasStaged = staged.length > 0;
  // Surface the current branch even when it isn't in the local list (detached HEAD / fresh branch).
  const branchOptions = status && !branches.includes(status.branch) ? [status.branch, ...branches] : branches;

  // One file row: a path button that toggles its inline diff (its glyph + screen-reader status), plus the
  // Stage or Unstage action for its area. The action's label carries the path screen-reader-only so each
  // button has a unique accessible name in a list of rows.
  const fileRow = (f: GitFile) => {
    const expanded = openDiff?.relPath === f.relPath && openDiff?.staged === f.staged;
    return (
      <li key={`${f.staged ? 's' : 'w'}:${f.relPath}`} class="koi-sc-file" data-relpath={f.relPath}>
        <div class="koi-sc-file-row">
          <button
            type="button"
            class="koi-sc-file-open"
            aria-expanded={expanded}
            onClick={() => void onToggleDiff(f)}
          >
            <span class={`koi-sc-glyph koi-sc-glyph-${f.status}`} aria-hidden="true">
              {STATUS_GLYPH[f.status]}
            </span>
            <span class="koi-sc-file-path">{f.relPath}</span>
            <span class="koi-sr-only"> {STATUS_LABEL[f.status]}</span>
          </button>
          {f.staged ? (
            <button type="button" class="koi-sc-act" disabled={busy} onClick={() => onUnstage(f.relPath)}>
              Unstage<span class="koi-sr-only"> {f.relPath}</span>
            </button>
          ) : (
            <button type="button" class="koi-sc-act" disabled={busy} onClick={() => onStage(f.relPath)}>
              Stage<span class="koi-sr-only"> {f.relPath}</span>
            </button>
          )}
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
  // so the rail doesn't carry hollow headers — the test relies on this to prove a file moved groups.
  const fileGroup = (label: string, list: GitFile[]) => {
    if (list.length === 0) return null;
    return (
      <section class="koi-sc-group" aria-label={label}>
        <h4 class="koi-sc-group-title">
          {label} <span class="koi-sc-count muted">{list.length}</span>
        </h4>
        <ul class="koi-sc-files">{list.map(fileRow)}</ul>
      </section>
    );
  };

  return (
    <div class="koi-sc">
      <header class="koi-sc-head">
        <div class="koi-sc-branch">
          <span class="koi-sc-branch-icon" aria-hidden="true">
            ⎇
          </span>
          {branchOptions.length > 0 ? (
            <select
              class="koi-sc-branch-select"
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
            <span class="koi-sc-branch-name">{status?.branch ?? '…'}</span>
          )}
        </div>
        <button type="button" class="koi-sc-refresh koi-docs-new-btn" disabled={busy} onClick={reload}>
          Refresh
        </button>
      </header>

      {actionError && (
        <p class="koi-sc-error" role="alert">
          {actionError}
        </p>
      )}

      {status === null ? (
        <p class="koi-docs-empty">Loading changes…</p>
      ) : (
        <>
          <div class="koi-sc-commit">
            <textarea
              class="koi-sc-commit-input"
              aria-label="Commit message"
              rows={2}
              placeholder="Message (what changed and why)"
              value={message}
              disabled={busy}
              onInput={(e) => setMessage((e.currentTarget as HTMLTextAreaElement).value)}
            />
            <button
              type="button"
              class="koi-sc-commit-btn koi-docs-save"
              disabled={busy || message.trim().length === 0 || !hasStaged}
              onClick={onCommit}
            >
              Commit
            </button>
          </div>

          {fileGroup('Staged Changes', staged)}
          {fileGroup('Changes', unstaged)}
          {fileGroup('Untracked', untracked)}

          {files.length === 0 && <p class="koi-docs-empty">No changes — the working tree is clean.</p>}

          <section class="koi-sc-group koi-sc-log-group" aria-label="Recent commits">
            <h4 class="koi-sc-group-title">Recent commits</h4>
            {log.length === 0 ? (
              <p class="koi-docs-empty">No commits yet.</p>
            ) : (
              <ul class="koi-sc-log">
                {log.slice(0, 10).map((c) => (
                  <li key={c.sha} class="koi-sc-log-item">
                    <code class="koi-sc-log-sha">{c.sha.slice(0, 7)}</code>
                    <span class="koi-sc-log-msg">{c.message}</span>
                    <span class="koi-sc-log-meta muted">
                      {c.author} · {formatDate(c.date)}
                    </span>
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
