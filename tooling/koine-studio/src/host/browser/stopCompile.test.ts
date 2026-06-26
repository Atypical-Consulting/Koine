// Tests for the Studio "Stop" affordance handler (#353): it terminates the WASM worker and boots a
// fresh one via the worker client's hard-cancel primitive, and is a no-op when no worker is booted.
import { afterEach, describe, expect, it, vi } from 'vitest';

// getWasmWorkerClient() is the seam (wasm.ts) the handler reads. Default null → main-thread/pre-boot.
const wasmState = vi.hoisted(() => ({ workerClient: null as unknown }));
vi.mock('@/host/browser/wasm', () => ({
  getWasmWorkerClient: () => wasmState.workerClient,
}));

// compileActivity is the real module (#469): canStopCompile() now ANDs in isCompileInFlight(), so the
// tests drive a compile in/out of flight through the real start/end helpers.
import { isCompileInFlight, markCompileEnd, markCompileStart } from '@/host/browser/compileActivity';
import { canStopCompile, stopRunawayCompile } from '@/host/browser/stopCompile';

describe('Studio Stop affordance (#353)', () => {
  afterEach(() => {
    wasmState.workerClient = null;
    // Drain any compile left in flight so the module-level counter can't leak between tests.
    while (isCompileInFlight()) markCompileEnd();
  });

  it('stopRunawayCompile() calls terminateAndRespawn() on the booted worker client', () => {
    const terminateAndRespawn = vi.fn();
    wasmState.workerClient = { terminateAndRespawn };

    stopRunawayCompile();

    expect(terminateAndRespawn).toHaveBeenCalledTimes(1);
  });

  it('stopRunawayCompile() is a no-op when no worker client is booted (main-thread fallback / pre-boot)', () => {
    wasmState.workerClient = null;
    expect(() => stopRunawayCompile()).not.toThrow();
  });

  it('canStopCompile() requires BOTH a cancellable worker AND a compile in flight (#469)', () => {
    // No worker, no compile → nothing to stop.
    wasmState.workerClient = null;
    expect(canStopCompile()).toBe(false);

    // Worker booted but idle (no compile) → still hidden: an idle Stop would needlessly restart it.
    wasmState.workerClient = { terminateAndRespawn: vi.fn() };
    expect(canStopCompile()).toBe(false);

    // Worker booted AND a compile in flight → offered.
    markCompileStart();
    expect(canStopCompile()).toBe(true);

    // Compile settles → hidden again.
    markCompileEnd();
    expect(canStopCompile()).toBe(false);
  });

  it('canStopCompile() stays false during an in-flight compile when no worker is booted (main-thread fallback)', () => {
    wasmState.workerClient = null;
    markCompileStart();
    expect(canStopCompile()).toBe(false); // no worker to terminate, even mid-compile
    markCompileEnd();
  });
});
