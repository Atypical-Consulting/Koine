import { describe, expect, test, beforeAll, afterEach } from 'vitest';
import * as mx from '@maxgraph/core';
import { selectDomainGraphs, buildCanvas, isClassNode, nodeLabelHtml, nodeSize, contextOf, createMaxGraphRenderer } from '@/diagrams/diagrams-maxgraph';
import type { Diagram, DiagramGraph, DiagramNode, DocsFile } from '@/lsp/lsp';

// happy-dom returns 0 from getBoundingClientRect; maxGraph reads the container rect on construction.
// Shim it so the graph constructs with a sane size, and assert on the MODEL (never on pixels).
beforeAll(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() {} }) as DOMRect;
});

afterEach(() => {
  document.body.innerHTML = '';
});

function makeContainer(): HTMLElement {
  const c = document.createElement('div');
  Object.assign(c.style, { width: '800px', height: '600px' });
  document.body.appendChild(c);
  return c;
}

function node(over: Partial<DiagramNode> & { id: string; qualifiedName: string }): DiagramNode {
  return {
    id: over.id,
    label: over.label ?? over.qualifiedName,
    kind: over.kind ?? 'value-object',
    qualifiedName: over.qualifiedName,
    sourceSpan: over.sourceSpan ?? null,
    stereotype: over.stereotype ?? null,
    members: over.members ?? [],
  };
}

function diagram(kind: string, graph: DiagramGraph): Diagram {
  return { caption: kind, kind, mermaid: '', graph };
}

function file(diagrams: Diagram[]): DocsFile {
  return { path: 'd.md', contents: '', diagrams };
}

describe('selectDomainGraphs', () => {
  test('excludes the strategic context map and empty graphs', () => {
    const domain: DiagramGraph = { nodes: [node({ id: 'Ordering.Order', qualifiedName: 'Ordering.Order' })], edges: [] };
    const ctxMap: DiagramGraph = { nodes: [node({ id: 'Ordering', qualifiedName: 'Ordering', kind: 'context' })], edges: [] };
    const empty: DiagramGraph = { nodes: [], edges: [] };
    const files = [file([diagram('aggregate', domain), diagram('contextmap', ctxMap), diagram('statemachine', empty)])];

    const selected = selectDomainGraphs(files);

    expect(selected).toHaveLength(1);
    expect(selected[0].nodes[0].qualifiedName).toBe('Ordering.Order');
  });
});

describe('isClassNode', () => {
  test('a stereotype OR any members makes a node a class box; otherwise a simple box', () => {
    expect(isClassNode(node({ id: 'a', qualifiedName: 'C.A', stereotype: 'aggregate root' }))).toBe(true);
    expect(isClassNode(node({ id: 'b', qualifiedName: 'C.B', members: [{ text: 'id: Id', kind: 'field' }] }))).toBe(true);
    expect(isClassNode(node({ id: 's', qualifiedName: 'Draft', kind: 'state' }))).toBe(false);
  });
});

describe('nodeLabelHtml', () => {
  test('a class node renders a compartmented box: stereotype, title, field + method rows', () => {
    const html = nodeLabelHtml(
      node({
        id: 'Ordering.Order',
        qualifiedName: 'Ordering.Order',
        label: 'Order',
        kind: 'aggregate-root',
        stereotype: 'aggregate root',
        members: [
          { text: 'id: OrderId', kind: 'field' },
          { text: 'total(): Money', kind: 'method' },
        ],
      }),
    );
    expect(html).toContain('koi-node--class');
    expect(html).toContain("data-kind=\"aggregate-root\"");
    expect(html).toContain('«aggregate root»');
    expect(html).toContain('>Order<');
    expect(html).toContain('id: OrderId');
    expect(html).toContain('total(): Money');
    // two compartments (fields + methods)
    expect(html.match(/koi-node__compartment/g)).toHaveLength(2);
  });

  test('a simple node renders a single labelled box, not a class box', () => {
    const html = nodeLabelHtml(node({ id: 'g0:Draft', qualifiedName: 'Draft', label: 'Draft', kind: 'state' }));
    expect(html).toContain('koi-node--simple');
    expect(html).toContain("data-kind=\"state\"");
    expect(html).not.toContain('koi-node--class');
    expect(html).not.toContain('koi-node__compartment');
  });

  test('escapes domain text so a stray < or & cannot break the markup', () => {
    const html = nodeLabelHtml(node({ id: 'C.X', qualifiedName: 'C.X', label: 'A<b>&c', members: [{ text: 'x: List<Y>', kind: 'field' }] }));
    expect(html).toContain('A&lt;b&gt;&amp;c');
    expect(html).toContain('x: List&lt;Y&gt;');
    expect(html).not.toContain('<b>');
  });

  test('nodeSize clamps width to [72, 280] and a class box is taller than a simple box', () => {
    const [simpleW, simpleH] = nodeSize(node({ id: 's', qualifiedName: 'S', label: 'S' }));
    expect(simpleW).toBeGreaterThanOrEqual(72);
    expect(simpleW).toBeLessThanOrEqual(280);
    const [, classH] = nodeSize(
      node({ id: 'c', qualifiedName: 'C.C', stereotype: 'entity', members: [{ text: 'a: Int', kind: 'field' }] }),
    );
    expect(classH).toBeGreaterThan(simpleH);
  });
});

