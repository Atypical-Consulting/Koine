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
  /** The llama.cpp GBNF grammar for constrained `.koi` decoding → grammar text (#257). */
  GbnfGrammar(): Promise<string>;
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
  /** Semantic tokens for ONE source document → JSON `{data:[int...], resultId}` (LSP delta stream). */
  SemanticTokens(source: string): Promise<string>;
  /** Prepare call hierarchy at a 0-based position → JSON CallHierarchyItem[]. */
  PrepareCallHierarchy(filesJson: string, activeUri: string, line: number, character: number): Promise<string>;
  /** Incoming calls into a CallHierarchyItem (passed as JSON) → JSON CallHierarchyIncomingCall[]. */
  IncomingCalls(filesJson: string, itemJson: string): Promise<string>;
  /** Outgoing calls from a CallHierarchyItem (passed as JSON) → JSON CallHierarchyOutgoingCall[]. */
  OutgoingCalls(filesJson: string, itemJson: string): Promise<string>;
  /** The module self-description (#330) → JSON `{ version, exports:[string], targets:[{id,displayName,fileExtension}] }`. */
  Capabilities(): Promise<string>;
}

/**
 * Every method this studio build calls — the surface declared on `KoineWasmApi`. Completeness is
 * **compiler-enforced**: typed `Record<keyof KoineWasmApi, true>`, so adding a method to `KoineWasmApi`
 * without listing it here (or vice-versa) is a `tsc` error.
 *
 * This is NOT the runtime forward source any more (issue #330). The proxy forwards based on the bundle's
 * own self-reported `Capabilities().exports`, derived at boot — so a single source of truth (the wasm
 * module) drives both forwarding and staleness detection. This map exists only to enumerate, at runtime,
 * what the studio *expects*, so `verifyBootSurface` can flag a bundle that omits a method the studio needs.
 */
const KOINE_WASM_EXPORT_MAP: Record<keyof KoineWasmApi, true> = {
  DiagnoseWorkspace: true,
  EmitPreview: true,
  ListEmitTargets: true,
  GbnfGrammar: true,
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
  SemanticTokens: true,
  PrepareCallHierarchy: true,
  IncomingCalls: true,
  OutgoingCalls: true,
  Capabilities: true,
};

/**
 * Every [JSExport] method this studio build calls — the surface declared on `KoineWasmApi`
 * (compiler-enforced complete via {@link KOINE_WASM_EXPORT_MAP}). The proxies forward / guard against
 * this set: a call to one of these names that the live bundle doesn't actually provide fails with the
 * actionable "rebuild" message rather than a bare `TypeError`. The bundle's own `Capabilities().exports`
 * is what {@link verifyBootSurface} checks this set against at boot to surface staleness early (#330).
 * Exported for tests.
 */
export const HOST_DECLARED_EXPORTS: ReadonlySet<string> = new Set(Object.keys(KOINE_WASM_EXPORT_MAP));

/** The compiler bundle's self-description (issue #330) — mirrors `WCapabilities` in CompilerInterop.cs. */
interface WasmCapabilities {
  version: string;
  exports: string[];
  targets: { id: string; displayName: string; fileExtension: string }[];
}

/**
 * Verify the live bundle's self-reported surface against what this studio build expects, ONCE at boot
 * (issue #330): a method `KoineWasmApi` declares that the bundle's `Capabilities().exports` omits means
 * the bundle in `public/koine-wasm/` is stale — surface it now, with the rebuild command, instead of only
 * at the first failing call. This is the early-warning half of staleness detection; the proxies still
 * give the same actionable per-call error (gating on {@link HOST_DECLARED_EXPORTS}) for anyone who misses
 * the warning. A bundle whose `Capabilities()` can't be read (too old, or it failed to load) is noted but
 * not fatal — the proxies degrade exactly as before. The reverse drift — the bundle exporting a method the
 * studio does not consume (e.g. the playground-only `Diagnose`/`Compile`) — is expected and not flagged.
 */
function verifyBootSurface(capabilitiesJson: string | null, source: WasmBootMode): void {
  let caps: WasmCapabilities | null = null;
  if (capabilitiesJson !== null) {
    try {
      const parsed = JSON.parse(capabilitiesJson) as Partial<WasmCapabilities>;
      if (Array.isArray(parsed.exports)) caps = parsed as WasmCapabilities;
    } catch {
      caps = null;
    }
  }

  if (caps === null) {
    console.warn(
      `Koine: could not read the compiler bundle's Capabilities() at boot (${source} path) — the bundle ` +
        `in public/koine-wasm/ may predate it or have failed to load. Rebuild it with: npm run build:wasm`,
    );
    return;
  }

  const missing = [...HOST_DECLARED_EXPORTS].filter((name) => !caps.exports.includes(name));
  if (missing.length > 0) {
    console.warn(
      `Koine: the compiler bundle in public/koine-wasm/ is stale — it is missing ${missing.length} ` +
        `export(s) this studio build needs (${missing.join(', ')}). Rebuild it with: npm run build:wasm`,
    );
  }
}

