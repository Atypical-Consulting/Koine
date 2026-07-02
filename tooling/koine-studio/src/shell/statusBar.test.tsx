import { afterEach, describe, expect, test, vi } from 'vitest';
import { createAppStore } from '@/store/index';
import { createCountingStore } from '@/store/testing';
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
    store.getState().setRoots(['folderB']); // quick switch to a non-git folder
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
    store.getState().setRoots(['opened']); // the change the branch segment listens for
    await flush();
    expect(gitStatus).toHaveBeenCalledWith('opened');
  });

  // #980: the status bar had no teardown seam — its :56 folder-token subscription and its two Preact
  // panels (DocsCoverageRing, EmitEcho) survived every boot. dispose() must release all three, and the
  // disposed flag must stop an in-flight branch refresh from writing into a torn-down bar.
  test('dispose() releases the folder-token subscription and unmounts both panels', async () => {
    seed();
    const { store, active } = createCountingStore();
    const handle = createStatusBar({ store, platform: fakePlatform(), folderRootToken: () => null, onOpenProblems: () => {} });
    // The folder-token subscription is live, and both panels rendered their content into their hosts.
    expect(active()).toBeGreaterThan(0);
    expect(document.querySelector('#sb-docs-ring .sb-ring-label')).not.toBeNull();
    expect(document.querySelector('#sb-emit .sb-emit-label')).not.toBeNull();

    handle.dispose();
    await flush();
    // The folder-token subscription is released. (The panels subscribe to the store via a deferred
    // preact/compat effect that never runs here — they are unmounted before it would — so the tally is
    // driven by the folder-token sub; the DOM checks below are what actually guard the panel unmount.)
    expect(active()).toBe(0);
    // Both Preact panels are unmounted: render(null, host) emptied their hosts, so their own store
    // subscriptions and any window listeners are gone. (Dropping either render(null) fails this.)
    expect(document.querySelector('#sb-docs-ring .sb-ring-label')).toBeNull();
    expect(document.querySelector('#sb-emit .sb-emit-label')).toBeNull();
  });

  test('a disposed status bar no longer refreshes the branch on a folder-token change', async () => {
    seed();
    const store = createAppStore();
    const gitStatus = vi.fn(async () => ({ branch: 'main', files: [] }));
    let token: string | null = 'opened';
    const handle = createStatusBar({
      store,
      platform: fakePlatform({ canUseGit: true, gitStatus }),
      folderRootToken: () => token,
      onOpenProblems: () => {},
    });
    await flush();
    gitStatus.mockClear();

    handle.dispose();
    token = 'other';
    store.getState().setRoots(['other']); // the disposed subscription must not react
    await flush();
    expect(gitStatus).not.toHaveBeenCalled();
  });

  test('an in-flight gitStatus that resolves after dispose() does not touch the branch segment', async () => {
    seed();
    const store = createAppStore();
    let resolve!: (v: { branch: string; files: never[] }) => void;
    const gitStatus = vi.fn(() => new Promise((r) => (resolve = r as never)));
    const handle = createStatusBar({
      store,
      platform: fakePlatform({ canUseGit: true, gitStatus: gitStatus as never }),
      folderRootToken: () => 'root', // never changes — the existing token guard does NOT bail here
      onOpenProblems: () => {},
    });
    // The initial refreshBranch is now suspended on the gitStatus await.
    handle.dispose();
    resolve({ branch: 'main', files: [] }); // resolves AFTER dispose
    await flush();

    const branchEl = document.getElementById('sb-branch') as HTMLElement;
    expect(branchEl.hidden).toBe(true); // the disposed flag bailed before the DOM write
    expect(document.querySelector('#sb-branch [data-role="branch-name"]')!.textContent).not.toBe('main');
  });
});
