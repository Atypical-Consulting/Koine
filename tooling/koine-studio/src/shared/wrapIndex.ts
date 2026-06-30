// Pure roving-tabindex wrap arithmetic shared across the settings form (prefs.ts) and the welcome
// page template tab-rail (welcome.ts). Keeping the formula in a dependency-free shared module
// ensures that a fix to the wrap arithmetic propagates to all callers automatically (#745).

/**
 * Wrap `current` by `delta` steps within `[0, length)`, handling both forward and backward wrap.
 * Returns `-1` when `length <= 0` (empty-guard — existing callers guard before reaching this,
 * but the helper is safe to call unconditionally).
 *
 * Only `delta = ±1` is in scope for all existing callers; the formula is `(current + delta + length) % length`
 * which gives a non-negative result when `|delta| < length` — always satisfied for ±1 and `length ≥ 1`.
 */
export function wrapIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  return (current + delta + length) % length;
}
