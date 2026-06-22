import { describe, expect, test, vi } from 'vitest';
import { act, render } from '@testing-library/preact';
import { createAppStore } from '@/store/index';
import { ContextBreadcrumb } from '@/panels/ContextBreadcrumb';
import { buildModelIndex } from '@/modelIndex';
import type { DiagramNode, DocsFile, DocsResult, GlossaryEntry, GlossaryModel, Range } from '@/lsp';

const range: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } };

const scopeSelect = (c: Element) => c.querySelector<HTMLSelectElement>('[data-role="crumb-scope"]');
const elementCrumb = (c: Element) => c.querySelector('[data-role="crumb-element"]');

// A real joined index (same pattern as PropertiesPanel.test) so the element crumb resolves a genuine
// construct kind → icon. Order is an aggregate, Money a value object.
function makeIndex() {
  const glossary: GlossaryModel = {
    entries: [
      { id: 'Ordering', name: 'Ordering', kind: 'context', context: 'Ordering', qualifiedName: 'Ordering', doc: null, nameRange: range },
      { id: 'Ordering.Order', name: 'Order', kind: 'aggregate', context: 'Ordering', qualifiedName: 'Ordering.Order', doc: null, nameRange: range },
      { id: 'Ordering.Money', name: 'Money', kind: 'value', context: 'Ordering', qualifiedName: 'Ordering.Money', doc: null, nameRange: range },
    ] satisfies GlossaryEntry[],
  };
  const node: DiagramNode = {
    id: 'Ordering.Order', label: 'Order', kind: 'aggregate', qualifiedName: 'Ordering.Order',
    sourceSpan: null, stereotype: 'aggregate root', members: [],
  };
  const file: DocsFile = {
    path: 'docs/x.md', contents: '',
    diagrams: [{ caption: 'c', kind: 'aggregate', mermaid: '', graph: { nodes: [node], edges: [] } }],
  };
  const docs: DocsResult = { files: [file] };
  return buildModelIndex(glossary, docs);
}

const noop = () => {};

describe('ContextBreadcrumb', () => {
  test('the scope selector shows "all" and lists the contexts; no element crumb on a fresh store', () => {
    const store = createAppStore();
    const { container } = render(
      <ContextBreadcrumb store={store} contexts={['Ordering', 'Billing']} index={null} onScopeChange={noop} />,
    );
    const select = scopeSelect(container)!;
    expect(select.value).toBe('all');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['all', 'Ordering', 'Billing']);
    expect(elementCrumb(container)).toBeNull();
  });

  test('tracks the active context scope', () => {
    const store = createAppStore();
    const { container } = render(
      <ContextBreadcrumb store={store} contexts={['Ordering']} index={null} onScopeChange={noop} />,
    );
    act(() => store.getState().setActiveContext('Ordering'));
    expect(scopeSelect(container)!.value).toBe('Ordering');
    // Narrowed → flagged for the full-strength styling; "All contexts" is the muted default.
    expect(container.querySelector('.koi-crumb-scope-wrap')!.getAttribute('data-scoped')).toBe('true');
  });

  test('picking a context routes through onScopeChange (the controller choke point)', () => {
    const store = createAppStore();
    const onScopeChange = vi.fn();
    const { container } = render(
      <ContextBreadcrumb store={store} contexts={['Ordering']} index={null} onScopeChange={onScopeChange} />,
    );
    const select = scopeSelect(container)!;
    select.value = 'Ordering';
    act(() => {
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onScopeChange).toHaveBeenCalledWith('Ordering');
  });

  test('shows the selected element by its simple name with the Explorer construct icon', () => {
    const store = createAppStore();
    const index = makeIndex();
    const { container } = render(
      <ContextBreadcrumb store={store} contexts={['Ordering']} index={index} onScopeChange={noop} />,
    );

    act(() => {
      store.getState().setActiveContext('Ordering');
      store.getState().setSelection({ qualifiedName: 'Ordering.Order', context: 'Ordering' });
    });
    const leaf = elementCrumb(container)!;
    expect(leaf.textContent).toBe('Order');
    // The icon is the SAME shared glyph as the navigator, keyed by construct — aggregate here.
    expect(leaf.querySelector('.koi-model-icon')!.getAttribute('data-construct')).toBe('aggregate');
    expect(leaf.getAttribute('title')).toBe('Aggregate');

    // Clearing the selection drops the element crumb but keeps the scope selector.
    act(() => store.getState().setSelection(null));
    expect(elementCrumb(container)).toBeNull();
    expect(scopeSelect(container)!.value).toBe('Ordering');
  });

  test('a value object resolves to the value-object glyph', () => {
    const store = createAppStore();
    const index = makeIndex();
    const { container } = render(
      <ContextBreadcrumb store={store} contexts={['Ordering']} index={index} onScopeChange={noop} />,
    );
    act(() => store.getState().setSelection({ qualifiedName: 'Ordering.Money', context: 'Ordering' }));
    const leaf = elementCrumb(container)!;
    expect(leaf.textContent).toBe('Money');
    expect(leaf.querySelector('.koi-model-icon')!.getAttribute('data-construct')).toBe('value');
    expect(leaf.getAttribute('title')).toBe('Value Object');
  });

  test('without an index the element crumb still shows the name (no icon yet)', () => {
    const store = createAppStore();
    const { container } = render(
      <ContextBreadcrumb store={store} contexts={['Ordering']} index={null} onScopeChange={noop} />,
    );
    act(() => store.getState().setSelection({ qualifiedName: 'Ordering.Order', context: 'Ordering' }));
    const leaf = elementCrumb(container)!;
    expect(leaf.textContent).toBe('Order');
    expect(leaf.querySelector('.koi-model-icon')).toBeNull();
  });
});
