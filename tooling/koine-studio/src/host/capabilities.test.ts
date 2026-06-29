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
});
