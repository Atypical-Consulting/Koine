// Koine.Wasm Web Worker module for the playground. Boots the .NET runtime once inside the worker
// (off the UI thread), then runs the message loop. No DOM is available here, so dotnet.js is loaded
// via a worker-side dynamic `import(/* @vite-ignore */ url)` — the same technique the playground's
// koine.ts used before this worker was introduced.
// The worker is always created with `{ type: 'module' }` so ESM `import()` is available.
//
// NOTE: This is an intentional, plan-sanctioned copy of the Studio worker design.
// The website/ and tooling/koine-studio/ are separate Vite build roots; cross-package imports
// would cause `new URL('./koine.worker.ts', import.meta.url)` and `import.meta.env.BASE_URL`
// to resolve against the wrong package root. The plan explicitly permits a playground-local copy.
//
// Wire protocol (mirrors workerClient.ts):
//   In  → { id: number; method: string; args: unknown[] }
//   Out ← { id: number; ok: true; result: string }
//        | { id: number; ok: false; error: string }
//   Broadcast ← { type: 'ready' }
//              | { type: 'boot-failure'; error: string }

import type { WorkerRequest, WorkerResponse, WorkerSignal } from './workerClient';

/** Base-aware URL of the published dotnet.js loader (respects Astro's base, e.g. `/Koine/`). */
function dotnetEntryUrl(): string {
  const base = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
  return `${base}/koine-wasm/_framework/dotnet.js`;
}

// ---------------------------------------------------------------------------
// Boot the .NET runtime once.
// ---------------------------------------------------------------------------

type InteropSurface = Record<string, (...args: unknown[]) => string>;

let interopPromise: Promise<InteropSurface> | null = null;

function bootRuntime(): Promise<InteropSurface> {
  if (interopPromise) return interopPromise;
  interopPromise = (async (): Promise<InteropSurface> => {
    // Worker-side dynamic import — Vite must NOT try to resolve this public-asset URL at build time.
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
// Boot and post the ready / boot-failure signal.
// ---------------------------------------------------------------------------

bootRuntime()
  .then(() => {
    self.postMessage({ type: 'ready' } satisfies WorkerSignal);
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ type: 'boot-failure', error: message } satisfies WorkerSignal);
  });

// ---------------------------------------------------------------------------
// Message loop: dispatch { id, method, args } → { id, ok, result/error }.
// ---------------------------------------------------------------------------

self.onmessage = async (ev: MessageEvent<WorkerRequest>): Promise<void> => {
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
};
