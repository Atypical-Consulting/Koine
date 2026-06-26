import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/preact';
import { SourceControlPanel, type GitSurface } from '@/model/SourceControlPanel';
import type { GitFile, GitLogEntry, GitStatus } from '@/host/types';
import { koiConfirm } from '@/shared/overlay';
import { axe } from 'vitest-axe';

// The save-all-before-commit prompt (#470) uses the shared Koine confirm dialog. Mock it so the
// commit path resolves deterministically (true/false) without opening a real modal overlay.
vi.mock('@/shared/overlay', () => ({ koiConfirm: vi.fn() }));

const TOKEN = 'file:///work';

// A small in-memory git fake: gitStage/gitUnstage flip a path's `staged` flag in the backing model and
// gitCommit clears it, so each mutation genuinely moves the file between groups on the next gitStatus
// re-fetch — exactly as the real desktop host would. gitStatus returns a fresh snapshot every call, and
// every method is a vi.fn so a test can assert the exact call. `satisfies GitSurface` keeps the concrete
// Mock types so `.mock`/`toHaveBeenCalledWith` stay available on the returned object.
function makeGit(initial: GitFile[]) {
  let files: GitFile[] = initial.map((f) => ({ ...f }));
  const snapshot = (): GitStatus => ({ branch: 'main', files: files.map((f) => ({ ...f })) });
  return {
    canUseGit: true,
    gitStatus: vi.fn(async () => snapshot()),
    gitDiff: vi.fn(async () => 'diff --git a/x b/x\n+added line'),
    gitStage: vi.fn(async (_token: string, paths: string[]) => {
      files = files.map((f): GitFile =>
        paths.includes(f.relPath) ? { ...f, staged: true, status: f.status === 'untracked' ? 'added' : f.status } : f,
      );
    }),
    gitUnstage: vi.fn(async (_token: string, paths: string[]) => {
      files = files.map((f): GitFile => (paths.includes(f.relPath) ? { ...f, staged: false } : f));
    }),
    gitCommit: vi.fn(async () => {
      files = [];
    }),
    gitBranches: vi.fn(async () => ['main', 'feature']),
    gitCheckout: vi.fn(async () => {}),
    gitLog: vi.fn(
      async (): Promise<GitLogEntry[]> => [
        { sha: 'abcdef1234567', author: 'Ada', date: '2026-06-01T10:00:00Z', message: 'Seed the model' },
      ],
    ),
  } satisfies GitSurface;
}

// The section element of one file group, addressed by its aria-label (the panel groups files into named
// landmarks). Returns null when the group has no files — the panel omits an empty group entirely.
const group = (c: Element, label: string) => c.querySelector(`[aria-label="${label}"]`);

