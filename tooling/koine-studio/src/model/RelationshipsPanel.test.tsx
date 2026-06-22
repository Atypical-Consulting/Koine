import { describe, expect, test } from 'vitest';
import { act, render } from '@testing-library/preact';
import { createAppStore } from '@/store/index';
import { RelationshipsPanel } from '@/model/RelationshipsPanel';
import type { ContextMapResult, DiagramEdge, DiagramGraph, DiagramNode, SourceSpan } from '@/lsp/lsp';

const span = (line: number): SourceSpan => ({
  file: 'file:///m.koi',
  line,
  column: 3,
  endLine: line,
  endColumn: 9,
  offset: 0,
  length: 6,
});

const node = (
  id: string,
  label: string,
  kind: string,
  qualifiedName: string,
  sourceSpan: SourceSpan | null = null,
): DiagramNode => ({ id, label, kind, qualifiedName, sourceSpan, stereotype: null, members: [] });

const edge = (from: string, to: string, label: string | null = null): DiagramEdge => ({ from, to, label });

// A merged graph with a structural relation in Sales and one in Inv, plus a strategic Sales→Shipping
// relation. Scoping to "Sales" keeps the Sales structural row + the strategic row, drops the Inv row.
const graph: DiagramGraph = {
  nodes: [
    node('Order', 'Order', 'aggregate-root', 'Sales.Order', span(3)),
    node('OrderItem', 'OrderItem', 'value-object', 'Sales.OrderItem', span(8)),
    node('Stock', 'Stock', 'aggregate-root', 'Inv.Stock', span(20)),
    node('StockLevel', 'StockLevel', 'value-object', 'Inv.StockLevel', span(24)),
  ],
  edges: [edge('Order', 'OrderItem'), edge('Stock', 'StockLevel')],
};

const contextMap: ContextMapResult = {
  contexts: ['Sales', 'Shipping', 'Inv'],
  relations: [
    { upstream: 'Sales', downstream: 'Shipping', kind: 'Customer/Supplier', bidirectional: false, sharedTypes: [], acl: [] },
  ],
};

describe('RelationshipsPanel', () => {
  test('lists every relation when unscoped, narrows structural + strategic rows on scope change', () => {
    const store = createAppStore();
    const { container } = render(
      <RelationshipsPanel store={store} graph={graph} contextMap={contextMap} handlers={{ goto: () => {} }} />,
    );

    // Unscoped → both structural relations and the strategic relation are present.
    expect(container.textContent).toContain('OrderItem');
    expect(container.textContent).toContain('StockLevel');
    expect(container.textContent).toContain('Customer/Supplier');

    // Narrowing to Sales keeps Sales' structural row + the Sales→Shipping strategic row; drops Inv's row.
    act(() => store.getState().setActiveContext('Sales'));
    expect(container.textContent).toContain('OrderItem');
    expect(container.textContent).toContain('Customer/Supplier');
    expect(container.textContent).not.toContain('StockLevel');
  });
});
