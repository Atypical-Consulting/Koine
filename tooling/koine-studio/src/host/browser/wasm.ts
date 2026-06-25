// Loads the Koine.Wasm compiler module in a Web Worker (off the UI thread) and exposes its
// [JSExport] language-service surface as an async proxy. The bundle (_framework/dotnet.js +
// assemblies) is published by scripts/build-wasm.mjs into public/koine-wasm/, so it is served as
// a static asset at `${BASE_URL}koine-wasm/`. The worker boots the .NET runtime via a worker-side
// dynamic import (no DOM needed), then posts a `ready` signal. The main thread talks to it over a
// typed id-correlated request/response protocol implemented in workerClient.ts.

import { createKoineWorkerClient, type WorkerClient } from '@/host/browser/workerClient';
import { dotnetEntryUrl } from '@/host/browser/dotnetAsset';

/** The JS-callable language-service surface (matches src/Koine.Wasm/CompilerInterop.LanguageService.cs). */
export interface KoineWasmApi {
  /** Diagnose the merged workspace → JSON `[{uri, diagnostics:[lsp]}]`. */
  DiagnoseWorkspace(filesJson: string): Promise<string>;
  /** Emit-preview the merged workspace for a target → JSON EmitPreviewResult. */
  EmitPreview(filesJson: string, target: string): Promise<string>;
  /** The registry's emit-target capability list → JSON `{ targets:[{id,displayName,fileExtension}] }` (#282). */
  ListEmitTargets(): Promise<string>;
  /** Glossary markdown for the merged workspace → JSON `{markdown}`. */
  Glossary(filesJson: string): Promise<string>;
  /** Structured glossary for the merged workspace → JSON `{entries}`. */
  GlossaryModel(filesJson: string): Promise<string>;
  /** Structured model graph (whole tree, or the subtree at `qname`) → JSON ModelNode (#91). */
  Model(filesJson: string, qname: string | null): Promise<string>;
  /** Editable children of the node at `qname` → JSON `{members}` (#91). */
  ModelMembers(filesJson: string, qname: string): Promise<string>;
  /** Apply a structured edit → JSON `{koine, diagnostics}` (#91). */
  EmitKoine(filesJson: string, editJson: string): Promise<string>;
  /** Apply a structured edit → JSON `{uri, edits, diagnostics}` (#91). */
  ApplyModelEdit(filesJson: string, editJson: string): Promise<string>;
  /** Strategic context map → JSON `{contexts, relations}`. */
  ContextMap(filesJson: string): Promise<string>;
  /** Set a declaration's doc comment by id → JSON `{uri, edits:[TextEdit]}`. */
  SetDoc(filesJson: string, id: string, text: string): Promise<string>;
  /** Hover at a 0-based position → JSON Hover or `null`. */
  Hover(filesJson: string, activeUri: string, line: number, character: number): Promise<string>;
  /** IntelliSense completions at a 0-based position → JSON CompletionList. */
  Completions(filesJson: string, activeUri: string, line: number, character: number): Promise<string>;
  /** Go-to-definition at a 0-based position → JSON Location or `null`. */
  Definition(filesJson: string, activeUri: string, line: number, character: number): Promise<string>;
  /** Signature help at a 0-based position → JSON SignatureHelp or `null`. */
  SignatureHelp(filesJson: string, activeUri: string, line: number, character: number): Promise<string>;
  /** Workspace-wide symbol search → JSON SymbolInformation[] (subsequence-matches `query`). */
  WorkspaceSymbols(filesJson: string, query: string): Promise<string>;
  /** Single-file document outline → JSON DocumentSymbol[]. */
  DocumentSymbols(source: string): Promise<string>;
  /** Collapsible regions of a single file → JSON FoldingRange[] (`{startLine,endLine}`). */
  FoldingRanges(source: string): Promise<string>;
  /** Selection-range chains for a set of 0-based positions → JSON SelectionRange[] (parallel). */
  SelectionRanges(source: string, positionsJson: string): Promise<string>;
  /** Code lenses of the active document → JSON CodeLens[] (`{range, title}`, reference counts). */
  CodeLenses(filesJson: string, activeUri: string): Promise<string>;
  /** Canonical formatting edits → JSON TextEdit[]. */
  Format(source: string): Promise<string>;
  /** Compatibility of current vs baseline workspace → JSON CheckResult. */
  Check(currentFilesJson: string, baselineFilesJson: string): Promise<string>;
  /** Every reference to the name at a 0-based position → JSON Location[]. */
  References(filesJson: string, activeUri: string, line: number, character: number): Promise<string>;
  /** Editable identifier range under the cursor → JSON `{range, placeholder}` or `null`. */
  PrepareRename(filesJson: string, activeUri: string, line: number, character: number): Promise<string>;
  /** Workspace edit renaming the symbol under the cursor → JSON WorkspaceEdit or `null`. */
  Rename(filesJson: string, activeUri: string, line: number, character: number, newName: string): Promise<string>;
  /** Quickfixes + refactors for a 0-based range → JSON CodeAction[]. */
  CodeActions(
    filesJson: string,
    activeUri: string,
    startLine: number,
    startChar: number,
    endLine: number,
    endChar: number,
    diagnosticsJson: string,
  ): Promise<string>;
  /** Living-documentation files (Mermaid-in-Markdown) for the merged workspace → JSON `{files}`. */
  Docs(filesJson: string): Promise<string>;
  /** Run a scenario (#149) → JSON ScenarioResult (command → events → invariant-checks). */
  RunScenario(filesJson: string, target: string, operation: string, givenJson: string, argsJson: string): Promise<string>;
  /** Runnable surface of the workspace (#149) → JSON ScenarioCatalog (`{targets}`). */
  ScenarioCatalog(filesJson: string): Promise<string>;
  /** Inlay hints (type/parameter annotations) for a 0-based range → JSON InlayHint[]. */
  InlayHints(
    filesJson: string,
    activeUri: string,
    startLine: number,
    startChar: number,
    endLine: number,
    endChar: number,
  ): Promise<string>;
  /** Prepare call hierarchy at a 0-based position → JSON CallHierarchyItem[]. */
  PrepareCallHierarchy(filesJson: string, activeUri: string, line: number, character: number): Promise<string>;
  /** Incoming calls into a CallHierarchyItem (passed as JSON) → JSON CallHierarchyIncomingCall[]. */
  IncomingCalls(filesJson: string, itemJson: string): Promise<string>;
  /** Outgoing calls from a CallHierarchyItem (passed as JSON) → JSON CallHierarchyOutgoingCall[]. */
  OutgoingCalls(filesJson: string, itemJson: string): Promise<string>;
}

