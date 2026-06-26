// Tests for the Studio "Stop" affordance handler (#353): it terminates the WASM worker and boots a
// fresh one via the worker client's hard-cancel primitive, and is a no-op when no worker is booted.
import { afterEach, describe, expect, it, vi } from 'vitest';

// getWasmWorkerClient() is the seam (wasm.ts) the handler reads. Default null → main-thread/pre-boot.
const wasmState = vi.hoisted(() => ({ workerClient: null as unknown }));
vi.mock('@/host/browser/wasm', () => ({
  getWasmWorkerClient: () => wasmState.workerClient,
}));

import { canStopCompile, stopRunawayCompile } from '@/host/browser/stopCompile';

describe('Studio Stop affordance (#353)', () => {
  afterEach(() => {
    wasmState.workerClient = null;
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

  it('canStopCompile() reflects whether a cancellable worker exists', () => {
    wasmState.workerClient = null;
    expect(canStopCompile()).toBe(false);

    wasmState.workerClient = { terminateAndRespawn: vi.fn() };
    expect(canStopCompile()).toBe(true);
  });
});
