import type { Meta, StoryObj } from '@storybook/preact-vite';
import { expect, waitFor } from 'storybook/test';
import { SourceControlPanel, type GitSurface } from '@/model/SourceControlPanel';
import type { GitFile, GitLogEntry, GitNumstatEntry, GitStatus, GitUpstream } from '@/host/types';

// The right-rail Source Control panel (#272), converged to the PR #1140 handoff design (#1142): the
// header actions + branch/sync bar, the bordered commit composer with its split ⌘⏎ button, the
// collapsible Staged/Changes/Untracked groups with hover actions and per-row glyphs + stat ↔ actions,
// and the recent-commits log with author avatars. These stories bring it to the migration's story+axe
// bar (#759). The panel owns its own async git fetch rather than reading the store, so each story seeds a
// small in-memory {@link GitSurface} fake (plain async fns — stories run in the Chromium project, no
// `vi`). The desktop story exercises the populated groups + branch/sync + composer + avatar log across
// files with and without a directory prefix; the browser and not-a-repo stories pin the two
// capability-gated empty states the panel must paint instead of crashing or blanking. The
// @storybook/addon-a11y axe pass guards each state's accessibility (incl. the Chromium colour-contrast
// check the happy-dom unit axe can't see).

const TOKEN = 'file:///work';

/** A static in-memory git surface: gitStatus returns the given snapshot; gitNumstat feeds the eager
 *  per-row `+n/−n` counts (#1152); `upstream` seeds the sync readout's ahead/behind data (#1150) —
 *  defaulted to a diverged origin/main so the counts + push button render; pass null for a branch
 *  with no upstream. Mutations are inert no-ops (stories don't drive interactions). `satisfies
 *  GitSurface` keeps it structurally exact. */
function makeGit(
  files: GitFile[],
  log: GitLogEntry[] = [],
  numstat: GitNumstatEntry[] = [],
  upstream: GitUpstream | null = { ref: 'origin/main', ahead: 2, behind: 1 },
): GitSurface {
  const snapshot = (): GitStatus => ({ branch: 'main', files: files.map((f) => ({ ...f })), upstream });
  return {
    canUseGit: true,
    gitStatus: async () => snapshot(),
    gitDiff: async () => 'diff --git a/x b/x\n@@ -1 +1 @@\n-old line\n+new line',
    gitNumstat: async () => numstat.map((e) => ({ ...e })),
    gitStage: async () => {},
    gitUnstage: async () => {},
    gitDiscard: async () => {},
    gitCommit: async () => {},
    gitPush: async () => {},
    gitPull: async () => {},
    gitFetch: async () => {},
    gitBranches: async () => ['main', 'feature/scm'],
    gitCheckout: async () => {},
    gitLog: async () => log,
    gitInit: async () => {},
  } satisfies GitSurface;
}

// Distinct authors exercise the initials avatar (single- and multi-word names), and a long subject
// exercises the message ellipsis.
const seededLog: GitLogEntry[] = [
  {
    sha: 'abcdef1234567',
    author: 'Philippe Matray',
    date: '2026-06-01T10:00:00Z',
    message: 'Add OrderLine invariants and tighten the total-price computation across the ordering context',
  },
  { sha: '0123456abcdef', author: 'Grace Hopper', date: '2026-05-28T09:30:00Z', message: 'Add ordering context' },
  { sha: '89abcde01234f', author: 'Ada', date: '2026-05-27T08:15:00Z', message: 'Seed the model' },
];

// A long history (> 10) so the Recent-commits log caps at 10 and the "View all" toggle is live (#1153):
// distinct authors exercise the initials avatar, and the tail past index 9 is what "View all" reveals.
const longLog: GitLogEntry[] = Array.from({ length: 14 }, (_, i) => ({
  sha: `${String(i).padStart(4, '0')}c0ffee1234`,
  author: ['Ada', 'Grace Hopper', 'Philippe Matray'][i % 3],
  date: `2026-06-${String(28 - i).padStart(2, '0')}T09:00:00Z`,
  message: `Refine the ordering context — change ${i + 1}`,
}));

// A staged file (so the composer enables), plus unstaged + untracked entries with a directory prefix
// (to show the name/dir split) and a top-level file (no dir).
const changedFiles: GitFile[] = [
  { relPath: 'ordering/order.koi', staged: true, status: 'modified' },
  { relPath: 'ordering/line-item.koi', staged: false, status: 'modified' },
  { relPath: 'README.md', staged: false, status: 'modified' },
  { relPath: 'billing/invoice.koi', staged: false, status: 'untracked' },
];

// Eager `+n/−n` counts (#1152) keyed by (relPath, staged) for each TRACKED changed file — the untracked
// `billing/invoice.koi` is intentionally absent (git numstat doesn't cover untracked), so that row keeps
// the neutral `·` and the story exercises both the real-count and fallback rendering.
const changedNumstat: GitNumstatEntry[] = [
  { relPath: 'ordering/order.koi', staged: true, added: 12, removed: 3 },
  { relPath: 'ordering/line-item.koi', staged: false, added: 4, removed: 1 },
  { relPath: 'README.md', staged: false, added: 1, removed: 0 },
];

