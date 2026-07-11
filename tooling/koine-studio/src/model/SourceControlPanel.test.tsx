import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/preact';
import { SourceControlPanel, type GitSurface } from '@/model/SourceControlPanel';
import type { GitFile, GitLogEntry, GitNumstatEntry, GitStatus, GitUpstream } from '@/host/types';
import { koiConfirm } from '@atypical/koine-ui';
import { axe } from 'vitest-axe';

// The save-all-before-commit prompt (#470) uses the shared Koine confirm dialog. Mock it so the
// commit path resolves deterministically (true/false) without opening a real modal overlay. A PARTIAL
// mock: `createFloatingMenu` (which the ⋮ / caret menus bridge, #1153) stays REAL so the menus exercise
// the actual engine — role="menu"/menuitem, disabled skipping, document.body mounting — under happy-dom,
// exactly as toolbarOverflow.test.ts / domainNavigator.test.ts do.
vi.mock('@atypical/koine-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@atypical/koine-ui')>();
  return { ...actual, koiConfirm: vi.fn() };
});

const TOKEN = 'file:///work';

// A small in-memory git fake: gitStage/gitUnstage flip a path's `staged` flag in the backing model and
// gitCommit clears it, so each mutation genuinely moves the file between groups on the next gitStatus
// re-fetch — exactly as the real desktop host would. gitStatus returns a fresh snapshot every call, and
// every method is a vi.fn so a test can assert the exact call. `satisfies GitSurface` keeps the concrete
// Mock types so `.mock`/`toHaveBeenCalledWith` stay available on the returned object. `upstream` seeds
// the snapshot's upstream-tracking data (#1150) — defaulted to an in-sync origin/main so most tests see
// the counts + push affordance; pass null for a branch with no upstream.
function makeGit(initial: GitFile[], upstream: GitUpstream | null = { ref: 'origin/main', ahead: 0, behind: 0 }) {
  let files: GitFile[] = initial.map((f) => ({ ...f }));
  const snapshot = (): GitStatus => ({ branch: 'main', files: files.map((f) => ({ ...f })), upstream });
  return {
    canUseGit: true,
    gitStatus: vi.fn(async () => snapshot()),
    gitDiff: vi.fn(async () => 'diff --git a/x b/x\n+added line'),
    // No eager counts by default — rows fall back to the neutral `·`; a test overrides this per case.
    gitNumstat: vi.fn(async () => [] as GitNumstatEntry[]),
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
    // A confirmed discard removes each named path's change from the backing model — a reverted tracked
    // file and a deleted untracked one both vanish from the next gitStatus snapshot, as on the real
    // host. The caller supplies the tracked/untracked split explicitly (the new gitDiscard contract).
    gitDiscard: vi.fn(async (_token: string, trackedPaths: string[], untrackedPaths: string[]) => {
      const gone = new Set([...trackedPaths, ...untrackedPaths]);
      files = files.filter((f) => !gone.has(f.relPath));
    }),
    gitPush: vi.fn(async () => {}),
    gitBranches: vi.fn(async () => ['main', 'feature']),
    gitCheckout: vi.fn(async () => {}),
    gitLog: vi.fn(
      async (): Promise<GitLogEntry[]> => [
        { sha: 'abcdef1234567', author: 'Ada', date: '2026-06-01T10:00:00Z', message: 'Seed the model' },
      ],
    ),
    gitInit: vi.fn(async () => {}),
  } satisfies GitSurface;
}

