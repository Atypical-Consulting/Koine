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

import type { WorkerRequest, WorkerResponse } from './workerClient';
import { broadcastBootSignal } from './bootWatchdog';
import { basePath } from '../lib/base';

/**
 * Watchdog budget for the in-worker boot (#510). If `dotnet.create()` neither resolves nor rejects
 * within this window, the watchdog posts an explicit `boot-failure` so the host fails fast — and falls
 * back to a main-thread boot — instead of waiting out its own 30 s timer with no diagnostic. Kept under
 * the host's `BOOT_TIMEOUT_MS = 30_000` so the named watchdog failure wins the race on a silent hang.
 */
const BOOT_WATCHDOG_MS = 20_000;

/** Base-aware URL of the published dotnet.js loader (respects Astro's base, e.g. `/Koine/`). */
function dotnetEntryUrl(): string {
  const base = basePath();
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
// CRITICAL (issues #357 / #358 / #492): the message loop is installed via
// `self.addEventListener('message', …)` AFTER the runtime has booted — NOT as a top-level
// `self.onmessage = …`. Assigning `self.onmessage` synchronously at worker startup clobbers the
// `message` channel the .NET WebAssembly runtime relies on while `dotnet.create()` boots inside a
// Worker, which deadlocks the boot: `import(dotnet.js)` resolves but `create()` never settles (no
// ready, no failure), so the host waits out its 30s timer ("Koine worker timed out after 30s"). This
// is the exact #357/#358 Studio hang; it was re-introduced on this website copy as #492. Wiring the
// handler only once boot has resolved leaves that channel untouched during boot. The host sends RPC
// only after it receives `ready`, so installing the handler just before `ready` loses no messages.
// (Mirrors tooling/koine-studio/src/host/browser/koine.worker.ts.)
//
// The watchdog (broadcastBootSignal, #510) drives that contract: it runs `onReady` — which installs
// the `addEventListener('message', …)` loop — BEFORE posting `ready`, posts `boot-failure` if the boot
// rejects, and converts a silent `dotnet.create()` hang into a named `boot-failure` after the budget.
// ---------------------------------------------------------------------------

broadcastBootSignal(
  bootRuntime(),
  (signal) => self.postMessage(signal),
  BOOT_WATCHDOG_MS,
  () =>
    self.addEventListener('message', (ev: MessageEvent) => void handleMessage(ev as MessageEvent<WorkerRequest>)),
);
