import { describe, expect, test } from 'vitest';
import { act, render } from '@testing-library/preact';
import { createAppStore } from '../store/index';
import { ModelOutlinePanel } from './ModelOutlinePanel';
import type { GlossaryEntry, GlossaryModel, Range } from '../lsp';
import type { ModelOutlineHandlers } from '../modelOutline';

const range: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

// A two-context glossary model, shaped exactly like the real GlossaryEntry (id/name/kind/context/
// qualifiedName/doc/nameRange). The Sales context owns Order, the Inv context owns Stock, so scoping
// to "Sales" must keep Order and drop Stock.
const model: GlossaryModel = {
  entries: [
    { id: 'Sales.Order', name: 'Order', kind: 'aggregate', context: 'Sales', qualifiedName: 'Sales.Order', doc: null, nameRange: range },
    { id: 'Inv.Stock', name: 'Stock', kind: 'entity', context: 'Inv', qualifiedName: 'Inv.Stock', doc: null, nameRange: range },
  ] satisfies GlossaryEntry[],
};

const handlers: ModelOutlineHandlers = {
  onSelect: () => {},
  goto: () => {},
  onOpenContextMap: () => {},
  onOpenGlossary: () => {},
};

describe('ModelOutlinePanel', () => {
  test('renders every context when unscoped, narrows when the active context changes', () => {
    const store = createAppStore();
    const { container } = render(<ModelOutlinePanel store={store} model={model} handlers={handlers} />);

    // Unscoped (ALL_CONTEXTS) → both contexts' leaves are present.
    expect(container.textContent).toContain('Order');
    expect(container.textContent).toContain('Stock');

    // Narrowing the scope re-renders the panel (the store mutation is wrapped in act() so Preact flushes
    // the async-batched re-render before we assert) and drops the other context's leaf.
    act(() => store.getState().setActiveContext('Sales'));
    expect(container.textContent).toContain('Order');
    expect(container.textContent).not.toContain('Stock');
  });

  test('marks the selected leaf with is-selected and clears it when the selection moves away', () => {
    const store = createAppStore();
    const { container } = render(<ModelOutlinePanel store={store} model={model} handlers={handlers} />);

    const orderLeaf = () => container.querySelector<HTMLElement>('.koi-model-leaf[data-qname="Sales.Order"]')!;
    expect(orderLeaf().classList.contains('is-selected')).toBe(false);

    act(() => store.getState().setSelection({ qualifiedName: 'Sales.Order', context: 'Sales' }));
    expect(orderLeaf().classList.contains('is-selected')).toBe(true);

    act(() => store.getState().setSelection({ qualifiedName: 'Inv.Stock', context: 'Inv' }));
    expect(orderLeaf().classList.contains('is-selected')).toBe(false);
    expect(
      container.querySelector<HTMLElement>('.koi-model-leaf[data-qname="Inv.Stock"]')!.classList.contains('is-selected'),
    ).toBe(true);
  });
});
