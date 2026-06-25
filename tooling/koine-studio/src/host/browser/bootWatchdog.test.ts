import { describe, expect, it, vi } from 'vitest';
import { broadcastBootSignal } from '@/host/browser/bootWatchdog';
import type { WorkerSignal } from '@/host/browser/workerClient';

/** A controllable timer double: capture the watchdog callback so the test can fire it on demand. */
function fakeTimers() {
  let fired: (() => void) | null = null;
  const clearTimeout = vi.fn();
  return {
    timers: {
      setTimeout: (fn: () => void) => {
        fired = fn;
        return 1;
      },
      clearTimeout,
    },
    fire: () => fired?.(),
    clearTimeout,
  };
}

describe('broadcastBootSignal (issue #357 worker watchdog)', () => {
  it('emits `ready` (after onReady wires the message loop) and clears the watchdog when boot resolves', async () => {
    const signals: WorkerSignal[] = [];
    const onReady = vi.fn();
    const ft = fakeTimers();

    broadcastBootSignal(Promise.resolve(), (s) => signals.push(s), 20_000, onReady, ft.timers);
    await Promise.resolve();
    await Promise.resolve();

    expect(signals).toEqual([{ type: 'ready' }]);
    expect(onReady).toHaveBeenCalledOnce();
    expect(ft.clearTimeout).toHaveBeenCalled();
  });

  it('runs onReady BEFORE emitting `ready` — the message loop must be wired before the host is told it is up', async () => {
    // The whole #357 fix hinges on this ordering: the worker installs its `message` listener (onReady)
    // before posting `ready`, so no RPC the host sends on `ready` can arrive before a listener exists.
    const order: string[] = [];
    const onReady = vi.fn(() => order.push('onReady'));
    const emit = (s: WorkerSignal) => order.push(`emit:${s.type}`);
    const ft = fakeTimers();

    broadcastBootSignal(Promise.resolve(), emit, 20_000, onReady, ft.timers);
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(['onReady', 'emit:ready']);
  });

  it('emits `boot-failure` with the error message when boot rejects', async () => {
    const signals: WorkerSignal[] = [];
    const ft = fakeTimers();

    broadcastBootSignal(
      Promise.reject(new Error('create exploded')),
      (s) => signals.push(s),
      20_000,
      () => {},
      ft.timers,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(signals).toEqual([{ type: 'boot-failure', error: 'create exploded' }]);
  });

  it('fires a watchdog `boot-failure` when boot never settles (the #357 hang) and never signals ready', () => {
    const signals: WorkerSignal[] = [];
    const onReady = vi.fn();
    const ft = fakeTimers();

    broadcastBootSignal(new Promise(() => {}), (s) => signals.push(s), 20_000, onReady, ft.timers);
    ft.fire(); // simulate the watchdog timeout

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ type: 'boot-failure' });
    expect((signals[0] as { error: string }).error).toContain('did not settle');
    expect(onReady).not.toHaveBeenCalled();
  });

  it('emits exactly once — a late boot resolution after the watchdog fired is ignored', async () => {
    const signals: WorkerSignal[] = [];
    const ft = fakeTimers();
    let resolveBoot!: () => void;
    const boot = new Promise<void>((res) => {
      resolveBoot = res;
    });

    broadcastBootSignal(boot, (s) => signals.push(s), 20_000, () => {}, ft.timers);
    ft.fire(); // watchdog fires first
    resolveBoot(); // boot resolves late
    await Promise.resolve();
    await Promise.resolve();

    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('boot-failure');
  });
});
