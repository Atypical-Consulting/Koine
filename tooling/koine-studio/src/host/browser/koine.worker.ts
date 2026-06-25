// Koine.Wasm Web Worker module. Boots the .NET runtime once inside the worker (off the UI thread),
// then runs the message loop. No DOM is available here, so dotnet.js is loaded via a worker-side
// dynamic `import(/* @vite-ignore */ url)` — the same technique the playground's koine.ts uses.
// The worker is always created with `{ type: 'module' }` so ESM `import()` is available.
//
// Wire protocol (mirrors workerClient.ts):
//   In  → { id: number; method: string; args: unknown[] }
//   Out ← { id: number; ok: true; result: string }
//        | { id: number; ok: false; error: string }
//   Broadcast ← { type: 'ready' }
//              | { type: 'boot-failure'; error: string }

import type { WorkerRequest, WorkerResponse, WorkerSignal } from './workerClient';
import { broadcastBootSignal } from './bootWatchdog';
import { dotnetEntryUrl } from './dotnetAsset';

/**
 * Watchdog ceiling for the in-worker runtime boot. If `dotnet.create()` neither resolves nor rejects
 * within this window (issue #357 — a silent hang), the worker posts an explicit `boot-failure` so the
 * host falls back promptly instead of waiting out its own 30 s timer with no diagnostic. A healthy
 * boot completes in well under a second once the bundle is cached.
 */
const BOOT_WATCHDOG_MS = 20_000;

// ---------------------------------------------------------------------------
// Boot the .NET runtime once.
// ---------------------------------------------------------------------------

type InteropSurface = Record<string, (...args: unknown[]) => string>;

let interopPromise: Promise<InteropSurface> | null = null;

function bootRuntime(): Promise<InteropSurface> {
  if (interopPromise) return interopPromise;
  interopPromise = (async (): Promise<InteropSurface> => {
    // Worker-side dynamic import of the published dotnet.js loader. `@vite-ignore` stops Vite from
    // statically rewriting/resolving the specifier at build time; under the dev server
    // `koineWasmDevPlugin` (vite.config.ts) serves this `?import` request as a raw /public asset (200),
    // so the worker fast-path actually boots in dev instead of 500-ing on ERR_LOAD_PUBLIC_URL and
    // forcing the main-thread fallback every time (issue #384).
    const mod = await import(/* @vite-ignore */ dotnetEntryUrl()) as Record<string, unknown>;
    const dotnet = mod.dotnet as { create(): Promise<unknown> };
    const runtime = await dotnet.create() as {
      getConfig(): { mainAssemblyName: string };
      getAssemblyExports(name: string): Promise<Record<string, unknown>>;
    };
    const config = runtime.getConfig();
    const exports = await runtime.getAssemblyExports(config.mainAssemblyName);
    return (exports as { Koine: { Wasm: { CompilerInterop: InteropSurface } } })
      .Koine.Wasm.CompilerInterop;
  })();
  return interopPromise;
}

// ---------------------------------------------------------------------------
// Message loop: dispatch { id, method, args } → { id, ok, result/error }.
// ---------------------------------------------------------------------------

/** Dispatch one `{ id, method, args }` request → `{ id, ok, result/error }` reply. */
async function handleMessage(ev: MessageEvent<WorkerRequest>): Promise<void> {
  const { id, method, args } = ev.data;
  try {
    const interop = await bootRuntime();
    const fn = interop[method];
    if (typeof fn !== 'function') {
      throw new Error(`Koine WASM export "${method}" is not a function`);
    }
    const result = fn(...args);
    self.postMessage({ id, ok: true, result } satisfies WorkerResponse);
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    self.postMessage({ id, ok: false, error } satisfies WorkerResponse);
  }
}

// ---------------------------------------------------------------------------
// Boot, then wire the message loop and broadcast ready / boot-failure.
//
// CRITICAL (issue #357): the message loop is installed via `addEventListener('message', …)` AFTER the
// runtime has booted — NOT as a top-level `self.onmessage = …`. Assigning `self.onmessage`
// synchronously at worker startup clobbers the `message` channel the .NET WebAssembly runtime relies
// on while `dotnet.create()` boots inside a Worker, which deadlocks the boot: `import(dotnet.js)`
// resolves but `create()` never settles (no ready, no failure). Wiring the handler only once boot has
// resolved leaves that channel untouched during the boot. The host sends RPC only after it receives
// `ready`, so installing the handler just before `ready` loses no messages.
// ---------------------------------------------------------------------------

broadcastBootSignal(
  bootRuntime(),
  (signal: WorkerSignal) => self.postMessage(signal),
  BOOT_WATCHDOG_MS,
  () => self.addEventListener('message', (ev: MessageEvent) => void handleMessage(ev as MessageEvent<WorkerRequest>)),
);
