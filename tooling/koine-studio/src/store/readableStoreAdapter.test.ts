import { describe, expect, test, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { shallowEqual, zustandToReadableStore } from '@/store/readableStoreAdapter';

interface Probe {
  count: number;
  other: number;
}

function createProbeStore() {
  return createStore<Probe>(() => ({ count: 0, other: 0 }));
}

describe('zustandToReadableStore', () => {
  test('getState() returns the selector applied to the current store state', () => {
    const store = createProbeStore();
    const readable = zustandToReadableStore(store, (s) => s.count);
    expect(readable.getState()).toBe(0);

    store.setState({ count: 5 });
    expect(readable.getState()).toBe(5);
  });

  test('notifies the listener when the selected slice changes', () => {
    const store = createProbeStore();
    const readable = zustandToReadableStore(store, (s) => s.count);
    const listener = vi.fn();
    readable.subscribe(listener);

    store.setState({ count: 1 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(1);
  });

  test('does NOT notify when an unrelated slice changes (default Object.is equality)', () => {
    const store = createProbeStore();
    const readable = zustandToReadableStore(store, (s) => s.count);
    const listener = vi.fn();
    readable.subscribe(listener);

    store.setState({ other: 99 });

    expect(listener).not.toHaveBeenCalled();
  });

  test('unsubscribe stops further notifications', () => {
    const store = createProbeStore();
    const readable = zustandToReadableStore(store, (s) => s.count);
    const listener = vi.fn();
    const unsubscribe = readable.subscribe(listener);

    unsubscribe();
    store.setState({ count: 42 });

    expect(listener).not.toHaveBeenCalled();
  });

  test('with a fresh-object selector and shallowEqual, does not notify when the derived fields are unchanged', () => {
    const store = createProbeStore();
    const readable = zustandToReadableStore(store, (s) => ({ count: s.count }), shallowEqual);
    const listener = vi.fn();
    readable.subscribe(listener);

    // A no-op write to an unrelated field still runs the selector (building a NEW object), but the
    // shallow-equal check must still swallow it since `count` itself hasn't changed.
    store.setState({ other: 7 });

    expect(listener).not.toHaveBeenCalled();
  });

  test('with shallowEqual, DOES notify once the derived field actually changes', () => {
    const store = createProbeStore();
    const readable = zustandToReadableStore(store, (s) => ({ count: s.count }), shallowEqual);
    const listener = vi.fn();
    readable.subscribe(listener);

    store.setState({ count: 1 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ count: 1 });
  });

  test('a custom isEqual can be supplied to override the default', () => {
    const store = createProbeStore();
    const alwaysEqual = () => true;
    const readable = zustandToReadableStore(store, (s) => s.count, alwaysEqual);
    const listener = vi.fn();
    readable.subscribe(listener);

    store.setState({ count: 999 });

    expect(listener).not.toHaveBeenCalled();
  });
});

// `shallowEqual` is a re-export of zustand's own `shallow` (see readableStoreAdapter.ts) — its own
// behavior is zustand's to test; the coverage above pins that THIS adapter wires it in correctly as an
// `isEqual` implementation, which is the part actually owned here.