/**
 * Every [JSExport] method the compiler bundle is expected to provide. This set is the single source of
 * truth and it must be COMPLETE: `buildWorkerProxy` forwards a call only when the method name is in
 * this set (a name not here resolves to `undefined`, i.e. an unforwarded method), and `guardWasmSurface`
 * flags a known export name that failed to resolve as a stale bundle. Any other property access (`then`,
 * `toString`, `catch`, …) passes through untouched.
 *
 * Completeness is **compiler-enforced**: the source map is typed `Record<keyof KoineWasmApi, true>`, so
 * adding a method to `KoineWasmApi` without listing it here is a `tsc` error (and vice-versa). This
 * prevents the silent drift where a real export is omitted and its feature stops being forwarded.
 */
const KOINE_WASM_EXPORT_MAP: Record<keyof KoineWasmApi, true> = {
  DiagnoseWorkspace: true,
  EmitPreview: true,
  ListEmitTargets: true,
  Glossary: true,
  GlossaryModel: true,
  Model: true,
  ModelMembers: true,
  EmitKoine: true,
  ApplyModelEdit: true,
  ContextMap: true,
  SetDoc: true,
  Hover: true,
  Completions: true,
  Definition: true,
  SignatureHelp: true,
  WorkspaceSymbols: true,
  DocumentSymbols: true,
  FoldingRanges: true,
  SelectionRanges: true,
  CodeLenses: true,
  Format: true,
  Check: true,
  References: true,
  PrepareRename: true,
  Rename: true,
  CodeActions: true,
  Docs: true,
  RunScenario: true,
  ScenarioCatalog: true,
  InlayHints: true,
  PrepareCallHierarchy: true,
  IncomingCalls: true,
  OutgoingCalls: true,
};

const KOINE_WASM_EXPORTS: ReadonlySet<string> = new Set(Object.keys(KOINE_WASM_EXPORT_MAP));

