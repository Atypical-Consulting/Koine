// A tiny id minter shared by Studio's view-only stores (review threads, canvas annotations). Each
// authored item gets a stable, unique id from crypto.randomUUID, with a single module-level monotonic
// counter as the fallback where Web Crypto is absent. The ids are opaque and never persisted-then-
// reparsed, so the fallback's exact shape is irrelevant — only that it stays unique per call.

/** A monotonic fallback so an item gets a unique id even where crypto.randomUUID is absent. */
let idSeq = 0;

/** A unique id of the form `${prefix}-${uuid}`, e.g. `review-1a2b…` / `note-3` (#480). */
export function prefixedId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid ?? ++idSeq}`;
}
