import { describe, expect, test, beforeAll, afterEach, vi } from 'vitest';
import * as mx from '@maxgraph/core';
import { selectDomainGraphs, buildCanvas, isClassNode, nodeLabelHtml, nodeSize, contextOf, createMaxGraphRenderer } from '@/diagrams/diagrams-maxgraph';
import {
  setDiagramEditing,
  setDiagramLayoutStore,
  setDiagramPersistScope,
  positionKey,
} from '@/diagrams/diagramContract';
import { loadDiagramPositions, saveDiagramPositions } from '@/settings/persistence';
import type { Diagram, DiagramGraph, DiagramNode, DocsFile } from '@/lsp/lsp';

// happy-dom returns 0 from getBoundingClientRect; maxGraph reads the container rect on construction.
// Shim it so the graph constructs with a sane size, and assert on the MODEL (never on pixels).
beforeAll(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() {} }) as DOMRect;
});

afterEach(() => {
  document.body.innerHTML = '';
  // Reset the module-level renderer state so an editing/persistence test can't leak into the next.
  setDiagramEditing(false);
  setDiagramPersistScope('scratch');
  setDiagramLayoutStore(null);
  localStorage.clear();
  vi.restoreAllMocks();
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

describe('edges', () => {
  const cls = (id: string) => node({ id, qualifiedName: id, stereotype: 'aggregate root' });

  test('a composition edge: diamond at the owner end, arrow at the part end, both multiplicities', () => {
    const merged: DiagramGraph = {
      nodes: [cls('Ordering.Order'), cls('Ordering.Line')],
      edges: [
        {
          from: 'Ordering.Order',
          to: 'Ordering.Line',
          label: 'contains',
          arrowKind: 'composition',
          sourceCardinality: '1',
          cardinality: '*',
          backingMember: 'Ordering.Order.lines',
        },
      ],
    };
    const container = makeContainer();
    const handle = buildCanvas(mx, container, merged);
    try {
      const edge = handle.cells.get('Ordering.Order')!.getEdgeAt(0);
      expect(edge).toBeTruthy();
      expect(edge!.getStyle().startArrow).toBe('diamond');
      expect(edge!.getStyle().startFill).toBe(true);
      expect(edge!.getStyle().endArrow).not.toBe('none');
      // the DiagramEdge stays on the cell so a disconnect gesture can read its backing field
      expect(edge!.value).toMatchObject({ backingMember: 'Ordering.Order.lines' });
      // the two multiplicity labels are child cells of the edge
      expect(edge!.getChildCount()).toBe(2);
    } finally {
      handle.dispose();
    }
  });

  test('a plain (association) edge: only a target arrow, no diamond, no multiplicity labels', () => {
    const merged: DiagramGraph = {
      nodes: [cls('Sales.Customer'), cls('Sales.Order')],
      edges: [{ from: 'Sales.Customer', to: 'Sales.Order', label: 'places', arrowKind: 'association' }],
    };
    const container = makeContainer();
    const handle = buildCanvas(mx, container, merged);
    try {
      const edge = handle.cells.get('Sales.Customer')!.getEdgeAt(0);
      expect(edge!.getStyle().startArrow).toBe('none');
      expect(edge!.getStyle().endArrow).not.toBe('none');
      expect(edge!.getChildCount()).toBe(0);
    } finally {
      handle.dispose();
    }
  });
});

describe('click → navigate', () => {
  const span = (over = {}) => ({ file: 'file:///m.koi', line: 3, column: 5, endLine: 3, endColumn: 12, offset: 0, length: 7, ...over });

  test('clicking a node bubbles NODE_NAVIGATE_EVENT carrying its raw 1-based span', () => {
    const merged: DiagramGraph = {
      nodes: [node({ id: 'Ordering.Order', qualifiedName: 'Ordering.Order', stereotype: 'aggregate root', sourceSpan: span() })],
      edges: [],
    };
    const container = makeContainer();
    const handle = buildCanvas(mx, container, merged);
    try {
      let detail: any = null;
      container.addEventListener('koi-diagram-node-click', (e) => { detail = (e as CustomEvent).detail; });
      handle.graph.fireEvent(new mx.EventObject(mx.InternalEvent.CLICK, 'cell', handle.cells.get('Ordering.Order')));
      expect(detail).toMatchObject({ qualifiedName: 'Ordering.Order', file: 'file:///m.koi', line: 3, column: 5, endLine: 3, endColumn: 12 });
    } finally {
      handle.dispose();
    }
  });

  test('a span-less node click is inert (no navigation)', () => {
    const merged: DiagramGraph = { nodes: [node({ id: 'g0:Draft', qualifiedName: 'Draft', kind: 'state', sourceSpan: null })], edges: [] };
    const container = makeContainer();
    const handle = buildCanvas(mx, container, merged);
    try {
      let fired = false;
      container.addEventListener('koi-diagram-node-click', () => { fired = true; });
      handle.graph.fireEvent(new mx.EventObject(mx.InternalEvent.CLICK, 'cell', handle.cells.get('g0:Draft')));
      expect(fired).toBe(false);
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

  test('mounts a canvas surface and the zoom control bar when there are nodes to draw', async () => {
    const g: DiagramGraph = { nodes: [node({ id: 'Ordering.Order', qualifiedName: 'Ordering.Order', stereotype: 'aggregate root' })], edges: [] };
    const container = makeContainer();
    await createMaxGraphRenderer().render(container, [file([diagram('aggregate', g)])], 'dark', () => true);
    expect(container.querySelector('.koi-svg-diagram .koi-canvas')).not.toBeNull();
    expect(container.querySelector('.koi-canvas-controls')).not.toBeNull();
    // − / + / fit (the % readout is a span, not a button)
    expect(container.querySelectorAll('.koi-canvas-btn')).toHaveLength(3);
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

describe('node navigation: null-file span', () => {
  test('a node whose span has no file still navigates by qualified name (file: null)', () => {
    const merged: DiagramGraph = {
      nodes: [
        node({
          id: 'Ordering.Order',
          qualifiedName: 'Ordering.Order',
          stereotype: 'aggregate root',
          sourceSpan: { file: null, line: 2, column: 1, endLine: 2, endColumn: 6, offset: 0, length: 5 },
        }),
      ],
      edges: [],
    };
    const container = makeContainer();
    const handle = buildCanvas(mx, container, merged);
    try {
      let detail: any = null;
      container.addEventListener('koi-diagram-node-click', (e) => { detail = (e as CustomEvent).detail; });
      handle.graph.fireEvent(new mx.EventObject(mx.InternalEvent.CLICK, 'cell', handle.cells.get('Ordering.Order')));
      expect(detail).toMatchObject({ qualifiedName: 'Ordering.Order', file: null, line: 2, column: 1 });
    } finally {
      handle.dispose();
    }
  });
});

describe('editing gestures: rename (double-click) + delete (right-click)', () => {
  const spanned = (over = {}) =>
    node({ id: 'Ordering.Order', qualifiedName: 'Ordering.Order', label: 'Order', kind: 'aggregate-root', stereotype: 'aggregate root',
      sourceSpan: { file: 'file:///m.koi', line: 5, column: 3, endLine: 5, endColumn: 8, offset: 0, length: 5 }, ...over });

  test('double-clicking an editable node prompts and bubbles NODE_EDIT rename with the name position', () => {
    setDiagramEditing(true);
    window.prompt = vi.fn(() => 'PurchaseOrder') as typeof window.prompt;
    const merged: DiagramGraph = { nodes: [spanned()], edges: [] };
    const container = makeContainer();
    const handle = buildCanvas(mx, container, merged);
    try {
      let detail: any = null;
      container.addEventListener('koi-diagram-node-edit', (e) => { detail = (e as CustomEvent).detail; });
      handle.graph.fireEvent(new mx.EventObject(mx.InternalEvent.DOUBLE_CLICK, 'cell', handle.cells.get('Ordering.Order')));
      expect(detail).toMatchObject({ qualifiedName: 'Ordering.Order', action: 'rename', newName: 'PurchaseOrder', label: 'Order', line: 5, column: 3 });
    } finally {
      handle.dispose();
    }
  });

  test('double-click is inert when editing is off', () => {
    setDiagramEditing(false);
    window.prompt = vi.fn(() => 'X') as typeof window.prompt;
    const container = makeContainer();
    const handle = buildCanvas(mx, container, { nodes: [spanned()], edges: [] });
    try {
      let fired = false;
      container.addEventListener('koi-diagram-node-edit', () => { fired = true; });
      handle.graph.fireEvent(new mx.EventObject(mx.InternalEvent.DOUBLE_CLICK, 'cell', handle.cells.get('Ordering.Order')));
      expect(fired).toBe(false);
    } finally {
      handle.dispose();
    }
  });

  test('right-clicking a node confirms and bubbles NODE_EDIT delete', () => {
    setDiagramEditing(true);
    window.confirm = vi.fn(() => true) as typeof window.confirm;
    const container = makeContainer();
    const handle = buildCanvas(mx, container, { nodes: [spanned()], edges: [] });
    try {
      // getCellAt needs laid-out geometry (absent headlessly), so stub it to return the node cell.
      handle.graph.getCellAt = (() => handle.cells.get('Ordering.Order')) as typeof handle.graph.getCellAt;
      let detail: any = null;
      container.addEventListener('koi-diagram-node-edit', (e) => { detail = (e as CustomEvent).detail; });
      container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 2 }));
      expect(detail).toMatchObject({ qualifiedName: 'Ordering.Order', action: 'delete', label: 'Order' });
    } finally {
      handle.dispose();
    }
  });
});

describe('canvas authoring: connect + disconnect', () => {
  const cls = (id: string, label: string) => node({ id, qualifiedName: id, label, stereotype: 'aggregate root' });

  test('a connect gesture bubbles DIAGRAM_CONNECT with both endpoints', () => {
    setDiagramEditing(true);
    const container = makeContainer();
    const handle = buildCanvas(mx, container, { nodes: [cls('Ordering.Order', 'Order'), cls('Ordering.Line', 'OrderLine')], edges: [] });
    try {
      let detail: any = null;
      container.addEventListener('koi-diagram-connect', (e) => { detail = (e as CustomEvent).detail; });
      // Simulate the ConnectionHandler completing a drag: a fresh edge between the two cells.
      const src = handle.cells.get('Ordering.Order')!;
      const tgt = handle.cells.get('Ordering.Line')!;
      const edge = handle.graph.insertEdge({ parent: handle.graph.getDefaultParent(), source: src, target: tgt, value: {} });
      const conn = handle.graph.getPlugin('ConnectionHandler') as unknown as { fireEvent(e: unknown): void };
      conn.fireEvent(new mx.EventObject(mx.InternalEvent.CONNECT, 'cell', edge, 'terminal', tgt));
      expect(detail).toMatchObject({
        sourceQualifiedName: 'Ordering.Order',
        targetQualifiedName: 'Ordering.Line',
        sourceLabel: 'Order',
        targetLabel: 'OrderLine',
      });
    } finally {
      handle.dispose();
    }
  });

  test('right-clicking a field-backed edge bubbles DIAGRAM_DISCONNECT with the backing member', () => {
    setDiagramEditing(true);
    const merged: DiagramGraph = {
      nodes: [cls('Ordering.Order', 'Order'), cls('Ordering.Line', 'OrderLine')],
      edges: [{ from: 'Ordering.Order', to: 'Ordering.Line', label: 'lines', arrowKind: 'composition', backingMember: 'Ordering.Order.lines' }],
    };
    const container = makeContainer();
    const handle = buildCanvas(mx, container, merged);
    try {
      const edgeCell = handle.cells.get('Ordering.Order')!.getEdgeAt(0);
      handle.graph.getCellAt = (() => edgeCell) as typeof handle.graph.getCellAt;
      let detail: any = null;
      container.addEventListener('koi-diagram-disconnect', (e) => { detail = (e as CustomEvent).detail; });
      container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 2 }));
      expect(detail).toMatchObject({ backingMember: 'Ordering.Order.lines', label: 'lines' });
    } finally {
      handle.dispose();
    }
  });
});

describe('authoring chrome (editing only)', () => {
  const g: DiagramGraph = { nodes: [node({ id: 'Ordering.Order', qualifiedName: 'Ordering.Order', stereotype: 'aggregate root' })], edges: [] };

  test('the read-only canvas shows only the three zoom controls', async () => {
    setDiagramEditing(false);
    const container = makeContainer();
    await createMaxGraphRenderer().render(container, [file([diagram('aggregate', g)])], 'dark', () => true);
    expect(container.querySelectorAll('.koi-canvas-btn')).toHaveLength(3);
    expect(container.querySelector('.koi-canvas--editing')).toBeNull();
  });

  test('editing adds the Auto-arrange control and the editing marker class', async () => {
    setDiagramEditing(true);
    const container = makeContainer();
    await createMaxGraphRenderer().render(container, [file([diagram('aggregate', g)])], 'dark', () => true);
    expect(container.querySelectorAll('.koi-canvas-btn')).toHaveLength(4);
    expect(container.querySelector('.koi-canvas--editing')).not.toBeNull();
    expect(container.querySelector('[aria-label="Auto-arrange layout"]')).not.toBeNull();
  });

  test('the Auto-arrange button clears saved positions and bubbles DIAGRAM_RELAYOUT', async () => {
    setDiagramEditing(true);
    setDiagramPersistScope('ws-test');
    saveDiagramPositions(positionKey(), { 'Ordering.Order': { x: 9, y: 9 } });
    const container = makeContainer();
    await createMaxGraphRenderer().render(container, [file([diagram('aggregate', g)])], 'dark', () => true);
    let relayouts = 0;
    container.addEventListener('koi-diagram-relayout', () => { relayouts++; });
    container.querySelector<HTMLButtonElement>('[aria-label="Auto-arrange layout"]')!.click();
    expect(relayouts).toBe(1);
    expect(loadDiagramPositions(positionKey())).toEqual({});
  });
});

describe('position persistence', () => {
  const cls = (id: string) => node({ id, qualifiedName: id, stereotype: 'aggregate root' });

  test('saved positions override the auto-layout (a hand-placed node does not snap back)', () => {
    const container = makeContainer();
    const handle = buildCanvas(mx, container, { nodes: [cls('Ordering.Order')], edges: [] }, { 'Ordering.Order': { x: 500, y: 120 } });
    try {
      const geo = handle.cells.get('Ordering.Order')!.getGeometry()!;
      expect(geo.x).toBe(500);
      expect(geo.y).toBe(120);
    } finally {
      handle.dispose();
    }
  });

  test('moving a node persists every node position to the browser store under positionKey()', () => {
    setDiagramPersistScope('ws-test'); // no layout store injected ⇒ the browser-storage fallback is used
    const container = makeContainer();
    const handle = buildCanvas(mx, container, { nodes: [cls('Ordering.Order'), cls('Ordering.Line')], edges: [] });
    try {
      const model = handle.graph.getDataModel();
      const cell = handle.cells.get('Ordering.Order')!;
      const geo = cell.getGeometry()!.clone();
      geo.x = 333;
      geo.y = 222;
      model.setGeometry(cell, geo);
      handle.graph.fireEvent(new mx.EventObject(mx.InternalEvent.CELLS_MOVED, 'cells', [cell], 'dx', 0, 'dy', 0));
      const saved = loadDiagramPositions(positionKey());
      expect(saved['Ordering.Order']).toEqual({ x: 333, y: 222 });
      expect(saved['Ordering.Line']).toBeDefined(); // a drag snapshots the WHOLE layout, not just the moved node
    } finally {
      handle.dispose();
    }
  });
});