const meta = {
  title: 'Panels/SourceControlPanel',
  component: SourceControlPanel,
  parameters: { layout: 'padded' },
  args: {
    git: makeGit(changedFiles, seededLog, changedNumstat),
    folderToken: TOKEN,
  },
} satisfies Meta<typeof SourceControlPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Desktop host with a dirty working tree: files grouped into Staged / Changes / Untracked, a branch
 *  switcher, and the recent-commit log. The default fixture's diverged upstream (↑2 · ↓1 against
 *  origin/main, #1150) renders the real-count sync readout with its accent-tinted push button. */
export const Desktop: Story = {};

/** The ⋮ header overflow menu opened (#1153): the live createFloatingMenu surface — Refresh / Stage all /
 *  Unstage all / Collapse-all / View all commits live, and Discard-all / Pull / Push / Fetch disabled
 *  (their git ops are sibling follow-ups). The `play` waits for the async git fetch to settle, then opens
 *  the menu so the Chromium @storybook/addon-a11y axe/contrast pass covers the open state. */
export const OverflowMenuOpen: Story = {
  name: 'Overflow menu (open)',
  play: async ({ canvasElement }) => {
    // The composer only mounts once `gitStatus` resolves — wait for it so the menu's Stage/Unstage/View-all
    // items compute against real data (enabled) rather than the transient empty snapshot.
    await waitFor(() => expect(canvasElement.querySelector('.koi-sc-composer')).toBeTruthy());
    const trigger = canvasElement.querySelector<HTMLElement>('button[aria-label="Views and more actions"]');
    expect(trigger).toBeTruthy();
    trigger!.click();
    // createFloatingMenu mounts on document.body (outside canvasElement) — assert against the document.
    await waitFor(() => expect(document.querySelector('.koi-sc-menu')).toBeTruthy());
  },
};

/** The split-commit caret menu opened (#1153): its two items — Amend last commit and Commit & Push — are
 *  disabled placeholders (their git ops are sibling follow-ups), but the menu surface is live. The `play`
 *  opens it so the Chromium axe/contrast pass covers the disabled-menuitem chrome. */
export const CommitOptionsMenuOpen: Story = {
  name: 'Commit options menu (open)',
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector('.koi-sc-composer')).toBeTruthy());
    const trigger = canvasElement.querySelector<HTMLElement>('button[aria-label="Commit options"]');
    expect(trigger).toBeTruthy();
    trigger!.click();
    await waitFor(() => expect(document.querySelector('.koi-sc-menu')).toBeTruthy());
  },
};

/** The full commit history expanded (#1153): a > 10-commit log caps at the 10 newest, then "View all"
 *  lifts the cap to reveal the whole already-fetched log in place (no new git op). The `play` waits for the
 *  capped log, clicks "View all", and asserts the expansion so the Chromium axe/contrast + visual pass
 *  covers the expanded state. */
export const FullHistoryExpanded: Story = {
  name: 'Full history (expanded)',
  args: { git: makeGit(changedFiles, longLog, changedNumstat) },
  play: async ({ canvasElement }) => {
    // Wait for the log to load capped at 10, then expand it via "View all".
    const region = await waitFor(() => {
      const el = canvasElement.querySelector<HTMLElement>('[aria-label="Recent commits"]');
      expect(el?.querySelectorAll('.koi-sc-log-item').length).toBe(10);
      return el!;
    });
    const viewAll = canvasElement.querySelector<HTMLElement>('.koi-sc-viewall');
    expect(viewAll).toBeTruthy();
    viewAll!.click();
    await waitFor(() => expect(region.querySelectorAll('.koi-sc-log-item').length).toBe(14));
  },
};

/** Desktop host with a clean working tree — no changes, but the branch header and "working tree is
 *  clean" message still render. */
export const CleanTree: Story = {
  args: { git: makeGit([], seededLog) },
};

/** A branch with no upstream (#1150) — detached HEAD, a fresh local branch, or a repo with no remote:
 *  the sync slot shows a muted "No upstream" hint with no counts (a 0/0 would be a lie) and no push
 *  button (a dead control would still be announced to AT users). */
export const NoUpstream: Story = {
  name: 'No upstream',
  args: { git: makeGit(changedFiles, seededLog, changedNumstat, null) },
};

/** Browser host (`canUseGit === false`): the panel paints the "available in the desktop app" empty state
 *  and makes no git calls. */
export const BrowserDesktopOnly: Story = {
  args: {
    git: { ...makeGit([]), canUseGit: false } satisfies GitSurface,
  },
};

/** Desktop host pointed at a non-repository folder: `gitStatus` rejects, and the panel drops into the
 *  "isn't a git repository" empty state rather than throwing. */
export const NotARepository: Story = {
  args: {
    git: {
      ...makeGit([]),
      gitStatus: async () => {
        throw new Error('not a git repository');
      },
    } satisfies GitSurface,
  },
};
