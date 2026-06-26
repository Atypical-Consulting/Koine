import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/preact';
import type { StoreApi } from 'zustand/vanilla';
import { createAppStore, type AppState } from '@/store/index';
import { CanvasPalette } from '@/diagrams/CanvasPalette';
import { buildModelIndex, type ModelIndex } from '@/model/modelIndex';
import type { GlossaryModel, Range } from '@/lsp/lsp';
import { axe } from 'vitest-axe';

const btn = (c: Element, kind: string) => c.querySelector(`[data-kind="${kind}"]`) as HTMLButtonElement;
const annBtn = (c: Element, kind: string) => c.querySelector(`[data-annotation="${kind}"]`) as HTMLButtonElement;

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
  opts: {
    index?: ModelIndex | null;
    onAdd?: (kind: string) => void;
    onAddAggregateMember?: (kind: string, qn: string) => void;
    onAddAnnotation?: (kind: string) => void;
    onExport?: (format: 'svg' | 'png' | 'plantuml') => void;
    onCopyMermaid?: () => void;
  } = {},
) {
  return render(
    <CanvasPalette
      store={store}
      index={opts.index ?? null}
      onAdd={opts.onAdd ?? (() => {})}
      onAddAggregateMember={opts.onAddAggregateMember ?? (() => {})}
      onAddAnnotation={opts.onAddAnnotation ?? (() => {})}
      onExport={opts.onExport ?? (() => {})}
      onCopyMermaid={opts.onCopyMermaid ?? (() => {})}
    />,
  );
}

const exportBtn = (c: Element, format: string) =>
  c.querySelector(`[data-export="${format}"]`) as HTMLButtonElement;

describe('CanvasPalette', () => {
  test('renders the six round-trip constructs, the two aggregate-scoped ones, plus the coming-soon buttons', () => {
    const { container } = renderPalette(createAppStore());
    for (const kind of ['entity', 'value', 'aggregate', 'event', 'enum', 'service', 'rule', 'repository']) {
      expect(btn(container, kind)).not.toBeNull();
    }
    // Coming-soon buttons are present and disabled. Service round-trips; Rule/Repository graduated to #254
    // and Note/Group to canvas-only annotations (#255), so only Relation remains muted.
    const soon = container.querySelectorAll('.koi-palette-btn--soon');
    expect(soon.length).toBe(1);
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

  test('the Note and Group annotation buttons are active (not context-gated) and fire onAddAnnotation', () => {
    const store = createAppStore(); // ALL_CONTEXTS, no contexts → round-trip constructs are disabled…
    const onAddAnnotation = vi.fn();
    const { container } = renderPalette(store, { onAddAnnotation });
    // …but the canvas-only annotations are enabled regardless (they have no `.koi` home context).
    expect(btn(container, 'entity').disabled).toBe(true);
    expect(annBtn(container, 'note')).not.toBeNull();
    expect(annBtn(container, 'note').disabled).toBe(false);
    expect(annBtn(container, 'group').disabled).toBe(false);

    fireEvent.click(annBtn(container, 'note'));
    expect(onAddAnnotation).toHaveBeenCalledWith('note');
    fireEvent.click(annBtn(container, 'group'));
    expect(onAddAnnotation).toHaveBeenCalledWith('group');
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

  test('clicking an export format fires onExport with that format (#271)', () => {
    const onExport = vi.fn();
    const { container } = renderPalette(createAppStore(), { onExport });
    for (const format of ['svg', 'png', 'plantuml'] as const) {
      const b = exportBtn(container, format);
      expect(b).not.toBeNull();
      fireEvent.click(b);
      expect(onExport).toHaveBeenCalledWith(format);
    }
  });

  test('the export menu and Copy Mermaid stay enabled regardless of context scope (#271)', () => {
    // The active diagram is the Visual canvas itself, not a `.koi` construct, so export never depends on
    // a home context — it's available even under "All contexts" with the round-trip constructs disabled.
    const store = createAppStore();
    const { container } = renderPalette(store);
    expect(btn(container, 'entity').disabled).toBe(true);
    expect(exportBtn(container, 'svg').disabled).toBe(false);
    expect(exportBtn(container, 'mermaid').disabled).toBe(false);
  });

  test('clicking Copy Mermaid fires onCopyMermaid (#271)', () => {
    const onCopyMermaid = vi.fn();
    const { container } = renderPalette(createAppStore(), { onCopyMermaid });
    const b = exportBtn(container, 'mermaid');
    expect(b).not.toBeNull();
    fireEvent.click(b);
    expect(onCopyMermaid).toHaveBeenCalledTimes(1);
  });

  // #534 facet (1): a native <details> only closes via its own <summary>, so picking an Export item used
  // to leave the popover open. Selecting any item must now both fire its action AND close the disclosure.
  test('selecting an export format closes the Export disclosure (#534)', () => {
    const onExport = vi.fn();
    const { container } = renderPalette(createAppStore(), { onExport });
    const details = container.querySelector('details.koi-export') as HTMLDetailsElement;
    details.setAttribute('open', '');
    expect(details.hasAttribute('open')).toBe(true);
    fireEvent.click(exportBtn(container, 'svg'));
    expect(onExport).toHaveBeenCalledWith('svg');
    expect(details.hasAttribute('open')).toBe(false);
  });

  test('clicking Copy Mermaid closes the Export disclosure (#534)', () => {
    const onCopyMermaid = vi.fn();
    const { container } = renderPalette(createAppStore(), { onCopyMermaid });
    const details = container.querySelector('details.koi-export') as HTMLDetailsElement;
    details.setAttribute('open', '');
    expect(details.hasAttribute('open')).toBe(true);
    fireEvent.click(exportBtn(container, 'mermaid'));
    expect(onCopyMermaid).toHaveBeenCalledTimes(1);
    expect(details.hasAttribute('open')).toBe(false);
  });

  test('has no accessibility violations', async () => {
    const store = createAppStore();
    act(() => store.getState().setActiveContext('Ordering'));
    const { container } = renderPalette(store, { index: aggregateIndex() });
    expect(await axe(container)).toHaveNoViolations();
  });
});