let apiPromise: Promise<KoineWasmApi> | null = null;
let workerClientInstance: WorkerClient | null = null;

/** Which boot path produced the live compiler surface (issue #357). */
export type WasmBootMode = 'worker' | 'main-thread';
let bootMode: WasmBootMode | null = null;

/** The boot path that produced the live compiler surface, or `null` before `loadWasmApi()` resolves. */
export function getWasmBootMode(): WasmBootMode | null {
  return bootMode;
}

/** Pattern that the worker emits for an export that isn't a function on the interop surface. */
const WORKER_MISSING_EXPORT_RE = /^Koine WASM export "([^"]+)" is not a function$/;

/**
 * Wrap the worker client so calling a method the bundle doesn't export fails with an actionable
 * message instead of a bare `Error: Koine WASM export "X" is not a function`. The bundle in
 * `public/koine-wasm/` is generated by `npm run build:wasm` (auto-run by the `predev:web` /
 * `prebuild:web` hooks) and goes stale whenever CompilerInterop.LanguageService.cs gains a new
 * [JSExport] — so a missing method means "rebuild the bundle", which is what we say.
 *
 * Property access for non-exports (`then`, `toString`, …) must still pass through untouched —
 * the Promise resolution machinery probes `value.then` to decide if the resolved value is a
 * thenable, so returning a throwing function there would make the language-server boot reject.
 */
export function guardWasmSurface(raw: Record<string, unknown>): KoineWasmApi {
  return new Proxy(raw, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      // Only a *known* export name that didn't resolve to a function is treated as a stale-bundle
      // call site. Everything else passes through untouched — crucially `then`: the Promise that
      // resolves to this proxy probes `proxy.then` to decide if it's a thenable, so returning a
      // throwing function there would make the whole language-server boot reject with a bogus
      // `export "then" is missing`. Symbols and non-export strings (toString, catch, …) likewise
      // pass through.
      if (typeof prop !== 'string' || typeof value === 'function' || !KOINE_WASM_EXPORTS.has(prop))
        return value;
      return () => {
        throw new Error(
          `Koine WASM export "${prop}" is missing — the compiler bundle in public/koine-wasm/ is ` +
            `stale. Rebuild it with: npm run build:wasm`,
        );
      };
    },
  }) as unknown as KoineWasmApi;
}

/**
 * Build a `KoineWasmApi` proxy whose every known method forwards to `client.call(name, args)`.
 * A call to a known export that the worker rejects as missing (the worker throws
 * `Koine WASM export "<method>" is not a function`) is re-raised as the stale-bundle message so
 * callers see the same actionable error they would from `guardWasmSurface`.
 *
 * Property access for non-exports (`then`, `toString`, …) must pass through untouched — see the
 * thenable-probe comment in `guardWasmSurface`.
 */
function buildWorkerProxy(call: (method: string, args: unknown[]) => Promise<string>): KoineWasmApi {
  const handler: ProxyHandler<object> = {
    get(_target, prop, _receiver) {
      // Pass through symbols and non-export strings (then, toString, catch, …) without wrapping.
      // This is critical: the Promise machinery probes `.then` on the resolved value to decide
      // if it's a thenable — intercepting it would cause the boot to reject spuriously.
      if (typeof prop !== 'string' || !KOINE_WASM_EXPORTS.has(prop)) {
        return undefined;
      }
      // Return an async function that forwards the call to the worker client.
      return (...args: unknown[]): Promise<string> =>
        call(prop, args).catch((err: unknown) => {
          // If the worker reports the export as missing, surface the stale-bundle message.
          const message = err instanceof Error ? err.message : String(err);
          const match = WORKER_MISSING_EXPORT_RE.exec(message);
          if (match) {
            throw new Error(
              `Koine WASM export "${match[1]}" is missing — the compiler bundle in public/koine-wasm/ is ` +
                `stale. Rebuild it with: npm run build:wasm`,
            );
          }
          throw err;
        });
    },
  };
  return new Proxy({}, handler) as unknown as KoineWasmApi;
}

