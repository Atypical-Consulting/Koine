import type { ReadableStore } from './store';

// The ONE plain `ReadableStore<T>` test double shared by this package's component tests and stories —
// koine-ui is store-free by design (#905/#944), so tests/stories mock the contract directly instead of
// pulling in koine-studio's real Zustand store; each slice's real derivation is the host adapter's job,
// pinned in koine-studio's readableStores.test.ts. This module replaces the per-file
// `createMock*Store`/`readableStoreOf` copies each test/story previously carried (code-review fix).
//
// Deliberately NOT exported from src/index.ts: the package's `exports` map exposes only `.` (and
// `./styles.css`), so this stays a test-side utility that cannot leak into the published API surface.

/**
 * A writable {@link ReadableStore} double: `set` replaces the state and notifies subscribers (a host
 * notification), `silentSet` replaces it WITHOUT notifying — models a host-side change between
 * notifications (e.g. a selector reading live editor state the store never writes).
 *
 * Slice types with union-typed members (e.g. a `kind: 'error' | 'warn' | 'clean'`) need the type
 * argument spelled at the call site — `createTestReadableStore<MySlice>({ … })` — or an object literal
 * infers the widened type and no longer satisfies the component's `ReadableStore<MySlice>` prop.
 */
export function createTestReadableStore<T>(initial: T): ReadableStore<T> & {
  set(next: T): void;
  /** Mutate the backing state WITHOUT notifying — models a host-side change between notifications. */
  silentSet(next: T): void;
} {
  let state = initial;
  const listeners = new Set<(state: T) => void>();
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      state = next;
      for (const listener of listeners) listener(next);
    },
    silentSet(next) {
      state = next;
    },
  };
}

/** A static, never-notifying {@link ReadableStore} over one fixed value — the story-side double for
 *  seeding a component's slice. Same union-member caveat as {@link createTestReadableStore}. */
export function readableStoreOf<T>(value: T): ReadableStore<T> {
  return {
    getState: () => value,
    subscribe: () => () => {},
  };
}
