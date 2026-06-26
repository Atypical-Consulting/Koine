// The Studio "Stop" affordance (#353): abandon a runaway compile by terminating the WASM worker and
// booting a fresh one. It consumes the worker client's hard-cancel primitive (terminateAndRespawn),
// exposed by wasm.ts via getWasmWorkerClient(). A no-op in the main-thread fallback or before boot,
// where there is no worker to terminate (getWasmWorkerClient() returns null). The fresh worker
// re-establishes its ready state lazily — the next LSP call awaits it — so this is fire-and-forget.
// Additive: no public API change, no [JSExport] / bundle change.
import { getWasmWorkerClient } from '@/host/browser/wasm';
import { isCompileInFlight } from '@/host/browser/compileActivity';

/**
 * True when the Stop affordance applies: a cancellable worker exists (the worker boot path) AND a
 * compile is actually in flight (#469). Gating on a worker alone offered the command the whole session,
 * so an idle Stop pointlessly terminated + re-instantiated the multi-MB WASM runtime; gating on
 * in-flight matches the docs-site playground, whose Stop is hidden unless a compile is running. In the
 * main-thread fallback (or before boot) there is no worker to terminate, so Stop stays hidden.
 */
export function canStopCompile(): boolean {
  return getWasmWorkerClient() !== null && isCompileInFlight();
}

/**
 * Abandon a runaway compile: terminate the worker and boot a fresh one. No-op when no worker is booted.
 */
export function stopRunawayCompile(): void {
  getWasmWorkerClient()?.terminateAndRespawn();
}
