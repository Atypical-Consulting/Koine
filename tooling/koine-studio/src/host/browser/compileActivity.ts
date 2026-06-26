// Compile-activity signal for the browser host (#469).
//
// Studio's "Stop compilation (restart compiler)" command should be offered only while a compile is
// actually in flight — abandoning a *runaway* compile — matching the docs-site playground, whose Stop
// button is hidden unless `setBusy(true)`. Before #469 the command was gated only on a worker existing
// (`getWasmWorkerClient() !== null`), so it was offered the whole session and an idle Stop pointlessly
// terminated + re-instantiated the multi-MB .NET WASM runtime.
//
// This module is a tiny module-level counter the worker transport (`transport.ts`) brackets around each
// compile-driven worker call — the keystroke diagnose (`DiagnoseWorkspace`), the emit-preview compile
// (`EmitPreview`), and the run-scenario compile (`RunScenario`) — via `withCompileActivity()`:
// `markCompileStart()` before issuing, `markCompileEnd()` in a `finally` so success, supersede-abort,
// `CancelledError` (a Stop mid-compile), and real errors all decrement. The Stop gate (`stopCompile.ts`)
// reads it via `isCompileInFlight()`. Additive: no public API change.
//
// One-shot LSP requests (hover/completion/definition/…) and lightweight model-projection queries are
// intentionally NOT counted — Stop is about abandoning a running compile, not IntelliSense traffic.
//
// Change notification (#516). The bare counter has no way to tell a consumer "busy began/ended", so a
// status-bar "compiling…" indicator would have to poll. `onCompileActivityChange(listener)` adds a tiny
// subscribe/notify seam: listeners fire ONLY on the idle↔busy (0↔1) boundary — the start that flips idle
// to busy and the end that flips busy back to idle — never on a nested 1↔2 increment, so a subscriber
// sees exactly the "busy began / busy ended" transitions, not every compile-call enqueue. Additive: the
// producer side (`transport.ts`) is untouched; existing `markCompileStart`/`markCompileEnd`/
// `isCompileInFlight` signatures are unchanged.

let inFlight = 0;

const listeners = new Set<() => void>();

/** Notify every subscriber of an idle↔busy boundary transition. */
function notify(): void {
  // Iterate a snapshot so a listener that unsubscribes itself during dispatch can't mutate the live Set.
  for (const listener of [...listeners]) listener();
}

/**
 * Subscribe to idle↔busy transitions of the compile-in-flight signal. The listener fires on the 0→1 edge
 * (a compile started from idle) and the 1→0 edge (the last compile ended), but NOT on nested
 * increments/decrements that keep the count busy. Returns an unsubscribe function; calling it (idempotently)
 * removes the listener so it stops firing.
 */
export function onCompileActivityChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Record the start of a compile/diagnose call (increments the in-flight count). */
export function markCompileStart(): void {
  inFlight++;
  if (inFlight === 1) notify(); // 0 → 1: idle → busy
}

/**
 * Record the end of a compile/diagnose call (decrements the in-flight count), clamped at zero so an
 * unmatched end can never drive the count negative and wedge `isCompileInFlight()` permanently false.
 */
export function markCompileEnd(): void {
  if (inFlight > 0) {
    inFlight--;
    if (inFlight === 0) notify(); // 1 → 0: busy → idle
  }
}

/** True while at least one compile/diagnose call is outstanding. */
export function isCompileInFlight(): boolean {
  return inFlight > 0;
}
