import { describe, expect, test } from 'vitest';
import { buildModelIndex, lookupElement, resolveInspectableQn } from '@/model/modelIndex';
import type { DiagramNode, DocsFile, DocsResult, GlossaryEntry, GlossaryModel, ModelMember, ModelNode, Range } from '@/lsp/lsp';

const range: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } };

function entry(name: string, kind: string, context: string, qualifiedName?: string): GlossaryEntry {
  return {
    id: qualifiedName ?? `${context}.${name}`,
    name,
    kind,
    context,
    qualifiedName: qualifiedName ?? `${context}.${name}`,
    doc: null,
    nameRange: range,
  };
}

function node(qualifiedName: string, stereotype: string | null, members: DiagramNode['members']): DiagramNode {
  return { id: qualifiedName, label: qualifiedName.split('.').pop()!, kind: 'x', qualifiedName, sourceSpan: null, stereotype, members };
}

function docs(...nodes: DiagramNode[]): DocsResult {
  const file: DocsFile = { path: 'docs/x.md', contents: '', diagrams: [{ caption: 'c', kind: 'aggregate', mermaid: '', graph: { nodes, edges: [] } }] };
  return { files: [file] };
}

function modelNode(qualifiedName: string, kind: string, transitions: ModelMember[] = [], members: ModelMember[] = []): ModelNode {
  return { kind, qualifiedName, title: qualifiedName.split('.').pop() ?? '', members, transitions, children: [] };
}

/** Wrap an owner entity node under a model → context tree (the shape a real `koine/model` payload has). */
function modelTree(context: string, owner: ModelNode): ModelNode {
  return {
    kind: 'model',
    qualifiedName: '',
    title: '',
    members: [],
    transitions: [],
    children: [{ kind: 'context', qualifiedName: context, title: context, members: [], transitions: [], children: [owner] }],
  };
}

const glossary: GlossaryModel = {
  entries: [
    entry('Sales', 'context', 'Sales'),
    entry('Order', 'aggregate', 'Sales'), // Sales.Order
    entry('Money', 'value', 'Sales', 'Sales.Order.Money'), // nested: glossary qn != diagram qn
    entry('Loose', 'value', 'Sales'), // top-level: Sales.Loose, no diagram node
  ],
};

describe('buildModelIndex', () => {
  test('joins a glossary entry to the diagram node sharing its context.simpleName', () => {
    const index = buildModelIndex(
      glossary,
      docs(node('Sales.Order', 'aggregate root', [{ text: 'id: OrderId', kind: 'field' }])),
    );
    expect(index.byQn.get('Sales.Order')!.node!.stereotype).toBe('aggregate root');
  });

  test('joins a nested type whose glossary qn differs from its diagram qn (context.simpleName)', () => {
    // Glossary qn is Sales.Order.Money but the diagram node is named Sales.Money.
    const index = buildModelIndex(glossary, docs(node('Sales.Money', null, [{ text: 'amount: Decimal', kind: 'field' }])));
    expect(index.byQn.get('Sales.Order.Money')!.node!.members).toHaveLength(1);
  });

  test('leaves node undefined for entries with no matching diagram node', () => {
    const index = buildModelIndex(glossary, docs());
    expect(index.byQn.get('Sales.Loose')!.node).toBeUndefined();
  });

  test('omits the context entry and maps ctxName → canonical qn', () => {
    const index = buildModelIndex(glossary, docs());
    expect(index.byQn.has('Sales')).toBe(false);
    expect(index.qnByCtxName.get('Sales.Money')).toBe('Sales.Order.Money');
  });

  test('attaches the structured-model members to each element by qualified name', () => {
    // The model tree carries every element's fields regardless of diagramming; Money has no diagram
    // node but its fields must still reach the index (so the inspector can show them).
    const model = {
      kind: 'model',
      qualifiedName: '',
      title: '',
      members: [],
      transitions: [],
      children: [
        {
          kind: 'context',
          qualifiedName: 'Sales',
          title: 'Sales',
          members: [],
          transitions: [],
          children: [
            {
              kind: 'value',
              qualifiedName: 'Sales.Money',
              title: 'Money',
              members: [
                { kind: 'field', name: 'amount', type: 'Decimal', value: null },
                { kind: 'field', name: 'currency', type: 'Currency', value: null },
              ],
              transitions: [],
              children: [],
            },
          ],
        },
      ],
    };
    const index = buildModelIndex({ entries: [entry('Money', 'value', 'Sales')] }, docs(), model);
    expect(index.byQn.get('Sales.Money')!.modelMembers).toEqual([
      { kind: 'field', name: 'amount', type: 'Decimal', value: null },
      { kind: 'field', name: 'currency', type: 'Currency', value: null },
    ]);
  });

  test('keeps the richest node when the same context.simpleName appears in several diagrams', () => {
    const lean = node('Sales.Order', null, []);
    const rich = node('Sales.Order', 'aggregate root', [{ text: 'id: OrderId', kind: 'field' }]);
    // lean first, rich second → rich wins; and rich first, lean second → rich still wins.
    expect(buildModelIndex(glossary, docs(lean, rich)).byQn.get('Sales.Order')!.node!.stereotype).toBe('aggregate root');
    expect(buildModelIndex(glossary, docs(rich, lean)).byQn.get('Sales.Order')!.node!.stereotype).toBe('aggregate root');
  });
});

