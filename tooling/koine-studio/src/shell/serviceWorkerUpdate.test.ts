// Tests for Koine Studio Web's service-worker registration + non-blocking update flow (issue #443).
//
// The registration + update wiring is split into pure, dependency-injected helpers (mirroring
// pwaInstall.ts, #442) so it unit-tests under happy-dom without a real ServiceWorker: registration is
// guarded for browsers that lack the API, and a detected update drives a dismissible "reload" affordance.

import { describe, it, expect, vi } from 'vitest';
import {
  serviceWorkerUrl,
  watchForUpdates,
  createUpdateController,
  connectUpdateAffordance,
  registerStudioServiceWorker,
  scheduleCompilerPrecache,
} from './serviceWorkerUpdate';

// --- minimal fakes for the SW registration lifecycle ----------------------------------------------

function makeFakeWorker() {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    state: 'installing' as string,
    addEventListener(type: string, cb: () => void) {
      (listeners[type] ??= []).push(cb);
    },
    fire(type: string) {
      (listeners[type] ?? []).forEach((cb) => cb());
    },
  };
}

function makeFakeRegistration(installing: ReturnType<typeof makeFakeWorker> | null) {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    installing,
    addEventListener(type: string, cb: () => void) {
      (listeners[type] ??= []).push(cb);
    },
    fire(type: string) {
      (listeners[type] ?? []).forEach((cb) => cb());
    },
  };
}

describe('serviceWorkerUpdate — serviceWorkerUrl', () => {
  it('builds a base-aware script URL + scope (root and sub-path)', () => {
    expect(serviceWorkerUrl('/')).toEqual({ url: '/koine-studio-sw.js', scope: '/' });
    expect(serviceWorkerUrl('/Koine/studio/')).toEqual({
      url: '/Koine/studio/koine-studio-sw.js',
      scope: '/Koine/studio/',
    });
    // tolerates a missing trailing slash and undefined
    expect(serviceWorkerUrl('/Koine/studio')).toEqual({
      url: '/Koine/studio/koine-studio-sw.js',
      scope: '/Koine/studio/',
    });
    expect(serviceWorkerUrl(undefined)).toEqual({ url: '/koine-studio-sw.js', scope: '/' });
  });
});

describe('serviceWorkerUpdate — watchForUpdates', () => {
  it('fires onUpdateReady when a NEW worker installs while a controller is already in charge', () => {
    const worker = makeFakeWorker();
    const reg = makeFakeRegistration(worker);
    const onUpdateReady = vi.fn();

    watchForUpdates(reg, onUpdateReady, /* hadController */ true);
    reg.fire('updatefound');
    worker.state = 'installed';
    worker.fire('statechange');

    expect(onUpdateReady).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire on the very first install (no prior controller)', () => {
    const worker = makeFakeWorker();
    const reg = makeFakeRegistration(worker);
    const onUpdateReady = vi.fn();

    watchForUpdates(reg, onUpdateReady, /* hadController */ false);
    reg.fire('updatefound');
    worker.state = 'installed';
    worker.fire('statechange');

    expect(onUpdateReady).not.toHaveBeenCalled();
  });

  it('is a no-op (never throws) when there is no installing worker', () => {
    const reg = makeFakeRegistration(null);
    expect(() => {
      watchForUpdates(reg, vi.fn(), true);
      reg.fire('updatefound');
    }).not.toThrow();
  });
});

describe('serviceWorkerUpdate — createUpdateController', () => {
  it('canReload() only after an update is ready and while not dismissed', () => {
    const c = createUpdateController();
    expect(c.canReload()).toBe(false);
    c.markUpdateReady();
    expect(c.canReload()).toBe(true);
    c.dismiss();
    expect(c.canReload()).toBe(false);
  });

  it('notifies subscribers on markUpdateReady and dismiss', () => {
    const c = createUpdateController();
    const listener = vi.fn();
    const unsub = c.subscribe(listener);
    c.markUpdateReady();
    c.dismiss();
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
    c.markUpdateReady();
    expect(listener).toHaveBeenCalledTimes(2); // unsubscribed
  });
});

