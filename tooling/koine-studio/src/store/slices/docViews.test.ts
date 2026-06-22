import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createDocViewsSlice, type DocViewsSlice } from './docViews';

const make = () => createStore<DocViewsSlice>((set, get) => createDocViewsSlice(set, get));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('docViews slice', () => {
  test('a fresh view is stale; markLoaded with the current token clears stale', () => {
    const s = make().getState();
    expect(s.isStale('model')).toBe(true);
    s.markLoaded('model', s.currentToken('model'));
    expect(s.isStale('model')).toBe(false); // loaded ⇒ not stale
    expect(make().getState().isStale('model')).toBe(true); // independent store still stale
  });

  test('invalidate bumps the token so a loader holding the old token cannot mark loaded', () => {
    const store = make();
    const before = store.getState().currentToken('diagrams');
    store.getState().invalidate(); // an edit happened mid-load
    store.getState().markLoaded('diagrams', before); // stale loader returns
    expect(store.getState().isStale('diagrams')).toBe(true); // discarded — still stale
    store.getState().markLoaded('diagrams', store.getState().currentToken('diagrams'));
    expect(store.getState().isStale('diagrams')).toBe(false);
  });

  test('scheduleRefresh debounces to a single call after 350ms', () => {
    const store = make();
    const fn = vi.fn();
    store.getState().scheduleRefresh(fn);
    store.getState().scheduleRefresh(fn);
    vi.advanceTimersByTime(349);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