// ---------------------------------------------------------------------------
// Main-thread fallback boot (issue #357).
//
// The worker boot is the fast path (off the UI thread, cancellable). But a failed worker boot must
// NEVER brick the studio, so `loadWasmApi()` falls back to booting the runtime ON THE MAIN THREAD —
// the path the studio used before #326, which boots reliably. The compiler is then usable (it may
// jank the UI on a big compile, but it works) instead of dead with "connection failed".
// ---------------------------------------------------------------------------

let loaderSeq = 0;

/**
 * Blind-timeout ceiling for the inline-`<script>` loader. The inline path only fetches + parses the
 * small dotnet.js *loader* (the multi-MB runtime downloads later, in `dotnet.create()`), so a few
 * seconds is plenty. Kept well under the worker's 20 s watchdog so a CSP-blocked or unparseable inline
 * script fails FAST with an actionable error instead of stalling the boot for the old 30 s (issue #359).
 */
const INLINE_LOADER_TIMEOUT_MS = 8_000;

/**
 * Import the dotnet.js ES module by URL via an injected inline module script. This is the DEV-SERVER
 * fallback only (see `importDotnetModule`): under Vite's dev server a direct dynamic import of a
 * `public/` asset is routed through the module-transform pipeline (the `?import` suffix) and fails on
 * the machine-generated loader, whereas an inline `<script type="module">` is invisible to Vite so the
 * browser fetches dotnet.js — and its relative dependencies — as raw static files. (Restored from the
 * pre-#326 main-thread boot.)
 *
 * Two ways it fails *slowly* (issue #359), which is why it's the fallback and not the primary path: a
 * strict Content-Security-Policy that forbids inline scripts blocks it with no callback at all, and an
 * inline module script raises no DOM `error` event on a parse/load failure — both stall until the
 * timeout below, which is therefore kept short and rejects with a cause-naming message.
 */
function importEsModuleViaScript(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = `__koineDotnet_${++loaderSeq}`;
    const w = window as unknown as Record<string, unknown>;
    const cleanup = () => {
      delete w[id];
      delete w[`${id}_err`];
    };
    w[id] = (mod: Record<string, unknown>) => {
      cleanup();
      resolve(mod);
    };
    w[`${id}_err`] = (message: string) => {
      cleanup();
      reject(new Error(message));
    };
    const script = document.createElement('script');
    script.type = 'module';
    // The inline module is never seen by Vite; its own `import()` is a plain browser fetch.
    script.textContent =
      `import(${JSON.stringify(url)}).then(` +
      `m => window.${id}(m), e => window.${id}_err(String((e && e.message) || e)));`;
    script.addEventListener('error', () => {
      cleanup();
      reject(new Error(`failed to load ${url}`));
    });
    document.head.appendChild(script);
    // Safety net: an inline module script raises no DOM `error` event on a parse/load failure, and a
    // CSP that blocks inline scripts fires no callback at all — so without this the boot would hang.
    // Reject fast with a cause-naming message instead (issue #359).
    setTimeout(() => {
      if (w[id]) {
        cleanup();
        reject(
          new Error(
            `timed out loading ${url} after ${INLINE_LOADER_TIMEOUT_MS / 1000}s via the inline-script ` +
              `loader — a Content-Security-Policy blocking inline scripts, or a parse/load error in ` +
              `dotnet.js, prevents it from settling.`,
          ),
        );
      }
    }, INLINE_LOADER_TIMEOUT_MS);
  });
}

/**
 * The raw dynamic-import primitive, isolated behind a seam so tests can stub it without executing a
 * real `import()` (which would try to fetch the non-existent dotnet.js URL). Mirrors the worker's
 * proven `import(/* @vite-ignore *​/ url)` (koine.worker.ts).
 */
type EsModuleImporter = (url: string) => Promise<Record<string, unknown>>;
const defaultEsModuleImporter: EsModuleImporter = (url) =>
  import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>;
let esModuleImporter: EsModuleImporter = defaultEsModuleImporter;

/** @internal Test seam — override the raw dynamic-import primitive. Pass `null` to restore. */
export function __setEsModuleImporterForTests(importer: EsModuleImporter | null): void {
  esModuleImporter = importer ?? defaultEsModuleImporter;
}

