// Tests for the Playground service-worker registration (sw-register.ts, issue #328).
// serviceWorkerUrls is pure (base-path math); registerPlaygroundServiceWorker is exercised against a
// stubbed navigator.serviceWorker + document, asserting it registers a module SW once at a base-aware
// URL/scope and never throws where service workers are unavailable. We use vi.stubGlobal because Node
// exposes `navigator` as a read-only global that can't be assigned directly.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { serviceWorkerUrls } from './sw-register';

describe('serviceWorkerUrls — base-path aware', () => {
  it('prefixes the SW url + scope with Astro base', () => {
    expect(serviceWorkerUrls('/Koine/')).toEqual({ url: '/Koine/koine-sw.js', scope: '/Koine/' });
  });
  it('handles the root base', () => {
    expect(serviceWorkerUrls('/')).toEqual({ url: '/koine-sw.js', scope: '/' });
    expect(serviceWorkerUrls(undefined)).toEqual({ url: '/koine-sw.js', scope: '/' });
  });
});

describe('registerPlaygroundServiceWorker', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers a module SW once with a base-aware url + scope', async () => {
    const register = vi.fn().mockResolvedValue({});
    vi.stubGlobal('navigator', { serviceWorker: { register } });
    vi.stubGlobal('document', { readyState: 'complete' });

    const mod = await import('./sw-register');
    mod.registerPlaygroundServiceWorker();
    mod.registerPlaygroundServiceWorker(); // idempotent — must not register twice

    expect(register).toHaveBeenCalledTimes(1);
    const [url, opts] = register.mock.calls[0];
    expect(url).toMatch(/koine-sw\.js$/);
    expect(opts).toMatchObject({ type: 'module' });
    expect(String(opts.scope)).toMatch(/\/$/); // scope ends in a slash
  });

  it('is a no-op (no throw) when service workers are unavailable', async () => {
    vi.stubGlobal('navigator', {}); // no serviceWorker
    const mod = await import('./sw-register');
    expect(() => mod.registerPlaygroundServiceWorker()).not.toThrow();
  });

  it('defers registration to window load when the document is still loading', async () => {
    const register = vi.fn().mockResolvedValue({});
    const listeners: Record<string, () => void> = {};
    vi.stubGlobal('navigator', { serviceWorker: { register } });
    vi.stubGlobal('document', { readyState: 'loading' });
    vi.stubGlobal('window', {
      addEventListener: (evt: string, cb: () => void) => {
        listeners[evt] = cb;
      },
    });

    const mod = await import('./sw-register');
    mod.registerPlaygroundServiceWorker();
    expect(register).not.toHaveBeenCalled(); // waits for load
    listeners.load?.(); // fire window 'load'
    expect(register).toHaveBeenCalledTimes(1);
  });
});