// The section element of one file group, addressed by its aria-label (the panel groups files into named
// landmarks). Returns null when the group has no files — the panel omits an empty group entirely.
const group = (c: Element, label: string) => c.querySelector<HTMLElement>(`[aria-label="${label}"]`);

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

  test('a file row shows its status glyph + change-stat, and hover row actions (Open changes / Stage / Unstage)', async () => {
    const git = makeGit([
      { relPath: 'a.koi', staged: true, status: 'modified' },
      { relPath: 'b.koi', staged: false, status: 'modified' },
    ]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    // The unstaged b.koi row carries a status glyph and a (best-effort) change-stat element.
    const changes = await waitFor(() => {
      const el = group(view.container, 'Changes');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(changes.querySelector('.koi-sc-glyph')).not.toBeNull();
    expect(changes.querySelector('.koi-sc-stat')).not.toBeNull();

    // The hover/focus row actions are reachable by accessible name: Open changes + Stage on the
    // unstaged row, Unstage on the staged row.
    expect(view.getByRole('button', { name: 'Open changes b.koi' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Stage b.koi' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Unstage a.koi' })).toBeTruthy();

    // Splitting the filename into name/dir must NOT change the file-open button's accessible name.
    expect(view.getByRole('button', { name: 'b.koi modified' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'a.koi modified' })).toBeTruthy();
  });

  test('shows eager +n/−n numstat counts on a row WITHOUT opening its diff, and falls back to · when absent or binary', async () => {
    const git = makeGit([
      { relPath: 'b.koi', staged: false, status: 'modified' }, // has real counts
      { relPath: 'c.koi', staged: false, status: 'modified' }, // no numstat entry → ·
      { relPath: 'logo.png', staged: false, status: 'modified' }, // binary (null counts) → ·
    ]);
    // One bounded numstat fetch feeds every row its (path, area) counts; binary carries null.
    git.gitNumstat.mockResolvedValue([
      { relPath: 'b.koi', staged: false, added: 5, removed: 2 },
      { relPath: 'logo.png', staged: false, added: null, removed: null },
    ]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    const statOf = async (relPath: string) =>
      (
        await waitFor(() => {
          const el = view.container.querySelector<HTMLElement>(`[data-relpath="${relPath}"] .koi-sc-stat`);
          expect(el).not.toBeNull();
          return el!;
        })
      );

    // b.koi shows its real churn at rest — the numbers come from numstat, so its diff is never opened.
    await waitFor(() => {
      const stat = view.container.querySelector<HTMLElement>('[data-relpath="b.koi"] .koi-sc-stat');
      expect(stat?.querySelector('.add')?.textContent).toBe('+5');
      expect(stat?.querySelector('.del')?.textContent).toContain('2');
      expect(stat?.querySelector('.none')).toBeNull();
    });
    expect(git.gitNumstat).toHaveBeenCalledWith(TOKEN);
    expect(git.gitDiff).not.toHaveBeenCalled();

    // c.koi has no numstat entry → the neutral placeholder, not a fake +0.
    const cStat = await statOf('c.koi');
    expect(cStat.querySelector('.none')?.textContent).toBe('·');
    expect(cStat.querySelector('.add')).toBeNull();

    // logo.png is binary (null counts) → also the neutral placeholder, never a bogus number.
    const pngStat = await statOf('logo.png');
    expect(pngStat.querySelector('.none')?.textContent).toBe('·');
    expect(pngStat.querySelector('.add')).toBeNull();

    // Opening the binary row's diff must NOT resurrect a fake +0/−0 from the diff body — it stays ·.
    fireEvent.click(view.getByRole('button', { name: 'logo.png modified' }));
    await view.findByLabelText('Diff for logo.png');
    const pngAfterOpen = view.container.querySelector<HTMLElement>('[data-relpath="logo.png"] .koi-sc-stat');
    expect(pngAfterOpen?.querySelector('.none')?.textContent).toBe('·');
    expect(pngAfterOpen?.querySelector('.add')).toBeNull();
  });

  test('renders the branch switcher, the ahead/behind sync readout, and the Refresh control', async () => {
    const git = makeGit([{ relPath: 'a.koi', staged: true, status: 'modified' }]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    // The branch switcher still resolves by its displayed value (the current branch).
    await view.findByDisplayValue('main');

    // The branch/sync bar renders a best-effort ahead/behind readout referencing the upstream ref.
    const sync = await waitFor(() => {
      const el = view.container.querySelector('.koi-sc-sync');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(sync.textContent).toContain('↑0');
    expect(sync.textContent).toContain('↓0');
    expect(sync.getAttribute('title')).toMatch(/origin\/main/);

    // The Refresh action is still present as an accessible button.
    expect(view.getByRole('button', { name: /Refresh/i })).toBeTruthy();
  });

  test('renders the REAL upstream ahead/behind counts and an accessible push action (#1150)', async () => {
    const git = makeGit(
      [{ relPath: 'a.koi', staged: true, status: 'modified' }],
      { ref: 'origin/main', ahead: 2, behind: 1 },
    );
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);
    await view.findByDisplayValue('main');

    // The readout shows the snapshot's real counts, not a hard-coded 0/0…
    const sync = view.container.querySelector('.koi-sc-sync')!;
    expect(sync.textContent).toContain('↑2');
    expect(sync.textContent).toContain('↓1');
    // …and the sr-only sentence names the upstream ref with the same numbers.
    expect(sync.textContent).toContain('2 commits ahead of, 1 behind origin/main');

    // The push affordance is a real button, named for its target ref.
    const push = view.getByRole('button', { name: 'Push to origin/main' }) as HTMLButtonElement;
    expect(push.disabled).toBe(false);
  });

  test('clicking Push runs gitPush through mutate and re-fetches status (#1150)', async () => {
    const git = makeGit(
      [{ relPath: 'a.koi', staged: true, status: 'modified' }],
      { ref: 'origin/main', ahead: 2, behind: 0 },
    );
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    const push = await view.findByRole('button', { name: 'Push to origin/main' });
    const statusCallsBefore = git.gitStatus.mock.calls.length;
    fireEvent.click(push);

    await waitFor(() => expect(git.gitPush).toHaveBeenCalledWith(TOKEN));
    // The mutate() follow-up reload re-reads status, so the counts track the pushed repository.
    await waitFor(() => expect(git.gitStatus.mock.calls.length).toBeGreaterThan(statusCallsBefore));
  });

  test('a rejected push surfaces as the action-error alert, not a crash (#1150)', async () => {
    const git = makeGit([{ relPath: 'a.koi', staged: true, status: 'modified' }]);
    git.gitPush.mockRejectedValue(new Error('non-fast-forward'));
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    fireEvent.click(await view.findByRole('button', { name: 'Push to origin/main' }));

    const alert = await view.findByRole('alert');
    expect(alert.textContent).toContain('non-fast-forward');
  });

  test('no upstream: no counts, no push button — a hint instead of a fake 0/0 (#1150)', async () => {
    const git = makeGit([{ relPath: 'a.koi', staged: true, status: 'modified' }], null);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);
    await view.findByDisplayValue('main');

    // The readout slot shows a plain no-upstream hint — never fake ↑0/↓0 counts…
    const sync = view.container.querySelector('.koi-sc-sync')!;
    expect(sync.textContent).toMatch(/no upstream/i);
    expect(sync.textContent).not.toContain('↑');
    expect(sync.textContent).not.toContain('↓');
    // …and no push button (a dead control would still be announced to AT users).
    expect(view.queryByRole('button', { name: /^Push to / })).toBeNull();

    // The branch bar stays accessibility-clean in the no-upstream state too.
    expect(await axe(view.container.querySelector('.koi-sc-branchbar')!)).toHaveNoViolations();
  });

  test('a file focus opens the targeted file\'s diff, not just the panel (#1165)', async () => {
    const git = makeGit([
      { relPath: 'a.koi', staged: false, status: 'modified' },
      { relPath: 'b.koi', staged: false, status: 'modified' },
    ]);
    const view = render(
      <SourceControlPanel git={git} folderToken={TOKEN} focus={{ file: 'b.koi' }} focusNonce={1} />,
    );

    // The launcher's "Open changes" opens the targeted file's inline diff (fetches it + expands the row)…
    await waitFor(() => expect(git.gitDiff).toHaveBeenCalledWith(TOKEN, 'b.koi', false));
    const open = view.container.querySelector('[data-relpath="b.koi"] .koi-sc-file-open');
    expect(open?.getAttribute('aria-expanded')).toBe('true');
    // …and only that file's diff — the other row stays collapsed.
    const otherOpen = view.container.querySelector('[data-relpath="a.koi"] .koi-sc-file-open');
    expect(otherOpen?.getAttribute('aria-expanded')).toBe('false');
  });

  test('a commit focus marks the targeted commit row (#1165)', async () => {
    const git = makeGit([]);
    const view = render(
      <SourceControlPanel git={git} folderToken={TOKEN} focus={{ commit: 'abcdef1234567' }} focusNonce={1} />,
    );

    // The launcher's "View commit" marks the specific commit so the panel highlights + scrolls to it.
    // The mark is applied by an effect once the log resolves, so wait for the attribute (not just the row).
    await waitFor(() =>
      expect(
        view.container.querySelector('[data-sha="abcdef1234567"]')?.getAttribute('data-focused'),
      ).toBe('true'),
    );
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

  test('a group header toggle collapses and expands its file list', async () => {
    const git = makeGit([{ relPath: 'b.koi', staged: false, status: 'modified' }]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    await waitFor(() => expect(group(view.container, 'Changes')).not.toBeNull());
    // The group header's toggle is the button whose accessible name is the label + count (not a row action).
    const toggle = () => within(group(view.container, 'Changes')!).getByRole('button', { name: /Changes/ });

    // Groups default to expanded.
    expect(group(view.container, 'Changes')!.classList.contains('collapsed')).toBe(false);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');

    // Clicking the toggle collapses the group (the file list hides via the `collapsed` class).
    fireEvent.click(toggle());
    expect(group(view.container, 'Changes')!.classList.contains('collapsed')).toBe(true);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');

    // Clicking again expands it back.
    fireEvent.click(toggle());
    expect(group(view.container, 'Changes')!.classList.contains('collapsed')).toBe(false);
  });

  test('a group header "Stage all" stages every file in that group', async () => {
    const git = makeGit([
      { relPath: 'b.koi', staged: false, status: 'modified' },
      { relPath: 'c.koi', staged: false, status: 'modified' },
    ]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    // The group action is named exactly "Stage all" so it never collides with the per-row "Stage b.koi".
    const stageAll = await view.findByRole('button', { name: 'Stage all' });
    fireEvent.click(stageAll);

    await waitFor(() => expect(git.gitStage).toHaveBeenCalledWith(TOKEN, ['b.koi', 'c.koi']));
  });

  test('a staged group "Unstage all" unstages every staged file', async () => {
    const git = makeGit([
      { relPath: 'a.koi', staged: true, status: 'modified' },
      { relPath: 'd.koi', staged: true, status: 'modified' },
    ]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    const unstageAll = await view.findByRole('button', { name: 'Unstage all' });
    fireEvent.click(unstageAll);

    await waitFor(() => expect(git.gitUnstage).toHaveBeenCalledWith(TOKEN, ['a.koi', 'd.koi']));
  });

  test('typing a message and clicking Commit calls gitCommit with the message', async () => {
    const git = makeGit([{ relPath: 'a.koi', staged: true, status: 'modified' }]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    const textarea = (await view.findByLabelText('Commit message')) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'Add order total' } });

    const commitBtn = view.getByRole('button', { name: /Commit \d+ file/ }) as HTMLButtonElement;
    expect(commitBtn.disabled).toBe(false);
    fireEvent.click(commitBtn);

    await waitFor(() => expect(git.gitCommit).toHaveBeenCalledWith(TOKEN, 'Add order total'));
  });

  test('the split Commit button is disabled until staged + message, and ⌘⏎ commits from the textarea', async () => {
    const git = makeGit([{ relPath: 'a.koi', staged: true, status: 'modified' }]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    const textarea = (await view.findByLabelText('Commit message')) as HTMLTextAreaElement;
    const commitBtn = () => view.getByRole('button', { name: /Commit \d+ file/ }) as HTMLButtonElement;

    // A staged file but an empty message → the split Commit button is disabled.
    expect(commitBtn().disabled).toBe(true);

    // ⌘⏎ with an empty message is a no-op (it only fires when the button would be enabled).
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    expect(git.gitCommit).not.toHaveBeenCalled();

    // Typing a non-empty message enables the button.
    fireEvent.input(textarea, { target: { value: 'Add order total' } });
    expect(commitBtn().disabled).toBe(false);

    // ⌘⏎ inside the textarea now commits (the keyboard shortcut the keycap advertises).
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(git.gitCommit).toHaveBeenCalledWith(TOKEN, 'Add order total'));
  });

  test('Ctrl+⏎ in the message textarea also commits (non-mac shortcut)', async () => {
    const git = makeGit([{ relPath: 'a.koi', staged: true, status: 'modified' }]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    const textarea = (await view.findByLabelText('Commit message')) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'Add order total' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

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
      gitInit: vi.fn(),
    } as unknown as GitSurface;

    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    expect(view.getByText(/desktop app/i)).toBeTruthy();
    // Let any (erroneous) effect microtask flush before asserting nothing was called.
    await Promise.resolve();
    expect(gitStatus).not.toHaveBeenCalled();
    expect(gitLog).not.toHaveBeenCalled();
  });

  test('initializes a repo from the not-a-repo state and leaves the empty state', async () => {
    let statusCalls = 0;
    const gitInit = vi.fn(async () => {});
    const git = {
      canUseGit: true,
      gitInit,
      // First call (the initial fetch) rejects — not a repo yet; the second (post-init reload)
      // resolves a clean status, mirroring what a real `git init` on the folder produces.
      gitStatus: vi.fn(async () => {
        statusCalls += 1;
        if (statusCalls === 1) throw new Error('not a git repository');
        return { branch: 'main', files: [] } satisfies GitStatus;
      }),
      gitDiff: vi.fn(),
      gitNumstat: vi.fn(async () => [] as GitNumstatEntry[]),
      gitStage: vi.fn(),
      gitUnstage: vi.fn(),
      gitDiscard: vi.fn(),
      gitCommit: vi.fn(),
      gitPush: vi.fn(),
      gitBranches: vi.fn(async () => ['main']),
      gitCheckout: vi.fn(),
      gitLog: vi.fn(async () => [] as GitLogEntry[]),
    } satisfies GitSurface;

    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    const initBtn = await view.findByRole('button', { name: /Initialize Repository/i });
    fireEvent.click(initBtn);

    await waitFor(() => expect(gitInit).toHaveBeenCalledWith(TOKEN));
    // The reload's gitStatus now resolves, so the panel leaves the not-a-repo empty state.
    await waitFor(() => expect(view.queryByRole('button', { name: /Initialize Repository/i })).toBeNull());
  });

  test('the recent-commits log renders each commit as an avatar + short SHA + message, plus a View all action', async () => {
    const git = makeGit([{ relPath: 'a.koi', staged: true, status: 'modified' }]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    // The Recent commits landmark keeps its accessible name (region query / axe rely on it).
    const recent = await view.findByRole('region', { name: 'Recent commits' });

    // Each log row leads with a mono avatar of the author's initials — "Ada" → "AD" (single-word name
    // → first two letters uppercased, matching the `initials` helper).
    const avatar = recent.querySelector('.koi-sc-avatar');
    expect(avatar).not.toBeNull();
    expect(avatar!.textContent).toBe('AD');

    // …beside the short 7-char SHA and the commit message.
    expect(recent.textContent).toContain('abcdef1'); // sha 'abcdef1234567'.slice(0,7)
    expect(recent.textContent).toContain('Seed the model');

    // The section header exposes a "View all" placeholder action for the (future) full-history surface.
    expect(view.getByRole('button', { name: /View all/i })).toBeTruthy();
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

describe('SourceControlPanel — Discard controls (#1151)', () => {
  beforeEach(() => {
    vi.mocked(koiConfirm).mockReset();
  });

  test('a confirmed row Discard calls gitDiscard with that path and re-fetches status', async () => {
    vi.mocked(koiConfirm).mockResolvedValue(true);
    const git = makeGit([{ relPath: 'b.koi', staged: false, status: 'modified' }]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    const discard = (await view.findByRole('button', { name: 'Discard b.koi changes' })) as HTMLButtonElement;
    expect(discard.disabled).toBe(false);
    const statusCallsBefore = git.gitStatus.mock.calls.length;
    fireEvent.click(discard);

    // A tracked (modified) row lands in the tracked bucket; the untracked bucket stays empty.
    await waitFor(() => expect(git.gitDiscard).toHaveBeenCalledWith(TOKEN, ['b.koi'], []));
    expect(koiConfirm).toHaveBeenCalledTimes(1);
    // The mutate() follow-up reload re-reads status, so the reverted file leaves its group.
    await waitFor(() => expect(git.gitStatus.mock.calls.length).toBeGreaterThan(statusCallsBefore));
    await waitFor(() => expect(group(view.container, 'Changes')).toBeNull());
  });

  test('declining the confirm aborts the discard — NO gitDiscard call, the change survives', async () => {
    vi.mocked(koiConfirm).mockResolvedValue(false);
    const git = makeGit([{ relPath: 'b.koi', staged: false, status: 'modified' }]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    fireEvent.click(await view.findByRole('button', { name: 'Discard b.koi changes' }));

    await waitFor(() => expect(koiConfirm).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20)); // let any (erroneous) discard microtask flush
    expect(git.gitDiscard).not.toHaveBeenCalled();
    expect(group(view.container, 'Changes')!.textContent).toContain('b.koi');
  });

  test('a confirmed group Discard-all passes every path of that group', async () => {
    vi.mocked(koiConfirm).mockResolvedValue(true);
    const git = makeGit([
      { relPath: 'b.koi', staged: false, status: 'modified' },
      { relPath: 'c.koi', staged: false, status: 'modified' },
      { relPath: 'a.koi', staged: true, status: 'modified' }, // staged — NOT part of the Changes group
    ]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    await waitFor(() => expect(group(view.container, 'Changes')).not.toBeNull());
    fireEvent.click(within(group(view.container, 'Changes')!).getByRole('button', { name: /Discard all changes/i }));

    // The Changes group holds only tracked files, so the whole list rides the tracked bucket.
    await waitFor(() => expect(git.gitDiscard).toHaveBeenCalledWith(TOKEN, ['b.koi', 'c.koi'], []));
    // The staged copy is untouched — group discard only covers the group's own paths.
    await waitFor(() => expect(group(view.container, 'Staged Changes')!.textContent).toContain('a.koi'));
  });

  test('discarding an UNTRACKED row asks with delete wording and removes the file on confirm', async () => {
    vi.mocked(koiConfirm).mockResolvedValue(true);
    const git = makeGit([{ relPath: 'c.koi', staged: false, status: 'untracked' }]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    fireEvent.click(await view.findByRole('button', { name: 'Discard c.koi changes' }));

    // An untracked row lands in the untracked bucket (→ `git clean`); the tracked bucket stays empty.
    await waitFor(() => expect(git.gitDiscard).toHaveBeenCalledWith(TOKEN, [], ['c.koi']));
    // An untracked file has no index/HEAD state to revert to — discard means DELETE, and the confirm
    // copy must say so instead of the tracked-file "revert your edits" phrasing.
    const req = vi.mocked(koiConfirm).mock.calls[0][0];
    expect(req.message).toContain('c.koi');
    expect(req.message).toMatch(/permanently removed/i);
    expect(req.message).not.toMatch(/revert/i);
    expect(req.confirmLabel).toMatch(/delete/i);
    // The confirmed delete removes the file on the next gitStatus → the Untracked group empties away.
    await waitFor(() => expect(group(view.container, 'Untracked')).toBeNull());
  });

  test('the Untracked group Discard-all asks with group-level delete wording', async () => {
    vi.mocked(koiConfirm).mockResolvedValue(true);
    const git = makeGit([
      { relPath: 'c.koi', staged: false, status: 'untracked' },
      { relPath: 'd.koi', staged: false, status: 'untracked' },
    ]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    await waitFor(() => expect(group(view.container, 'Untracked')).not.toBeNull());
    fireEvent.click(
      within(group(view.container, 'Untracked')!).getByRole('button', { name: /Discard all changes/i }),
    );

    // The Untracked group's whole list rides the untracked bucket; the tracked bucket stays empty.
    await waitFor(() => expect(git.gitDiscard).toHaveBeenCalledWith(TOKEN, [], ['c.koi', 'd.koi']));
    const req = vi.mocked(koiConfirm).mock.calls[0][0];
    expect(req.message).toMatch(/2 untracked files/i);
    expect(req.message).toMatch(/permanently/i);
  });

  test('a failed gitDiscard surfaces the action-error alert and leaves the group intact', async () => {
    vi.mocked(koiConfirm).mockResolvedValue(true);
    const git = makeGit([{ relPath: 'b.koi', staged: false, status: 'modified' }]);
    git.gitDiscard.mockRejectedValue(new Error('restore failed'));
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    fireEvent.click(await view.findByRole('button', { name: 'Discard b.koi changes' }));

    // The rejection lands in the same role="alert" every other mutation uses…
    const alert = await view.findByRole('alert');
    expect(alert.textContent).toContain('restore failed');
    // …and the untouched file stays listed (no reload wiped the group on failure).
    expect(group(view.container, 'Changes')!.textContent).toContain('b.koi');
  });

  test('rows in the Staged Changes group expose NO Discard button (mirrors the group header)', async () => {
    const git = makeGit([
      { relPath: 'a.koi', staged: true, status: 'modified' },
      { relPath: 'b.koi', staged: false, status: 'modified' },
    ]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);
    await waitFor(() => expect(group(view.container, 'Staged Changes')).not.toBeNull());

    // The staged group's header already withholds Discard-all; its rows must withhold the per-row
    // Discard too — a staged row's "discard" would silently revert only the worktree delta, not the
    // staged change the row shows (a data-loss trap).
    expect(
      within(group(view.container, 'Staged Changes')!).queryByRole('button', { name: /^Discard / }),
    ).toBeNull();
    // The non-staged row keeps its live Discard control.
    expect(
      within(group(view.container, 'Changes')!).getByRole('button', { name: 'Discard b.koi changes' }),
    ).toBeTruthy();
  });

  test('the enabled Discard controls stay axe-clean and expose live (non-"coming soon") names (#1151)', async () => {
    const git = makeGit([
      { relPath: 'a.koi', staged: true, status: 'modified' }, // staged — contributes NO Discard control
      { relPath: 'b.koi', staged: false, status: 'modified' },
      { relPath: 'c.koi', staged: false, status: 'untracked' },
    ]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);
    await waitFor(() => expect(group(view.container, 'Changes')).not.toBeNull());

    // Both non-staged per-row Discards and both group Discard-alls (Changes + Untracked) are live,
    // enabled buttons — and exactly those four: the staged group (header AND row) offers none.
    const discards = view.getAllByRole('button', { name: /^Discard / }) as HTMLButtonElement[];
    expect(discards.length).toBe(4);
    expect(discards.map((b) => b.getAttribute('aria-label'))).not.toContain('Discard a.koi changes');
    for (const b of discards) {
      expect(b.disabled).toBe(false);
      expect(b.getAttribute('aria-label')).not.toMatch(/coming soon/i);
    }

    expect(await axe(view.container)).toHaveNoViolations();
  });
});

describe('SourceControlPanel — overflow ⋮ actions menu (#1153)', () => {
  beforeEach(() => {
    vi.mocked(koiConfirm).mockReset();
  });

  // Open the ⋮ menu (a REAL createFloatingMenu, mounted on document.body) and return its role="menu".
  async function openOverflow(view: ReturnType<typeof render>) {
    const trigger = await view.findByRole('button', { name: 'Views and more actions' });
    fireEvent.click(trigger);
    return waitFor(() => {
      const menu = document.querySelector<HTMLElement>('[role="menu"]');
      expect(menu).not.toBeNull();
      return menu!;
    });
  }

  test('the ⋮ trigger is a live, ARIA-correct menu button (enabled, aria-haspopup="menu")', async () => {
    const git = makeGit([{ relPath: 'a.koi', staged: true, status: 'modified' }]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);
    const trigger = (await view.findByRole('button', { name: 'Views and more actions' })) as HTMLButtonElement;
    // No longer a "coming soon" disabled placeholder — a real, openable menu trigger.
    expect(trigger.disabled).toBe(false);
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-label')).not.toMatch(/coming soon/i);
  });

  test('clicking ⋮ opens a role="menu" of already-backed live actions plus the deferred disabled ones', async () => {
    // Seed > 10 commits so "View all commits" has something to reveal (it disables when the log fits in 10).
    const git = {
      ...makeGit([
        { relPath: 'a.koi', staged: true, status: 'modified' },
        { relPath: 'b.koi', staged: false, status: 'modified' },
        { relPath: 'c.koi', staged: false, status: 'untracked' },
      ]),
      gitLog: vi.fn(
        async (): Promise<GitLogEntry[]> =>
          Array.from({ length: 12 }, (_, i) => ({
            sha: `commit${i}abcdef`,
            author: 'Ada',
            date: '2026-06-01T10:00:00Z',
            message: `c${i}`,
          })),
      ),
    } satisfies GitSurface;
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);
    await view.findByDisplayValue('main');
    const menu = await openOverflow(view);
    const item = (name: string | RegExp) => within(menu).getByRole('menuitem', { name }) as HTMLButtonElement;

    // Live items — already backed by the panel's existing handlers/data.
    expect(item('Refresh').disabled).toBe(false);
    expect(item('Stage all changes').disabled).toBe(false);
    expect(item('Unstage all changes').disabled).toBe(false);
    expect(item('Collapse all groups').disabled).toBe(false);
    expect(item('View all commits').disabled).toBe(false);
    // Discard-all and Push (#1401) are now wired to the same gitDiscard/gitPush ops the panel's other
    // controls already use — live with a non-staged discard candidate + a tracked upstream present.
    expect(item('Discard all changes').disabled).toBe(false);
    expect(item('Push').disabled).toBe(false);

    // Deferred items — no backing Platform git op yet (sibling follow-ups): rendered disabled, never inert-live.
    expect(item('Pull').disabled).toBe(true);
    expect(item('Fetch').disabled).toBe(true);
  });

  test('the ⋮ menu "Discard all changes" confirms then calls gitDiscard with the full tracked/untracked split', async () => {
    vi.mocked(koiConfirm).mockResolvedValue(true);
    const git = makeGit([
      { relPath: 'a.koi', staged: true, status: 'modified' }, // staged — Discard all never touches it
      { relPath: 'b.koi', staged: false, status: 'modified' }, // tracked, unstaged
      { relPath: 'c.koi', staged: false, status: 'untracked' },
    ]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);
    await view.findByDisplayValue('main');
    const menu = await openOverflow(view);

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Discard all changes' }));

    // Destructive, so it asks first — through the same danger confirm every other Discard control uses.
    await waitFor(() => expect(koiConfirm).toHaveBeenCalledTimes(1));
    const req = vi.mocked(koiConfirm).mock.calls[0][0];
    expect(req.danger).toBe(true);

    // The tracked/untracked split lands exactly like the per-row/group Discard controls: b.koi (tracked)
    // in the first bucket, c.koi (untracked) in the second.
    await waitFor(() => expect(git.gitDiscard).toHaveBeenCalledWith(TOKEN, ['b.koi'], ['c.koi']));
    // The staged file is untouched — Discard all never reaches into the Staged Changes group.
    await waitFor(() => expect(group(view.container, 'Staged Changes')?.textContent).toContain('a.koi'));
  });

  test('declining the "Discard all changes" confirm makes NO gitDiscard call', async () => {
    vi.mocked(koiConfirm).mockResolvedValue(false);
    const git = makeGit([
      { relPath: 'b.koi', staged: false, status: 'modified' },
      { relPath: 'c.koi', staged: false, status: 'untracked' },
    ]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);
    await view.findByDisplayValue('main');
    const menu = await openOverflow(view);

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Discard all changes' }));

    await waitFor(() => expect(koiConfirm).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20)); // let any (erroneous) discard microtask flush
    expect(git.gitDiscard).not.toHaveBeenCalled();
  });

  test('the ⋮ menu "Discard all changes" is disabled when there is nothing to discard', async () => {
    // Only a staged file — Discard all never covers staged rows, so there is no discardable candidate.
    const git = makeGit([{ relPath: 'a.koi', staged: true, status: 'modified' }]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);
    await view.findByDisplayValue('main');
    const menu = await openOverflow(view);

    expect(
      (within(menu).getByRole('menuitem', { name: 'Discard all changes' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test('the ⋮ menu "Push" calls gitPush and re-fetches status', async () => {
    const git = makeGit(
      [{ relPath: 'a.koi', staged: true, status: 'modified' }],
      { ref: 'origin/main', ahead: 2, behind: 0 },
    );
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);
    await view.findByDisplayValue('main');
    const menu = await openOverflow(view);
    const statusCallsBefore = git.gitStatus.mock.calls.length;

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Push' }));

    await waitFor(() => expect(git.gitPush).toHaveBeenCalledWith(TOKEN));
    // The mutate() follow-up reload re-reads status, so the ahead count tracks the pushed repository.
    await waitFor(() => expect(git.gitStatus.mock.calls.length).toBeGreaterThan(statusCallsBefore));
  });

  test('the ⋮ menu "Push" is disabled when the branch has no upstream', async () => {
    const git = makeGit([{ relPath: 'b.koi', staged: false, status: 'modified' }], null);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);
    await view.findByDisplayValue('main');
    const menu = await openOverflow(view);

    expect((within(menu).getByRole('menuitem', { name: 'Push' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('the ⋮ menu "Discard all changes" and "Push" are both disabled while busy', async () => {
    const git = makeGit(
      [
        { relPath: 'b.koi', staged: false, status: 'modified' },
        { relPath: 'c.koi', staged: false, status: 'untracked' },
      ],
      { ref: 'origin/main', ahead: 1, behind: 0 },
    );
    // Never resolves — latches `busy` true across the rest of the test, mirroring an in-flight mutation.
    git.gitStage.mockImplementation(() => new Promise<void>(() => {}));
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);
    await view.findByDisplayValue('main');

    fireEvent.click(await view.findByRole('button', { name: 'Stage b.koi' }));
    const menu = await openOverflow(view);

    expect(
      (within(menu).getByRole('menuitem', { name: 'Discard all changes' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((within(menu).getByRole('menuitem', { name: 'Push' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('the ⋮ menu "Stage all changes" stages every unstaged + untracked path', async () => {
    const git = makeGit([
      { relPath: 'a.koi', staged: true, status: 'modified' }, // already staged — excluded from "stage all"
      { relPath: 'b.koi', staged: false, status: 'modified' },
      { relPath: 'c.koi', staged: false, status: 'untracked' },
    ]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);
    await view.findByDisplayValue('main');
    const menu = await openOverflow(view);

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Stage all changes' }));
    await waitFor(() => expect(git.gitStage).toHaveBeenCalledWith(TOKEN, ['b.koi', 'c.koi']));
  });
});

describe('SourceControlPanel — split-commit caret menu (#1153)', () => {
  // Open the caret menu (a REAL createFloatingMenu on document.body) and return its role="menu".
  async function openCaret(view: ReturnType<typeof render>) {
    const trigger = await view.findByRole('button', { name: 'Commit options' });
    fireEvent.click(trigger);
    return waitFor(() => {
      const menu = document.querySelector<HTMLElement>('[role="menu"]');
      expect(menu).not.toBeNull();
      return menu!;
    });
  }

  test('the split-commit caret is a live, ARIA-correct menu trigger (enabled, aria-haspopup="menu")', async () => {
    const git = makeGit([{ relPath: 'a.koi', staged: true, status: 'modified' }]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);
    const trigger = (await view.findByRole('button', { name: 'Commit options' })) as HTMLButtonElement;
    // No longer a "coming soon" disabled placeholder — an openable menu trigger.
    expect(trigger.disabled).toBe(false);
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-label')).not.toMatch(/coming soon/i);
  });

  test('opening the caret shows Amend last commit + Commit & Push, both disabled (deferred ops)', async () => {
    const git = makeGit([{ relPath: 'a.koi', staged: true, status: 'modified' }]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);
    await view.findByDisplayValue('main');
    const menu = await openCaret(view);
    const amend = within(menu).getByRole('menuitem', { name: 'Amend last commit' }) as HTMLButtonElement;
    const commitPush = within(menu).getByRole('menuitem', { name: 'Commit & Push' }) as HTMLButtonElement;
    expect(amend.disabled).toBe(true);
    expect(commitPush.disabled).toBe(true);
  });

  test('the caret items are inert placeholders — activating them fires no git.* op', async () => {
    const git = makeGit([{ relPath: 'a.koi', staged: true, status: 'modified' }]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);
    await view.findByDisplayValue('main');
    const menu = await openCaret(view);

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Amend last commit' }));
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Commit & Push' }));
    await new Promise((r) => setTimeout(r, 20)); // let any (erroneous) op microtask flush
    expect(git.gitCommit).not.toHaveBeenCalled();
    expect(git.gitStage).not.toHaveBeenCalled();
    expect(git.gitUnstage).not.toHaveBeenCalled();
  });
});

describe('SourceControlPanel — full commit history (#1153)', () => {
  // N synthetic commits, newest-first, with unique 7-char SHA prefixes ("sha0000" … "sha00NN") so a test
  // can assert on an exact row that is (or isn't) rendered without substring collisions.
  function manyCommits(n: number): GitLogEntry[] {
    return Array.from({ length: n }, (_, i) => ({
      sha: `sha${String(i).padStart(4, '0')}deadbeef`,
      author: i % 2 === 0 ? 'Ada' : 'Grace Hopper',
      date: '2026-06-01T10:00:00Z',
      message: `Commit ${i}`,
    }));
  }

  function gitWithLog(log: GitLogEntry[]): GitSurface {
    return {
      ...makeGit([{ relPath: 'a.koi', staged: true, status: 'modified' }]),
      gitLog: vi.fn(async () => log),
    } satisfies GitSurface;
  }

  test('caps the recent log at 10 and reveals the whole history on "View all"', async () => {
    const git = gitWithLog(manyCommits(12));
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);
    const recent = await view.findByRole('region', { name: 'Recent commits' });

    // Only the 10 newest render initially; the 11th/12th (sha0010/sha0011) are held back.
    await waitFor(() => expect(recent.querySelectorAll('.koi-sc-log-item').length).toBe(10));
    expect(recent.textContent).not.toContain('sha0011');

    const viewAll = view.getByRole('button', { name: /View all/i }) as HTMLButtonElement;
    expect(viewAll.disabled).toBe(false);
    fireEvent.click(viewAll);

    // The full log now renders — all 12 rows, including the previously-capped tail.
    await waitFor(() => expect(recent.querySelectorAll('.koi-sc-log-item').length).toBe(12));
    expect(recent.textContent).toContain('sha0011');

    // The Recent-commits landmark is preserved (the region/axe tests depend on its accessible name).
    expect(view.getByRole('region', { name: 'Recent commits' })).toBe(recent);
  });

  test('"View all" un-collapses the Recent-commits section when it is collapsed (never a dead click)', async () => {
    const git = gitWithLog(manyCommits(12));
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);
    const recent = await view.findByRole('region', { name: 'Recent commits' });
    await waitFor(() => expect(recent.querySelectorAll('.koi-sc-log-item').length).toBe(10));

    // Collapse the Recent-commits section via its chevron toggle — the list is now hidden by CSS.
    fireEvent.click(within(recent).getByRole('button', { name: /Recent commits/ }));
    expect(recent.classList.contains('collapsed')).toBe(true);

    // "View all" must ALSO un-collapse (not just flip the cap), or it'd be a live-but-inert click while
    // the section stays collapsed and hides the list.
    fireEvent.click(view.getByRole('button', { name: /View all/i }));
    expect(recent.classList.contains('collapsed')).toBe(false);
    await waitFor(() => expect(recent.querySelectorAll('.koi-sc-log-item').length).toBe(12));
  });

  test('a short history (≤ 10) shows every commit and disables "View all" (nothing more to reveal)', async () => {
    const git = gitWithLog(manyCommits(3));
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);
    const recent = await view.findByRole('region', { name: 'Recent commits' });
    await waitFor(() => expect(recent.querySelectorAll('.koi-sc-log-item').length).toBe(3));
    expect((view.getByRole('button', { name: /View all/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('empty history: "View all" is absent (nothing to show)', async () => {
    const git = gitWithLog([]);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);
    await view.findByRole('region', { name: 'Recent commits' });
    await view.findByText(/No commits yet/i);
    expect(view.queryByRole('button', { name: /View all/i })).toBeNull();
  });

  test('the ⋮ menu "View all commits" item reveals the full history too', async () => {
    const git = gitWithLog(manyCommits(12));
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);
    const recent = await view.findByRole('region', { name: 'Recent commits' });
    await waitFor(() => expect(recent.querySelectorAll('.koi-sc-log-item').length).toBe(10));

    fireEvent.click(view.getByRole('button', { name: 'Views and more actions' }));
    const menu = await waitFor(() => {
      const m = document.querySelector<HTMLElement>('[role="menu"]');
      expect(m).not.toBeNull();
      return m!;
    });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'View all commits' }));
    await waitFor(() => expect(recent.querySelectorAll('.koi-sc-log-item').length).toBe(12));
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
    const commitBtn = view.getByRole('button', { name: /Commit \d+ file/ }) as HTMLButtonElement;
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

describe('SourceControlPanel — inline diff request identity', () => {
  // makeGit with a gitDiff whose resolution the TEST controls per path — so one row's fetch can be held
  // pending while another row is toggled, reproducing a slow `git diff` on a large file.
  function makeDiffGit(files: GitFile[]) {
    const pending = new Map<string, (text: string) => void>();
    const git = {
      ...makeGit(files),
      gitDiff: vi.fn(
        (_token: string, relPath: string, _staged: boolean) =>
          new Promise<string>((resolve) => {
            pending.set(relPath, resolve);
          }),
      ),
    };
    return { git, pending };
  }

  const twoFiles: GitFile[] = [
    { relPath: 'a.koi', staged: false, status: 'modified' },
    { relPath: 'b.koi', staged: false, status: 'modified' },
  ];

  test("a late diff resolve from a previously-clicked row never overwrites the open row's diff", async () => {
    const { git, pending } = makeDiffGit(twoFiles);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    // Open a.koi (its fetch stays pending — a slow `git diff`), then open b.koi before it lands.
    fireEvent.click(await view.findByRole('button', { name: 'a.koi modified' }));
    fireEvent.click(view.getByRole('button', { name: 'b.koi modified' }));

    pending.get('b.koi')!('diff for b.koi');
    await waitFor(() => expect(view.getByLabelText('Diff for b.koi').textContent).toContain('diff for b.koi'));

    // a's slow fetch finally resolves — it must be discarded, not painted into b's expanded row.
    pending.get('a.koi')!('diff for a.koi');
    await new Promise((r) => setTimeout(r, 20));
    expect(view.getByLabelText('Diff for b.koi').textContent).toContain('diff for b.koi');
    expect(view.container.textContent).not.toContain('diff for a.koi');
  });

  test("opening another row clears the previous row's diff while the new fetch is in flight", async () => {
    const { git, pending } = makeDiffGit(twoFiles);
    const view = render(<SourceControlPanel git={git} folderToken={TOKEN} />);

    fireEvent.click(await view.findByRole('button', { name: 'a.koi modified' }));
    pending.get('a.koi')!('diff for a.koi');
    await waitFor(() => expect(view.getByLabelText('Diff for a.koi').textContent).toContain('diff for a.koi'));

    // b's freshly-expanded row must not display a's diff while its own fetch is pending.
    fireEvent.click(view.getByRole('button', { name: 'b.koi modified' }));
    const diffB = await view.findByLabelText('Diff for b.koi');
    expect(diffB.textContent).toBe('No changes to show.');

    pending.get('b.koi')!('diff for b.koi');
    await waitFor(() => expect(view.getByLabelText('Diff for b.koi').textContent).toContain('diff for b.koi'));
  });
});
