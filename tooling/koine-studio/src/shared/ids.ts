// A tiny id minter shared by Studio's view-only stores (review threads, canvas annotations). Each
// authored item gets a stable, unique id from crypto.randomUUID. Where Web Crypto is absent — a
// non-secure context such as Studio served over plain HTTP to a LAN IP, where crypto.randomUUID is
// undefined — it falls back to a per-session timestamp plus a monotonic counter. Review-thread (and
// annotation) ids ARE persisted (to `.koine/reviews.json` / `koine.layout.json`) and reloaded, so the
// fallback must stay unique ACROSS sessions: the counter alone resets to 0 on every page load, so a
// reloaded `review-1` would collide with a freshly-minted one — the timestamp component prevents that.

/** A monotonic counter so the no-crypto fallback stays unique within a session. */
let idSeq = 0;

/** A unique id of the form `${prefix}-${uuid}`, e.g. `review-1a2b…` / `note-3` (#480). */
export function prefixedId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  // No Web Crypto: a per-session timestamp + counter, so ids minted-and-persisted in one session do not
  // collide with ids minted in the next (when the counter has reset to 0).
  return `${prefix}-${Date.now().toString(36)}-${++idSeq}`;
}
