// Worker boot watchdog (issue #357). Extracted from koine.worker.ts so it can be unit-tested without
// triggering the worker module's top-level boot side effects.
//
// The worker boots the .NET runtime, then broadcasts exactly one signal to the host: `ready` on
// success or `boot-failure` on failure. But `dotnet.create()` can HANG inside a worker (it neither
// resolves nor rejects), leaving the host to wait out its own 30 s timeout with no diagnostic. The
// watchdog converts that silent infinite hang into an explicit `boot-failure` so the host falls back
// promptly and the failure is named.

import type { WorkerSignal } from './workerClient';

/** Injectable timers so tests can drive the watchdog without real time. */
export interface WatchdogTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const realTimers: WatchdogTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Broadcast exactly ONE boot signal for `boot`:
 *  - `ready` when it resolves — AFTER `onReady()` runs, so the worker wires its message loop before
 *    the host is told it is up (no RPC is sent before `ready`);
 *  - `boot-failure` when it rejects (carrying the error message);
 *  - OR a watchdog `boot-failure` if it does neither within `timeoutMs` (the #357 hang).
 *
 * Idempotent: whichever outcome lands first wins; a late settle after the watchdog fired is ignored.
 */
export function broadcastBootSignal(
  boot: Promise<unknown>,
  emit: (signal: WorkerSignal) => void,
  timeoutMs: number,
  onReady: () => void = () => {},
  timers: WatchdogTimers = realTimers,
): void {
  let settled = false;
  const finish = (signal: WorkerSignal, ready: boolean): void => {
    if (settled) return;
    settled = true;
    timers.clearTimeout(handle);
    if (ready) onReady();
    emit(signal);
  };

  const handle = timers.setTimeout(() => {
    finish(
      {
        type: 'boot-failure',
        error: `Koine WASM runtime did not finish booting within ${timeoutMs / 1000}s (dotnet.create did not settle)`,
      },
      false,
    );
  }, timeoutMs);

  boot.then(
    () => finish({ type: 'ready' }, true),
    (err) => finish({ type: 'boot-failure', error: err instanceof Error ? err.message : String(err) }, false),
  );
}
