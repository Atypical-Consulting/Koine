import type { StoreApi } from 'zustand/vanilla';
import { createAppStore, type AppState } from '@/store/index';

/**
 * A test-only wrapper over {@link createAppStore} that tracks how many store
 * subscriptions are currently live. Every `subscribe` increments the count; the
 * unsubscribe it hands back decrements it — at most once per listener, even if
 * called repeatedly (zustand tolerates a double-unsubscribe, and the balance
 * assertions must not double-count). `active()` is the current listener tally.
 *
 * The payoff is a "boot + dispose returns the tally to baseline" assertion: it
 * guards *every* subscription a shell module holds (controller subscriptions and
 * the Preact panels' own `useStore` hook subscriptions alike), not just the ones
 * a given test happens to know about — so a future dropped disposal is caught the
 * moment the count fails to return to baseline.
 *
 * The filename deliberately does not end in `.test.ts`, so it is excluded from the
 * `src/**\/*.test.ts` include glob in `vitest.config.ts` — it is a shared helper,
 * not a suite.
 */
export function createCountingStore(): { store: StoreApi<AppState>; active(): number } {
  const store = createAppStore();
  let count = 0;
  const rawSubscribe = store.subscribe.bind(store);
  store.subscribe = ((listener: Parameters<StoreApi<AppState>['subscribe']>[0]) => {
    count++;
    const rawUnsubscribe = rawSubscribe(listener);
    let released = false;
    return () => {
      if (!released) {
        released = true;
        count--;
      }
      rawUnsubscribe();
    };
  }) as StoreApi<AppState>['subscribe'];
  return { store, active: () => count };
}

/**
 * A test-only wrapper over {@link createAppStore} that snapshots `store.getState()` at the moment of
 * every `subscribe(...)` registration (#1260). The payoff is an "is this write already applied by the
 * time a subscriber exists" assertion — the ORDERING question a construction-time reset atomicity guard
 * needs — without relying on before/after value inequality (which a reset that happens to re-apply a
 * field's already-current value would hide even when the write genuinely runs too late).
 */
export function createRecordingStore(): { store: StoreApi<AppState>; subscribeSnapshots: AppState[] } {
  const store = createAppStore();
  const subscribeSnapshots: AppState[] = [];
  const rawSubscribe = store.subscribe.bind(store);
  store.subscribe = ((listener: Parameters<StoreApi<AppState>['subscribe']>[0]) => {
    subscribeSnapshots.push(store.getState());
    return rawSubscribe(listener);
  }) as StoreApi<AppState>['subscribe'];
  return { store, subscribeSnapshots };
}
