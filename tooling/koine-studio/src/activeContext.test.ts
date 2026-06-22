import { describe, expect, test } from 'vitest';
import {
  ALL_CONTEXTS,
  fileContextFollow,
  filterGlossaryModel,
  isAllContexts,
  listContexts,
  scopeContextMap,
  scopeDocsFiles,
  scopeGlossaryModel,
  scopeGraph,
} from '@/activeContext';
import type { ContextMapResult, DiagramGraph, DiagramNode, DocsFile, GlossaryEntry, GlossaryModel } from '@/lsp/lsp';

const node = (id: string, qualifiedName: string, kind = 'aggregate-root'): DiagramNode => ({
  id,
  label: qualifiedName.includes('.') ? qualifiedName.slice(qualifiedName.indexOf('.') + 1) : qualifiedName,
  kind,
  qualifiedName,
  sourceSpan: null,
  stereotype: null,
  members: [],
});

const edge = (from: string, to: string, label: string | null = null) => ({ from, to, label });

// Two contexts: Sales (Order —contains→ OrderItem) and Inventory (Stock), plus a cross-context edge.
const graph: DiagramGraph = {
  nodes: [node('n1', 'Sales.Order'), node('n2', 'Sales.OrderItem', 'entity'), node('n3', 'Inventory.Stock')],
  edges: [edge('n1', 'n2'), edge('n1', 'n3', 'references')],
};

const entry = (qualifiedName: string, kind = 'aggregate'): GlossaryEntry => ({
  id: qualifiedName,
  name: qualifiedName.slice(qualifiedName.indexOf('.') + 1),
  kind,
  context: qualifiedName.slice(0, qualifiedName.indexOf('.')),
  qualifiedName,
  doc: null,
  nameRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
});

const model: GlossaryModel = {
  entries: [entry('Sales.Order'), entry('Sales.OrderItem', 'entity'), entry('Inventory.Stock')],
};

describe('listContexts', () => {
  test('returns each bounded context once, in first-seen order, from a graph', () => {
    expect(listContexts(graph)).toEqual(['Sales', 'Inventory']);
  });

  test('de-duplicates contexts that appear on several nodes', () => {
    const many: DiagramGraph = {
      nodes: [node('a', 'Sales.Order'), node('b', 'Sales.OrderItem'), node('c', 'Sales.Customer')],
      edges: [],
    };
    expect(listContexts(many)).toEqual(['Sales']);
  });

  test('reads the strategic list straight off a context map (de-duped, blanks dropped)', () => {
    const ctxMap: ContextMapResult = { contexts: ['Sales', 'Inventory', 'Sales', ''], relations: [] };
    expect(listContexts(ctxMap)).toEqual(['Sales', 'Inventory']);
  });

  test('derives contexts from a glossary model', () => {
    expect(listContexts(model)).toEqual(['Sales', 'Inventory']);
  });

  test('a context node keyed by its bare name contributes that name', () => {
    const ctxGraph: DiagramGraph = { nodes: [node('c1', 'Sales', 'context')], edges: [] };
    expect(listContexts(ctxGraph)).toEqual(['Sales']);
  });
});

describe('scopeGraph', () => {
  test('keeps only the named context’s nodes and the edges between them', () => {
    const scoped = scopeGraph(graph, 'Sales');
    expect(scoped.nodes.map((n) => n.id)).toEqual(['n1', 'n2']);
    // The cross-context edge n1->n3 is dropped because n3 (Inventory) was filtered out.
    expect(scoped.edges).toEqual([edge('n1', 'n2')]);
  });

  test('ALL_CONTEXTS is the identity (same graph, unmodified)', () => {
    expect(scopeGraph(graph, ALL_CONTEXTS)).toBe(graph);
  });

  test('an unknown context scopes to an empty graph', () => {
    expect(scopeGraph(graph, 'Shipping')).toEqual({ nodes: [], edges: [] });
  });

  test('does not mutate the input graph', () => {
    scopeGraph(graph, 'Sales');
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toHaveLength(2);
  });
});

describe('scopeDocsFiles', () => {
  const diagram = (kind: string, g: DiagramGraph) => ({ caption: kind, kind, mermaid: '', graph: g });
  const files: DocsFile[] = [
    {
      path: 'Sales.md',
      contents: '# Sales',
      diagrams: [diagram('aggregate', { nodes: [node('n1', 'Sales.Order')], edges: [] })],
    },
    {
      path: 'Inventory.md',
      contents: '# Inventory',
      diagrams: [diagram('aggregate', { nodes: [node('n2', 'Inventory.Stock')], edges: [] })],
    },
  ];

  test('keeps only files/diagrams with nodes in the active context', () => {
    const scoped = scopeDocsFiles(files, 'Sales');
    expect(scoped).toHaveLength(1);
    expect(scoped[0].path).toBe('Sales.md');
    expect(scoped[0].diagrams[0].graph.nodes.map((n) => n.qualifiedName)).toEqual(['Sales.Order']);
  });

  test('drops a diagram whose graph empties under the scope', () => {
    const mixed: DocsFile[] = [
      {
        path: 'overview.md',
        contents: '# Overview',
        diagrams: [
          diagram('aggregate', { nodes: [node('a', 'Sales.Order')], edges: [] }),
          diagram('aggregate', { nodes: [node('b', 'Inventory.Stock')], edges: [] }),
        ],
      },
    ];
    const scoped = scopeDocsFiles(mixed, 'Sales');
    expect(scoped).toHaveLength(1);
    expect(scoped[0].diagrams).toHaveLength(1);
    expect(scoped[0].diagrams[0].graph.nodes.map((n) => n.id)).toEqual(['a']);
  });

  test('ALL_CONTEXTS is the identity (same files)', () => {
    expect(scopeDocsFiles(files, ALL_CONTEXTS)).toBe(files);
  });
});

