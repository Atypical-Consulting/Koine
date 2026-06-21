import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  extractEvents,
  extractRelationships,
  mergeDiagramGraphs,
  type EventRow,
  type RelationRow,
} from './modelTables';
import type { ContextMapResult, DiagramEdge, DiagramGraph, DiagramNode, SourceSpan } from './lsp';

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

// Renderer suites (Task 2) — declared here so the renderers are designed against these row shapes.
describe('renderers (placeholder until Task 2)', () => {
  test('row shapes are stable', () => {
    const e: EventRow = { name: 'X', type: 'domain', publishedBy: 'A', context: 'C', when: '', span: null };
    const r: RelationRow = { source: 'A', relation: 'contains', target: 'B', contexts: ['C'], span: null };
    expect(e.name).toBe('X');
    expect(r.relation).toBe('contains');
    expect(vi.fn()).toBeTypeOf('function');
  });
});
