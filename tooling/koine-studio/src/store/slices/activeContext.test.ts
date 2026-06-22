import { describe, expect, test, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { ALL_CONTEXTS } from '../../activeContext';
import { createActiveContextSlice, type ActiveContextSlice } from './activeContext';

const make = () => createStore<ActiveContextSlice>((set, get) => createActiveContextSlice(set, get));

describe('activeContext slice', () => {
  test('defaults to ALL_CONTEXTS', () => {
    expect(make().getState().activeContext).toBe(ALL_CONTEXTS);
  });

  test('re-selecting the same scope does not notify (no churn)', () => {
    const s = make();
    const fn = vi.fn();
    s.subscribe(fn);
    s.getState().setActiveContext('Sales');
    s.getState().setActiveContext('Sales');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
