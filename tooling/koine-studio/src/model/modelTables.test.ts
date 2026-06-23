import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  extractEvents,
  extractRelationships,
  mergeDiagramGraphs,
  mergeGraphsForView,
  renderEventsTable,
  renderRelationshipsTable,
  type EventRow,
  type RelationRow,
} from '@/model/modelTables';
import type { ContextMapResult, DiagramEdge, DiagramGraph, DiagramNode, SourceSpan } from '@/lsp/lsp';

afterEach(() => {
  document.body.innerHTML = '';
});

const span = (line: number, file: string | null = 'file:///m.koi'): SourceSpan => ({
  file,
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

// A single combined projection (what ide.ts builds via mergeDiagramGraphs): one aggregate's class
// diagram (root + nested VO + nested domain event, composition edges) fused with the cross-context
// integration-event flow (publisher context --publishes--> event --consumed by--> subscriber).
const combined: DiagramGraph = {
  nodes: [
    node('Order', 'Order', 'aggregate-root', 'Sales.Order', span(3)),
    node('OrderItem', 'OrderItem', 'value-object', 'Sales.OrderItem', span(8)),
    node('OrderPlaced', 'OrderPlaced', 'event', 'Sales.OrderPlaced', span(12)),
    node('evt_Sales_OrderShipped', 'Sales.OrderShipped', 'integration-event', 'Sales.OrderShipped', span(20)),
    node('Sales', 'Sales', 'context', 'Sales', span(1)),
    node('Shipping', 'Shipping', 'context', 'Shipping', span(40)),
  ],
  edges: [
    edge('Order', 'OrderItem'), // composition (contains)
    edge('Order', 'OrderPlaced'), // composition (contains a domain event)
    edge('Sales', 'evt_Sales_OrderShipped', 'publishes'),
    edge('evt_Sales_OrderShipped', 'Shipping', 'consumed by'),
  ],
};

const contextMap: ContextMapResult = {
  contexts: ['Sales', 'Shipping'],
  relations: [
    { upstream: 'Sales', downstream: 'Shipping', kind: 'Customer/Supplier', bidirectional: false, sharedTypes: [], acl: [] },
  ],
};

describe('extractEvents', () => {
  test('classifies domain vs integration and fills publisher/context', () => {
    const rows = extractEvents(combined);
    const byName = (n: string): EventRow => rows.find((r) => r.name === n)!;

    const placed = byName('OrderPlaced');
    expect(placed.type).toBe('domain');
    expect(placed.publishedBy).toBe('Order'); // the owning aggregate root (composition edge)
    expect(placed.context).toBe('Sales');
    expect(placed.qualifiedName).toBe('Sales.OrderPlaced'); // carried for select-to-inspect

    const shipped = byName('OrderShipped');
    expect(shipped.type).toBe('integration');
    expect(shipped.publishedBy).toBe('Sales'); // the publishing context
    expect(shipped.context).toBe('Sales');
  });

  test('includes only event / integration-event nodes (not aggregates, VOs, or contexts)', () => {
    const names = extractEvents(combined).map((r) => r.name);
    expect(names).toContain('OrderPlaced');
    expect(names).toContain('OrderShipped');
    expect(names).not.toContain('Order');
    expect(names).not.toContain('OrderItem');
    expect(names).not.toContain('Sales');
    expect(names).not.toContain('Shipping');
  });

  test('carries the source span for goto', () => {
    const placed = extractEvents(combined).find((r) => r.name === 'OrderPlaced')!;
    expect(placed.span).not.toBeNull();
    expect(placed.span!.line).toBe(12);
    expect(placed.span!.column).toBe(3);
  });

  test('defaults a missing publisher to an em dash', () => {
    const orphan: DiagramGraph = {
      nodes: [node('Loose', 'Loose', 'event', 'Sales.Loose', span(5))],
      edges: [],
    };
    expect(extractEvents(orphan)[0].publishedBy).toBe('—');
  });

  test('returns [] for a graph with no events', () => {
    const noEvents: DiagramGraph = {
      nodes: [node('Order', 'Order', 'aggregate-root', 'Sales.Order', span(3))],
      edges: [],
    };
    expect(extractEvents(noEvents)).toEqual([]);
  });
});

describe('extractRelationships', () => {
  test('maps composition edges to source/relation/target', () => {
    const rows = extractRelationships(combined, { contexts: [], relations: [] });
    const contains = rows.filter((r) => r.relation === 'contains');
    expect(contains).toEqual([
      expect.objectContaining({ source: 'Order', relation: 'contains', target: 'OrderItem', contexts: ['Sales'] }),
      expect.objectContaining({ source: 'Order', relation: 'contains', target: 'OrderPlaced', contexts: ['Sales'] }),
    ]);
  });

  test('includes strategic relations from the context map', () => {
    const rows = extractRelationships(combined, contextMap);
    const strategic = rows.find((r) => r.source === 'Sales' && r.target === 'Shipping');
    expect(strategic).toMatchObject({ relation: 'Customer/Supplier', contexts: ['Sales', 'Shipping'] });
  });

  test('excludes event-flow and state edges (only structural + strategic relations)', () => {
    const rows = extractRelationships(combined, contextMap);
    expect(rows.some((r) => r.relation === 'publishes')).toBe(false);
    expect(rows.some((r) => r.relation === 'consumed by')).toBe(false);
  });

  test('carries the source span for structural rows; strategic rows have none', () => {
    const rows = extractRelationships(combined, contextMap);
    const contains = rows.find((r) => r.relation === 'contains')!;
    expect(contains.span).not.toBeNull();
    expect(contains.span!.line).toBe(3); // the source (Order) declaration
    const strategic = rows.find((r) => r.relation === 'Customer/Supplier')!;
    expect(strategic.span).toBeNull();
  });

  test('returns [] when there are no edges and no context map', () => {
    const empty: DiagramGraph = { nodes: [], edges: [] };
    expect(extractRelationships(empty, { contexts: [], relations: [] })).toEqual([]);
  });
});

describe('mergeDiagramGraphs', () => {
  test('disambiguates colliding node ids across graphs while keeping each graph’s edges intact', () => {
    const g1: DiagramGraph = {
      nodes: [node('X', 'X1', 'aggregate-root', 'A.X'), node('Y', 'Y1', 'value-object', 'A.Y')],
      edges: [edge('X', 'Y')],
    };
    const g2: DiagramGraph = {
      nodes: [node('X', 'X2', 'aggregate-root', 'B.X'), node('Z', 'Z2', 'value-object', 'B.Z')],
      edges: [edge('X', 'Z')],
    };
    const merged = mergeDiagramGraphs([g1, g2]);
    expect(merged.nodes).toHaveLength(4);
    // Every edge endpoint still resolves to a node in the merged graph...
    const ids = new Set(merged.nodes.map((n) => n.id));
    for (const e of merged.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
    // ...and the two colliding 'X' ids did NOT cross-link: g1's X→Y resolves to X1/Y1, g2's X→Z to X2/Z2.
    const byId = new Map(merged.nodes.map((n) => [n.id, n] as const));
    const [e1, e2] = merged.edges;
    expect(byId.get(e1.from)!.label).toBe('X1');
    expect(byId.get(e1.to)!.label).toBe('Y1');
    expect(byId.get(e2.from)!.label).toBe('X2');
    expect(byId.get(e2.to)!.label).toBe('Z2');
  });

});

describe('mergeGraphsForView', () => {
  test('dedupes a node shared across diagrams (by qualified name), keeping the richest', () => {
    // Order appears in its aggregate diagram (with members) AND as a bare node in a state machine.
    const richOrder: DiagramNode = {
      id: 'Order',
      label: 'Order',
      kind: 'aggregate-root',
      qualifiedName: 'Sales.Order',
      sourceSpan: null,
      stereotype: 'aggregate root',
      members: [{ text: 'id: OrderId', kind: 'field' }],
    };
    const aggregate: DiagramGraph = { nodes: [richOrder, node('S', 'OrderStatus', 'value', 'Sales.OrderStatus')], edges: [edge('Order', 'S')] };
    const stateMachine: DiagramGraph = {
      nodes: [node('Order', 'Order', 'aggregate-root', 'Sales.Order'), node('s1', 'PENDING', 'state', 'PENDING')],
      edges: [edge('Order', 's1')],
    };
    const merged = mergeGraphsForView([aggregate, stateMachine]);
    // Order collapses to ONE node (the rich one with members); OrderStatus + the state survive.
    const orders = merged.nodes.filter((n) => n.qualifiedName === 'Sales.Order');
    expect(orders).toHaveLength(1);
    expect(orders[0].members).toHaveLength(1); // kept the richest representation
    expect(merged.nodes).toHaveLength(3); // Order, OrderStatus, PENDING
    // Edges remap to the surviving ids and stay resolvable; no duplicates / self-loops.
    const ids = new Set(merged.nodes.map((n) => n.id));
    for (const e of merged.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
      expect(e.from).not.toBe(e.to);
    }
    expect(merged.edges).toHaveLength(2); // Order→OrderStatus, Order→PENDING
  });

  test('keeps distinct context-less nodes (e.g. same-named states) separate', () => {
    const g1: DiagramGraph = { nodes: [node('s', 'OPEN', 'state', 'OPEN')], edges: [] };
    const g2: DiagramGraph = { nodes: [node('s', 'OPEN', 'state', 'OPEN')], edges: [] };
    // Both 'OPEN' lack a dotted qualified name, so they don't collapse — they're namespaced per graph.
    expect(mergeGraphsForView([g1, g2]).nodes).toHaveLength(2);
  });

  test('preserves the compiler-derived edge cardinality through the merge', () => {
    const g: DiagramGraph = {
      nodes: [node('A', 'A', 'aggregate-root', 'Sales.A'), node('B', 'B', 'value', 'Sales.B')],
      edges: [{ from: 'A', to: 'B', label: null, cardinality: '*' }],
    };
    expect(mergeGraphsForView([g]).edges[0].cardinality).toBe('*');
  });
});

describe('mergeDiagramGraphs extractor pipeline', () => {
  test('a merged projection feeds the extractors end-to-end', () => {
    const aggregate: DiagramGraph = {
      nodes: [
        node('Order', 'Order', 'aggregate-root', 'Sales.Order', span(3)),
        node('OrderPlaced', 'OrderPlaced', 'event', 'Sales.OrderPlaced', span(12)),
      ],
      edges: [edge('Order', 'OrderPlaced')],
    };
    const integration: DiagramGraph = {
      nodes: [
        node('evt_Sales_OrderShipped', 'Sales.OrderShipped', 'integration-event', 'Sales.OrderShipped', span(20)),
        node('Sales', 'Sales', 'context', 'Sales', span(1)),
      ],
      edges: [edge('Sales', 'evt_Sales_OrderShipped', 'publishes')],
    };
    const events = extractEvents(mergeDiagramGraphs([aggregate, integration]));
    expect(events.map((r) => `${r.name}:${r.type}:${r.publishedBy}`)).toEqual([
      'OrderPlaced:domain:Order',
      'OrderShipped:integration:Sales',
    ]);
  });
});

describe('renderEventsTable', () => {
  const rows: EventRow[] = [
    { name: 'OrderPlaced', qualifiedName: 'Sales.OrderPlaced', type: 'domain', publishedBy: 'Order', context: 'Sales', when: '', span: span(12) },
    { name: 'OrderShipped', qualifiedName: 'Sales.OrderShipped', type: 'integration', publishedBy: 'Sales', context: 'Sales', when: '', span: span(20) },
  ];

  test('renders a header row and one body row per event, with the spec’s columns', () => {
    const el = renderEventsTable(rows, { goto: () => {} });
    const headers = Array.from(el.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(headers).toEqual(['Event', 'Type', 'Published By', 'Bounded Context', 'When']);
    expect(el.querySelectorAll('tbody tr')).toHaveLength(2);
    const firstRow = Array.from(el.querySelectorAll('tbody tr')[0].querySelectorAll('td')).map((td) => td.textContent);
    expect(firstRow).toEqual(['OrderPlaced', 'Domain', 'Order', 'Sales', '—']); // empty `when` shows an em dash
    const second = Array.from(el.querySelectorAll('tbody tr')[1].querySelectorAll('td')).map((td) => td.textContent);
    expect(second).toEqual(['OrderShipped', 'Integration', 'Sales', 'Sales', '—']);
  });

  test('a row click invokes goto with the row’s span', () => {
    const goto = vi.fn();
    const el = renderEventsTable(rows, { goto });
    document.body.appendChild(el);
    (el.querySelectorAll('tbody tr')[1] as HTMLElement).click();
    expect(goto).toHaveBeenCalledWith(rows[1].span);
  });

  test('Enter on a focused row invokes goto (keyboard access)', () => {
    const goto = vi.fn();
    const el = renderEventsTable(rows, { goto });
    document.body.appendChild(el);
    const row = el.querySelectorAll('tbody tr')[0] as HTMLElement;
    expect(row.tabIndex).toBe(0);
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(goto).toHaveBeenCalledWith(rows[0].span);
  });

  test('navigable rows carry an aria-label naming the jump-to-source action', () => {
    const el = renderEventsTable(rows, { goto: () => {} });
    const row = el.querySelectorAll('tbody tr')[0] as HTMLElement;
    expect(row.getAttribute('aria-label')).toBe('Jump to source: OrderPlaced');
  });

  test('a row click also invokes onSelect with the event’s qualifiedName + context (loads the inspector)', () => {
    const onSelect = vi.fn();
    const el = renderEventsTable(rows, { goto: () => {}, onSelect });
    document.body.appendChild(el);
    (el.querySelectorAll('tbody tr')[0] as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledWith('Sales.OrderPlaced', 'Sales');
  });

  test('empty input renders an empty-state element (no table rows)', () => {
    const el = renderEventsTable([], { goto: () => {} });
    expect(el.querySelector('tbody tr')).toBeNull();
    expect(el.classList.contains('koi-table-empty')).toBe(true);
  });

  test('clicking a column header sorts rows by that column, toggling direction', () => {
    const unsorted: EventRow[] = [
      { name: 'Shipped', qualifiedName: 'Sales.Shipped', type: 'integration', publishedBy: 'Sales', context: 'Sales', when: '', span: span(20) },
      { name: 'Placed', qualifiedName: 'Sales.Placed', type: 'domain', publishedBy: 'Order', context: 'Sales', when: '', span: span(12) },
    ];
    const el = renderEventsTable(unsorted, { goto: () => {} });
    document.body.appendChild(el);
    const eventHeader = el.querySelectorAll('thead th')[0];
    const names = () => Array.from(el.querySelectorAll('tbody tr')).map((r) => r.querySelector('td')!.textContent);

    eventHeader.querySelector('button')!.click(); // ascending
    expect(names()).toEqual(['Placed', 'Shipped']);
    expect(eventHeader.getAttribute('aria-sort')).toBe('ascending');

    eventHeader.querySelector('button')!.click(); // descending
    expect(names()).toEqual(['Shipped', 'Placed']);
    expect(eventHeader.getAttribute('aria-sort')).toBe('descending');
  });

  test('sorting preserves click-to-source on the re-ordered rows', () => {
    const goto = vi.fn();
    const el = renderEventsTable(rows, { goto });
    document.body.appendChild(el);
    el.querySelectorAll('thead th')[0].querySelector('button')!.click();
    (el.querySelectorAll('tbody tr')[0] as HTMLElement).click();
    expect(goto).toHaveBeenCalledTimes(1);
  });
});

describe('renderRelationshipsTable', () => {
  const rows: RelationRow[] = [
    { source: 'Order', relation: 'contains', target: 'OrderItem', contexts: ['Sales'], span: span(8) },
    { source: 'Sales', relation: 'Customer/Supplier', target: 'Shipping', contexts: ['Sales', 'Shipping'], span: null },
  ];

  test('renders a header row and one body row per relation, with the spec’s columns', () => {
    const el = renderRelationshipsTable(rows, { goto: () => {} });
    const headers = Array.from(el.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(headers).toEqual(['Source', 'Relation', 'Target', 'Contexts']);
    expect(el.querySelectorAll('tbody tr')).toHaveLength(2);
    const structural = Array.from(el.querySelectorAll('tbody tr')[0].querySelectorAll('td')).map((td) => td.textContent);
    expect(structural).toEqual(['Order', 'contains', 'OrderItem', 'Sales']);
    const strategic = Array.from(el.querySelectorAll('tbody tr')[1].querySelectorAll('td')).map((td) => td.textContent);
    expect(strategic).toEqual(['Sales', 'Customer/Supplier', 'Shipping', 'Sales → Shipping']);
  });

  test('a structural row (with a span) is click-to-source', () => {
    const goto = vi.fn();
    const el = renderRelationshipsTable(rows, { goto });
    document.body.appendChild(el);
    (el.querySelectorAll('tbody tr')[0] as HTMLElement).click();
    expect(goto).toHaveBeenCalledWith(rows[0].span);
  });

  test('a strategic row (no span) is not clickable', () => {
    const goto = vi.fn();
    const el = renderRelationshipsTable(rows, { goto });
    document.body.appendChild(el);
    const tr = el.querySelectorAll('tbody tr')[1] as HTMLElement;
    expect(tr.classList.contains('koi-row-link')).toBe(false);
    tr.click();
    expect(goto).not.toHaveBeenCalled();
  });

  test('empty input renders an empty-state element', () => {
    const el = renderRelationshipsTable([], { goto: () => {} });
    expect(el.querySelector('tbody tr')).toBeNull();
    expect(el.classList.contains('koi-table-empty')).toBe(true);
  });
});
