import { describe, it, expect } from 'vitest';
import { BrowserPlatform } from '@/host/browser';

describe('BrowserPlatform host capabilities', () => {
  it('cannot host an MCP sidecar', () => {
    expect(new BrowserPlatform().canHostMcp).toBe(false);
  });
  it('needs in-process sources for the compatibility check', () => {
    expect(new BrowserPlatform().compatNeedsInProcessSources).toBe(true);
  });
  it('is updated via a service worker', () => {
    expect(new BrowserPlatform().usesServiceWorker).toBe(true);
  });

  it('cannot reveal a file in the OS file manager (#1165)', () => {
    expect(new BrowserPlatform().canRevealInFileManager).toBe(false);
  });

  it('revealPath is a graceful no-op in the browser (resolves, never throws) (#1165)', async () => {
    await expect(new BrowserPlatform().revealPath('/anything')).resolves.toBeUndefined();
  });

  // The cold-boot ladder asks this to decide what it may silently re-open: the OPFS default + the
  // `example-*` example dirs (re-acquire with no prompt), but NOT a picked folder (needs a gesture).
  describe('isAutoRestorableToken', () => {
    const p = new BrowserPlatform();
    it('vouches for an example workspace and the default token', async () => {
      expect(await p.isAutoRestorableToken('example-pizzeria')).toBe(true);
      expect(await p.isAutoRestorableToken('(default)')).toBe(true);
    });
    it('declines a picked-folder name and any other token', async () => {
      expect(await p.isAutoRestorableToken('My Project')).toBe(false);
      expect(await p.isAutoRestorableToken('/Users/me/models')).toBe(false);
    });
  });
});
