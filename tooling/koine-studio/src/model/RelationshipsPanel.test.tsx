import { describe, expect, test } from 'vitest';
import { act, render } from '@testing-library/preact';
import { createAppStore } from '@/store/index';
import { RelationshipsPanel } from '@/model/RelationshipsPanel';
import type { DiagramEdge, DiagramGraph, DiagramNode, SourceSpan } from '@/lsp/lsp';
import { axe } from 'vitest-axe';

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

// A merged graph with a structural relation in Sales and one in Inv. Scoping to "Sales" keeps the Sales
// structural row and drops the Inv row. The panel renders STRUCTURAL edges only — strategic context→
// context relations live in the Output → Context Map facet, so none are passed or expected here (#146).
const graph: DiagramGraph = {
  nodes: [
    node('Order', 'Order', 'aggregate-root', 'Sales.Order', span(3)),
    node('OrderItem', 'OrderItem', 'value-object', 'Sales.OrderItem', span(8)),
    node('Stock', 'Stock', 'aggregate-root', 'Inv.Stock', span(20)),
    node('StockLevel', 'StockLevel', 'value-object', 'Inv.StockLevel', span(24)),
  ],
  edges: [edge('Order', 'OrderItem'), edge('Stock', 'StockLevel')],
};

describe('RelationshipsPanel', () => {
  test('lists every structural relation when unscoped, narrows to the active context on scope change', () => {
    const store = createAppStore();
    const { container } = render(
      <RelationshipsPanel store={store} graph={graph} handlers={{ goto: () => {} }} />,
    );

    // Unscoped → both contexts' structural relations are present.
    expect(container.textContent).toContain('OrderItem');
    expect(container.textContent).toContain('StockLevel');

    // Narrowing to Sales keeps Sales' structural row; drops Inv's row.
    act(() => store.getState().setActiveContext('Sales'));
    expect(container.textContent).toContain('OrderItem');
    expect(container.textContent).not.toContain('StockLevel');
  });

  test('has no accessibility violations', async () => {
    const store = createAppStore();
    const { container } = render(
      <RelationshipsPanel store={store} graph={graph} handlers={{ goto: () => {} }} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
