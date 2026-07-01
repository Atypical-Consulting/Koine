import type { Meta, StoryObj } from '@storybook/preact-vite';
import { SourceControlPanel, type GitSurface } from '@/model/SourceControlPanel';
import type { GitFile, GitLogEntry, GitStatus } from '@/host/types';

// The right-rail Source Control panel (#272) — already a Preact island; these stories bring it to the
// migration's story+axe bar (#759). The panel owns its own async git fetch rather than reading the
// store, so each story seeds a small in-memory {@link GitSurface} fake (plain async fns — stories run in
// the Chromium project, no `vi`). The desktop story exercises the populated groups + branch + log; the
// browser and not-a-repo stories pin the two capability-gated empty states the panel must paint instead
// of crashing or blanking. The @storybook/addon-a11y axe pass guards each state's accessibility.

const TOKEN = 'file:///work';

/** A static in-memory git surface: gitStatus returns the given snapshot; mutations are inert no-ops
 *  (stories don't drive interactions). `satisfies GitSurface` keeps it structurally exact. */
function makeGit(files: GitFile[], log: GitLogEntry[] = []): GitSurface {
  const snapshot = (): GitStatus => ({ branch: 'main', files: files.map((f) => ({ ...f })) });
  return {
    canUseGit: true,
    gitStatus: async () => snapshot(),
    gitDiff: async () => 'diff --git a/x b/x\n@@ -1 +1 @@\n-old line\n+new line',
    gitStage: async () => {},
    gitUnstage: async () => {},
    gitCommit: async () => {},
    gitBranches: async () => ['main', 'feature/scm'],
    gitCheckout: async () => {},
    gitLog: async () => log,
    gitInit: async () => {},
  } satisfies GitSurface;
}

const seededLog: GitLogEntry[] = [
  { sha: 'abcdef1234567', author: 'Ada', date: '2026-06-01T10:00:00Z', message: 'Seed the model' },
  { sha: '0123456abcdef', author: 'Grace', date: '2026-05-28T09:30:00Z', message: 'Add ordering context' },
];

const changedFiles: GitFile[] = [
  { relPath: 'ordering/order.koi', staged: true, status: 'modified' },
  { relPath: 'ordering/line-item.koi', staged: false, status: 'modified' },
  { relPath: 'billing/invoice.koi', staged: false, status: 'untracked' },
];

const meta = {
  title: 'Panels/SourceControlPanel',
  component: SourceControlPanel,
  parameters: { layout: 'padded' },
  args: {
    git: makeGit(changedFiles, seededLog),
    folderToken: TOKEN,
  },
} satisfies Meta<typeof SourceControlPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Desktop host with a dirty working tree: files grouped into Staged / Changes / Untracked, a branch
 *  switcher, and the recent-commit log. */
export const Desktop: Story = {};

/** Desktop host with a clean working tree — no changes, but the branch header and "working tree is
 *  clean" message still render. */
export const CleanTree: Story = {
  args: { git: makeGit([], seededLog) },
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
