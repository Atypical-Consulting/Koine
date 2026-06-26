// The Studio "Stop" affordance (#353): abandon a runaway compile by terminating the WASM worker and
// booting a fresh one. It consumes the worker client's hard-cancel primitive (terminateAndRespawn),
// exposed by wasm.ts via getWasmWorkerClient(). A no-op in the main-thread fallback or before boot,
// where there is no worker to terminate (getWasmWorkerClient() returns null). The fresh worker
// re-establishes its ready state lazily — the next LSP call awaits it — so this is fire-and-forget.
// Additive: no public API change, no [JSExport] / bundle change.
import { getWasmWorkerClient } from '@/host/browser/wasm';

/**
 * True when a cancellable worker exists (the worker boot path), i.e. when the Stop affordance applies.
 * In the main-thread fallback (or before boot) there is no worker to terminate, so Stop is hidden.
 */
export function canStopCompile(): boolean {
  return getWasmWorkerClient() !== null;
}

/**
 * Abandon a runaway compile: terminate the worker and boot a fresh one. No-op when no worker is booted.
 */
export function stopRunawayCompile(): void {
  getWasmWorkerClient()?.terminateAndRespawn();
}
