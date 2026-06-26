import { describe, expect, test } from 'vitest';
import { reanchorSelectionAfterRename, type SelectedElement } from '@/model/selection';

// Regression coverage for #537: renaming an element via the Properties panel re-keys the model under a
// new qualified name, but the selection slice is keyed by that SAME qualified name. Without re-anchoring
// the selection, the Properties panel lookup misses (empty "Select an element…" state) and the toolbar
// breadcrumb renders the now-stale old name. `reanchorSelectionAfterRename` is the pure re-key the
// rename path applies right after the edit lands. A selection can be keyed by EITHER the canonical
// glossary qn (`Context.Aggregate.Name`) or a diagram-node alias (`Context.Name`); both must re-anchor.
describe('reanchorSelectionAfterRename', () => {
  test('re-anchors the selection when it points at the renamed element (top-level aggregate)', () => {
    const sel: SelectedElement = { qualifiedName: 'NewModel.NewAggregateRoot', context: 'NewModel' };
    const next = reanchorSelectionAfterRename(
      sel,
      { qualifiedName: 'NewModel.NewAggregateRoot', context: 'NewModel', name: 'NewAggregateRoot' },
      'Order',
    );
    expect(next).toEqual({ qualifiedName: 'NewModel.Order', context: 'NewModel' });
  });

  test('swaps only the leaf segment for a nested element selected by its CANONICAL qn', () => {
    const sel: SelectedElement = { qualifiedName: 'Ordering.Order.Line', context: 'Ordering' };
    const next = reanchorSelectionAfterRename(
      sel,
      { qualifiedName: 'Ordering.Order.Line', context: 'Ordering', name: 'Line' },
      'LineItem',
    );
    expect(next).toEqual({ qualifiedName: 'Ordering.Order.LineItem', context: 'Ordering' });
  });

  test('re-anchors a nested element selected by its diagram ALIAS qn to the new CANONICAL qn (#537 gap)', () => {
    // The Events table / Events-Flow canvas store the alias form `Context.Name` (qnByCtxName), while the
    // renamed element's identity carries the canonical `Context.Aggregate.Name`. The re-anchor must still
    // fire and resolve to the new canonical qn (a direct byQn hit) — otherwise #537 reproduces here.
    const sel: SelectedElement = { qualifiedName: 'Sales.OrderPlaced', context: 'Sales' };
    const next = reanchorSelectionAfterRename(
      sel,
      { qualifiedName: 'Sales.Order.OrderPlaced', context: 'Sales', name: 'OrderPlaced' },
      'OrderConfirmed',
    );
    expect(next).toEqual({ qualifiedName: 'Sales.Order.OrderConfirmed', context: 'Sales' });
  });

  test('leaves the selection untouched when a DIFFERENT (non-selected) element is renamed', () => {
    const sel: SelectedElement = { qualifiedName: 'Ordering.Order', context: 'Ordering' };
    const next = reanchorSelectionAfterRename(
      sel,
      { qualifiedName: 'Ordering.Customer', context: 'Ordering', name: 'Customer' },
      'Buyer',
    );
    // Same reference back — so the rename path can cheaply skip the store write.
    expect(next).toBe(sel);
  });

  test('returns null unchanged when there is no selection', () => {
    const next = reanchorSelectionAfterRename(
      null,
      { qualifiedName: 'Ordering.Order', context: 'Ordering', name: 'Order' },
      'PurchaseOrder',
    );
    expect(next).toBeNull();
  });

  test('is idempotent — re-running with the already-applied name no longer matches', () => {
    const sel: SelectedElement = { qualifiedName: 'NewModel.Order', context: 'NewModel' };
    // The renamed-from identity ('NewModel.NewAggregateRoot') no longer matches the (already re-anchored)
    // selection in either key form, so a duplicate blur/Enter is a no-op.
    const next = reanchorSelectionAfterRename(
      sel,
      { qualifiedName: 'NewModel.NewAggregateRoot', context: 'NewModel', name: 'NewAggregateRoot' },
      'Order',
    );
    expect(next).toBe(sel);
  });
});
