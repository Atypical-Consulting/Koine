import { describe, expect, test, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createSelectionSlice, type SelectionSlice } from './selection';

const make = () => createStore<SelectionSlice>((set, get) => createSelectionSlice(set, get));

describe('selection slice', () => {
  test('starts null; setSelection updates state', () => {
    const s = make();
    expect(s.getState().selection).toBeNull();
    s.getState().setSelection({ qualifiedName: 'Ordering.Order', context: 'Ordering' });
    expect(s.getState().selection).toEqual({ qualifiedName: 'Ordering.Order', context: 'Ordering' });
  });

  test('subscribers fire on change and stop after unsubscribe', () => {
    const s = make();
    const fn = vi.fn();
    const off = s.subscribe(fn);
    s.getState().setSelection({ qualifiedName: 'Ordering.Order', context: 'Ordering' });
    off();
    s.getState().setSelection({ qualifiedName: 'Inventory.Stock', context: 'Inventory' });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
