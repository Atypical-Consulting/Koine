import { describe, expect, test, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createSelectionSlice, type SelectionSlice } from '@/store/slices/selection';
import { reanchorSelectionAfterRename } from '@/model/selection';

const make = () => createStore<SelectionSlice>((set, get) => createSelectionSlice(set, get));

describe('selection slice', () => {
  test('starts null; setSelection updates state', () => {
    const s = make();
    expect(s.getState().selection).toBeNull();
    s.getState().setSelection({ qualifiedName: 'Ordering.Order', context: 'Ordering' });
    expect(s.getState().selection).toEqual({ qualifiedName: 'Ordering.Order', context: 'Ordering' });
  });

  test('setSelection(null) clears the selection', () => {
    const s = make();
    s.getState().setSelection({ qualifiedName: 'Ordering.Order', context: 'Ordering' });
    s.getState().setSelection(null);
    expect(s.getState().selection).toBeNull();
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

  test('subscribers see every change with the new selection state', () => {
    const s = make();
    const fn = vi.fn();
    s.subscribe((state) => fn(state.selection));
    s.getState().setSelection({ qualifiedName: 'Ordering.Order', context: 'Ordering' });
    s.getState().setSelection({ qualifiedName: 'Inventory.Stock', context: 'Inventory' });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, { qualifiedName: 'Ordering.Order', context: 'Ordering' });
    expect(fn).toHaveBeenNthCalledWith(2, { qualifiedName: 'Inventory.Stock', context: 'Inventory' });
  });

  test('multiple subscribers each receive the change', () => {
    const s = make();
    const a = vi.fn();
    const b = vi.fn();
    s.subscribe(a);
    s.subscribe(b);
    s.getState().setSelection({ qualifiedName: 'Ordering.Order', context: 'Ordering' });
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  // #537: the Properties-panel rename path must re-anchor the selection to the renamed element's new
  // qualified name. This exercises the exact transformation `renameElement` applies — read selection →
  // re-anchor → write it back — proving the store ends up on the NEW name (it used to keep the old one,
  // which the inspector + breadcrumb then failed to resolve).
  test('rename re-anchors the store selection to the new qualified name', () => {
    const s = make();
    s.getState().setSelection({ qualifiedName: 'NewModel.NewAggregateRoot', context: 'NewModel' });

    const current = s.getState().selection;
    const reanchored = reanchorSelectionAfterRename(current, 'NewModel.NewAggregateRoot', 'Order');
    if (reanchored !== current) s.getState().setSelection(reanchored);

    expect(s.getState().selection).toEqual({ qualifiedName: 'NewModel.Order', context: 'NewModel' });
  });
});
