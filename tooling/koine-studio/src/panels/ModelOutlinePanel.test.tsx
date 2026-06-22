import { describe, expect, test } from 'vitest';
import { act, fireEvent, render } from '@testing-library/preact';
import { createAppStore } from '@/store/index';
import { ModelOutlinePanel } from '@/panels/ModelOutlinePanel';
import type { GlossaryEntry, GlossaryModel, Range } from '@/lsp/lsp';
import type { ModelOutlineHandlers } from '@/modelOutline';

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

  test('a filter query narrows the visible leaves by name; clearing it restores them', () => {
    const store = createAppStore();
    const { container } = render(<ModelOutlinePanel store={store} model={model} handlers={handlers} />);

    const input = container.querySelector<HTMLInputElement>('input.koi-outline-filter')!;
    expect(input).not.toBeNull();

    // Both contexts' leaves present before filtering.
    expect(container.textContent).toContain('Order');
    expect(container.textContent).toContain('Stock');

    // Typing "Ord" keeps the matching leaf (Order) and drops the rest (Stock).
    fireEvent.input(input, { target: { value: 'Ord' } });
    expect(container.textContent).toContain('Order');
    expect(container.textContent).not.toContain('Stock');

    // Clearing the query restores the full tree.
    fireEvent.input(input, { target: { value: '' } });
    expect(container.textContent).toContain('Order');
    expect(container.textContent).toContain('Stock');
  });

  test('the filter query is store-backed, so it survives a panel remount (model reload)', () => {
    const store = createAppStore();
    const first = render(<ModelOutlinePanel store={store} model={model} handlers={handlers} />);
    fireEvent.input(first.container.querySelector<HTMLInputElement>('input.koi-outline-filter')!, {
      target: { value: 'Ord' },
    });
    expect(first.container.textContent).not.toContain('Stock');
    first.unmount();

    // A fresh panel against the SAME store — exactly what the controller does on every loadModel — keeps
    // the filter instead of resetting it (the local-useState version would have cleared here).
    const second = render(<ModelOutlinePanel store={store} model={model} handlers={handlers} />);
    expect(second.container.querySelector<HTMLInputElement>('input.koi-outline-filter')!.value).toBe('Ord');
    expect(second.container.textContent).toContain('Order');
    expect(second.container.textContent).not.toContain('Stock');
  });

  test('the filter composes with the active-context scope', () => {
    const store = createAppStore();
    const { container } = render(<ModelOutlinePanel store={store} model={model} handlers={handlers} />);
    const input = container.querySelector<HTMLInputElement>('input.koi-outline-filter')!;

    // Scope to Sales first (drops Stock), then a filter that matches nothing in Sales clears the tree.
    act(() => store.getState().setActiveContext('Sales'));
    expect(container.textContent).toContain('Order');
    fireEvent.input(input, { target: { value: 'Stock' } });
    expect(container.textContent).not.toContain('Order');
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
