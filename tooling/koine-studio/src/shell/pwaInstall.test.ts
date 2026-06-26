import { describe, it, expect, vi } from 'vitest';
import {
  createInstallController,
  INSTALL_DISMISSED_KEY,
  type BeforeInstallPromptEvent,
  type InstallStorage,
} from '@/shell/pwaInstall';

// An in-memory Storage stand-in so each test controls the dismissal flag deterministically (the
// global happy-dom shim is shared across files; a fresh map per test keeps the cases isolated).
function memStorage(seed: Record<string, string> = {}): InstallStorage {
  const m = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

// A fake deferred `beforeinstallprompt` event: records preventDefault, and resolves userChoice with a
// configurable outcome. `prompt()` is single-use in the real API; we count the calls to prove that.
function fakeEvent(outcome: 'accepted' | 'dismissed' = 'accepted'): BeforeInstallPromptEvent & {
  preventDefaultCalls: number;
  promptCalls: number;
} {
  const e = {
    preventDefaultCalls: 0,
    promptCalls: 0,
    preventDefault() {
      this.preventDefaultCalls++;
    },
    prompt() {
      this.promptCalls++;
      return Promise.resolve();
    },
    userChoice: Promise.resolve({ outcome, platform: 'web' }),
  };
  return e as unknown as BeforeInstallPromptEvent & { preventDefaultCalls: number; promptCalls: number };
}

describe('createInstallController', () => {
  it('is not armed until a beforeinstallprompt event is stashed', () => {
    const c = createInstallController({ storage: memStorage() });
    expect(c.canInstall()).toBe(false);

    const e = fakeEvent();
    c.onBeforeInstallPrompt(e);

    expect(e.preventDefaultCalls).toBe(1); // suppress the browser's own mini-infobar
    expect(c.canInstall()).toBe(true);
  });

  it('promptInstall() calls event.prompt() exactly once, then clears the single-use stash', async () => {
    const storage = memStorage();
    const c = createInstallController({ storage });
    const e = fakeEvent('accepted');
    c.onBeforeInstallPrompt(e);

    const outcome = await c.promptInstall();
    expect(outcome).toBe('accepted');
    expect(e.promptCalls).toBe(1);

    // The deferred event is single-use: it's gone, so the controller can no longer install.
    expect(c.canInstall()).toBe(false);
    const again = await c.promptInstall();
    expect(again).toBe('unavailable');
    expect(e.promptCalls).toBe(1); // not called a second time
  });

  it('promptInstall() returns "unavailable" when nothing is stashed', async () => {
    const c = createInstallController({ storage: memStorage() });
    expect(await c.promptInstall()).toBe('unavailable');
  });

  it('dismiss() persists the flag and keeps canInstall() false thereafter', () => {
    const storage = memStorage();
    const c = createInstallController({ storage });
    c.onBeforeInstallPrompt(fakeEvent());
    expect(c.canInstall()).toBe(true);

    c.dismiss();

    expect(storage.getItem(INSTALL_DISMISSED_KEY)).toBe('1');
    expect(c.isDismissed()).toBe(true);
    expect(c.canInstall()).toBe(false);

    // A re-fired beforeinstallprompt after dismissal stays dismissed (non-nagging).
    c.onBeforeInstallPrompt(fakeEvent());
    expect(c.canInstall()).toBe(false);
  });

  it('respects a pre-existing dismissal flag from storage', () => {
    const c = createInstallController({ storage: memStorage({ [INSTALL_DISMISSED_KEY]: '1' }) });
    expect(c.isDismissed()).toBe(true);

    c.onBeforeInstallPrompt(fakeEvent());
    expect(c.canInstall()).toBe(false);
  });

  it('onAppInstalled() clears the stash so the affordance hides', () => {
    const c = createInstallController({ storage: memStorage() });
    c.onBeforeInstallPrompt(fakeEvent());
    expect(c.canInstall()).toBe(true);

    c.onAppInstalled();
    expect(c.canInstall()).toBe(false);
  });

  it('notifies subscribers on every state change', () => {
    const c = createInstallController({ storage: memStorage() });
    const sub = vi.fn();
    const unsub = c.subscribe(sub);

    c.onBeforeInstallPrompt(fakeEvent());
    c.dismiss();
    expect(sub).toHaveBeenCalledTimes(2);

    unsub();
    c.onBeforeInstallPrompt(fakeEvent());
    expect(sub).toHaveBeenCalledTimes(2); // no further calls after unsubscribe
  });

  it('survives a storage that throws (private mode) without crashing', () => {
    const throwing: InstallStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const c = createInstallController({ storage: throwing });
    expect(c.isDismissed()).toBe(false);
    c.onBeforeInstallPrompt(fakeEvent());
    expect(c.canInstall()).toBe(true);
    expect(() => c.dismiss()).not.toThrow();
    expect(c.canInstall()).toBe(false);
  });
});
