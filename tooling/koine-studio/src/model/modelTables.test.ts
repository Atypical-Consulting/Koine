import { afterEach, describe, expect, test } from 'vitest';
import {
  extractEventFlow,
  extractEvents,
  extractRelationships,
  mergeDiagramGraphs,
  mergeGraphsForView,
  type EventRow,
} from '@/model/modelTables';
import type { DiagramEdge, DiagramGraph, DiagramNode, SourceSpan } from '@/lsp/lsp';

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
  doc: string | null = null,
): DiagramNode => ({ id, label, kind, qualifiedName, sourceSpan, stereotype: null, members: [], doc });

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

  test('fills the When column from the event node doc, empty when undocumented (issue #170)', () => {
    const docs: DiagramGraph = {
      nodes: [
        node('Placed', 'Placed', 'event', 'Sales.Placed', span(12), 'Raised when an order is placed.'),
        node('Lost', 'Lost', 'event', 'Sales.Lost', span(15)), // undocumented → doc null
      ],
      edges: [],
    };
    const rows = extractEvents(docs);
    expect(rows.find((r) => r.name === 'Placed')!.when).toBe('Raised when an order is placed.');
    expect(rows.find((r) => r.name === 'Lost')!.when).toBe('');
  });
});

describe('extractEventFlow', () => {
  test('a domain event yields a domain-event node + a flow edge from its publishing aggregate', () => {
    const { nodes, edges } = extractEventFlow(combined);

    const placed = nodes.find((n) => n.qualifiedName === 'Sales.OrderPlaced')!;
    expect(placed.kind).toBe('domain-event');
    expect(placed.label).toBe('OrderPlaced'); // simple name, not the qualified name
    expect(placed.context).toBe('Sales');
    expect(placed.span!.line).toBe(12); // carried from the DiagramNode for click-to-source

    // The publishing aggregate becomes an `aggregate` card…
    const order = nodes.find((n) => n.label === 'Order')!;
    expect(order.kind).toBe('aggregate');
    // …with a `flow` edge aggregate → domain event.
    const flow = edges.find((e) => e.kind === 'flow' && e.to === placed.id)!;
    expect(flow.from).toBe(order.id);
  });

  test('an integration event yields an integration-event node + publish/subscribe edges bridging contexts', () => {
    const { nodes, edges } = extractEventFlow(combined);

    const shipped = nodes.find((n) => n.kind === 'integration-event')!;
    expect(shipped.qualifiedName).toBe('Sales.OrderShipped');
    expect(shipped.label).toBe('OrderShipped');
    expect(shipped.context).toBe('Sales');

    // A `publish` edge FROM the publishing context (a swimlane the renderer synthesizes, not a card).
    const publish = edges.find((e) => e.kind === 'publish' && e.to === shipped.id)!;
    expect(publish.from).toBe('Sales');

    // A `subscribe` edge TO the consuming context (the cross-context arrow).
    const subscribe = edges.find((e) => e.kind === 'subscribe' && e.from === shipped.id)!;
    expect(subscribe.to).toBe('Shipping');
  });

  test('an orphan event (no edges) still yields one node and zero edges', () => {
    const orphan: DiagramGraph = {
      nodes: [node('Loose', 'Loose', 'event', 'Sales.Loose', span(5))],
      edges: [],
    };
    const { nodes, edges } = extractEventFlow(orphan);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('domain-event');
    expect(edges).toHaveLength(0);
  });

  test('a graph with no events yields an empty flow', () => {
    const noEvents: DiagramGraph = {
      nodes: [node('Order', 'Order', 'aggregate-root', 'Sales.Order', span(3))],
      edges: [],
    };
    expect(extractEventFlow(noEvents)).toEqual({ nodes: [], edges: [] });
  });
});

