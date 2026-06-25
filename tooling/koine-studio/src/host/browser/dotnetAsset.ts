// Single source of truth for the published dotnet.js loader URL, shared by both boot paths: the
// worker fast-path (koine.worker.ts) and the main-thread fallback (wasm.ts). Keep it in its own
// module (not exported from koine.worker.ts) so the main thread can import it without pulling in the
// worker module's top-level boot side effects.

/** Base-aware URL of the published dotnet.js loader (respects Vite's `base`, e.g. `/Koine/studio/`). */
export function dotnetEntryUrl(): string {
  const base = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
  return `${base}/koine-wasm/_framework/dotnet.js`;
}