/** Fetch + return the bundle's raw `Capabilities()` JSON over the worker client, or `null` if unavailable. */
async function fetchCapabilitiesViaCall(
  call: (method: string, args: unknown[]) => Promise<string>,
): Promise<string | null> {
  try {
    return await call('Capabilities', []);
  } catch {
    return null;
  }
}

/** Call the raw (main-thread) `Capabilities()` export and return its JSON, or `null` if unavailable. */
function fetchCapabilitiesRaw(raw: Record<string, unknown>): string | null {
  try {
    const fn = raw.Capabilities;
    return typeof fn === 'function' ? (fn as () => string)() : null;
  } catch {
    return null;
  }
}

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
      // Only a *known* export name (one this studio build calls — {@link HOST_DECLARED_EXPORTS}) that
      // didn't resolve to a function is treated as a stale-bundle call site. Everything else passes
      // through untouched — crucially `then`: the Promise that resolves to this proxy probes `proxy.then`
      // to decide if it's a thenable, so returning a throwing function there would make the whole
      // language-server boot reject with a bogus `export "then" is missing`. Symbols and non-export
      // strings (toString, catch, …) likewise pass through. (verifyBootSurface already warned at boot if
      // the bundle was stale — this is the per-call backstop for anyone who missed it.)
      if (typeof prop !== 'string' || typeof value === 'function' || !HOST_DECLARED_EXPORTS.has(prop))
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
      // if it's a thenable — intercepting it would cause the boot to reject spuriously. We forward the
      // methods this studio build calls ({@link HOST_DECLARED_EXPORTS}); if the bundle is stale and a
      // forwarded method is absent, the worker rejects with "is not a function" and the catch below
      // re-raises the actionable rebuild message (verifyBootSurface also warned at boot — #330).
      if (typeof prop !== 'string' || !HOST_DECLARED_EXPORTS.has(prop)) {
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
 * Acquire the dotnet.js ES module for the main-thread fallback — CSP-safe and faster-failing
 * (issues #359, #365):
 *  1. Try a direct `import(/* @vite-ignore *​/ url)` — the same CSP-neutral path the worker already
 *     uses. In the built / deployed bundle (the only place that matters for production) this is the
 *     canonical path: it succeeds and never touches the DOM, so a strict CSP can't block it.
 *  2. Only if it throws AND we're under Vite's dev server (`import.meta.env.DEV`) — fall back to the
 *     inline-`<script>` loader (invisible to Vite's transform, so it's the CSP/transform escape). NOTE:
 *     with `koineWasmDevPlugin` (vite.config.ts, issue #384) now serving `/koine-wasm/**` `?import`
 *     requests as raw assets, the direct import in step 1 already SUCCEEDS under the dev server — so
 *     this inline path is now a DEEPER fallback (a strict CSP blocking the direct `import()`, or a
 *     non-Vite host), not the routine dev path it was before #384.
 *  3. In a built / deployed bundle (`import.meta.env.DEV === false`) there is no such transform, so a
 *     thrown direct import is a *genuine* load error (dotnet.js 404, network failure, a host that
 *     blocks `import()`). Rethrow it PROMPTLY (#365) instead of stalling on the inline loader's blind
 *     ~8s timeout — and since an inline `<script>` that itself calls `import()` can't bypass a CSP that
 *     blocks `import()`, the inline path was never a real production safety net anyway. `import.meta.env.DEV`
 *     is statically `false` in a Vite production build, so the inline branch is dead-code-eliminated
 *     from the deployed bundle.
 */
async function importDotnetModule(url: string): Promise<Record<string, unknown>> {
  try {
    return await esModuleImporter(url);
  } catch (directErr: unknown) {
    // The inline loader exists ONLY for Vite's dev-server `?import` transform. In a built/deployed
    // bundle there is no such transform, so a thrown direct import is a genuine load error — reject
    // promptly with it instead of waiting out the inline loader's blind timeout (#365).
    if (!import.meta.env.DEV) throw directErr;
    const reason = directErr instanceof Error ? directErr.message : String(directErr);
    // The dev-server case the inline loader exists for. Note it, then take the inline path.
    console.warn(
      `Koine: direct dotnet.js import failed under the dev server (${reason}); using the inline-script loader.`,
    );
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
  const raw = (exports as { Koine: { Wasm: { CompilerInterop: Record<string, unknown> } } }).Koine.Wasm
    .CompilerInterop;
  // Verify the surface at boot from the bundle's own self-description (#330) — warns early if stale —
  // then guard the surface (the guard re-raises the actionable error per-call as the backstop).
  verifyBootSurface(fetchCapabilitiesRaw(raw), 'main-thread');
  return guardWasmSurface(raw);
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
      const call = client.call.bind(client);
      // Verify the surface at boot from the bundle's own self-description (#330) — Capabilities() is
      // queried directly over the client (not via the proxy) — so staleness is warned early; the proxy
      // then forwards the studio's calls, with the worker's missing-export rejection as the per-call backstop.
      verifyBootSurface(await fetchCapabilitiesViaCall(call), 'worker');
      return buildWorkerProxy(call);
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
