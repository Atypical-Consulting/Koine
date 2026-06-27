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
import { bootMainThreadCompiler } from './mainThreadBoot';

export type Severity = 'error' | 'warning';

/** Which boot path produced the live compiler — `worker` (fast path) or the `main-thread` fallback (#510). */
export type BootMode = 'worker' | 'main-thread';
let bootMode: BootMode | null = null;

/** The boot path that won, or `null` before {@link whenReady} resolves. Mirrors Studio's `getWasmBootMode()`. */
export function getBootMode(): BootMode | null {
  return bootMode;
}

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

/**
 * LSP semantic tokens (full document) — the delta-encoded int stream the wasm `SemanticTokens` export
 * returns (shipped in #361). `data` is groups of 5 ints `[deltaLine, deltaStartChar, length, tokenType,
 * tokenModifiers]`; `resultId` supports delta requests the playground doesn't use. Mirrors the server
 * contract (`SemanticTokens` in tooling/koine-studio/src/lsp/protocol.ts) — the editor decodes this
 * against the fixed `SEMANTIC_TOKEN_TYPES` legend to paint semantic highlighting.
 */
export interface SemanticTokens {
  data: number[];
  resultId?: string | null;
}

export interface CompileResult {
  ok: boolean;
  target: string;
  diagnostics: KoineDiagnostic[];
  files: EmittedFile[];
}

/** A backend emit-target id (e.g. `csharp`, `rust`). The authoritative set is whatever the loaded
 *  compiler reports via {@link listEmitTargets} (#438) — no longer a hand-maintained union — so a
 *  newly-shipped target is selectable with zero website edits. */
export type Target = string;

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

/** Minimal built-in target set used only as a fallback when the loaded compiler can't report its
 *  targets (runtime not yet booted, `ListEmitTargets` export missing, or an empty/failed list). It is
 *  NOT a second source of which targets exist — {@link listEmitTargets} always prefers the runtime's
 *  list; this just keeps the Playground usable offline. Mirrors Studio's BUILTIN_EMIT_TARGETS
 *  (#282/#293). */
export const BUILTIN_EMIT_TARGETS: readonly EmitTarget[] = [
  { id: 'csharp', displayName: 'C#', fileExtension: '.cs' },
  { id: 'typescript', displayName: 'TypeScript', fileExtension: '.ts' },
  { id: 'python', displayName: 'Python', fileExtension: '.py' },
  { id: 'php', displayName: 'PHP', fileExtension: '.php' },
];

// ---------------------------------------------------------------------------
// Singleton worker client — booted once, reused for all calls.
// ---------------------------------------------------------------------------

let clientPromise: Promise<WorkerClient> | null = null;

/** Boots the worker once and returns the WorkerClient. */
function loadApi(): Promise<WorkerClient> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    // The worker boot is the FAST path (off the UI thread). If it never reaches `ready` — it hangs
    // past the budget, or the watchdog posts `boot-failure` — fall back to a main-thread boot so the
    // Playground still works (#510). `getBootMode()` reports which path won (mirrors Studio's wasm.ts).
    let usedFallback = false;
    const client = createKoineWorkerClient({
      fallbackBoot: () => {
        usedFallback = true;
        return bootMainThreadCompiler();
      },
    });
    await client.whenReady();
    bootMode = usedFallback ? 'main-thread' : 'worker';
    return client;
  })();
  // Don't cache a TOTAL boot failure (worker AND main-thread both rejected): clear so a later
  // preloadCompiler()/compile() retries from scratch instead of forever re-awaiting a rejected promise.
  const attempt = clientPromise;
  attempt.catch(() => {
    if (clientPromise === attempt) clientPromise = null;
  });
  return clientPromise;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Kick off the (multi-MB) runtime download ahead of first use, without awaiting it. */
export function preloadCompiler(): void {
  void loadApi();
}

/**
 * Hard-cancel a runaway compile (the playground "Stop" affordance, #353): terminate the worker and
 * boot a fresh generation. The SAME client object is reused (its worker is swapped) — no second client
 * is created. The singleton is re-pointed at the fresh generation so the next `compile`/`diagnose`
 * awaits it; callers should re-`preloadCompiler()` to warm the new worker. No-op if the runtime was
 * never booted. Additive — existing call sites are unchanged.
 */
export function terminateAndRespawn(): void {
  const prev = clientPromise;
  if (!prev) return; // never booted — nothing in flight to terminate
  clientPromise = (async () => {
    const client = await prev; // the existing (booted) client object
    client.terminateAndRespawn(); // kill the runaway worker; spawn a fresh generation
    await client.whenReady(); // wait for the fresh generation to signal ready
    return client;
  })();
  // Don't leave a rejected boot cached: if the fresh generation fails to boot, clear so a later
  // preloadCompiler()/compile() retries from scratch (mirrors the studio wasm.ts cache discipline).
  const attempt = clientPromise;
  attempt.catch(() => {
    if (clientPromise === attempt) clientPromise = null;
  });
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

/** LSP semantic tokens for the document (#367): routes the wasm `SemanticTokens` export through the
 *  SAME generic worker (`koine.worker.ts` dispatches `interop[method](...args)`, so no worker edit) and
 *  parses the JSON int stream. The editor decodes this against the fixed legend to paint semantic
 *  highlighting; an empty `data` (a non-parsing document) leaves the static grammar authoritative. */
export async function semanticTokens(source: string, opts?: CallOptions): Promise<SemanticTokens> {
  const client = await loadApi();
  return JSON.parse(await client.call('SemanticTokens', [source], opts)) as SemanticTokens;
}

/** The module's self-description (#330): version + [JSExport] names + emit targets — the single source
 *  of truth the status line reads its version from (no hard-coded string). */
export async function capabilities(opts?: CallOptions): Promise<Capabilities> {
  const client = await loadApi();
  return JSON.parse(await client.call('Capabilities', [], opts)) as Capabilities;
}

/** The emit targets the loaded compiler actually ships — read from the `ListEmitTargets` export, the
 *  single source of truth Koine Studio also derives its target list from (#282/#293/#438). Falls back
 *  to {@link BUILTIN_EMIT_TARGETS} when the runtime can't report them (offline boot, missing export, or
 *  an empty list) so the Playground always offers a usable set. */
export async function listEmitTargets(opts?: CallOptions): Promise<EmitTarget[]> {
  const fallback = () => BUILTIN_EMIT_TARGETS.map((t) => ({ ...t }));
  try {
    const client = await loadApi();
    const parsed = JSON.parse(await client.call('ListEmitTargets', [], opts)) as { targets?: EmitTarget[] };
    const targets = parsed.targets ?? [];
    if (targets.length > 0) return targets.map((t) => ({ ...t }));
    console.warn('Koine playground: compiler reported no emit targets — using the built-in fallback set.');
    return fallback();
  } catch (e) {
    console.warn('Koine playground: could not read emit targets from the compiler — using the built-in fallback set.', e);
    return fallback();
  }
}