/**
 * Acquire the dotnet.js ES module for the main-thread fallback — CSP-safe and fast-failing (issue #359):
 *  1. Try a direct `import(/* @vite-ignore *​/ url)` — the same CSP-neutral path the worker already
 *     uses. In the built / deployed bundle (the only place that matters for production) this succeeds
 *     and never touches the DOM, so a strict CSP can't block it and it fails fast on a real load error.
 *  2. Only if that throws (Vite's dev-server public-asset transform breaks a direct app-code import)
 *     fall back to the inline-`<script>` loader, which is invisible to Vite's transform.
 */
async function importDotnetModule(url: string): Promise<Record<string, unknown>> {
  try {
    return await esModuleImporter(url);
  } catch (directErr: unknown) {
    const reason = directErr instanceof Error ? directErr.message : String(directErr);
    // The dev-server case the inline loader exists for. Note it, then take the inline path.
    console.warn(`Koine: direct dotnet.js import failed (${reason}); using the inline-script loader.`);
    return importEsModuleViaScript(url);
  }
}

/** How the main-thread fallback acquires the dotnet ES module. Overridable for tests. */
type DotnetModuleLoader = (url: string) => Promise<Record<string, unknown>>;
let dotnetModuleLoader: DotnetModuleLoader = importDotnetModule;

/** @internal Test seam — override the main-thread dotnet module loader. Pass `null` to restore. */
export function __setDotnetModuleLoaderForTests(loader: DotnetModuleLoader | null): void {
  dotnetModuleLoader = loader ?? importDotnetModule;
}

/** Boot the .NET runtime on the MAIN THREAD and resolve the compiler's [JSExport] surface. */
async function bootMainThread(): Promise<KoineWasmApi> {
  const mod = await dotnetModuleLoader(dotnetEntryUrl());
  const dotnet = mod.dotnet as {
    create(): Promise<{
      getConfig(): { mainAssemblyName: string };
      getAssemblyExports(name: string): Promise<Record<string, unknown>>;
    }>;
  };
  const runtime = await dotnet.create();
  const config = runtime.getConfig();
  const exports = await runtime.getAssemblyExports(config.mainAssemblyName);
  return guardWasmSurface(
    (exports as { Koine: { Wasm: { CompilerInterop: Record<string, unknown> } } }).Koine.Wasm
      .CompilerInterop,
  );
}

/**
 * Boot the worker once and resolve the compiler's [JSExport] surface as an async proxy. If the worker
 * boot fails or times out (issue #357 — the deployed worker boot can hang), fall back to a main-thread
 * boot so the studio is never bricked. `getWasmBootMode()` reports which path won.
 */
export function loadWasmApi(): Promise<KoineWasmApi> {
  if (apiPromise) return apiPromise;
  const attempt = (async () => {
    const client = createKoineWorkerClient();
    workerClientInstance = client;
    try {
      // Fast path: the runtime boots off the UI thread and signals `ready` (or rejects on
      // boot-failure / the worker's boot timeout).
      await client.whenReady();
      bootMode = 'worker';
      return buildWorkerProxy(client.call.bind(client));
    } catch (workerErr: unknown) {
      // A failed worker boot must not brick the studio: tear down the dead worker and boot the
      // runtime on the main thread instead (the pre-#326 path, which boots reliably).
      const reason = workerErr instanceof Error ? workerErr.message : String(workerErr);
      console.warn(`Koine: worker compiler boot failed (${reason}); falling back to the main thread.`);
      client.dispose();
      workerClientInstance = null;
      const api = await bootMainThread();
      bootMode = 'main-thread';
      return api;
    }
  })();
  apiPromise = attempt;
  // Don't cache a TOTAL boot failure (both the worker AND the main-thread boot rejected — e.g. a
  // transient asset-serving hiccup). Clearing the cache lets a later call retry from scratch instead
  // of forever re-awaiting a permanently-rejected promise. The caller still sees this attempt reject.
  attempt.catch(() => {
    if (apiPromise === attempt) apiPromise = null;
  });
  return attempt;
}

/**
 * Returns the underlying `WorkerClient` once the WASM API has been loaded, or `null` before
 * `loadWasmApi()` has been called. Exposes cancellation primitives (`cancel`, `terminateAndRespawn`)
 * to callers (e.g. a transport-level superseder) without changing `KoineWasmApi` method signatures.
 * Additive — existing callers of `loadWasmApi()` are unaffected.
 */
export function getWasmWorkerClient(): WorkerClient | null {
  return workerClientInstance;
}
