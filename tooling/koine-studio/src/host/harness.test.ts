import { describe, it, expect } from 'vitest';
import { BrowserPlatform } from '@/host/browser';
import type { Platform } from '@/host/types';

// Smoke test: confirms the vitest + jsdom harness runs and the DOM environment is wired up.
describe('test harness', () => {
  it('runs under jsdom', () => {
    const div = document.createElement('div');
    div.textContent = 'koine';
    expect(div.textContent).toBe('koine');
  });
});

// Source control capability (issue #272). git is desktop-only: a plain browser tab has no git, so the
// browser host advertises `canUseGit === false` and every `git*` method degrades gracefully. The flag
// is the contract — callers (e.g. the Source Control panel) MUST check `canUseGit` first — and the
// rejecting stub is the safety net: a missed guard surfaces as a HANDLED async rejection rather than a
// synchronous throw, a console error, or fake "clean working tree" data. This mirrors the existing
// `canRunShell` + terminal split, where the capability flag gates a host-specific surface.
describe('BrowserPlatform git capability', () => {
  it('advertises git as unavailable through canUseGit', () => {
    expect(new BrowserPlatform().canUseGit).toBe(false);
  });

  it('degrades gitStatus to an async rejection (no synchronous throw, no fake data)', async () => {
    // Typed as the Platform contract (what every call site holds), so the test exercises the
    // interface's `gitStatus(folderToken)` signature rather than the concrete class's stub arity.
    const platform: Platform = new BrowserPlatform();
    // Invoking the stub without a `canUseGit` guard must NOT throw inline: it returns a promise that
    // rejects with an Error, so any call site that forgot to guard still degrades gracefully.
    await expect(platform.gitStatus('any-folder-token')).rejects.toBeInstanceOf(Error);
  });

  it('degrades gitInit to an async rejection, same as every other git* stub', async () => {
    const platform: Platform = new BrowserPlatform();
    await expect(platform.gitInit('any-folder-token')).rejects.toBeInstanceOf(Error);
  });

  it('degrades gitClone to an async rejection, same as every other git* stub', async () => {
    const platform: Platform = new BrowserPlatform();
    await expect(platform.gitClone('https://x/y/repo.git', '/parent', 'repo')).rejects.toBeInstanceOf(Error);
  });

  it('degrades gitNumstat to an async rejection, same as every other git* stub', async () => {
    const platform: Platform = new BrowserPlatform();
    await expect(platform.gitNumstat('any-folder-token')).rejects.toBeInstanceOf(Error);
  });
});
