// Pure helpers over the open-buffer set, factored out of the IDE shell so unsaved-work tracking
// (the global dirty indicator, the unload guard) is unit-testable without a DOM or a live editor.
// No imports, no app state.

/**
 * The document title for `count` unsaved files: a `• ` prefix signals unsaved work, like a native
 * editor's modified-title dot. Idempotent — never double-prefixes an already-marked base.
 */
export function titleWithDirty(base: string, count: number): string {
  const clean = base.replace(/^• /, '');
  return count > 0 ? `• ${clean}` : clean;
}

/** The slice of a `BeforeUnloadEvent` the guard touches, so it's testable with a plain fake. */
export interface UnloadEvent {
  preventDefault(): void;
  returnValue: unknown;
}

/**
 * `beforeunload` guard: when `isDirty()` reports unsaved work, cancel the unload (preventDefault +
 * a legacy non-empty `returnValue`) so the browser shows its native "Leave site?" confirmation. A
 * no-op when nothing is dirty, so a clean session closes without friction. Returns whether it
 * blocked the unload (for testability — the browser ignores the return value).
 */
export function handleBeforeUnload(event: UnloadEvent, isDirty: () => boolean): boolean {
  if (!isDirty()) return false;
  event.preventDefault();
  // Legacy requirement: assigning a non-empty returnValue is what triggers the prompt in older
  // Chromium/Firefox; modern engines key off preventDefault().
  event.returnValue = 'You have unsaved changes.';
  return true;
}
