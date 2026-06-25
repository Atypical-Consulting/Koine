// Lazy loader + typed wrapper around the Koine compiler running in a Web Worker.
// The .NET WebAssembly runtime (published into /koine-wasm/_framework by scripts/build-wasm.mjs)
// is booted inside the worker (off the UI thread); callers get plain promises returning typed results.
//
// Public API — signatures are unchanged from the direct-dotnet version so call sites (controller.ts)
// need no edits:
//   preloadCompiler()   — kicks off the worker boot without awaiting
//   whenReady()         — resolves once the worker has booted the runtime
//   diagnose(source)    — returns diagnostics for editor squiggles
//   compile(source, target) — returns the full compile result

import { createKoineWorkerClient, type WorkerClient, type CallOptions } from './workerClient';

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

export type Target = 'csharp' | 'typescript' | 'python' | 'php' | 'glossary' | 'docs' | 'asyncapi' | 'openapi' | 'rust';

export interface EmitTarget {
  id: string;
  displayName: string;
  fileExtension: string;
}

/** The compiler module's self-description (issue #330) — mirrors `WCapabilities` in CompilerInterop.cs. */
export interface Capabilities {
  version: string;
  exports: string[];
  targets: EmitTarget[];
}

// ---------------------------------------------------------------------------
// Singleton worker client — booted once, reused for all calls.
// ---------------------------------------------------------------------------

let clientPromise: Promise<WorkerClient> | null = null;

/** Boots the worker once and returns the WorkerClient. */
function loadApi(): Promise<WorkerClient> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const client = createKoineWorkerClient();
    await client.whenReady();
    return client;
  })();
  return clientPromise;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Kick off the (multi-MB) runtime download ahead of first use, without awaiting it. */
export function preloadCompiler(): void {
  void loadApi();
}

/** True once the runtime has finished booting (use to gate UI spinners). */
export async function whenReady(): Promise<void> {
  await loadApi();
}

/** Parse + validate; returns diagnostics for editor squiggles. */
export async function diagnose(source: string, opts?: CallOptions): Promise<KoineDiagnostic[]> {
  const client = await loadApi();
  return JSON.parse(await client.call('Diagnose', [source], opts)) as KoineDiagnostic[];
}

/** Full compile through the chosen emitter. */
export async function compile(source: string, target: Target, opts?: CallOptions): Promise<CompileResult> {
  const client = await loadApi();
  return JSON.parse(await client.call('Compile', [source, target], opts)) as CompileResult;
}

/** The module's self-description (#330): version + [JSExport] names + emit targets — the single source
 *  of truth the status line reads its version from (no hard-coded string). */
export async function capabilities(opts?: CallOptions): Promise<Capabilities> {
  const client = await loadApi();
  return JSON.parse(await client.call('Capabilities', [], opts)) as Capabilities;
}