describe('contextOf', () => {
  test('takes the prefix before the first dot, or empty for an undotted name', () => {
    expect(contextOf('Ordering.Order')).toBe('Ordering');
    expect(contextOf('Draft')).toBe('');
  });
});

describe('buildCanvas', () => {
  test('indexes one cell per node and groups dotted nodes into bounded-context containers', () => {
    const merged: DiagramGraph = {
      nodes: [
        node({ id: 'Ordering.Order', qualifiedName: 'Ordering.Order', stereotype: 'aggregate root' }),
        node({ id: 'Ordering.Money', qualifiedName: 'Ordering.Money', members: [{ text: 'amount: Decimal', kind: 'field' }] }),
        node({ id: 'Billing.Invoice', qualifiedName: 'Billing.Invoice', stereotype: 'aggregate root' }),
        node({ id: 'g0:Draft', qualifiedName: 'Draft', kind: 'state' }),
      ],
      edges: [],
    };
    const container = makeContainer();

    const handle = buildCanvas(mx, container, merged);

    try {
      // every node is indexed by id
      expect(handle.cells.size).toBe(4);
      expect(handle.cells.get('Ordering.Order')?.value).toMatchObject({ qualifiedName: 'Ordering.Order' });
      // one container per distinct dotted context, each holding its members
      expect(handle.containers.size).toBe(2);
      expect(handle.containers.get('Ordering')?.getChildCount()).toBe(2);
      expect(handle.containers.get('Billing')?.getChildCount()).toBe(1);
      // root holds the two containers + the one context-less node
      expect(handle.graph.getDefaultParent().getChildCount()).toBe(3);
      expect(handle.cells.get('g0:Draft')?.getParent()).toBe(handle.graph.getDefaultParent());
    } finally {
      handle.dispose();
    }
  });

  test('a node inside a context is parented to that context container', () => {
    const merged: DiagramGraph = {
      nodes: [node({ id: 'Ordering.Order', qualifiedName: 'Ordering.Order', stereotype: 'aggregate root' })],
      edges: [],
    };
    const container = makeContainer();
    const handle = buildCanvas(mx, container, merged);
    try {
      expect(handle.cells.get('Ordering.Order')?.getParent()).toBe(handle.containers.get('Ordering'));
    } finally {
      handle.dispose();
    }
  });
});

describe('createMaxGraphRenderer.render', () => {
  test('shows the empty state (three concept doorways) when there is nothing to draw', async () => {
    const container = makeContainer();
    await createMaxGraphRenderer().render(container, [], 'dark', () => true);
    expect(container.querySelectorAll('.koi-concept-tile')).toHaveLength(3);
    expect(container.textContent).toContain('No diagrams yet');
  });

  test('mounts a canvas surface when there are nodes to draw', async () => {
    const g: DiagramGraph = { nodes: [node({ id: 'Ordering.Order', qualifiedName: 'Ordering.Order', stereotype: 'aggregate root' })], edges: [] };
    const container = makeContainer();
    await createMaxGraphRenderer().render(container, [file([diagram('aggregate', g)])], 'dark', () => true);
    expect(container.querySelector('.koi-svg-diagram .koi-canvas')).not.toBeNull();
  });

  test('a superseded render does not clobber the container', async () => {
    const g: DiagramGraph = { nodes: [node({ id: 'Ordering.Order', qualifiedName: 'Ordering.Order' })], edges: [] };
    const container = makeContainer();
    container.append('sentinel');
    await createMaxGraphRenderer().render(container, [file([diagram('aggregate', g)])], 'dark', () => false);
    expect(container.textContent).toContain('sentinel');
    expect(container.querySelector('.koi-canvas')).toBeNull();
  });
});