describe('buildModelIndex — state transitions relay (#1163)', () => {
  const ordering: GlossaryModel = { entries: [entry('Order', 'entity', 'Ordering')] }; // Ordering.Order

  test('relays a declared guarded edge off the owner node onto the element', () => {
    const owner = modelNode('Ordering.Order', 'entity', [
      { kind: 'transition', name: 'Draft', type: 'totalIsPositive', value: 'Submitted', via: 'Submit' },
    ]);
    const index = buildModelIndex(ordering, docs(), modelTree('Ordering', owner));
    expect(index.byQn.get('Ordering.Order')!.transitions).toEqual([
      { from: 'Draft', to: 'Submitted', guard: 'totalIsPositive', via: 'Submit' },
    ]);
  });

  test('maps an omitted guard/via to undefined, not empty string', () => {
    const owner = modelNode('Ordering.Order', 'entity', [
      { kind: 'transition', name: 'Draft', type: null, value: 'Submitted' }, // via absent
    ]);
    const index = buildModelIndex(ordering, docs(), modelTree('Ordering', owner));
    expect(index.byQn.get('Ordering.Order')!.transitions).toEqual([
      { from: 'Draft', to: 'Submitted', guard: undefined, via: undefined },
    ]);
  });

  test('does not fabricate transitions for an element with no state machine', () => {
    const owner = modelNode('Ordering.Order', 'entity', []); // empty transitions
    const withModel = buildModelIndex(ordering, docs(), modelTree('Ordering', owner));
    expect(withModel.byQn.get('Ordering.Order')!.transitions).toBeUndefined();
    // And with no model at all.
    const noModel = buildModelIndex(ordering, docs());
    expect(noModel.byQn.get('Ordering.Order')!.transitions).toBeUndefined();
  });

  test('relays each already-fanned-out multi-target edge 1:1', () => {
    const owner = modelNode('Ordering.Order', 'entity', [
      { kind: 'transition', name: 'Placed', type: null, value: 'Shipped', via: 'Ship' },
      { kind: 'transition', name: 'Placed', type: null, value: 'Cancelled', via: 'Cancel' },
    ]);
    const index = buildModelIndex(ordering, docs(), modelTree('Ordering', owner));
    expect(index.byQn.get('Ordering.Order')!.transitions).toEqual([
      { from: 'Placed', to: 'Shipped', guard: undefined, via: 'Ship' },
      { from: 'Placed', to: 'Cancelled', guard: undefined, via: 'Cancel' },
    ]);
  });
});

describe('lookupElement', () => {
  const index = buildModelIndex(glossary, docs(node('Sales.Money', null, [{ text: 'amount: Decimal', kind: 'field' }])));

  test('resolves a canonical glossary qualified name', () => {
    const hit = lookupElement(index, 'Sales.Order.Money')!;
    expect(hit.canonicalQn).toBe('Sales.Order.Money');
    expect(hit.element.node!.members).toHaveLength(1);
  });

  test('resolves a diagram context.simpleName to the canonical entry (key-form robustness)', () => {
    const hit = lookupElement(index, 'Sales.Money')!;
    expect(hit.canonicalQn).toBe('Sales.Order.Money');
    expect(hit.element.entry.name).toBe('Money');
  });

  test('returns null for an unknown key', () => {
    expect(lookupElement(index, 'Sales.Nope')).toBeNull();
  });
});

describe('resolveInspectableQn', () => {
  const index = buildModelIndex(glossary, docs(node('Sales.Order', 'aggregate root', [{ text: 'id: OrderId', kind: 'field' }])));

  test('resolves a directly-inspectable node to its canonical qn', () => {
    expect(resolveInspectableQn(index, 'Sales.Order')).toBe('Sales.Order');
  });

  test('walks a state node (Context.Aggregate.State) up to its owning aggregate', () => {
    // A diagram state box is named Sales.Order.Draft — not a glossary entry. The nearest inspectable
    // ancestor is the owning aggregate, Sales.Order.
    expect(resolveInspectableQn(index, 'Sales.Order.Draft')).toBe('Sales.Order');
  });

  test('returns null for a context node (no inspectable element)', () => {
    // Contexts are omitted from the index; a bare single segment has no inspectable ancestor.
    expect(resolveInspectableQn(index, 'Sales')).toBeNull();
  });

  test('returns null when no ancestor segment is inspectable', () => {
    expect(resolveInspectableQn(index, 'Nope.Whatever.Deep')).toBeNull();
  });

  test('accepts a diagram context.simpleName form and returns the canonical qn', () => {
    expect(resolveInspectableQn(index, 'Sales.Money')).toBe('Sales.Order.Money');
  });
});
