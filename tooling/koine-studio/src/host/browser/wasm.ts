// Loads the Koine.Wasm compiler module in the browser and exposes its [JSExport] language-service
// surface. The bundle (_framework/dotnet.js + assemblies) is published by scripts/build-wasm.mjs
// into public/koine-wasm/, so it is served as a static asset at `${BASE_URL}koine-wasm/`. Mirrors
// the docs-site Playground loader (website/src/playground/koine.ts): boot the runtime once, cache
// the promise, and resolve the exports lazily.

/** The JS-callable language-service surface (matches src/Koine.Wasm/CompilerInterop.LanguageService.cs). */
export interface KoineWasmApi {
  /** Diagnose the merged workspace → JSON `[{uri, diagnostics:[lsp]}]`. */
  DiagnoseWorkspace(filesJson: string): string;
  /** Emit-preview the merged workspace for a target → JSON EmitPreviewResult. */
  EmitPreview(filesJson: string, target: string): string;
  /** Glossary markdown for the merged workspace → JSON `{markdown}`. */
  Glossary(filesJson: string): string;
  /** Structured glossary for the merged workspace → JSON `{entries}`. */
  GlossaryModel(filesJson: string): string;
  /** Strategic context map → JSON `{contexts, relations}`. */
  ContextMap(filesJson: string): string;
  /** Set a declaration's doc comment by id → JSON `{uri, edits:[TextEdit]}`. */
  SetDoc(filesJson: string, id: string, text: string): string;
  /** Hover at a 0-based position → JSON Hover or `null`. */
  Hover(filesJson: string, activeUri: string, line: number, character: number): string;
  /** IntelliSense completions at a 0-based position → JSON CompletionList. */
  Completions(filesJson: string, activeUri: string, line: number, character: number): string;
  /** Go-to-definition at a 0-based position → JSON Location or `null`. */
  Definition(filesJson: string, activeUri: string, line: number, character: number): string;
  /** Single-file document outline → JSON DocumentSymbol[]. */
  DocumentSymbols(source: string): string;
  /** Collapsible regions of a single file → JSON FoldingRange[] (`{startLine,endLine}`). */
  FoldingRanges(source: string): string;
  /** Selection-range chains for a set of 0-based positions → JSON SelectionRange[] (parallel). */
  SelectionRanges(source: string, positionsJson: string): string;
  /** Canonical formatting edits → JSON TextEdit[]. */
  Format(source: string): string;
  /** Compatibility of current vs baseline workspace → JSON CheckResult. */
  Check(currentFilesJson: string, baselineFilesJson: string): string;
  /** Every reference to the name at a 0-based position → JSON Location[]. */
  References(filesJson: string, activeUri: string, line: number, character: number): string;
  /** Editable identifier range under the cursor → JSON `{range, placeholder}` or `null`. */
  PrepareRename(filesJson: string, activeUri: string, line: number, character: number): string;
  /** Workspace edit renaming the symbol under the cursor → JSON WorkspaceEdit or `null`. */
  Rename(filesJson: string, activeUri: string, line: number, character: number, newName: string): string;
  /** Quickfixes + refactors for a 0-based range → JSON CodeAction[]. */
  CodeActions(
    filesJson: string,
    activeUri: string,
    startLine: number,
    startChar: number,
    endLine: number,
    endChar: number,
    diagnosticsJson: string,
  ): string;
  /** Living-documentation files (Mermaid-in-Markdown) for the merged workspace → JSON `{files}`. */
  Docs(filesJson: string): string;
}

/**
 * The names of every [JSExport] method the compiler bundle is expected to provide (keep in sync with
 * `KoineWasmApi` above). The guard only flags a *known* export name that failed to resolve as a stale
 * bundle; any other property access (`then`, `toString`, `catch`, …) must pass through untouched — see
 * `guardWasmSurface`.
 */
const KOINE_WASM_EXPORTS: ReadonlySet<string> = new Set<keyof KoineWasmApi>([
  'DiagnoseWorkspace',
  'EmitPreview',
  'Glossary',
  'GlossaryModel',
  'ContextMap',
  'SetDoc',
  'Hover',
  'Completions',
  'Definition',
  'DocumentSymbols',
  'FoldingRanges',
  'SelectionRanges',
  'Format',
  'Check',
  'References',
  'PrepareRename',
  'Rename',
  'CodeActions',
  'Docs',
]);

let apiPromise: Promise<KoineWasmApi> | null = null;
let loaderSeq = 0;

/** Base-aware URL of the published dotnet.js loader (respects Vite's `base`, e.g. `/Koine/studio/`). */
function dotnetEntryUrl(): string {
  const base = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
  return `${base}/koine-wasm/_framework/dotnet.js`;
}

/**
 * Import the dotnet.js ES module by URL via an injected inline module script. We deliberately do NOT
 * call `import(url)` from app code: under Vite's dev server a dynamic import of a `public/` asset is
 * routed through the module-transform pipeline (the `?import` suffix) and fails on the
 * machine-generated loader (Vite forbids importing public JS as a module). An inline
 * `<script type="module">` is invisible to Vite, so the browser fetches dotnet.js — and its relative
 * dependencies — as raw static files. Works identically for the built / deployed bundle.
 */
function importEsModule(url: string): Promise<Record<string, unknown>> {
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
    // Safety net so a silent failure can't hang the LSP handshake forever.
    setTimeout(() => {
      if (w[id]) {
        cleanup();
        reject(new Error(`timed out loading ${url}`));
      }
    }, 30000);
  });
}

/**
 * Wrap the resolved [JSExport] surface so calling a method the bundle doesn't export fails with an
 * actionable message instead of a bare `TypeError: api.X is not a function`. The bundle in
 * `public/koine-wasm/` is generated by `npm run build:wasm` (auto-run by the `predev:web` /
 * `prebuild:web` hooks) and goes stale whenever CompilerInterop.LanguageService.cs gains a new
 * [JSExport] — so a missing method means "rebuild the bundle", which is what we say.
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

/** Boot the .NET runtime once and resolve the compiler's [JSExport] surface. */
export function loadWasmApi(): Promise<KoineWasmApi> {
  if (apiPromise) return apiPromise;
  apiPromise = (async () => {
    const mod = await importEsModule(dotnetEntryUrl());
    const dotnet = mod.dotnet as { create(): Promise<any> };
    const runtime = await dotnet.create();
    const config = runtime.getConfig();
    const exports = await runtime.getAssemblyExports(config.mainAssemblyName);
    return guardWasmSurface(exports.Koine.Wasm.CompilerInterop as Record<string, unknown>);
  })();
  return apiPromise;
}
