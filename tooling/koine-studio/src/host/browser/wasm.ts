// Loads the Koine.Wasm compiler module in a Web Worker (off the UI thread) and exposes its
// [JSExport] language-service surface as an async proxy. The bundle (_framework/dotnet.js +
// assemblies) is published by scripts/build-wasm.mjs into public/koine-wasm/, so it is served as
// a static asset at `${BASE_URL}koine-wasm/`. The worker boots the .NET runtime via a worker-side
// dynamic import (no DOM needed), then posts a `ready` signal. The main thread talks to it over a
// typed id-correlated request/response protocol implemented in workerClient.ts.

import { createKoineWorkerClient, type WorkerClient } from '@/host/browser/workerClient';

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

/** Boot the worker once and resolve the compiler's [JSExport] surface as an async proxy. */
export function loadWasmApi(): Promise<KoineWasmApi> {
  if (apiPromise) return apiPromise;
  apiPromise = (async () => {
    const client = createKoineWorkerClient();
    workerClientInstance = client;
    // Await the worker's `ready` signal (or reject on boot-failure / 30 s timeout).
    await client.whenReady();
    return buildWorkerProxy(client.call.bind(client));
  })();
  return apiPromise;
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
