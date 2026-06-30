import { describe, expect, test, beforeAll, afterEach, vi, type Mock } from 'vitest';
import * as mx from '@maxgraph/core';
import {
  selectDomainGraphs,
  buildCanvas,
  buildEventFlowCanvas,
  renderEventFlowGraph,
  isClassNode,
  isContextNode,
  nodeLabelHtml,
  nodeSize,
  contextOf,
  createMaxGraphRenderer,
  renderContextMapGraph,
  routeContextMapClick,
} from '@/diagrams/diagrams-maxgraph';
import type { EventFlowEdge, EventFlowNode } from '@/model/modelTables';

// The diagram's rename/delete gestures now route through Koine's own modal (koiPrompt/koiConfirm),
// not window.prompt/confirm. Stub them so the tests drive the async dialog deterministically.
vi.mock('@/shared/overlay', () => ({ koiPrompt: vi.fn(), koiConfirm: vi.fn() }));
import { koiPrompt, koiConfirm } from '@/shared/overlay';
import {
  isDiagramEditing,
  DIAGRAM_ANNOTATION_CREATE_EVENT,
  DIAGRAM_REFIT_EVENT,
  setDefaultCanvasZoom,
  setDiagramEditing,
  setDiagramTouchMode,
  setDiagramLayoutStore,
  setDiagramPersistScope,
  positionKey,
} from '@/diagrams/diagramContract';
import { loadDiagramAnnotations, loadDiagramPositions, loadDiagramZoom, saveDiagramPositions, saveDiagramZoom } from '@/settings/persistence';
import { createBrowserLayoutStore } from '@/diagrams/layoutStore';
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
  setDiagramTouchMode(false);
  setDiagramPersistScope('scratch');
  setDiagramLayoutStore(null);
  setDefaultCanvasZoom(100);
  localStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks(); // also clear the koiPrompt/koiConfirm call history between editing-gesture tests
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

  test('strips the event-flow chain command/policy nodes + their edges from the structural canvas (#439)', () => {
    // The context graph carries the #439 event-flow chain; the structural domain canvas must keep only the
    // class nodes/edges — commands/policies belong on the Events → Flow canvas.
    const graph: DiagramGraph = {
      nodes: [
        node({ id: 'Order', qualifiedName: 'Ordering.Order', kind: 'aggregate-root', stereotype: 'aggregate root' }),
        node({ id: 'OrderSubmitted', qualifiedName: 'Ordering.OrderSubmitted', kind: 'event' }),
        node({ id: 'cmd_Order_submit', qualifiedName: 'Ordering.Order.submit', kind: 'command' }),
        node({ id: 'policy_Notify', qualifiedName: 'Ordering.Notify', kind: 'policy' }),
      ],
      edges: [
        { from: 'OrderSubmitted', to: 'Order', label: null },
        { from: 'cmd_Order_submit', to: 'OrderSubmitted', label: 'emits' },
        { from: 'OrderSubmitted', to: 'policy_Notify', label: 'triggers' },
      ],
    };

    const [selected] = selectDomainGraphs([file([diagram('context', graph)])]);

    expect(selected.nodes.map((n) => n.kind).sort()).toEqual(['aggregate-root', 'event']);
    // Only the structural edge survives; the two chain edges touching a command/policy are dropped.
    expect(selected.edges).toEqual([{ from: 'OrderSubmitted', to: 'Order', label: null }]);
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

describe('context nodes', () => {
  const ctx = (name: string) => node({ id: name, qualifiedName: name, label: name, kind: 'context' });

  test('a context node is recognised and is NOT a class/aggregate compartment box', () => {
    expect(isContextNode(ctx('Ordering'))).toBe(true);
    expect(isClassNode(ctx('Ordering'))).toBe(false);
    // a real class node is neither a context nor a simple box
    expect(isContextNode(node({ id: 'C.A', qualifiedName: 'C.A', stereotype: 'aggregate root' }))).toBe(false);
  });

  test('a context node sizes as a distinct, prominent tile (wider minimum + taller than a plain box)', () => {
    const [ctxW, ctxH] = nodeSize(ctx('A')); // short label hits the minimums
    const [, simpleH] = nodeSize(node({ id: 's', qualifiedName: 'Draft', label: 'Draft', kind: 'state' }));
    expect(ctxW).toBeGreaterThanOrEqual(120);
    expect(ctxH).toBeGreaterThan(simpleH);
  });

  test('a context node renders a simple labelled box tagged data-kind="context" for the distinct CSS', () => {
    const html = nodeLabelHtml(ctx('Ordering'));
    expect(html).toContain('koi-node--simple');
    expect(html).toContain('data-kind="context"');
    expect(html).not.toContain('koi-node--class');
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

  test('a bidirectional edge (context-map Partnership / Shared Kernel) draws an arrowhead at BOTH ends', () => {
    const merged: DiagramGraph = {
      nodes: [node({ id: 'Sales', qualifiedName: 'Sales', kind: 'context' }), node({ id: 'Support', qualifiedName: 'Support', kind: 'context' })],
      edges: [{ from: 'Sales', to: 'Support', label: 'Partnership', arrowKind: 'bidirectional' }],
    };
    const container = makeContainer();
    const handle = buildCanvas(mx, container, merged);
    try {
      const edge = handle.cells.get('Sales')!.getEdgeAt(0);
      expect(edge!.getStyle().startArrow).not.toBe('none'); // two-headed → arrow at the source end too
      expect(edge!.getStyle().endArrow).not.toBe('none');
      expect(edge!.getStyle().startArrow).not.toBe('diamond'); // not a composition diamond
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

describe('initial canvas zoom: open at the saved-or-default zoom, not auto-fit (#762)', () => {
  // A graph wide enough that the (old) auto-fit scale is clearly ≠ 1.0 — so "opens at the default,
  // not fit" is observable rather than coinciding with 100%.
  const wideGraph = (): DiagramGraph => ({
    nodes: Array.from({ length: 8 }, (_, i) =>
      node({ id: `Ordering.N${i}`, qualifiedName: `Ordering.N${i}`, stereotype: i === 0 ? 'aggregate root' : undefined }),
    ),
    edges: [],
  });

  function renderWide(container: HTMLElement): Promise<void> {
    return createMaxGraphRenderer().render(container, [file([diagram('aggregate', wideGraph())])], 'dark', () => true);
  }

  test('opens at the default 100% (1:1), with the readout synced to the real scale', async () => {
    setDefaultCanvasZoom(100);
    const container = makeContainer();
    await renderWide(container);
    expect(container.querySelector('.koi-canvas-zoom-pct')?.textContent).toBe('100%');
  });

  test('the + button steps zoom up monotonically (×1.2): 100% → 120%', async () => {
    setDefaultCanvasZoom(100);
    const container = makeContainer();
    await renderWide(container);
    container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click();
    expect(container.querySelector('.koi-canvas-zoom-pct')?.textContent).toBe('120%');
  });

  test('honors a configurable default zoom (75%) when nothing per-diagram is saved', async () => {
    setDefaultCanvasZoom(75);
    const container = makeContainer();
    await renderWide(container);
    expect(container.querySelector('.koi-canvas-zoom-pct')?.textContent).toBe('75%');
  });

  test('a saved per-diagram zoom (150%) wins over the default', async () => {
    setDefaultCanvasZoom(100);
    saveDiagramZoom('koi-domain-diagram', 150);
    const container = makeContainer();
    await renderWide(container);
    expect(container.querySelector('.koi-canvas-zoom-pct')?.textContent).toBe('150%');
  });
});

describe('routeContextMapClick', () => {
  const ctxNode = node({ id: 'Sales', qualifiedName: 'Sales', kind: 'context' });
  const relEdge = { from: 'Sales', to: 'Shipping', label: 'Customer/Supplier', arrowKind: 'association' };

  test('a context node routes to onContextClick (filter), not onRelationSelect', () => {
    let ctx: any = 'unset';
    let rel: any = 'unset';
    routeContextMapClick(ctxNode, { onContextClick: (n) => (ctx = n), onRelationSelect: (e) => (rel = e) });
    expect(ctx).toMatchObject({ qualifiedName: 'Sales' });
    expect(rel).toBe('unset');
  });

  test('a relation edge routes to onRelationSelect', () => {
    let rel: any = 'unset';
    routeContextMapClick(relEdge, { onRelationSelect: (e) => (rel = e) });
    expect(rel).toMatchObject({ from: 'Sales', to: 'Shipping' });
  });

  test('an empty / unknown click clears the selection (onRelationSelect(null))', () => {
    let rel: any = 'unset';
    routeContextMapClick(null, { onRelationSelect: (e) => (rel = e) });
    expect(rel).toBeNull();
  });
});

describe('renderContextMapGraph', () => {
  const ctx = (name: string) => node({ id: name, qualifiedName: name, label: name, kind: 'context' });

  test('mounts a read-only context-map canvas (its own root class) and returns a disposable handle', async () => {
    const graph: DiagramGraph = {
      nodes: [ctx('Sales'), ctx('Shipping')],
      edges: [{ from: 'Sales', to: 'Shipping', label: 'Customer/Supplier', arrowKind: 'association' }],
    };
    const container = makeContainer();
    const handle = await renderContextMapGraph(container, graph, () => true);
    try {
      expect(handle).not.toBeNull();
      expect(container.querySelector('.koi-ctxmap-graph .koi-canvas')).not.toBeNull();
      // its own root class — NOT the domain canvas's cross-highlight hook (`koi-svg-diagram`)
      expect(container.querySelector('.koi-svg-diagram')).toBeNull();
    } finally {
      handle?.dispose();
    }
  });

  test('does NOT persist its zoom into the shared per-diagram key — no cross-talk with the domain canvas (#762)', async () => {
    // The domain canvas remembers 150% under the single shared key; the read-only context map must not
    // clobber it (the bug that made the domain canvas open at a read-only canvas's zoom instead of its default).
    saveDiagramZoom('koi-domain-diagram', 150);
    const graph: DiagramGraph = {
      nodes: [ctx('A'), ctx('B')],
      edges: [{ from: 'A', to: 'B', label: 'Customer/Supplier', arrowKind: 'association' }],
    };
    const container = makeContainer();
    const handle = await renderContextMapGraph(container, graph, () => true);
    try {
      // Zoom the read-only canvas: its readout updates, but it must not overwrite the domain's saved zoom.
      container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click();
      expect(loadDiagramZoom('koi-domain-diagram')).toBe(150);
    } finally {
      handle?.dispose();
    }
  });

  test('saves its zoom under its own key koi-context-map, not the shared domain key (#769)', async () => {
    const graph: DiagramGraph = {
      nodes: [ctx('A'), ctx('B')],
      edges: [{ from: 'A', to: 'B', label: 'Customer/Supplier', arrowKind: 'association' }],
    };
    const container = makeContainer();
    const handle = await renderContextMapGraph(container, graph, () => true);
    try {
      container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click();
      // Must persist to its own key, never to the domain canvas's key
      expect(loadDiagramZoom('koi-context-map')).not.toBeNull();
      expect(loadDiagramZoom('koi-domain-diagram')).toBeNull();
    } finally {
      handle?.dispose();
    }
  });

  test('restores its own saved zoom from koi-context-map on mount (#769)', async () => {
    saveDiagramZoom('koi-context-map', 150);
    const graph: DiagramGraph = {
      nodes: [ctx('A'), ctx('B')],
      edges: [{ from: 'A', to: 'B', label: 'Customer/Supplier', arrowKind: 'association' }],
    };
    const container = makeContainer();
    const handle = await renderContextMapGraph(container, graph, () => true);
    try {
      expect(container.querySelector('.koi-canvas-zoom-pct')?.textContent).toBe('150%');
    } finally {
      handle?.dispose();
    }
  });

  test('renders READ-ONLY even when global editing is ON, without mutating the editing flag', async () => {
    setDiagramEditing(true);
    const graph: DiagramGraph = {
      nodes: [ctx('A'), ctx('B')],
      edges: [{ from: 'A', to: 'B', label: 'Partnership', arrowKind: 'bidirectional' }],
    };
    const container = makeContainer();
    const handle = await renderContextMapGraph(container, graph, () => true);
    try {
      expect(isDiagramEditing()).toBe(true); // the context map never touches the global editing flag
      // no authoring chrome on the context-map canvas even though editing is globally on (readOnly localizes it)
      expect(container.querySelector('.koi-ctxmap-graph.koi-canvas--editing')).toBeNull();
    } finally {
      handle?.dispose();
    }
  });

  test('a superseded render (isCurrent() false) commits nothing and returns null', async () => {
    const graph: DiagramGraph = { nodes: [ctx('A')], edges: [] };
    const container = makeContainer();
    container.append('sentinel');
    const handle = await renderContextMapGraph(container, graph, () => false);
    expect(handle).toBeNull();
    expect(container.querySelector('.koi-ctxmap-graph')).toBeNull();
    expect(container.textContent).toContain('sentinel');
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

  test('double-clicking an editable node prompts and bubbles NODE_EDIT rename with the name position', async () => {
    setDiagramEditing(true);
    (koiPrompt as Mock).mockResolvedValue('PurchaseOrder');
    const merged: DiagramGraph = { nodes: [spanned()], edges: [] };
    const container = makeContainer();
    const handle = buildCanvas(mx, container, merged);
    try {
      let detail: any = null;
      container.addEventListener('koi-diagram-node-edit', (e) => { detail = (e as CustomEvent).detail; });
      handle.graph.fireEvent(new mx.EventObject(mx.InternalEvent.DOUBLE_CLICK, 'cell', handle.cells.get('Ordering.Order')));
      await vi.waitFor(() =>
        expect(detail).toMatchObject({ qualifiedName: 'Ordering.Order', action: 'rename', newName: 'PurchaseOrder', label: 'Order', line: 5, column: 3 }),
      );
    } finally {
      handle.dispose();
    }
  });

  test('double-click is inert when editing is off', () => {
    setDiagramEditing(false);
    const container = makeContainer();
    const handle = buildCanvas(mx, container, { nodes: [spanned()], edges: [] });
    try {
      let fired = false;
      container.addEventListener('koi-diagram-node-edit', () => { fired = true; });
      handle.graph.fireEvent(new mx.EventObject(mx.InternalEvent.DOUBLE_CLICK, 'cell', handle.cells.get('Ordering.Order')));
      expect(fired).toBe(false);
      expect(koiPrompt).not.toHaveBeenCalled(); // never even reaches the dialog
    } finally {
      handle.dispose();
    }
  });

  test('right-clicking a node confirms and bubbles NODE_EDIT delete', async () => {
    setDiagramEditing(true);
    (koiConfirm as Mock).mockResolvedValue(true);
    const container = makeContainer();
    const handle = buildCanvas(mx, container, { nodes: [spanned()], edges: [] });
    try {
      // getCellAt needs laid-out geometry (absent headlessly), so stub it to return the node cell.
      handle.graph.getCellAt = (() => handle.cells.get('Ordering.Order')) as typeof handle.graph.getCellAt;
      let detail: any = null;
      container.addEventListener('koi-diagram-node-edit', (e) => { detail = (e as CustomEvent).detail; });
      container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 2 }));
      await vi.waitFor(() =>
        expect(detail).toMatchObject({ qualifiedName: 'Ordering.Order', action: 'delete', label: 'Order' }),
      );
    } finally {
      handle.dispose();
    }
  });

  test('declining the delete confirm bubbles nothing', async () => {
    setDiagramEditing(true);
    (koiConfirm as Mock).mockResolvedValue(false);
    const container = makeContainer();
    const handle = buildCanvas(mx, container, { nodes: [spanned()], edges: [] });
    try {
      handle.graph.getCellAt = (() => handle.cells.get('Ordering.Order')) as typeof handle.graph.getCellAt;
      let fired = false;
      container.addEventListener('koi-diagram-node-edit', () => { fired = true; });
      container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 2 }));
      await vi.waitFor(() => expect(koiConfirm).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 0)); // let the (resolved-false) .then run
      expect(fired).toBe(false);
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

describe('touch mode: freehand off, tap-to-navigate kept (#221 Task 3)', () => {
  const spanned = (over = {}) =>
    node({
      id: 'Ordering.Order',
      qualifiedName: 'Ordering.Order',
      label: 'Order',
      kind: 'aggregate-root',
      stereotype: 'aggregate root',
      sourceSpan: { file: 'file:///m.koi', line: 5, column: 3, endLine: 5, endColumn: 8, offset: 0, length: 5 },
      ...over,
    });

  test('with touch mode on, the canvas is neither movable nor connectable even when editing is on', () => {
    setDiagramEditing(true);
    setDiagramTouchMode(true); // freehand off is INDEPENDENT of editing
    const container = makeContainer();
    const handle = buildCanvas(mx, container, { nodes: [spanned()], edges: [] }, undefined, { touch: true });
    try {
      expect(handle.graph.isCellsMovable()).toBe(false); // drag-to-reposition off
      expect(handle.graph.isConnectable()).toBe(false); // drag-to-connect off
    } finally {
      handle.dispose();
    }
  });

  test('double-click rename is inert in touch mode (no NODE_EDIT, no prompt)', () => {
    setDiagramEditing(true);
    setDiagramTouchMode(true);
    const container = makeContainer();
    const handle = buildCanvas(mx, container, { nodes: [spanned()], edges: [] }, undefined, { touch: true });
    try {
      let fired = false;
      container.addEventListener('koi-diagram-node-edit', () => { fired = true; });
      handle.graph.fireEvent(new mx.EventObject(mx.InternalEvent.DOUBLE_CLICK, 'cell', handle.cells.get('Ordering.Order')));
      expect(fired).toBe(false);
      expect(koiPrompt).not.toHaveBeenCalled(); // never reaches the rename dialog
    } finally {
      handle.dispose();
    }
  });

  test('right-click delete is inert in touch mode (no NODE_EDIT, no confirm)', () => {
    setDiagramEditing(true);
    setDiagramTouchMode(true);
    const container = makeContainer();
    const handle = buildCanvas(mx, container, { nodes: [spanned()], edges: [] }, undefined, { touch: true });
    try {
      handle.graph.getCellAt = (() => handle.cells.get('Ordering.Order')) as typeof handle.graph.getCellAt;
      let fired = false;
      container.addEventListener('koi-diagram-node-edit', () => { fired = true; });
      container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 2 }));
      expect(fired).toBe(false);
      expect(koiConfirm).not.toHaveBeenCalled(); // never reaches the delete confirm
    } finally {
      handle.dispose();
    }
  });

  test('a node tap still bubbles NODE_NAVIGATE_EVENT in touch mode (tap-to-inspect)', () => {
    setDiagramEditing(true);
    setDiagramTouchMode(true);
    const container = makeContainer();
    const handle = buildCanvas(mx, container, { nodes: [spanned()], edges: [] }, undefined, { touch: true });
    try {
      let detail: any = null;
      container.addEventListener('koi-diagram-node-click', (e) => { detail = (e as CustomEvent).detail; });
      handle.graph.fireEvent(new mx.EventObject(mx.InternalEvent.CLICK, 'cell', handle.cells.get('Ordering.Order')));
      expect(detail).toMatchObject({ qualifiedName: 'Ordering.Order', file: 'file:///m.koi', line: 5, column: 3 });
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

describe('refit on reveal (#529): re-fit + minimap re-layout when the canvas becomes measurable', () => {
  const g: DiagramGraph = { nodes: [node({ id: 'Ordering.Order', qualifiedName: 'Ordering.Order', stereotype: 'aggregate root' })], edges: [] };

  test('a DIAGRAM_REFIT_EVENT re-fits the live canvas and reconstructs the Outline minimap', async () => {
    const container = makeContainer();
    await createMaxGraphRenderer().render(container, [file([diagram('aggregate', g)])], 'dark', () => true);

    // The minimap built at render time. On a real phone it would have mounted against a zero-size hidden
    // zone (an oversized empty box); here it builds against the shimmed 800×600 host — what matters is that
    // the refit REPLACES this instance with a fresh one once the zone is revealed.
    const outlineDiv = container.querySelector('.koi-canvas-outline');
    expect(outlineDiv).not.toBeNull();
    const minimapBefore = outlineDiv!.firstElementChild;
    expect(minimapBefore).not.toBeNull();

    // Spy AFTER the initial render so only the refit's work is counted. `fit()` always calls graph.center()
    // (re-frames the content off the top-left); a rebuilt Outline destroys the prior instance first — two
    // independent proofs the refit ran on the live canvas.
    const centerSpy = vi.spyOn(mx.Graph.prototype, 'center');
    const destroySpy = vi.spyOn(mx.Outline.prototype, 'destroy');

    // The IDE dispatches this on `document` when it reveals the hidden mobile Diagram zone (ide.tsx).
    document.dispatchEvent(new Event(DIAGRAM_REFIT_EVENT));

    expect(centerSpy).toHaveBeenCalled(); // content re-framed to fit — no longer jammed in the top-left
    expect(destroySpy).toHaveBeenCalled(); // the stale minimap was torn down…
    const minimapAfter = container.querySelector('.koi-canvas-outline')!.firstElementChild;
    expect(minimapAfter).not.toBeNull();
    expect(minimapAfter).not.toBe(minimapBefore); // …and rebuilt against the now-measurable host
  });
});

describe('position persistence', () => {
  const cls = (id: string) => node({ id, qualifiedName: id, stereotype: 'aggregate root' });

  test('saved positions override the auto-layout (a hand-placed node does not snap back)', () => {
    const container = makeContainer();
    const handle = buildCanvas(mx, container, { nodes: [cls('Ordering.Order')], edges: [] }, { positions: { 'Ordering.Order': { x: 500, y: 120 } }, notes: [], groups: [] });
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

describe('canvas annotations (#255)', () => {
  const cls = (id: string) => node({ id, qualifiedName: id, stereotype: 'aggregate root' });
  const twoNodes = { nodes: [cls('Ordering.Order'), cls('Ordering.Line')], edges: [] };
  const positions = { 'Ordering.Order': { x: 40, y: 40 }, 'Ordering.Line': { x: 360, y: 200 } };
  const note = { id: 'note-1', text: 'Remember to model returns', x: 600, y: 30, width: 180, height: 96 };
  const group = { id: 'group-1', label: 'Checkout', members: ['Ordering.Order', 'Ordering.Line'] };

  test('renders a note cell and a group cell, both painted BEHIND the nodes', () => {
    const container = makeContainer();
    const handle = buildCanvas(mx, container, twoNodes, { positions, notes: [note], groups: [group] });
    try {
      const noteCell = handle.noteCells.get('note-1');
      const groupCell = handle.groupCells.get('group-1');
      expect(noteCell).toBeDefined();
      expect(groupCell).toBeDefined();

      // Paint order == root child order: the annotations come before the context container (so they sit
      // behind the nodes parented into it), and the group (a region) comes before the note.
      const root = handle.graph.getDefaultParent();
      const containerCell = handle.containers.get('Ordering')!;
      const groupIdx = root.getIndex(groupCell!);
      const noteIdx = root.getIndex(noteCell!);
      const containerIdx = root.getIndex(containerCell);
      expect(groupIdx).toBeLessThan(noteIdx);
      expect(noteIdx).toBeLessThan(containerIdx);
    } finally {
      handle.dispose();
    }
  });

  test("a note's text and geometry round-trip from the saved layout onto its cell", () => {
    const container = makeContainer();
    const handle = buildCanvas(mx, container, twoNodes, { positions, notes: [note], groups: [] });
    try {
      const cell = handle.noteCells.get('note-1')!;
      const geo = cell.getGeometry()!;
      expect(geo.x).toBe(600);
      expect(geo.y).toBe(30);
      expect(geo.width).toBe(180);
      expect(geo.height).toBe(96);
      expect(handle.graph.convertValueToString(cell)).toContain('Remember to model returns');
    } finally {
      handle.dispose();
    }
  });

  test("a group's rectangle wraps the absolute bounding box of its members", () => {
    const container = makeContainer();
    const handle = buildCanvas(mx, container, twoNodes, { positions, notes: [], groups: [group] });
    try {
      const ctxGeo = handle.containers.get('Ordering')!.getGeometry()!; // members are relative to this
      const m1 = handle.cells.get('Ordering.Order')!.getGeometry()!;
      const m2 = handle.cells.get('Ordering.Line')!.getGeometry()!;
      const minX = Math.min(m1.x, m2.x) + ctxGeo.x;
      const minY = Math.min(m1.y, m2.y) + ctxGeo.y;
      const maxX = Math.max(m1.x + m1.width, m2.x + m2.width) + ctxGeo.x;
      const maxY = Math.max(m1.y + m1.height, m2.y + m2.height) + ctxGeo.y;

      const gg = handle.groupCells.get('group-1')!.getGeometry()!;
      expect(handle.groupCells.get('group-1')!.isVisible()).toBe(true);
      expect(gg.x).toBeLessThanOrEqual(minX);
      expect(gg.y).toBeLessThanOrEqual(minY);
      expect(gg.x + gg.width).toBeGreaterThanOrEqual(maxX);
      expect(gg.y + gg.height).toBeGreaterThanOrEqual(maxY);
    } finally {
      handle.dispose();
    }
  });

  test('a group with no resolvable members is hidden (nothing to enclose)', () => {
    const container = makeContainer();
    const orphan = { id: 'group-x', label: 'Orphan', members: ['Nope.Missing'] };
    const handle = buildCanvas(mx, container, twoNodes, { positions, notes: [], groups: [orphan] });
    try {
      expect(handle.groupCells.get('group-x')!.isVisible()).toBe(false);
    } finally {
      handle.dispose();
    }
  });

  test('moving a note persists its new geometry to the layout store (notes ride the save)', () => {
    setDiagramPersistScope('ws-test'); // browser-storage fallback (no injected store)
    const container = makeContainer();
    const handle = buildCanvas(mx, container, twoNodes, { positions, notes: [note], groups: [group] });
    try {
      const model = handle.graph.getDataModel();
      const cell = handle.noteCells.get('note-1')!;
      const geo = cell.getGeometry()!.clone();
      geo.x = 720;
      geo.y = 510;
      model.setGeometry(cell, geo);
      handle.graph.fireEvent(new mx.EventObject(mx.InternalEvent.CELLS_MOVED, 'cells', [cell], 'dx', 0, 'dy', 0));

      const saved = loadDiagramAnnotations(positionKey());
      expect(saved.notes).toHaveLength(1);
      expect(saved.notes[0]).toMatchObject({ id: 'note-1', x: 720, y: 510 });
      // The group rides the same save (membership preserved; rect is re-derived, not stored).
      expect(saved.groups).toEqual([{ id: 'group-1', label: 'Checkout', members: ['Ordering.Order', 'Ordering.Line'] }]);
    } finally {
      handle.dispose();
    }
  });

  // create / edit / delete (Task 3): the renderer owns the annotation lifecycle (no `.koi` round-trip).
  const tick = () => new Promise((r) => setTimeout(r, 0)); // let the koiPrompt/koiConfirm promise chains settle

  test('the create-annotation event adds a note (prompted text) and persists it', async () => {
    setDiagramEditing(true);
    setDiagramPersistScope('ws-test');
    vi.mocked(koiPrompt).mockResolvedValue('Returns flow TBD');
    const container = makeContainer();
    const handle = buildCanvas(mx, container, twoNodes, { positions, notes: [], groups: [] });
    try {
      document.dispatchEvent(new CustomEvent(DIAGRAM_ANNOTATION_CREATE_EVENT, { detail: { kind: 'note' } }));
      await tick();

      expect(handle.noteCells.size).toBe(1);
      const saved = loadDiagramAnnotations(positionKey());
      expect(saved.notes).toHaveLength(1);
      expect(saved.notes[0].text).toBe('Returns flow TBD');
    } finally {
      handle.dispose();
    }
  });

  test('the create-annotation event groups the selected nodes (prompted label) and persists it', async () => {
    setDiagramEditing(true);
    setDiagramPersistScope('ws-test');
    vi.mocked(koiPrompt).mockResolvedValue('Checkout');
    const container = makeContainer();
    const handle = buildCanvas(mx, container, twoNodes, { positions, notes: [], groups: [] });
    try {
      handle.graph.setSelectionCell(handle.cells.get('Ordering.Order')!); // group around the selection
      document.dispatchEvent(new CustomEvent(DIAGRAM_ANNOTATION_CREATE_EVENT, { detail: { kind: 'group' } }));
      await tick();

      expect(handle.groupCells.size).toBe(1);
      const saved = loadDiagramAnnotations(positionKey());
      expect(saved.groups).toHaveLength(1);
      expect(saved.groups[0]).toMatchObject({ label: 'Checkout', members: ['Ordering.Order'] });
    } finally {
      handle.dispose();
    }
  });

  test('double-clicking a note edits its text and persists', async () => {
    setDiagramEditing(true);
    setDiagramPersistScope('ws-test');
    vi.mocked(koiPrompt).mockResolvedValue('Edited text');
    const container = makeContainer();
    const handle = buildCanvas(mx, container, twoNodes, { positions, notes: [note], groups: [] });
    try {
      const cell = handle.noteCells.get('note-1')!;
      handle.graph.fireEvent(new mx.EventObject(mx.InternalEvent.DOUBLE_CLICK, 'cell', cell));
      await tick();

      expect(handle.graph.convertValueToString(cell)).toContain('Edited text');
      expect(loadDiagramAnnotations(positionKey()).notes[0].text).toBe('Edited text');
    } finally {
      handle.dispose();
    }
  });

  test('right-clicking an annotation deletes it (confirmed) and persists the removal', async () => {
    setDiagramEditing(true);
    setDiagramPersistScope('ws-test');
    vi.mocked(koiConfirm).mockResolvedValue(true);
    const container = makeContainer();
    const handle = buildCanvas(mx, container, twoNodes, { positions, notes: [note], groups: [] });
    try {
      const cell = handle.noteCells.get('note-1')!;
      handle.graph.getCellAt = (() => cell) as typeof handle.graph.getCellAt; // happy-dom can't hit-test by pixel
      container.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
      await tick();

      expect(handle.noteCells.size).toBe(0);
      expect(loadDiagramAnnotations(positionKey()).notes).toHaveLength(0);
    } finally {
      handle.dispose();
    }
  });

  test('end-to-end: notes & groups survive a save → fresh reload and render behind the nodes', async () => {
    setDiagramPersistScope('ws-e2e');
    const e2eNote = { id: 'n-e2e', text: 'survives reload', x: 500, y: 40, width: 180, height: 96 };
    const e2eGroup = { id: 'g-e2e', label: 'Core', members: ['Ordering.Order', 'Ordering.Line'] };

    // Persist a layout through one store…
    createBrowserLayoutStore().save({ positions, notes: [e2eNote], groups: [e2eGroup] });

    // …then a FRESH store over the same workspace reads it back intact.
    const restored = await createBrowserLayoutStore().load();
    expect(restored.notes).toEqual([e2eNote]);
    expect(restored.groups).toEqual([e2eGroup]);

    // Rendering the restored layout puts the annotation cells on the canvas, behind the nodes.
    const container = makeContainer();
    const handle = buildCanvas(mx, container, twoNodes, restored);
    try {
      expect(handle.noteCells.get('n-e2e')).toBeDefined();
      expect(handle.groupCells.get('g-e2e')).toBeDefined();
      const root = handle.graph.getDefaultParent();
      expect(root.getIndex(handle.noteCells.get('n-e2e')!)).toBeLessThan(root.getIndex(handle.containers.get('Ordering')!));
    } finally {
      handle.dispose();
    }
  });
});

// --- event flow canvas (#270) ------------------------------------------------
const EVENT_FLOW: { nodes: EventFlowNode[]; edges: EventFlowEdge[] } = {
  nodes: [
    { id: 'cmd', label: 'PlaceOrder', kind: 'command', qualifiedName: 'Sales.PlaceOrder', context: 'Sales', span: null },
    {
      id: 'evt',
      label: 'OrderPlaced',
      kind: 'domain-event',
      qualifiedName: 'Sales.OrderPlaced',
      context: 'Sales',
      span: { file: 'file:///m.koi', line: 12, column: 3, endLine: 12, endColumn: 9, offset: 0, length: 6 },
    },
    { id: 'pol', label: 'NotifyKitchen', kind: 'policy', qualifiedName: 'Sales.NotifyKitchen', context: 'Sales', span: null },
    { id: 'int', label: 'OrderShipped', kind: 'integration-event', qualifiedName: 'Sales.OrderShipped', context: 'Sales', span: null },
  ],
  edges: [
    { from: 'cmd', to: 'evt', label: null, kind: 'flow' },
    { from: 'evt', to: 'pol', label: null, kind: 'flow' },
    { from: 'Sales', to: 'int', label: 'publishes', kind: 'publish' },
    { from: 'int', to: 'Shipping', label: 'consumed by', kind: 'subscribe' },
  ],
};

describe('buildEventFlowCanvas', () => {
  test('indexes one card per node and a swimlane per bridged context, with the expected edge endpoints', () => {
    const container = makeContainer();
    const handle = buildEventFlowCanvas(mx, container, EVENT_FLOW);
    try {
      // one cell per card, keyed by id, carrying the EventFlowNode (and its kind)
      expect(handle.cells.size).toBe(4);
      expect(handle.cells.get('cmd')!.value).toMatchObject({ kind: 'command' });
      expect(handle.cells.get('evt')!.value).toMatchObject({ kind: 'domain-event' });
      expect(handle.cells.get('pol')!.value).toMatchObject({ kind: 'policy' });
      expect(handle.cells.get('int')!.value).toMatchObject({ kind: 'integration-event' });

      // a swimlane vertex per context referenced by a publish/subscribe arrow (NOT a card)
      expect(handle.containers.size).toBe(2);
      expect(handle.containers.has('Sales')).toBe(true);
      expect(handle.containers.has('Shipping')).toBe(true);

      // flow edge: command card → event card
      const flowEdge = handle.cells.get('cmd')!.getEdgeAt(0);
      expect(flowEdge!.value).toMatchObject({ kind: 'flow' });
      expect(flowEdge!.getTerminal(false)).toBe(handle.cells.get('evt'));

      // publish edge: Sales swimlane → integration-event card
      const pub = handle.containers.get('Sales')!.getEdgeAt(0);
      expect(pub!.value).toMatchObject({ kind: 'publish' });
      expect(pub!.getTerminal(true)).toBe(handle.containers.get('Sales'));
      expect(pub!.getTerminal(false)).toBe(handle.cells.get('int'));

      // subscribe edge: integration-event card → Shipping swimlane
      const sub = handle.containers.get('Shipping')!.getEdgeAt(0);
      expect(sub!.value).toMatchObject({ kind: 'subscribe' });
      expect(sub!.getTerminal(true)).toBe(handle.cells.get('int'));
      expect(sub!.getTerminal(false)).toBe(handle.containers.get('Shipping'));
    } finally {
      handle.dispose();
    }
  });

  test('a card click bubbles NODE_NAVIGATE_EVENT with the card’s span; a span-less card is inert', () => {
    const container = makeContainer();
    const handle = buildEventFlowCanvas(mx, container, EVENT_FLOW);
    try {
      let detail: any = null;
      container.addEventListener('koi-diagram-node-click', (e) => {
        detail = (e as CustomEvent).detail;
      });
      handle.graph.fireEvent(new mx.EventObject(mx.InternalEvent.CLICK, 'cell', handle.cells.get('evt')));
      expect(detail).toMatchObject({ qualifiedName: 'Sales.OrderPlaced', line: 12, column: 3 });

      detail = null;
      handle.graph.fireEvent(new mx.EventObject(mx.InternalEvent.CLICK, 'cell', handle.cells.get('cmd'))); // span: null
      expect(detail).toBeNull();
    } finally {
      handle.dispose();
    }
  });

  test('an empty flow builds an empty canvas (no cards, no swimlanes)', () => {
    const container = makeContainer();
    const handle = buildEventFlowCanvas(mx, container, { nodes: [], edges: [] });
    try {
      expect(handle.cells.size).toBe(0);
      expect(handle.containers.size).toBe(0);
    } finally {
      handle.dispose();
    }
  });
});

describe('renderEventFlowGraph', () => {
  test('mounts a canvas surface + zoom controls for a non-empty flow (its own root class)', async () => {
    const container = makeContainer();
    const handle = await renderEventFlowGraph(container, EVENT_FLOW, () => true);
    try {
      expect(handle).not.toBeNull();
      expect(container.querySelector('.koi-eventflow-graph .koi-canvas')).not.toBeNull();
      expect(container.querySelector('.koi-canvas-controls')).not.toBeNull();
    } finally {
      handle?.dispose();
    }
  });

  test('a superseded render (isCurrent() false) commits nothing and returns null', async () => {
    const container = makeContainer();
    container.append('sentinel');
    const handle = await renderEventFlowGraph(container, EVENT_FLOW, () => false);
    expect(handle).toBeNull();
    expect(container.querySelector('.koi-eventflow-graph')).toBeNull();
    expect(container.textContent).toContain('sentinel');
  });

  test('saves its zoom under its own key koi-event-flow, not the shared domain key (#769)', async () => {
    const container = makeContainer();
    const handle = await renderEventFlowGraph(container, EVENT_FLOW, () => true);
    try {
      container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click();
      // Must persist to its own key, never to the domain canvas's key
      expect(loadDiagramZoom('koi-event-flow')).not.toBeNull();
      expect(loadDiagramZoom('koi-domain-diagram')).toBeNull();
    } finally {
      handle?.dispose();
    }
  });

  test('restores its own saved zoom from koi-event-flow on mount (#769)', async () => {
    saveDiagramZoom('koi-event-flow', 150);
    const container = makeContainer();
    const handle = await renderEventFlowGraph(container, EVENT_FLOW, () => true);
    try {
      expect(container.querySelector('.koi-canvas-zoom-pct')?.textContent).toBe('150%');
    } finally {
      handle?.dispose();
    }
  });
});

describe('event flow layout persistence (#270)', () => {
  test('moving a card persists under a per-workspace event-flow key (not the domain key), and a fresh canvas restores it', () => {
    setDiagramPersistScope('ws-eventflow'); // no layout store injected ⇒ the browser-storage fallback is used
    const container = makeContainer();
    const handle = buildEventFlowCanvas(mx, container, EVENT_FLOW);
    try {
      const model = handle.graph.getDataModel();
      const cell = handle.cells.get('evt')!;
      const geo = cell.getGeometry()!.clone();
      geo.x = 321;
      geo.y = 123;
      model.setGeometry(cell, geo);
      handle.graph.fireEvent(new mx.EventObject(mx.InternalEvent.CELLS_MOVED, 'cells', [cell], 'dx', 0, 'dy', 0));

      // Persisted under the event-flow key, keyed by the card's qualified name…
      expect(loadDiagramPositions('ws-eventflow:koi-event-flow')['Sales.OrderPlaced']).toEqual({ x: 321, y: 123 });
      // …and NOT under the domain canvas's key, so the two views' layouts never clobber each other.
      expect(loadDiagramPositions(positionKey())).toEqual({});
    } finally {
      handle.dispose();
    }

    // A FRESH canvas over the same flow re-applies the saved position (survives a reload).
    const container2 = makeContainer();
    const handle2 = buildEventFlowCanvas(mx, container2, EVENT_FLOW);
    try {
      const restored = handle2.cells.get('evt')!.getGeometry()!;
      expect(restored.x).toBe(321);
      expect(restored.y).toBe(123);
    } finally {
      handle2.dispose();
    }
  });
});
