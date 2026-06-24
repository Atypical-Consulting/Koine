import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/preact';
import type { StoreApi } from 'zustand/vanilla';
import { createAppStore, type AppState } from '@/store/index';
import { CanvasPalette } from '@/diagrams/CanvasPalette';
import { buildModelIndex, type ModelIndex } from '@/model/modelIndex';
import type { GlossaryModel, Range } from '@/lsp/lsp';
import { axe } from 'vitest-axe';

const btn = (c: Element, kind: string) => c.querySelector(`[data-kind="${kind}"]`) as HTMLButtonElement;

const range: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

// A model index holding a single aggregate `Sales.Orders`, so a selection of it lights up the
// aggregate-scoped (rule / repository) buttons.
function aggregateIndex(): ModelIndex {
  const glossary: GlossaryModel = {
    entries: [
      { id: 'Sales', name: 'Sales', kind: 'context', context: 'Sales', qualifiedName: 'Sales', doc: null, nameRange: range },
      { id: 'Sales.Orders', name: 'Orders', kind: 'aggregate', context: 'Sales', qualifiedName: 'Sales.Orders', doc: null, nameRange: range },
    ],
  };
  return buildModelIndex(glossary, { files: [] });
}

function renderPalette(
  store: StoreApi<AppState>,
  opts: { index?: ModelIndex | null; onAdd?: (kind: string) => void; onAddAggregateMember?: (kind: string, qn: string) => void } = {},
) {
  return render(
    <CanvasPalette
      store={store}
      index={opts.index ?? null}
      onAdd={opts.onAdd ?? (() => {})}
      onAddAggregateMember={opts.onAddAggregateMember ?? (() => {})}
    />,
  );
}

describe('CanvasPalette', () => {
  test('renders the six round-trip constructs, the two aggregate-scoped ones, plus the coming-soon buttons', () => {
    const { container } = renderPalette(createAppStore());
    for (const kind of ['entity', 'value', 'aggregate', 'event', 'enum', 'service', 'rule', 'repository']) {
      expect(btn(container, kind)).not.toBeNull();
    }
    // Coming-soon buttons are present and disabled (Service round-trips; Rule/Repository graduated to #254).
    const soon = container.querySelectorAll('.koi-palette-btn--soon');
    expect(soon.length).toBe(3);
    soon.forEach((b) => expect((b as HTMLButtonElement).disabled).toBe(true));
  });

  test('each construct button wears its shape-coded type icon (same glyph as the diagram nodes)', () => {
    const { container } = renderPalette(createAppStore());
    for (const kind of ['entity', 'value', 'aggregate', 'event', 'enum', 'service', 'rule', 'repository']) {
      const icon = btn(container, kind).querySelector('.koi-model-icon');
      expect(icon).not.toBeNull();
      expect((icon as HTMLElement).dataset.construct).toBe(kind);
    }
  });

  test('context-scoped buttons are disabled under "All contexts" and enabled once a context is active', () => {
    const store = createAppStore();
    const { container } = renderPalette(store);
    expect(btn(container, 'entity').disabled).toBe(true);
    act(() => store.getState().setActiveContext('Ordering'));
    expect(btn(container, 'entity').disabled).toBe(false);
  });

  test('under "All contexts", buttons enable when the model has exactly one context (the only home)', () => {
    const store = createAppStore(); // defaults to ALL_CONTEXTS
    const { container } = renderPalette(store);
    expect(btn(container, 'entity').disabled).toBe(true); // no contexts known yet
    act(() => store.getState().setContexts(['Ordering']));
    expect(btn(container, 'entity').disabled).toBe(false); // single context = unambiguous target
    act(() => store.getState().setContexts(['Ordering', 'Billing']));
    expect(btn(container, 'entity').disabled).toBe(true); // 2+ contexts = ambiguous, must pick
  });

  test('clicking an enabled construct calls onAdd with its kind', () => {
    const store = createAppStore();
    act(() => store.getState().setActiveContext('Ordering'));
    const onAdd = vi.fn();
    const { container } = renderPalette(store, { onAdd });
    fireEvent.click(btn(container, 'aggregate'));
    expect(onAdd).toHaveBeenCalledWith('aggregate');
  });

  test('aggregate-scoped buttons (rule/repository) are disabled until an aggregate is selected', () => {
    const store = createAppStore();
    const { container } = renderPalette(store, { index: aggregateIndex() });
    // No selection yet → both disabled.
    expect(btn(container, 'rule').disabled).toBe(true);
    expect(btn(container, 'repository').disabled).toBe(true);
    // Selecting the aggregate enables them.
    act(() => store.getState().setSelection({ qualifiedName: 'Sales.Orders', context: 'Sales' }));
    expect(btn(container, 'rule').disabled).toBe(false);
    expect(btn(container, 'repository').disabled).toBe(false);
  });

  test('clicking an aggregate-scoped button calls onAddAggregateMember with its kind and the aggregate qname', () => {
    const store = createAppStore();
    act(() => store.getState().setSelection({ qualifiedName: 'Sales.Orders', context: 'Sales' }));
    const onAddAggregateMember = vi.fn();
    const { container } = renderPalette(store, { index: aggregateIndex(), onAddAggregateMember });
    fireEvent.click(btn(container, 'repository'));
    expect(onAddAggregateMember).toHaveBeenCalledWith('repository', 'Sales.Orders');
  });

  test('selecting a non-aggregate element keeps the aggregate-scoped buttons disabled', () => {
    const store = createAppStore();
    // Resolves to nothing in the index → not an aggregate.
    act(() => store.getState().setSelection({ qualifiedName: 'Sales.Money', context: 'Sales' }));
    const { container } = renderPalette(store, { index: aggregateIndex() });
    expect(btn(container, 'rule').disabled).toBe(true);
    expect(btn(container, 'repository').disabled).toBe(true);
  });

  test('has no accessibility violations', async () => {
    const store = createAppStore();
    act(() => store.getState().setActiveContext('Ordering'));
    const { container } = renderPalette(store, { index: aggregateIndex() });
    expect(await axe(container)).toHaveNoViolations();
  });
});
