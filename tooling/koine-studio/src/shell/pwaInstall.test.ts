import { describe, it, expect, vi } from 'vitest';
import {
  connectInstallAffordance,
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

  it('promptInstall() swallows a rejecting prompt() and reports "unavailable" (no unhandled rejection)', async () => {
    const c = createInstallController({ storage: memStorage() });
    const rejecting = {
      preventDefault() {},
      prompt: () => Promise.reject(new Error('NotAllowedError')),
      userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
    } as unknown as BeforeInstallPromptEvent;
    c.onBeforeInstallPrompt(rejecting);

    await expect(c.promptInstall()).resolves.toBe('unavailable');
    expect(c.canInstall()).toBe(false); // single-use stash still cleared
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

describe('connectInstallAffordance', () => {
  // Build the affordance DOM the shell mounts: a container with an Install button and a dismiss "×".
  function makeDom() {
    const root = document.createElement('div');
    root.hidden = true; // mirror the shipped markup (index.html ships #install-affordance hidden)
    const installButton = document.createElement('button');
    const dismissButton = document.createElement('button');
    root.append(installButton, dismissButton);
    document.body.append(root);
    // A private event bus so the test never depends on (or pollutes) the real window.
    const target = new EventTarget();
    return { root, installButton, dismissButton, target };
  }

  // A dispatchable `beforeinstallprompt`: cancelable (so preventDefault sets defaultPrevented) with the
  // non-standard prompt()/userChoice surface bolted on.
  function dispatchBip(target: EventTarget, outcome: 'accepted' | 'dismissed' = 'accepted') {
    const e = new Event('beforeinstallprompt', { cancelable: true }) as BeforeInstallPromptEvent;
    const prompt = vi.fn(() => Promise.resolve());
    (e as unknown as { prompt: typeof prompt }).prompt = prompt;
    (e as unknown as { userChoice: Promise<unknown> }).userChoice = Promise.resolve({ outcome, platform: 'web' });
    target.dispatchEvent(e);
    return { e, prompt };
  }

  it('keeps the affordance hidden until a beforeinstallprompt arrives, then reveals it', () => {
    const dom = makeDom();
    const controller = createInstallController({ storage: memStorage() });
    const dispose = connectInstallAffordance(controller, dom);

    expect(dom.root.hidden).toBe(true);

    const { e } = dispatchBip(dom.target);
    expect(e.defaultPrevented).toBe(true); // mini-infobar suppressed
    expect(dom.root.hidden).toBe(false);

    dispose();
  });

  it('clicking Install invokes the prompt and hides the affordance (single-use)', () => {
    const dom = makeDom();
    const controller = createInstallController({ storage: memStorage() });
    const dispose = connectInstallAffordance(controller, dom);

    const { prompt } = dispatchBip(dom.target);
    expect(dom.root.hidden).toBe(false);

    dom.installButton.click();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(dom.root.hidden).toBe(true); // stash cleared synchronously before the await

    dispose();
  });

  it('clicking dismiss hides the affordance and persists the dismissal', () => {
    const dom = makeDom();
    const storage = memStorage();
    const controller = createInstallController({ storage });
    const dispose = connectInstallAffordance(controller, dom);

    dispatchBip(dom.target);
    expect(dom.root.hidden).toBe(false);

    dom.dismissButton.click();
    expect(dom.root.hidden).toBe(true);
    expect(storage.getItem(INSTALL_DISMISSED_KEY)).toBe('1');

    // A re-fired event stays hidden — respects the persisted dismissal.
    dispatchBip(dom.target);
    expect(dom.root.hidden).toBe(true);

    dispose();
  });

  it('hides the affordance on appinstalled', () => {
    const dom = makeDom();
    const controller = createInstallController({ storage: memStorage() });
    const dispose = connectInstallAffordance(controller, dom);

    dispatchBip(dom.target);
    expect(dom.root.hidden).toBe(false);

    dom.target.dispatchEvent(new Event('appinstalled'));
    expect(dom.root.hidden).toBe(true);

    dispose();
  });

  it('dispose() detaches every listener', () => {
    const dom = makeDom();
    const controller = createInstallController({ storage: memStorage() });
    const dispose = connectInstallAffordance(controller, dom);
    dispose();

    dispatchBip(dom.target);
    expect(dom.root.hidden).toBe(true); // no longer listening, so it never armed
  });

  it('announces once via the shared live region on the hidden→visible reveal (and not on dismiss)', () => {
    const dom = makeDom();
    const announce = vi.fn();
    const controller = createInstallController({ storage: memStorage() });
    const dispose = connectInstallAffordance(controller, { ...dom, announce });

    expect(announce).not.toHaveBeenCalled(); // nothing to announce while hidden

    dispatchBip(dom.target); // hidden → visible
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Koine Studio can be installed');

    // Dismissing is silent, and a re-fired event stays hidden (persisted dismissal) → no re-announce.
    dom.dismissButton.click();
    dispatchBip(dom.target);
    expect(announce).toHaveBeenCalledTimes(1);

    dispose();
  });
});

describe('connectInstallAffordance — perceivability gate (#573)', () => {
  // Reuse the shell-mounted affordance DOM and a dispatchable beforeinstallprompt.
  function makeDom() {
    const root = document.createElement('div');
    root.hidden = true;
    const installButton = document.createElement('button');
    const dismissButton = document.createElement('button');
    root.append(installButton, dismissButton);
    document.body.append(root);
    const target = new EventTarget();
    return { root, installButton, dismissButton, target };
  }
  function dispatchBip(target: EventTarget) {
    const e = new Event('beforeinstallprompt', { cancelable: true }) as BeforeInstallPromptEvent;
    (e as unknown as { prompt: () => Promise<void> }).prompt = () => Promise.resolve();
    (e as unknown as { userChoice: Promise<unknown> }).userChoice = Promise.resolve({
      outcome: 'accepted',
      platform: 'web',
    });
    target.dispatchEvent(e);
  }
  // An injectable perceivability signal: a predicate + a subscription whose callbacks fire on demand.
  function makePerceivable(initial: boolean) {
    let perceivable = initial;
    const cbs = new Set<() => void>();
    return {
      isPerceivable: () => perceivable,
      subscribePerceivable: (cb: () => void) => {
        cbs.add(cb);
        return () => void cbs.delete(cb);
      },
      set(value: boolean) {
        perceivable = value;
        for (const cb of cbs) cb();
      },
    };
  }

  it('defers the announcement when revealed while not perceivable, then flushes once it becomes perceivable', () => {
    const dom = makeDom();
    const announce = vi.fn();
    const p = makePerceivable(false);
    const controller = createInstallController({ storage: memStorage() });
    const dispose = connectInstallAffordance(controller, {
      ...dom,
      announce,
      isPerceivable: p.isPerceivable,
      subscribePerceivable: p.subscribePerceivable,
    });

    dispatchBip(dom.target); // revealed, but #app is route-hidden → defer
    expect(dom.root.hidden).toBe(false);
    expect(announce).not.toHaveBeenCalled();

    p.set(true); // editor route shown → flush the deferred announcement exactly once
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Koine Studio can be installed');

    // Further perceivability toggles never re-announce — one announcement per reveal.
    p.set(false);
    p.set(true);
    expect(announce).toHaveBeenCalledTimes(1);

    dispose();
  });

  it('announces immediately when revealed while already perceivable (no defer)', () => {
    const dom = makeDom();
    const announce = vi.fn();
    const p = makePerceivable(true);
    const controller = createInstallController({ storage: memStorage() });
    const dispose = connectInstallAffordance(controller, {
      ...dom,
      announce,
      isPerceivable: p.isPerceivable,
      subscribePerceivable: p.subscribePerceivable,
    });

    dispatchBip(dom.target);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Koine Studio can be installed');

    dispose();
  });

  it('drops a deferred announcement when dismissed before it became perceivable', () => {
    const dom = makeDom();
    const announce = vi.fn();
    const p = makePerceivable(false);
    const controller = createInstallController({ storage: memStorage() });
    const dispose = connectInstallAffordance(controller, {
      ...dom,
      announce,
      isPerceivable: p.isPerceivable,
      subscribePerceivable: p.subscribePerceivable,
    });

    dispatchBip(dom.target); // deferred
    dom.dismissButton.click(); // dismissed while still route-hidden
    p.set(true); // becoming perceivable must NOT resurrect the dropped announcement
    expect(announce).not.toHaveBeenCalled();

    dispose();
  });

  it('announces immediately by default when no perceivability gate is injected', () => {
    const dom = makeDom();
    const announce = vi.fn();
    const controller = createInstallController({ storage: memStorage() });
    const dispose = connectInstallAffordance(controller, { ...dom, announce });

    dispatchBip(dom.target);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Koine Studio can be installed');

    dispose();
  });

  it('dispose unsubscribes the perceivability subscription', () => {
    const dom = makeDom();
    const announce = vi.fn();
    const unsub = vi.fn();
    const subscribePerceivable = vi.fn(() => unsub);
    const controller = createInstallController({ storage: memStorage() });
    const dispose = connectInstallAffordance(controller, {
      ...dom,
      announce,
      isPerceivable: () => false,
      subscribePerceivable,
    });

    expect(subscribePerceivable).toHaveBeenCalledTimes(1);
    dispose();
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});
