// A throw-safe raw `localStorage` string accessor, shared by the small persisted view-chrome
// preferences the IDE keeps (layout, inspector rail/diagnostics/context-map view, settings page
// mode/scope, and the settings/persistence.ts blob + secrets I/O). Web Storage can throw — Safari
// private mode, disabled cookies, a sandboxed iframe — so every access is guarded and degrades to a
// silent no-op rather than crashing the caller. This is the string sibling of the #514 boolean-flag
// helper (`localStorageFlag.ts`): that one owns a single-key set/unset sentinel behind a factory,
// this one is the plain `getItem`/`setItem` guard every caller wraps its own typed narrowing around.

/** Read a key, returning `null` on any error (including when storage is unavailable). */
export function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Write a key, swallowing quota/security errors (best-effort — a write failure just won't persist). */
export function writeRaw(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable or full — best effort only
  }
}
