// Compile-activity signal for the browser host (#469).
//
// Studio's "Stop compilation (restart compiler)" command should be offered only while a compile is
// actually in flight — abandoning a *runaway* compile — matching the docs-site playground, whose Stop
// button is hidden unless `setBusy(true)`. Before #469 the command was gated only on a worker existing
// (`getWasmWorkerClient() !== null`), so it was offered the whole session and an idle Stop pointlessly
// terminated + re-instantiated the multi-MB .NET WASM runtime.
//
// This module is a tiny module-level counter the worker transport (`transport.ts`) brackets around its
// compile/diagnose call — `markCompileStart()` before issuing, `markCompileEnd()` in a `finally` so
// success, supersede-abort, `CancelledError` (a Stop mid-compile), and real errors all decrement — and
// the Stop gate (`stopCompile.ts`) reads via `isCompileInFlight()`. Additive: no public API change.
//
// One-shot LSP requests (hover/completion/definition/…) are intentionally NOT counted — Stop is about
// compiles, not IntelliSense traffic.

let inFlight = 0;

/** Record the start of a compile/diagnose call (increments the in-flight count). */
export function markCompileStart(): void {
  inFlight++;
}

/**
 * Record the end of a compile/diagnose call (decrements the in-flight count), clamped at zero so an
 * unmatched end can never drive the count negative and wedge `isCompileInFlight()` permanently false.
 */
export function markCompileEnd(): void {
  if (inFlight > 0) inFlight--;
}

/** True while at least one compile/diagnose call is outstanding. */
export function isCompileInFlight(): boolean {
  return inFlight > 0;
}
