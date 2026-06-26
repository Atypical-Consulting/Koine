import { describe, expect, test } from 'vitest';
import { reanchorSelectionAfterRename, type SelectedElement } from '@/model/selection';

// Regression coverage for #537: renaming an element via the Properties panel re-keys the model under a
// new qualified name, but the selection slice is keyed by that SAME qualified name. Without re-anchoring
// the selection, the Properties panel lookup misses (empty "Select an element…" state) and the toolbar
// breadcrumb renders the now-stale old name. `reanchorSelectionAfterRename` is the pure re-key the
// rename path applies right after the edit lands.
describe('reanchorSelectionAfterRename', () => {
  test('re-anchors the selection when it points at the renamed element (top-level)', () => {
    const sel: SelectedElement = { qualifiedName: 'NewModel.NewAggregateRoot', context: 'NewModel' };
    const next = reanchorSelectionAfterRename(sel, 'NewModel.NewAggregateRoot', 'Order');
    expect(next).toEqual({ qualifiedName: 'NewModel.Order', context: 'NewModel' });
  });

  test('swaps only the leaf segment for a nested element, keeping the context prefix', () => {
    const sel: SelectedElement = { qualifiedName: 'Ordering.Order.Line', context: 'Ordering' };
    const next = reanchorSelectionAfterRename(sel, 'Ordering.Order.Line', 'LineItem');
    expect(next).toEqual({ qualifiedName: 'Ordering.Order.LineItem', context: 'Ordering' });
  });

  test('leaves the selection untouched when a DIFFERENT (non-selected) element is renamed', () => {
    const sel: SelectedElement = { qualifiedName: 'Ordering.Order', context: 'Ordering' };
    const next = reanchorSelectionAfterRename(sel, 'Ordering.Customer', 'Buyer');
    // Same reference back — so the rename path can cheaply skip the store write.
    expect(next).toBe(sel);
  });

  test('returns null unchanged when there is no selection', () => {
    expect(reanchorSelectionAfterRename(null, 'Ordering.Order', 'PurchaseOrder')).toBeNull();
  });

  test('handles a bare (dotless) qualified name by replacing it wholesale', () => {
    const sel: SelectedElement = { qualifiedName: 'Order', context: 'Order' };
    const next = reanchorSelectionAfterRename(sel, 'Order', 'PurchaseOrder');
    expect(next).toEqual({ qualifiedName: 'PurchaseOrder', context: 'Order' });
  });

  test('is idempotent — re-running with the already-applied name no longer matches', () => {
    const sel: SelectedElement = { qualifiedName: 'NewModel.Order', context: 'NewModel' };
    // The renamed-from qn ('NewModel.NewAggregateRoot') no longer matches the (already re-anchored)
    // selection, so a duplicate blur/Enter is a no-op.
    const next = reanchorSelectionAfterRename(sel, 'NewModel.NewAggregateRoot', 'Order');
    expect(next).toBe(sel);
  });
});
