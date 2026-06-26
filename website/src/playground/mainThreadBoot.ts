// Main-thread compiler boot for the Playground (#510). Wired as createKoineWorkerClient's
// `fallbackBoot` so that when the worker never reaches `ready` (it hangs past the boot budget, or the
// watchdog posts `boot-failure`), the compiler still comes up — on the UI thread. It may briefly jank
// the page on a big compile, but a working Playground beats a broken one. The worker stays the FAST
// path; this is only the safety net. Mirrors Studio's wasm.ts main-thread fallback (loadWasmApi).
//
// No DOM-specific loader is needed: this reuses the worker's proven `import(/* @vite-ignore */ url)`
// technique (koine.worker.ts) off-worker, and derives the dotnet.js URL from the SAME base helper as
// the worker and the service worker (#369 / #328 / #362) — never re-deriving `BASE_URL` inline.

import type { FallbackCall } from './workerClient';
import { basePath } from '../lib/base';

/** Base-aware URL of the published dotnet.js loader (respects Astro's base, e.g. `/Koine/`). */
function dotnetEntryUrl(): string {
  return `${basePath()}/koine-wasm/_framework/dotnet.js`;
}

type InteropSurface = Record<string, (...args: unknown[]) => string>;

/**
 * The raw dynamic-import primitive, isolated behind a seam so tests can stub it without executing a
 * real `import()` of dotnet.js (absent in a Node test env). Mirrors the worker's
 * `import(/* @vite-ignore *​/ url)`.
 */
type EsModuleImporter = (url: string) => Promise<Record<string, unknown>>;
const defaultImporter: EsModuleImporter = (url) =>
  import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>;
let esModuleImporter: EsModuleImporter = defaultImporter;

/** @internal Test seam — override the dynamic-import primitive. Pass `null` to restore the default. */
export function __setDotnetImporterForTests(importer: EsModuleImporter | null): void {
  esModuleImporter = importer ?? defaultImporter;
}

/** Boot the .NET runtime ON THE MAIN THREAD and resolve the compiler's [JSExport] interop surface. */
async function bootMainThreadInterop(): Promise<InteropSurface> {
  const mod = await esModuleImporter(dotnetEntryUrl());
  const dotnet = mod.dotnet as { create(): Promise<unknown> };
  const runtime = (await dotnet.create()) as {
    getConfig(): { mainAssemblyName: string };
    getAssemblyExports(name: string): Promise<Record<string, unknown>>;
  };
  const config = runtime.getConfig();
  const exports = await runtime.getAssemblyExports(config.mainAssemblyName);
  return (exports as { Koine: { Wasm: { CompilerInterop: InteropSurface } } }).Koine.Wasm.CompilerInterop;
}

/**
 * `fallbackBoot` for {@link createKoineWorkerClient}: boot the compiler on the main thread and expose a
 * `call(method, args)` surface mirroring the worker's RPC shape, so the client can route calls to it
 * transparently. An unknown export rejects with the same message the worker uses, so callers see one
 * consistent error regardless of which boot path served the call.
 */
export async function bootMainThreadCompiler(): Promise<FallbackCall> {
  const interop = await bootMainThreadInterop();
  return (method: string, args: unknown[]): Promise<string> => {
    const fn = interop[method];
    if (typeof fn !== 'function') {
      return Promise.reject(new Error(`Koine WASM export "${method}" is not a function`));
    }
    try {
      return Promise.resolve(fn(...args));
    } catch (err: unknown) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  };
}
