import { describe, expect, it, vi } from 'vitest';

import { connectRevealAnnouncer } from './revealAnnouncer';

const MESSAGE = 'A toolbar action appeared';

// A fake visibility source: a settable predicate plus a subscription whose callbacks fire on demand —
// the slice of an affordance controller the announcer drives (canInstall() / canReload() + subscribe).
function makeVisibility(initial: boolean) {
  let visible = initial;
  const cbs = new Set<() => void>();
  return {
    isVisible: () => visible,
    subscribe: (cb: () => void) => {
      cbs.add(cb);
      return () => void cbs.delete(cb);
    },
    set(value: boolean) {
      visible = value;
      for (const cb of cbs) cb();
    },
  };
}

// An injectable perceivability signal (#573): a predicate + a subscription whose callbacks fire on demand.
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

describe('connectRevealAnnouncer', () => {
  it('announces once on the hidden→visible edge, never on a repeat visible notification', () => {
    const v = makeVisibility(false);
    const announce = vi.fn();
    const dispose = connectRevealAnnouncer({
      isVisible: v.isVisible,
      subscribe: v.subscribe,
      announce,
      message: MESSAGE,
      initiallyVisible: false,
    });

    expect(announce).not.toHaveBeenCalled(); // nothing to announce while hidden

    v.set(true);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(MESSAGE);

    // Staying visible across further notifications never re-announces — one announcement per reveal.
    v.set(true);
    expect(announce).toHaveBeenCalledTimes(1);

    dispose();
  });

  it('stays silent on a hidden→hidden notification', () => {
    const v = makeVisibility(false);
    const announce = vi.fn();
    const dispose = connectRevealAnnouncer({
      isVisible: v.isVisible,
      subscribe: v.subscribe,
      announce,
      message: MESSAGE,
      initiallyVisible: false,
    });

    v.set(false); // a notification that doesn't cross the reveal edge
    expect(announce).not.toHaveBeenCalled();

    dispose();
  });

  it('announces on connect when already visible but seeded hidden (initial reveal edge)', () => {
    const v = makeVisibility(true);
    const announce = vi.fn();
    const dispose = connectRevealAnnouncer({
      isVisible: v.isVisible,
      subscribe: v.subscribe,
      announce,
      message: MESSAGE,
      initiallyVisible: false, // markup ships hidden though the controller is already armed
    });

    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(MESSAGE);

    dispose();
  });

  it('does not announce on connect when seeded already-visible (no reveal edge)', () => {
    const v = makeVisibility(true);
    const announce = vi.fn();
    const dispose = connectRevealAnnouncer({
      isVisible: v.isVisible,
      subscribe: v.subscribe,
      announce,
      message: MESSAGE,
      initiallyVisible: true,
    });

    expect(announce).not.toHaveBeenCalled();

    dispose();
  });

  it('defaults initiallyVisible to the current isVisible(), so a seeded-visible connect stays silent', () => {
    const v = makeVisibility(true);
    const announce = vi.fn();
    const dispose = connectRevealAnnouncer({
      isVisible: v.isVisible,
      subscribe: v.subscribe,
      announce,
      message: MESSAGE,
    });

    expect(announce).not.toHaveBeenCalled(); // seeded from isVisible()===true → no edge on the initial sync

    dispose();
  });

  it('defers the announcement when revealed while not perceivable, then flushes exactly once', () => {
    const v = makeVisibility(false);
    const p = makePerceivable(false);
    const announce = vi.fn();
    const dispose = connectRevealAnnouncer({
      isVisible: v.isVisible,
      subscribe: v.subscribe,
      announce,
      message: MESSAGE,
      initiallyVisible: false,
      isPerceivable: p.isPerceivable,
      subscribePerceivable: p.subscribePerceivable,
    });

    v.set(true); // revealed, but not perceivable yet → defer
    expect(announce).not.toHaveBeenCalled();

    p.set(true); // became perceivable while still visible → flush the deferred announcement once
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(MESSAGE);

    // Further perceivability toggles never re-announce — one announcement per reveal.
    p.set(false);
    p.set(true);
    expect(announce).toHaveBeenCalledTimes(1);

    dispose();
  });

  it('announces immediately when revealed while already perceivable (no defer)', () => {
    const v = makeVisibility(false);
    const p = makePerceivable(true);
    const announce = vi.fn();
    const dispose = connectRevealAnnouncer({
      isVisible: v.isVisible,
      subscribe: v.subscribe,
      announce,
      message: MESSAGE,
      initiallyVisible: false,
      isPerceivable: p.isPerceivable,
      subscribePerceivable: p.subscribePerceivable,
    });

    v.set(true);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(MESSAGE);

    dispose();
  });

  it('drops a deferred announcement when hidden before it becomes perceivable', () => {
    const v = makeVisibility(false);
    const p = makePerceivable(false);
    const announce = vi.fn();
    const dispose = connectRevealAnnouncer({
      isVisible: v.isVisible,
      subscribe: v.subscribe,
      announce,
      message: MESSAGE,
      initiallyVisible: false,
      isPerceivable: p.isPerceivable,
      subscribePerceivable: p.subscribePerceivable,
    });

    v.set(true); // deferred
    v.set(false); // hidden before it could flush → drop the deferred announcement
    p.set(true); // becoming perceivable must NOT resurrect the dropped announcement
    expect(announce).not.toHaveBeenCalled();

    dispose();
  });

  it('announces immediately by default when no perceivability gate is injected', () => {
    const v = makeVisibility(false);
    const announce = vi.fn();
    const dispose = connectRevealAnnouncer({
      isVisible: v.isVisible,
      subscribe: v.subscribe,
      announce,
      message: MESSAGE,
      initiallyVisible: false,
    });

    v.set(true);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(MESSAGE);

    dispose();
  });

  it('dispose unsubscribes both the visibility and perceivability subscriptions', () => {
    const unsubVisible = vi.fn();
    const unsubPerceivable = vi.fn();
    const subscribe = vi.fn(() => unsubVisible);
    const subscribePerceivable = vi.fn(() => unsubPerceivable);
    const dispose = connectRevealAnnouncer({
      isVisible: () => false,
      subscribe,
      announce: vi.fn(),
      message: MESSAGE,
      initiallyVisible: false,
      isPerceivable: () => false,
      subscribePerceivable,
    });

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribePerceivable).toHaveBeenCalledTimes(1);

    dispose();
    expect(unsubVisible).toHaveBeenCalledTimes(1);
    expect(unsubPerceivable).toHaveBeenCalledTimes(1);
  });
});
