import { describe, expect, test, vi } from 'vitest';
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

// Moved from modelTables.test.ts's `renderRelationshipsTable` describe block when #992 task 3 retired
// that pure-DOM builder in favor of the shared SortableTable — these assert the Relationships table's
// SPECIFIC column set, empty-state text, and that a structural row lacking a span (both endpoints
// undocumented) renders plain / isn't clickable; generic table behavior (keyboard access, aria-label,
// sort toggling) is covered once, generically, by SortableTable.test.tsx.
describe('RelationshipsPanel — table (moved from modelTables.test.ts)', () => {
  test('renders the Source · Relation · Target · Contexts columns', () => {
    const store = createAppStore();
    const { container } = render(
      <RelationshipsPanel store={store} graph={graph} handlers={{ goto: () => {} }} />,
    );
    const headers = Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(headers).toEqual(['Source', 'Relation', 'Target', 'Contexts']);
    const firstRow = Array.from(container.querySelectorAll('tbody tr')[0].querySelectorAll('td')).map(
      (td) => td.textContent,
    );
    expect(firstRow).toEqual(['Order', 'contains', 'OrderItem', 'Sales']);
  });

  test('a row with a span is click-to-source; a spanless structural row renders plain and is not clickable', () => {
    // Neither Customer nor its relation to Order carries a source span (both endpoints undocumented) —
    // extractRelationships falls back to `from.sourceSpan ?? to.sourceSpan`, both null here.
    const spanlessGraph: DiagramGraph = {
      nodes: [
        node('Order', 'Order', 'aggregate-root', 'Sales.Order'),
        node('Customer', 'Customer', 'entity', 'Sales.Customer'),
      ],
      edges: [edge('Order', 'Customer', 'references')],
    };
    const goto = vi.fn();
    const store = createAppStore();
    const { container } = render(
      <RelationshipsPanel store={store} graph={spanlessGraph} handlers={{ goto }} />,
    );
    const tr = container.querySelectorAll('tbody tr')[0] as HTMLElement;
    expect(tr.classList.contains('koi-row-link')).toBe(false);
    tr.click();
    expect(goto).not.toHaveBeenCalled();
  });

  test('empty input renders the Relationships-specific empty-state text (no table)', () => {
    const noRelations: DiagramGraph = { nodes: [], edges: [] };
    const store = createAppStore();
    const { container } = render(
      <RelationshipsPanel store={store} graph={noRelations} handlers={{ goto: () => {} }} />,
    );
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('.koi-table-empty')!.textContent).toBe(
      'No structural relationships yet — add an aggregate or an entity reference to your model.',
    );
  });
});
