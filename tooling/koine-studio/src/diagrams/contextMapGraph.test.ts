import { describe, expect, test } from 'vitest';
import { buildContextMapGraph } from '@/diagrams/contextMapGraph';
import type { ContextMapResult } from '@/lsp/lsp';

function ctxMap(over: Partial<ContextMapResult> = {}): ContextMapResult {
  return { contexts: over.contexts ?? [], relations: over.relations ?? [], contextSpans: over.contextSpans };
}

describe('buildContextMapGraph', () => {
  test('one node per declared context, kind=context, label/qualifiedName = the context name', () => {
    const g = buildContextMapGraph(ctxMap({ contexts: ['Ordering', 'Billing'] }));

    expect(g.nodes).toHaveLength(2);
    expect(g.nodes.map((n) => n.qualifiedName)).toEqual(['Ordering', 'Billing']);
    for (const n of g.nodes) {
      expect(n.kind).toBe('context');
      expect(n.label).toBe(n.qualifiedName);
      expect(n.id).toBe(n.qualifiedName);
      // undotted qualified name ⇒ contextOf() === '' ⇒ a root-level node (no swimlane container)
      expect(n.qualifiedName).not.toContain('.');
      // without contextSpans a context node has no span and stays inert to jump-to-source
      expect(n.sourceSpan).toBeNull();
      expect(n.members).toEqual([]);
    }
  });

  test("a declared context's node carries its declaration span from contextSpans (#290)", () => {
    const orderingSpan = { file: 'file:///ord.koi', line: 1, column: 9, endLine: 1, endColumn: 17, offset: 8, length: 8 };
    const g = buildContextMapGraph(
      ctxMap({ contexts: ['Ordering', 'Billing'], contextSpans: { Ordering: orderingSpan, Billing: null } }),
    );

    // The context with a span gets it verbatim (so buildCanvas's navigate listener can fire on click);
    // a context whose span is null (recovered parse) stays inert.
    expect(g.nodes.find((n) => n.qualifiedName === 'Ordering')!.sourceSpan).toEqual(orderingSpan);
    expect(g.nodes.find((n) => n.qualifiedName === 'Billing')!.sourceSpan).toBeNull();
  });

  test('a dangling relation endpoint (absent from contextSpans) keeps sourceSpan null (#290)', () => {
    const g = buildContextMapGraph(
      ctxMap({
        contexts: ['A'],
        contextSpans: { A: { file: 'file:///a.koi', line: 1, column: 9, endLine: 1, endColumn: 10, offset: 8, length: 1 } },
        relations: [{ upstream: 'A', downstream: 'B', kind: 'Conformist', bidirectional: false, sharedTypes: [], acl: [] }],
      }),
    );

    // 'B' is only a relation endpoint, never declared, so it has no span and stays inert to navigation.
    expect(g.nodes.find((n) => n.qualifiedName === 'A')!.sourceSpan).not.toBeNull();
    expect(g.nodes.find((n) => n.qualifiedName === 'B')!.sourceSpan).toBeNull();
  });

  test('one edge per relation: source = upstream, target = downstream (upstream → downstream)', () => {
    const g = buildContextMapGraph(
      ctxMap({
        contexts: ['Sales', 'Shipping'],
        relations: [
          { upstream: 'Sales', downstream: 'Shipping', kind: 'Customer/Supplier', bidirectional: false, sharedTypes: [], acl: [] },
        ],
      }),
    );

    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].from).toBe('Sales');
    expect(g.edges[0].to).toBe('Shipping');
  });

  test('a bidirectional relation (Partnership / Shared Kernel) is flagged for undirected/two-headed drawing', () => {
    const g = buildContextMapGraph(
      ctxMap({
        contexts: ['A', 'B', 'C'],
        relations: [
          { upstream: 'A', downstream: 'B', kind: 'Partnership', bidirectional: true, sharedTypes: [], acl: [] },
          { upstream: 'B', downstream: 'C', kind: 'Customer/Supplier', bidirectional: false, sharedTypes: [], acl: [] },
        ],
      }),
    );

    expect(g.edges[0].bidirectional).toBe(true);
    expect(g.edges[0].arrowKind).toBe('bidirectional');
    expect(g.edges[1].bidirectional).toBe(false);
    expect(g.edges[1].arrowKind).toBe('association');
  });

  test('the edge label is the relationship kind', () => {
    const g = buildContextMapGraph(
      ctxMap({
        contexts: ['A', 'B'],
        relations: [{ upstream: 'A', downstream: 'B', kind: 'Anticorruption Layer', bidirectional: false, sharedTypes: [], acl: [] }],
      }),
    );

    expect(g.edges[0].label).toBe('Anticorruption Layer');
  });

  test('sharedTypes and acl ride the edge as metadata (no information lost from the table)', () => {
    const acl = [{ upstreamContext: 'Sales', upstreamType: 'Customer', localContext: 'Shipping', localType: 'Recipient' }];
    const g = buildContextMapGraph(
      ctxMap({
        contexts: ['Sales', 'Shipping'],
        relations: [
          { upstream: 'Sales', downstream: 'Shipping', kind: 'Customer/Supplier', bidirectional: false, sharedTypes: ['Address', 'Money'], acl },
        ],
      }),
    );

    expect(g.edges[0].sharedTypes).toEqual(['Address', 'Money']);
    expect(g.edges[0].acl).toEqual(acl);
  });

  test('a relation endpoint missing from `contexts` still yields a node (the graph never dangles)', () => {
    const g = buildContextMapGraph(
      ctxMap({
        contexts: ['A'],
        relations: [{ upstream: 'A', downstream: 'B', kind: 'Conformist', bidirectional: false, sharedTypes: [], acl: [] }],
      }),
    );

    expect(g.nodes.map((n) => n.qualifiedName).sort()).toEqual(['A', 'B']);
    // and the edge still references both by id
    expect(g.edges[0].from).toBe('A');
    expect(g.edges[0].to).toBe('B');
  });

  test('a context that appears in several relations is added only once', () => {
    const g = buildContextMapGraph(
      ctxMap({
        contexts: [],
        relations: [
          { upstream: 'Hub', downstream: 'A', kind: 'Customer/Supplier', bidirectional: false, sharedTypes: [], acl: [] },
          { upstream: 'Hub', downstream: 'B', kind: 'Customer/Supplier', bidirectional: false, sharedTypes: [], acl: [] },
        ],
      }),
    );

    expect(g.nodes.filter((n) => n.qualifiedName === 'Hub')).toHaveLength(1);
    expect(g.nodes).toHaveLength(3); // Hub, A, B
  });

  test('an empty context map yields an empty graph', () => {
    const g = buildContextMapGraph(ctxMap());
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
  });
});
