import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GitLogEntry, GitNumstatEntry, GitStatus } from '@/host/types';

// Drive TauriPlatform's source-control (git) surface against a mocked Tauri IPC: every git* method is a
// thin `invoke('git_*', { … })` wrapper, so the contract under test is the command name + the camelCase
// arg keys (Tauri maps those to the snake_case Rust params; the Rust structs already serialize to the TS
// types, so there's no manual remapping to assert). Only `invoke` is mocked; tauri.ts's other imports load
// normally under happy-dom. A dedicated file (mirroring tauriTerminal.test.ts) keeps this file-global
// vi.mock out of harness.test.ts, which builds a real BrowserPlatform.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { TauriPlatform } from '@/host/tauri';

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

describe('TauriPlatform git surface', () => {
  it('reports canUseGit = true (the desktop host shells out to a real git)', () => {
    expect(new TauriPlatform().canUseGit).toBe(true);
  });

  it('gitStatus invokes git_status with { dir } and returns the host result unmapped', async () => {
    const status: GitStatus = { branch: 'main', files: [{ relPath: 'a.koi', staged: false, status: 'modified' }] };
    invokeMock.mockResolvedValue(status);

    const result = await new TauriPlatform().gitStatus('/work');

    expect(invokeMock).toHaveBeenCalledWith('git_status', { dir: '/work' });
    expect(result).toBe(status);
  });

  it('gitDiff invokes git_diff with { dir, relPath, staged } and returns the patch text', async () => {
    invokeMock.mockResolvedValue('--- a/x.koi\n+++ b/x.koi\n');

    const result = await new TauriPlatform().gitDiff('/work', 'x.koi', true);

    expect(invokeMock).toHaveBeenCalledWith('git_diff', { dir: '/work', relPath: 'x.koi', staged: true });
    expect(result).toBe('--- a/x.koi\n+++ b/x.koi\n');
  });

  it('gitStage invokes git_stage with { dir, relPaths }', async () => {
    await new TauriPlatform().gitStage('/work', ['a.koi', 'b.koi']);
    expect(invokeMock).toHaveBeenCalledWith('git_stage', { dir: '/work', relPaths: ['a.koi', 'b.koi'] });
  });

  it('gitUnstage invokes git_unstage with { dir, relPaths }', async () => {
    await new TauriPlatform().gitUnstage('/work', ['a.koi']);
    expect(invokeMock).toHaveBeenCalledWith('git_unstage', { dir: '/work', relPaths: ['a.koi'] });
  });

  it('gitDiscard invokes git_discard with { dir, trackedPaths, untrackedPaths } — the caller-supplied split', async () => {
    await new TauriPlatform().gitDiscard('/work', ['a.koi'], ['scratch.koi']);
    expect(invokeMock).toHaveBeenCalledWith('git_discard', {
      dir: '/work',
      trackedPaths: ['a.koi'],
      untrackedPaths: ['scratch.koi'],
    });
  });

  it('gitCommit invokes git_commit with { dir, message }', async () => {
    await new TauriPlatform().gitCommit('/work', 'feat: add aggregate');
    expect(invokeMock).toHaveBeenCalledWith('git_commit', { dir: '/work', message: 'feat: add aggregate' });
  });

  it('gitRevert invokes git_revert with { dir, sha }', async () => {
    await new TauriPlatform().gitRevert('/work', 'abc1234');
    expect(invokeMock).toHaveBeenCalledWith('git_revert', { dir: '/work', sha: 'abc1234' });
  });

  it('gitPush invokes git_push with { dir }', async () => {
    await new TauriPlatform().gitPush('/work');
    expect(invokeMock).toHaveBeenCalledWith('git_push', { dir: '/work' });
  });

  it('gitBranches invokes git_branches with { dir } and returns the branch names', async () => {
    invokeMock.mockResolvedValue(['main', 'dev']);

    const result = await new TauriPlatform().gitBranches('/work');

    expect(invokeMock).toHaveBeenCalledWith('git_branches', { dir: '/work' });
    expect(result).toEqual(['main', 'dev']);
  });

  it('gitCheckout invokes git_checkout with { dir, branch }', async () => {
    await new TauriPlatform().gitCheckout('/work', 'dev');
    expect(invokeMock).toHaveBeenCalledWith('git_checkout', { dir: '/work', branch: 'dev' });
  });

  it('gitLog invokes git_log with { dir, relPath } and returns the commit list', async () => {
    const log: GitLogEntry[] = [{ sha: 'abc', author: 'Ada', date: '2026-06-26T00:00:00Z', message: 'init' }];
    invokeMock.mockResolvedValue(log);

    const result = await new TauriPlatform().gitLog('/work', 'a.koi');

    expect(invokeMock).toHaveBeenCalledWith('git_log', { dir: '/work', relPath: 'a.koi' });
    expect(result).toBe(log);
  });

  it('gitLog without a relPath passes relPath: undefined (whole-repo log)', async () => {
    invokeMock.mockResolvedValue([]);
    await new TauriPlatform().gitLog('/work');
    expect(invokeMock).toHaveBeenCalledWith('git_log', { dir: '/work', relPath: undefined });
  });

  it('gitInit invokes git_init with { dir }', async () => {
    await new TauriPlatform().gitInit('/work');
    expect(invokeMock).toHaveBeenCalledWith('git_init', { dir: '/work' });
  });

  it('gitClone invokes git_clone with { url, parentDir, dirName } and returns the cloned dir path', async () => {
    invokeMock.mockResolvedValue('/parent/repo');

    const result = await new TauriPlatform().gitClone('https://x/y/repo.git', '/parent', 'repo');

    expect(invokeMock).toHaveBeenCalledWith('git_clone', {
      url: 'https://x/y/repo.git',
      parentDir: '/parent',
      dirName: 'repo',
    });
    expect(result).toBe('/parent/repo');
  });

  it('gitClone without a dirName passes dirName: undefined (host derives the repo name)', async () => {
    invokeMock.mockResolvedValue('/parent/repo');
    await new TauriPlatform().gitClone('https://x/y/repo.git', '/parent');
    expect(invokeMock).toHaveBeenCalledWith('git_clone', {
      url: 'https://x/y/repo.git',
      parentDir: '/parent',
      dirName: undefined,
    });
  });

  it('gitNumstat invokes git_numstat with { dir } and returns the host entries unmapped', async () => {
    // The Rust struct serializes straight to GitNumstatEntry (binary → null counts), so the wrapper is a
    // verbatim pass-through — like gitStatus/gitLog, no manual remapping to assert.
    const entries: GitNumstatEntry[] = [
      { relPath: 'b.koi', staged: false, added: 5, removed: 2 },
      { relPath: 'logo.png', staged: false, added: null, removed: null },
    ];
    invokeMock.mockResolvedValue(entries);

    const result = await new TauriPlatform().gitNumstat('/work');

    expect(invokeMock).toHaveBeenCalledWith('git_numstat', { dir: '/work' });
    expect(result).toBe(entries);
  });
});