describe('SourceControlPanel', () => {
  test('renders the branch and groups changed files into Staged / Changes / Untracked', async () => {
    const git = makeGit([
      { relPath: 'a.koi', staged: true, status: 'modified' },
      { relPath: 'b.koi', staged: false, status: 'modified' },
      { relPath: 'c.koi', staged: false, status: 'untracked' },
    ]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    // The branch header shows the current branch (a switcher whose displayed value is the branch).
    await view.findByDisplayValue('main');

    // Each file lands in its own group by (staged, status).
    await waitFor(() => expect(group(view.container, 'Staged Changes')).not.toBeNull());
    expect(group(view.container, 'Staged Changes')!.textContent).toContain('a.koi');
    expect(group(view.container, 'Changes')!.textContent).toContain('b.koi');
    expect(group(view.container, 'Untracked')!.textContent).toContain('c.koi');
  });

  test('clicking Stage stages the file and re-fetches so it moves to the staged group', async () => {
    const git = makeGit([{ relPath: 'b.koi', staged: false, status: 'modified' }]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    const stageBtn = await view.findByRole('button', { name: /Stage b\.koi/ });
    fireEvent.click(stageBtn);

    await waitFor(() => expect(git.gitStage).toHaveBeenCalledWith(TOKEN, ['b.koi']));
    // The re-fetch moves the file into Staged Changes and empties (so drops) the Changes group.
    await waitFor(() => expect(group(view.container, 'Staged Changes')?.textContent).toContain('b.koi'));
    expect(group(view.container, 'Changes')).toBeNull();
  });

  test('typing a message and clicking Commit calls gitCommit with the message', async () => {
    const git = makeGit([{ relPath: 'a.koi', staged: true, status: 'modified' }]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    const textarea = (await view.findByLabelText('Commit message')) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'Add order total' } });

    const commitBtn = view.getByRole('button', { name: 'Commit' }) as HTMLButtonElement;
    expect(commitBtn.disabled).toBe(false);
    fireEvent.click(commitBtn);

    await waitFor(() => expect(git.gitCommit).toHaveBeenCalledWith(TOKEN, 'Add order total'));
  });

  test('renders the graceful empty state and makes NO git calls when canUseGit is false', async () => {
    const gitStatus = vi.fn();
    const gitLog = vi.fn();
    const git = {
      canUseGit: false,
      gitStatus,
      gitDiff: vi.fn(),
      gitStage: vi.fn(),
      gitUnstage: vi.fn(),
      gitCommit: vi.fn(),
      gitBranches: vi.fn(),
      gitCheckout: vi.fn(),
      gitLog,
    } as unknown as GitSurface;

    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    expect(view.getByText(/desktop app/i)).toBeTruthy();
    // Let any (erroneous) effect microtask flush before asserting nothing was called.
    await Promise.resolve();
    expect(gitStatus).not.toHaveBeenCalled();
    expect(gitLog).not.toHaveBeenCalled();
  });

  test('has no accessibility violations', async () => {
    const git = makeGit([
      { relPath: 'a.koi', staged: true, status: 'modified' },
      { relPath: 'b.koi', staged: false, status: 'modified' },
    ]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);
    await view.findByRole('region', { name: 'Staged Changes' });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});

describe('SourceControlPanel — save-all-before-commit prompt (#470)', () => {
  beforeEach(() => {
    vi.mocked(koiConfirm).mockReset();
  });

  // Drive a Commit on a panel with one staged file + a typed message, then return the call order so a
  // test can assert onSaveAll ran (or didn't) BEFORE gitCommit.
  async function commitWith(props: { dirtyCount?: number; onSaveAll?: () => Promise<void> }) {
    const git = makeGit([{ relPath: 'a.koi', staged: true, status: 'modified' }]);
    const order: string[] = [];
    git.gitCommit.mockImplementation(async () => {
      order.push('commit');
    });
    const onSaveAll = props.onSaveAll
      ? vi.fn(async () => {
          order.push('saveAll');
          await props.onSaveAll!();
        })
      : undefined;
    const view = render(
      <SourceControlPanel git={git} folderToken={TOKEN} dirtyCount={props.dirtyCount} onSaveAll={onSaveAll} />,
    );
    const textarea = (await view.findByLabelText('Commit message')) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'Add order total' } });
    const commitBtn = view.getByRole('button', { name: 'Commit' }) as HTMLButtonElement;
    expect(commitBtn.disabled).toBe(false);
    fireEvent.click(commitBtn);
    return { git, onSaveAll, order };
  }

  test('unsaved buffers → confirm + await onSaveAll BEFORE gitCommit', async () => {
    vi.mocked(koiConfirm).mockResolvedValue(true);
    const { git, onSaveAll, order } = await commitWith({ dirtyCount: 2, onSaveAll: async () => {} });

    await waitFor(() => expect(git.gitCommit).toHaveBeenCalledWith(TOKEN, 'Add order total'));
    expect(koiConfirm).toHaveBeenCalledTimes(1);
    expect(onSaveAll).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['saveAll', 'commit']); // saved first, then committed
  });

  test('no unsaved buffers (dirtyCount 0) → straight to gitCommit, no prompt', async () => {
    const { git, onSaveAll } = await commitWith({ dirtyCount: 0, onSaveAll: async () => {} });

    await waitFor(() => expect(git.gitCommit).toHaveBeenCalledWith(TOKEN, 'Add order total'));
    expect(koiConfirm).not.toHaveBeenCalled();
    expect(onSaveAll).not.toHaveBeenCalled();
  });

  test('props omitted → behaves exactly as before (gitCommit directly, no prompt)', async () => {
    const { git } = await commitWith({});

    await waitFor(() => expect(git.gitCommit).toHaveBeenCalledWith(TOKEN, 'Add order total'));
    expect(koiConfirm).not.toHaveBeenCalled();
  });

  test('a failed onSaveAll aborts the commit (does NOT call gitCommit)', async () => {
    vi.mocked(koiConfirm).mockResolvedValue(true);
    const { git, onSaveAll } = await commitWith({
      dirtyCount: 1,
      onSaveAll: async () => {
        throw new Error('disk full');
      },
    });

    await waitFor(() => expect(onSaveAll).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20)); // let any (erroneous) commit microtask flush
    expect(git.gitCommit).not.toHaveBeenCalled();
  });

  test('declining the prompt aborts the commit (no save, no gitCommit)', async () => {
    vi.mocked(koiConfirm).mockResolvedValue(false);
    const { git, onSaveAll } = await commitWith({ dirtyCount: 1, onSaveAll: async () => {} });

    await waitFor(() => expect(koiConfirm).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(onSaveAll).not.toHaveBeenCalled();
    expect(git.gitCommit).not.toHaveBeenCalled();
  });
});