describe('serviceWorkerUpdate — connectUpdateAffordance', () => {
  function dom() {
    const root = document.createElement('div');
    root.hidden = true;
    const reloadButton = document.createElement('button');
    const dismissButton = document.createElement('button');
    root.append(reloadButton, dismissButton);
    document.body.append(root);
    return { root, reloadButton, dismissButton };
  }

  it('reveals the affordance when an update is ready and hides it on dismiss', () => {
    const controller = createUpdateController();
    const d = dom();
    const reload = vi.fn();
    const dispose = connectUpdateAffordance(controller, { ...d, reload });

    expect(d.root.hidden).toBe(true); // hidden until an update lands
    controller.markUpdateReady();
    expect(d.root.hidden).toBe(false); // revealed

    d.dismissButton.click();
    expect(d.root.hidden).toBe(true); // dismissed → hidden, reload NOT triggered
    expect(reload).not.toHaveBeenCalled();
    dispose();
  });

  it('reloads when the reload button is clicked', () => {
    const controller = createUpdateController();
    const d = dom();
    const reload = vi.fn();
    const dispose = connectUpdateAffordance(controller, { ...d, reload });

    controller.markUpdateReady();
    d.reloadButton.click();
    expect(reload).toHaveBeenCalledTimes(1);
    dispose();
  });
});

describe('serviceWorkerUpdate — scheduleCompilerPrecache', () => {
  it('is a no-op when the Service Worker API is unavailable (no throw)', () => {
    expect(() => scheduleCompilerPrecache({ navigatorRef: {} as Navigator })).not.toThrow();
  });

  it('is a no-op when the controller is not yet ready (no throw)', () => {
    expect(() =>
      scheduleCompilerPrecache({ navigatorRef: { serviceWorker: {} } as unknown as Navigator }),
    ).not.toThrow();
  });

  it('posts a precache message to the active worker once ready (on idle)', async () => {
    const postMessage = vi.fn();
    const ready = Promise.resolve({ active: { postMessage } });
    const original = (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
    (globalThis as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback = (cb) => cb();
    try {
      scheduleCompilerPrecache({
        navigatorRef: { serviceWorker: { ready } } as unknown as Navigator,
      });
      await ready;
      await Promise.resolve();
      expect(postMessage).toHaveBeenCalledWith({ type: 'precache' });
    } finally {
      (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = original;
    }
  });
});

describe('serviceWorkerUpdate — registerStudioServiceWorker (guarded)', () => {
  it('is a no-op where the Service Worker API is unavailable (older browsers)', () => {
    const attempted = registerStudioServiceWorker({
      navigatorRef: {} as Navigator, // no `serviceWorker`
      isTauriRef: () => false,
    });
    expect(attempted).toBe(false);
  });

  it('does not register inside the Tauri desktop shell', () => {
    const register = vi.fn();
    const attempted = registerStudioServiceWorker({
      navigatorRef: { serviceWorker: { controller: null, register } } as unknown as Navigator,
      isTauriRef: () => true,
    });
    expect(attempted).toBe(false);
    expect(register).not.toHaveBeenCalled();
  });

  it('registers the base-aware module SW when supported, and watches for updates', async () => {
    const worker = makeFakeWorker();
    const reg = makeFakeRegistration(worker);
    const register = vi.fn().mockResolvedValue(reg);
    const onUpdateReady = vi.fn();

    const attempted = registerStudioServiceWorker({
      navigatorRef: { serviceWorker: { controller: {}, register } } as unknown as Navigator,
      isTauriRef: () => false,
      base: '/studio/',
      startImmediately: true,
      onUpdateReady,
    });

    expect(attempted).toBe(true);
    expect(register).toHaveBeenCalledWith('/studio/koine-studio-sw.js', {
      type: 'module',
      scope: '/studio/',
    });

    await Promise.resolve(); // let the register() promise settle so watchForUpdates is wired
    await Promise.resolve();
    reg.fire('updatefound');
    worker.state = 'installed';
    worker.fire('statechange');
    expect(onUpdateReady).toHaveBeenCalledTimes(1); // controller was present → treated as an update
  });
});
