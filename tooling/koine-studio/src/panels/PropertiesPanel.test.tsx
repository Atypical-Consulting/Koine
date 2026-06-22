import { describe, expect, test, vi } from 'vitest';
import { act, render } from '@testing-library/preact';
import { createAppStore } from '@/store/index';
import { useAppStore } from '@/store/hooks';
import { PropertiesPanel } from '@/panels/PropertiesPanel';
import { buildModelIndex } from '@/modelIndex';
import type { DiagramNode, DocsFile, DocsResult, GlossaryEntry, GlossaryModel, Range } from '@/lsp/lsp';
import type { InspectorHandlers } from '@/inspector';

const range: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } };

// Build a real joined index the same way modelIndex.test.ts does (buildModelIndex over a tiny glossary
// + a docs file with one diagram node), so the panel resolves a genuine element and renders real text.
function makeIndex() {
  const glossary: GlossaryModel = {
    entries: [
      { id: 'Sales', name: 'Sales', kind: 'context', context: 'Sales', qualifiedName: 'Sales', doc: null, nameRange: range },
      { id: 'Sales.Order', name: 'Order', kind: 'aggregate', context: 'Sales', qualifiedName: 'Sales.Order', doc: null, nameRange: range },
    ] satisfies GlossaryEntry[],
  };
  const orderNode: DiagramNode = {
    id: 'Sales.Order',
    label: 'Order',
    kind: 'aggregate',
    qualifiedName: 'Sales.Order',
    sourceSpan: null,
    stereotype: 'aggregate root',
    members: [{ text: 'id: OrderId', kind: 'field' }],
  };
  const file: DocsFile = {
    path: 'docs/x.md',
    contents: '',
    diagrams: [{ caption: 'c', kind: 'aggregate', mermaid: '', graph: { nodes: [orderNode], edges: [] } }],
  };
  const docs: DocsResult = { files: [file] };
  return buildModelIndex(glossary, docs);
}

const handlers: InspectorHandlers = { onGoto: () => {} };

describe('PropertiesPanel', () => {
  test('renders the selected element name and re-renders when selection changes', () => {
    const store = createAppStore();
    const index = makeIndex();
    const { container } = render(<PropertiesPanel store={store} index={index} handlers={handlers} />);

    // Nothing selected yet → the inspector's empty state is mounted.
    expect(container.querySelector('.koi-inspector')).not.toBeNull();
    expect(container.textContent).not.toContain('Order');

    // Selecting an element re-renders the panel and shows the resolved element's name. The store
    // mutation is wrapped in act() so Preact flushes the (async-batched) re-render before we assert.
    act(() => store.getState().setSelection({ qualifiedName: 'Sales.Order', context: 'Sales' }));
    expect(container.textContent).toContain('Order');
  });

  test('does NOT re-render on an unrelated slice change (bottom tab)', () => {
    const store = createAppStore();
    const index = makeIndex();

    // A probe that subscribes to exactly the same slice the panel does. If an unrelated slice change
    // re-rendered selection subscribers, this counter would tick.
    const renders = vi.fn();
    function Probe() {
      useAppStore(store, (s) => s.selection);
      renders();
      return <PropertiesPanel store={store} index={index} handlers={handlers} />;
    }
    render(<Probe />);
    const before = renders.mock.calls.length;

    // An unrelated slice change must not re-render a selection subscriber (flushed via act()).
    act(() => store.getState().setBottom('events'));
    expect(renders.mock.calls.length).toBe(before); // no re-render

    // Sanity: a relevant change DOES re-render, proving the probe is actually wired.
    act(() => store.getState().setSelection({ qualifiedName: 'Sales.Order', context: 'Sales' }));
    expect(renders.mock.calls.length).toBeGreaterThan(before);
  });
});