describe('scopeGlossaryModel', () => {
  test('keeps only the named context’s entries', () => {
    const scoped = scopeGlossaryModel(model, 'Sales');
    expect(scoped.entries.map((e) => e.qualifiedName)).toEqual(['Sales.Order', 'Sales.OrderItem']);
  });

  test('ALL_CONTEXTS is the identity (same model)', () => {
    expect(scopeGlossaryModel(model, ALL_CONTEXTS)).toBe(model);
  });
});

describe('filterGlossaryModel', () => {
  test('a blank query is the identity (same model returned)', () => {
    expect(filterGlossaryModel(model, '')).toBe(model);
    expect(filterGlossaryModel(model, '   ')).toBe(model);
  });

  test('keeps entries whose name matches (case-insensitive substring), drops the rest', () => {
    const names = (m: GlossaryModel) => m.entries.map((e) => e.name);
    // "order" matches Order AND OrderItem, drops Stock.
    expect(names(filterGlossaryModel(model, 'order'))).toEqual(['Order', 'OrderItem']);
    // "item" matches only OrderItem.
    expect(names(filterGlossaryModel(model, 'item'))).toEqual(['OrderItem']);
    // no match → empty.
    expect(names(filterGlossaryModel(model, 'zzz'))).toEqual([]);
  });

  test('keeps a context-header entry only when that context has a matching child', () => {
    const ctx = (name: string): GlossaryEntry => ({
      id: name,
      name,
      kind: 'context',
      context: name,
      qualifiedName: name,
      doc: null,
      nameRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    });
    const withHeaders: GlossaryModel = {
      entries: [ctx('Sales'), entry('Sales.Order'), ctx('Inventory'), entry('Inventory.Stock')],
    };
    // Filtering to "order": the Sales header survives (Sales.Order matches), the Inventory header and
    // Stock both fall away — so a matching leaf keeps its section header and empty sections disappear.
    expect(filterGlossaryModel(withHeaders, 'order').entries.map((e) => e.qualifiedName)).toEqual([
      'Sales',
      'Sales.Order',
    ]);
  });
});

describe('scopeContextMap', () => {
  const ctxMap: ContextMapResult = {
    contexts: ['Sales', 'Inventory', 'Billing'],
    relations: [
      { upstream: 'Sales', downstream: 'Billing', kind: 'customer-supplier', bidirectional: false, sharedTypes: [], acl: [] },
      { upstream: 'Inventory', downstream: 'Billing', kind: 'conformist', bidirectional: false, sharedTypes: [], acl: [] },
    ],
  };

  test('keeps only relations touching the scope (as upstream or downstream)', () => {
    const scoped = scopeContextMap(ctxMap, 'Sales');
    expect(scoped.relations.map((r) => `${r.upstream}->${r.downstream}`)).toEqual(['Sales->Billing']);
    expect(scoped.contexts).toEqual(ctxMap.contexts);
    expect(scopeContextMap(ctxMap, 'Billing').relations).toHaveLength(2);
  });

  test('ALL_CONTEXTS is the identity (same context map)', () => {
    expect(scopeContextMap(ctxMap, ALL_CONTEXTS)).toBe(ctxMap);
  });
});

describe('isAllContexts', () => {
  test('is true only for the ALL_CONTEXTS sentinel', () => {
    expect(isAllContexts(ALL_CONTEXTS)).toBe(true);
    expect(isAllContexts('Sales')).toBe(false);
  });
});

describe('fileContextFollow', () => {
  test('follows the file’s first (primary) context', () => {
    expect(fileContextFollow(['Sales'], ALL_CONTEXTS)).toBe('Sales');
    expect(fileContextFollow(['Sales', 'Inventory'], 'Inventory')).toBe('Sales');
  });

  test('overrides "All contexts" — opening a file is navigation into it', () => {
    expect(fileContextFollow(['Inventory'], ALL_CONTEXTS)).toBe('Inventory');
  });

  test('no-op when the file’s context already matches the active scope', () => {
    expect(fileContextFollow(['Sales'], 'Sales')).toBeUndefined();
  });

  test('no-op when the file declares no context (empty/unparseable → no symbols)', () => {
    expect(fileContextFollow([], 'Sales')).toBeUndefined();
    expect(fileContextFollow([], ALL_CONTEXTS)).toBeUndefined();
  });
});