describe('extractEventFlow command → event → policy → command chain (#439)', () => {
  // The enriched context graph the compiler now emits: a `capture` command emits `ChargeCaptured`; the
  // `PostToLedger` policy reacts and issues `record`. (Mirrors the pizzeria/saas payment context.)
  const chain: DiagramGraph = {
    nodes: [
      node('cmd_Charge_capture', 'capture', 'command', 'Payment.Charge.capture', span(10)),
      node('ChargeCaptured', 'ChargeCaptured', 'event', 'Payment.ChargeCaptured', span(5)),
      node('policy_PostToLedger', 'PostToLedger', 'policy', 'Payment.PostToLedger', span(20)),
      node('cmd_LedgerEntry_record', 'record', 'command', 'Payment.LedgerEntry.record', span(30)),
    ],
    edges: [
      edge('cmd_Charge_capture', 'ChargeCaptured', 'emits'),
      edge('ChargeCaptured', 'policy_PostToLedger', 'triggers'),
      edge('policy_PostToLedger', 'cmd_LedgerEntry_record', 'issues'),
    ],
  };

  test('produces command + policy cards with the bare behaviour/policy name', () => {
    const { nodes } = extractEventFlow(chain);

    const capture = nodes.find((n) => n.qualifiedName === 'Payment.Charge.capture')!;
    expect(capture.kind).toBe('command');
    expect(capture.label).toBe('capture'); // the bare name, NOT 'Charge.capture'
    expect(capture.context).toBe('Payment');
    expect(capture.span!.line).toBe(10); // carried for click-to-source

    const policy = nodes.find((n) => n.qualifiedName === 'Payment.PostToLedger')!;
    expect(policy.kind).toBe('policy');
    expect(policy.label).toBe('PostToLedger');

    expect(nodes.find((n) => n.qualifiedName === 'Payment.ChargeCaptured')!.kind).toBe('domain-event');
  });

  test('wires the full chain as flow edges carrying the emit/trigger/issue verbs', () => {
    const { edges } = extractEventFlow(chain);
    const flow = (from: string, to: string) =>
      edges.find((e) => e.kind === 'flow' && e.from === from && e.to === to);

    expect(flow('cmd_Charge_capture', 'ChargeCaptured')?.label).toBe('emits');
    expect(flow('ChargeCaptured', 'policy_PostToLedger')?.label).toBe('triggers');
    expect(flow('policy_PostToLedger', 'cmd_LedgerEntry_record')?.label).toBe('issues');
  });

  test('a command → event edge does not hijack the event’s aggregate publisher', () => {
    // The domain event is owned by an aggregate (composition edge) AND emitted by a command. The publisher
    // must stay the aggregate (the command is the chain producer, surfaced separately) — guards a regression
    // where the command → event edge would be read as the event's publisher.
    const both: DiagramGraph = {
      nodes: [
        node('Order', 'Order', 'aggregate-root', 'Sales.Order', span(3)),
        node('OrderPlaced', 'OrderPlaced', 'event', 'Sales.OrderPlaced', span(12)),
        node('cmd_Order_place', 'place', 'command', 'Sales.Order.place', span(15)),
      ],
      edges: [
        edge('Order', 'OrderPlaced'), // aggregate composition (owns the event)
        edge('cmd_Order_place', 'OrderPlaced', 'emits'), // command emit — must NOT become the publisher
      ],
    };

    // The Events table still attributes the event to the aggregate, not the command.
    expect(extractEvents(both).find((r) => r.name === 'OrderPlaced')!.publishedBy).toBe('Order');

    // The flow keeps the aggregate → event arrow AND adds the command → event chain edge.
    const { nodes, edges } = extractEventFlow(both);
    expect(nodes.find((n) => n.id === 'Order')!.kind).toBe('aggregate');
    expect(edges.some((e) => e.kind === 'flow' && e.from === 'Order' && e.to === 'OrderPlaced')).toBe(true);
    expect(edges.some((e) => e.kind === 'flow' && e.from === 'cmd_Order_place' && e.to === 'OrderPlaced')).toBe(true);
  });

  test('an unwired command/policy still yields an orphan card', () => {
    const orphans: DiagramGraph = {
      nodes: [
        node('cmd_X_do', 'do', 'command', 'X.E.do', span(1)),
        node('policy_P', 'P', 'policy', 'X.P', span(2)),
      ],
      edges: [],
    };
    const { nodes, edges } = extractEventFlow(orphans);
    expect(nodes.map((n) => n.kind).sort()).toEqual(['command', 'policy']);
    expect(edges).toEqual([]);
  });
});

describe('extractRelationships', () => {
  test('maps composition edges to source/relation/target', () => {
    const rows = extractRelationships(combined);
    const contains = rows.filter((r) => r.relation === 'contains');
    expect(contains).toEqual([
      expect.objectContaining({ source: 'Order', relation: 'contains', target: 'OrderItem', contexts: ['Sales'] }),
      expect.objectContaining({ source: 'Order', relation: 'contains', target: 'OrderPlaced', contexts: ['Sales'] }),
    ]);
  });

  test('emits STRUCTURAL edges only — no strategic context→context rows (those are the Context Map facet)', () => {
    const rows = extractRelationships(combined);
    // A context→context relation (Sales → Shipping) must NOT appear here; its canonical home is the
    // Output → Context Map facet (#146). Every structural row spans exactly one bounded context.
    expect(rows.some((r) => r.source === 'Sales' && r.target === 'Shipping')).toBe(false);
    expect(rows.some((r) => r.relation === 'Customer/Supplier')).toBe(false);
    expect(rows.every((r) => r.contexts.length === 1)).toBe(true);
  });

  test('excludes event-flow and state edges (only structural relations)', () => {
    const rows = extractRelationships(combined);
    expect(rows.some((r) => r.relation === 'publishes')).toBe(false);
    expect(rows.some((r) => r.relation === 'consumed by')).toBe(false);
  });

  test('carries the source span for structural rows', () => {
    const rows = extractRelationships(combined);
    const contains = rows.find((r) => r.relation === 'contains')!;
    expect(contains.span).not.toBeNull();
    expect(contains.span!.line).toBe(3); // the source (Order) declaration
  });

  test('returns [] when there are no structural edges', () => {
    const empty: DiagramGraph = { nodes: [], edges: [] };
    expect(extractRelationships(empty)).toEqual([]);
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
