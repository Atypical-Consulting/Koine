// A throw-safe persisted boolean flag, shared by the small `localStorage` preference flags the IDE
// keeps (e.g. the #368 boot switch and the #442 PWA install-dismissal). Each flag is a single key
// holding the sentinel `'1'` (set) or absent (unset). Web Storage can throw — Safari private mode,
// disabled cookies, a sandboxed iframe — so every access is guarded and degrades to a silent no-op
// rather than crashing the caller. This is the one place that robustness has to be correct.

/** The slice of the Web Storage API a flag needs; lets callers/tests pass an in-memory stand-in. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A persisted boolean flag over a single key. Every method swallows storage throws (best-effort). */
export interface PersistedFlag {
  /** True iff the sentinel is present; `false` on any read error (storage absent / throwing). */
  isSet(): boolean;
  /** Persist the flag (best-effort). Never throws — a write failure just means it won't persist. */
  set(): void;
  /** Remove the flag (best-effort). Never throws. */
  clear(): void;
}

/** The sentinel a set flag stores; any other value (or absence) reads as unset. */
const SENTINEL = '1';

/** A best-effort `StorageLike` backed by `localStorage`, degrading to a no-op when it's unavailable. */
function defaultStorage(): StorageLike {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // localStorage access can throw (sandboxed iframe / disabled cookies) — fall through to the no-op.
  }
  return {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
}

/**
 * A throw-safe boolean flag persisted under `key`. `storage` defaults to a best-effort `localStorage`
 * adapter that no-ops when Web Storage is absent; inject a stand-in to unit-test the storage paths.
 */
export function localStorageFlag(key: string, storage: StorageLike = defaultStorage()): PersistedFlag {
  return {
    isSet(): boolean {
      try {
        return storage.getItem(key) === SENTINEL;
      } catch {
        // read blocked (private mode / no Web Storage) — treat as unset rather than crashing.
        return false;
      }
    },
    set(): void {
      try {
        storage.setItem(key, SENTINEL);
      } catch {
        // storage unavailable — the flag won't persist across loads, but the caller carries on.
      }
    },
    clear(): void {
      try {
        storage.removeItem(key);
      } catch {
        // storage unavailable — nothing to clear; degrade silently.
      }
    },
  };
}
