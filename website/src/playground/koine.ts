// Lazy loader + typed wrapper around the Koine compiler running as a .NET WebAssembly
// module (published into /koine-wasm/_framework by scripts/build-wasm.mjs). The runtime is
// booted once on first use and reused; callers get plain promises returning typed results.

export type Severity = 'error' | 'warning';

export interface KoineDiagnostic {
  severity: Severity;
  code: string;
  message: string;
  /** 1-based start line. */
  line: number;
  /** 1-based start column. */
  col: number;
  /** 1-based, end-exclusive line. */
  endLine: number;
  /** 1-based, end-exclusive column. */
  endCol: number;
}

export interface EmittedFile {
  path: string;
  contents: string;
}

export interface CompileResult {
  ok: boolean;
  target: string;
  diagnostics: KoineDiagnostic[];
  files: EmittedFile[];
}

export type Target = 'csharp' | 'typescript' | 'python' | 'glossary';

let apiPromise: Promise<KoineWasmApi> | null = null;

interface KoineWasmApi {
  Diagnose(source: string): string;
  Compile(source: string, target: string): string;
}

/** The base-aware URL of the published dotnet.js loader (respects Astro's `/Koine/` base). */
function dotnetEntryUrl(): string {
  const base = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
  return `${base}/koine-wasm/_framework/dotnet.js`;
}

/** Boots the .NET runtime once and resolves the compiler's [JSExport] surface. */
function loadApi(): Promise<KoineWasmApi> {
  if (apiPromise) return apiPromise;
  apiPromise = (async () => {
    // Runtime-computed URL → native dynamic import; keep Vite from trying to resolve it.
    const mod = await import(/* @vite-ignore */ dotnetEntryUrl());
    const dotnet = mod.dotnet;
    const runtime = await dotnet.create();
    const config = runtime.getConfig();
    const exports = await runtime.getAssemblyExports(config.mainAssemblyName);
    return exports.Koine.Wasm.CompilerInterop as KoineWasmApi;
  })();
  return apiPromise;
}

/** Kick off the (multi-MB) runtime download ahead of first use, without awaiting it. */
export function preloadCompiler(): void {
  void loadApi();
}

/** True once the runtime has finished booting (use to gate UI spinners). */
export async function whenReady(): Promise<void> {
  await loadApi();
}

/** Parse + validate; returns diagnostics for editor squiggles. */
export async function diagnose(source: string): Promise<KoineDiagnostic[]> {
  const api = await loadApi();
  return JSON.parse(api.Diagnose(source)) as KoineDiagnostic[];
}

/** Full compile through the chosen emitter. */
export async function compile(source: string, target: Target): Promise<CompileResult> {
  const api = await loadApi();
  return JSON.parse(api.Compile(source, target)) as CompileResult;
}
