import { afterEach, describe, expect, test, vi } from 'vitest';
import { createAppStore } from '@/store/index';
import type { Platform } from '@/host';
import { createStatusBar } from '@/shell/statusBar';

const SEED = `
  <button id="sb-branch" hidden><span data-role="branch-name"></span></button>
  <button id="sb-problems"><span id="sb-problems-errors">✕ 0</span><span id="sb-problems-warnings">⚠ 0</span></button>
  <span id="sb-docs-ring"></span>
  <span id="sb-emit"></span>`;

function seed(): void {
  document.body.innerHTML = SEED;
}

// A minimal Platform stub: only the fields createStatusBar touches. `canUseGit` + `gitStatus` vary per test.
function fakePlatform(over: Partial<Platform> = {}): Platform {
  return { canUseGit: false, ...over } as unknown as Platform;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('createStatusBar', () => {
  test('mounts the docs ring and emit echo into their hosts', () => {
    seed();
    const store = createAppStore();
    createStatusBar({ store, platform: fakePlatform(), folderRootToken: () => null, onOpenProblems: () => {} });

    expect(document.querySelector('#sb-docs-ring .sb-ring-label')!.textContent).toBe('Docs 0/0');
    expect(document.querySelector('#sb-emit .sb-emit-label')!.textContent).toBe('Emit: C#');
  });

  test('the Problems segment opens the Problems tab', () => {
    seed();
    const store = createAppStore();
    const onOpenProblems = vi.fn();
    createStatusBar({ store, platform: fakePlatform(), folderRootToken: () => null, onOpenProblems });

    document.getElementById('sb-problems')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onOpenProblems).toHaveBeenCalledOnce();
  });

  test('the branch segment stays hidden when the host has no git', async () => {
    seed();
    const store = createAppStore();
    createStatusBar({ store, platform: fakePlatform({ canUseGit: false }), folderRootToken: () => 'root', onOpenProblems: () => {} });
    await flush();
    expect((document.getElementById('sb-branch') as HTMLElement).hidden).toBe(true);
  });

  test('the branch segment reveals the current git branch when a git folder is open', async () => {
    seed();
    const store = createAppStore();
    const gitStatus = vi.fn(async () => ({ branch: 'feat/chrome-v2', files: [] }));
    createStatusBar({
      store,
      platform: fakePlatform({ canUseGit: true, gitStatus }),
      folderRootToken: () => 'root-token',
      onOpenProblems: () => {},
    });
    await flush();

    expect(gitStatus).toHaveBeenCalledWith('root-token');
    expect((document.getElementById('sb-branch') as HTMLElement).hidden).toBe(false);
    expect(document.querySelector('#sb-branch [data-role="branch-name"]')!.textContent).toBe('feat/chrome-v2');
  });

  // Regression: refreshBranch wrote the DOM unconditionally after its await, so with two overlapping
  // folder switches whichever gitStatus resolved LAST won — a slow previous repo's branch re-showed
  // over the current (non-git) folder's hidden segment.
  test('a slow gitStatus from a previous folder cannot overwrite the current folder segment', async () => {
    seed();
    const store = createAppStore();
    let token: string | null = 'repoA';
    let resolveA!: (v: { branch: string; files: never[] }) => void;
    const gitStatus = vi.fn((t: string) =>
      t === 'repoA'
        ? new Promise((res) => (resolveA = res)) // a large repo: its status takes a while
        : Promise.reject(new Error('not a git repo')), // folderB: rejects fast
    );
    createStatusBar({
      store,
      platform: fakePlatform({ canUseGit: true, gitStatus: gitStatus as never }),
      folderRootToken: () => token,
      onOpenProblems: () => {},
    });
    await flush(); // repoA's fetch is now in flight

    token = 'folderB';
    store.getState().setFolderRootToken('folderB'); // quick switch to a non-git folder
    await flush(); // B's refresh rejected → the segment hides
    const branchEl = document.getElementById('sb-branch') as HTMLElement;
    expect(branchEl.hidden).toBe(true);

    resolveA({ branch: 'main', files: [] }); // repoA's stale result lands LAST
    await flush();

    // The stale branch must not re-show (or write its name) while folder B is open.
    expect(branchEl.hidden).toBe(true);
    expect(document.querySelector('#sb-branch [data-role="branch-name"]')!.textContent).not.toBe('main');
  });

  test('refreshes the branch when the workspace folder token changes', async () => {
    seed();
    const store = createAppStore();
    const gitStatus = vi.fn(async () => ({ branch: 'main', files: [] }));
    let token: string | null = null;
    createStatusBar({
      store,
      platform: fakePlatform({ canUseGit: true, gitStatus }),
      folderRootToken: () => token,
      onOpenProblems: () => {},
    });
    await flush(); // initial: no token → no fetch
    expect(gitStatus).not.toHaveBeenCalled();

    token = 'opened';
    store.getState().setFolderRootToken('opened'); // the change the branch segment listens for
    await flush();
    expect(gitStatus).toHaveBeenCalledWith('opened');
  });
});
