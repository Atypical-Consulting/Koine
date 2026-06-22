// Tests for the hand-rolled, addressable SVG diagram renderer (issue #93, Task 3). The renderer
// consumes the structured `{ nodes, edges }` graph (not the Mermaid markdown) and emits real DOM:
// one `<g class="koi-svg-node">` per node, tagged with the node's provenance so Task 4 can navigate
// without re-querying. Layout coordinates are NOT asserted (layout-lib-dependent); we assert
// structure, the node DOM contract, and the per-diagram fallback robustness only.
import { afterEach, describe, expect, test } from 'vitest';
import {
  createSvgRenderer,
  setDiagramEditing,
  setDiagramPersistScope,
  DIAGRAM_RELAYOUT_EVENT,
  DIAGRAM_CONNECT_EVENT,
  DIAGRAM_DISCONNECT_EVENT,
  NODE_NAVIGATE_EVENT,
  type DiagramConnectDetail,
  type DiagramDisconnectDetail,
  type DiagramNodeNavigateDetail,
} from './diagrams-svg';
import { loadDiagramPositions, saveDiagramPositions } from './store';
import type { DocsFile, Diagram, DiagramNode } from './lsp';

const EMPTY_STATE = 'No diagrams yet';

/** Build a DiagramNode with the simple-box defaults (no stereotype/members) unless overridden. */
function mkNode(over: Partial<DiagramNode> & Pick<DiagramNode, 'id' | 'label' | 'kind' | 'qualifiedName'>): DiagramNode {
  return {
    sourceSpan: null,
    stereotype: null,
    members: [],
    ...over,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

function diagram(graph: Diagram['graph'], over: Partial<Diagram> = {}): Diagram {
  return {
    caption: 'Ordering',
    kind: 'aggregate',
    mermaid: 'graph TD\n  A --> B',
    graph,
    ...over,
  };
}

function file(diagrams: Diagram[], over: Partial<DocsFile> = {}): DocsFile {
  return {
    path: 'ordering.md',
    contents: '# Ordering\n',
    diagrams,
    ...over,
  };
}

const ROOT = () => {
  const c = document.createElement('div');
  document.body.appendChild(c);
  return c;
};

describe('createSvgRenderer', () => {
  test('renders one addressable node element per graph node, each carrying data-qname', async () => {
    const files: DocsFile[] = [
      file([
        diagram({
          nodes: [
            mkNode({
              id: 'order',
              label: 'Order',
              kind: 'aggregate-root',
              qualifiedName: 'Ordering.Order',
              sourceSpan: {
                file: 'ordering.koi',
                line: 3,
                column: 5,
                endLine: 3,
                endColumn: 10,
                offset: 20,
                length: 5,
              },
            }),
            mkNode({
              id: 'money',
              label: 'Money',
              kind: 'value-object',
              qualifiedName: 'Ordering.Money',
              sourceSpan: null,
            }),
          ],
          edges: [{ from: 'order', to: 'money', label: 'total' }],
        }),
      ]),
    ];

    const container = ROOT();
    await createSvgRenderer().render(container, files, 'light', () => true);

    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();

    // Scope to the primary diagram SVG: the minimap (#145) clones the node layer as a decorative
    // thumbnail, so an unscoped `.koi-svg-node` count would also pick up the inert clones.
    const nodes = container.querySelectorAll('.koi-svg-diagram .koi-svg-node');
    expect(nodes.length).toBe(2);

    const qnames = [...nodes].map((n) => n.getAttribute('data-qname')).sort();
    expect(qnames).toEqual(['Ordering.Money', 'Ordering.Order']);

    // Each node group has a rect + a text label.
    for (const n of nodes) {
      expect(n.querySelector('rect')).not.toBeNull();
      expect(n.querySelector('text')).not.toBeNull();
    }
  });

  test('a node with a sourceSpan carries the raw 1-based span data-attributes', async () => {
    const files: DocsFile[] = [
      file([
        diagram({
          nodes: [
            mkNode({
              id: 'order',
              label: 'Order',
              kind: 'aggregate-root',
              qualifiedName: 'Ordering.Order',
              sourceSpan: {
                file: 'ordering.koi',
                line: 3,
                column: 5,
                endLine: 7,
                endColumn: 10,
                offset: 20,
                length: 5,
              },
            }),
          ],
          edges: [],
        }),
      ]),
    ];

    const container = ROOT();
    await createSvgRenderer().render(container, files, 'light', () => true);

    const node = container.querySelector('.koi-svg-node[data-qname="Ordering.Order"]')!;
    expect(node).not.toBeNull();
    expect(node.getAttribute('data-file')).toBe('ordering.koi');
    expect(node.getAttribute('data-line')).toBe('3');
    expect(node.getAttribute('data-column')).toBe('5');
    expect(node.getAttribute('data-end-line')).toBe('7');
    expect(node.getAttribute('data-end-column')).toBe('10');
    // styled by kind
    expect(node.getAttribute('data-kind')).toBe('aggregate-root');
  });

  test('a node with sourceSpan: null carries NO span data-attributes', async () => {
    const files: DocsFile[] = [
      file([
        diagram({
          nodes: [
            mkNode({
              id: 'money',
              label: 'Money',
              kind: 'value-object',
              qualifiedName: 'Ordering.Money',
              sourceSpan: null,
            }),
          ],
          edges: [],
        }),
      ]),
    ];

    const container = ROOT();
    await createSvgRenderer().render(container, files, 'light', () => true);

    const node = container.querySelector('.koi-svg-node[data-qname="Ordering.Money"]')!;
    expect(node).not.toBeNull();
    expect(node.hasAttribute('data-file')).toBe(false);
    expect(node.hasAttribute('data-line')).toBe(false);
    expect(node.hasAttribute('data-column')).toBe(false);
    expect(node.hasAttribute('data-end-line')).toBe(false);
    expect(node.hasAttribute('data-end-column')).toBe(false);
    // qname is still present so the node is still addressable.
    expect(node.getAttribute('data-qname')).toBe('Ordering.Money');
  });

  test('draws an edge element between connected nodes', async () => {
    const files: DocsFile[] = [
      file([
        diagram({
          nodes: [
            mkNode({ id: 'a', label: 'A', kind: 'state', qualifiedName: 'Ord.A' }),
            mkNode({ id: 'b', label: 'B', kind: 'state', qualifiedName: 'Ord.B' }),
          ],
          edges: [{ from: 'a', to: 'b', label: 'go' }],
        }),
      ]),
    ];

    const container = ROOT();
    await createSvgRenderer().render(container, files, 'light', () => true);

    // Scope to the primary diagram SVG (the minimap clones the edge layer too).
    const edges = container.querySelectorAll('.koi-svg-diagram .koi-svg-edge');
    expect(edges.length).toBe(1);
  });

  test('shows the empty-state note when no file has a diagram', async () => {
    const container = ROOT();
    await createSvgRenderer().render(container, [file([])], 'light', () => true);
    expect(container.textContent).toContain('No diagrams yet');
    expect(container.querySelector('svg')).toBeNull();
  });

  test('a malformed/empty graph does not throw — it shows the empty-state note', async () => {
    // An edge referencing non-existent ids and an empty node list: the only diagram has no drawable
    // nodes, so the SVG renderer must not throw and shows the empty-state note (never blank). There is
    // no Mermaid fallback — the structured graph is the single source.
    const files: DocsFile[] = [
      file([diagram({ nodes: [], edges: [{ from: 'ghost', to: 'phantom', label: null }] }, { caption: 'Broken' })]),
    ];
    const container = ROOT();
    await expect(createSvgRenderer().render(container, files, 'light', () => true)).resolves.toBeUndefined();
    expect(container.textContent).toContain(EMPTY_STATE);
  });

  test('the strategic context map is excluded from the unified diagram (it has its own tab)', async () => {
    // A contextmap diagram alongside an aggregate: only the aggregate is drawn on the visual canvas.
    const files: DocsFile[] = [
      file([
        diagram({ nodes: [mkNode({ id: 'Sales', label: 'Sales', kind: 'context', qualifiedName: 'Sales' })], edges: [] }, { kind: 'contextmap' }),
        diagram({ nodes: [mkNode({ id: 'o', label: 'Order', kind: 'aggregate-root', qualifiedName: 'Sales.Order' })], edges: [] }, { kind: 'aggregate' }),
      ]),
    ];
    const container = ROOT();
    await createSvgRenderer().render(container, files, 'light', () => true);
    expect(container.querySelector('.koi-svg-node[data-qname="Sales.Order"]')).not.toBeNull();
    expect(container.querySelector('.koi-svg-node[data-kind="context"]')).toBeNull();
  });

  test('a superseded render (isCurrent() === false) does not write to the container', async () => {
    const files: DocsFile[] = [
      file([
        diagram({
          nodes: [mkNode({ id: 'a', label: 'A', kind: 'state', qualifiedName: 'Ord.A' })],
          edges: [],
        }),
      ]),
    ];

    const container = ROOT();
    container.innerHTML = '<span id="sentinel">keep me</span>';
    await createSvgRenderer().render(container, files, 'light', () => false);
    expect(container.querySelector('#sentinel')).not.toBeNull();
    expect(container.querySelector('svg')).toBeNull();
  });
});

describe('interactive canvas — zoom / pan / fit (issue #145)', () => {
  /** A one-node diagram is enough to exercise the canvas chrome; layout coords are not asserted. */
  function oneNodeFile(): DocsFile[] {
    return [
      file([
        diagram({
          nodes: [mkNode({ id: 'a', label: 'Order', kind: 'aggregate-root', qualifiedName: 'Ord.Order' })],
          edges: [],
        }),
      ]),
    ];
  }

  /** Parse the integer percent off the zoom readout (e.g. "120%" → 120). */
  function pctOf(container: HTMLElement): number {
    const text = container.querySelector('.koi-canvas-zoom-pct')!.textContent ?? '';
    return parseInt(text, 10);
  }

  const viewBoxNumbers = (svg: SVGSVGElement) =>
    (svg.getAttribute('viewBox') ?? '').split(/\s+/).map(Number);

  test('wraps the drawn SVG in an interactive .koi-canvas with a − / % / + / fit control bar', async () => {
    const container = ROOT();
    await createSvgRenderer().render(container, oneNodeFile(), 'light', () => true);

    const canvas = container.querySelector('.koi-canvas');
    expect(canvas).not.toBeNull();
    // The drawn SVG lives inside the canvas (not loose in the surface).
    expect(canvas!.querySelector('svg.koi-svg-diagram')).not.toBeNull();

    // The control bar exposes the four named controls.
    expect(container.querySelector('.koi-canvas-btn[aria-label="Zoom in"]')).not.toBeNull();
    expect(container.querySelector('.koi-canvas-btn[aria-label="Zoom out"]')).not.toBeNull();
    expect(container.querySelector('.koi-canvas-btn[aria-label="Fit to screen"]')).not.toBeNull();
    expect(container.querySelector('.koi-canvas-zoom-pct')).not.toBeNull();
    expect(pctOf(container)).toBeGreaterThan(0);
  });

  test('applies a finite 4-value viewBox to the canvas SVG (driven by the fit transform)', async () => {
    const container = ROOT();
    await createSvgRenderer().render(container, oneNodeFile(), 'light', () => true);

    const svg = container.querySelector<SVGSVGElement>('.koi-canvas svg')!;
    const nums = viewBoxNumbers(svg);
    expect(nums).toHaveLength(4);
    expect(nums.every(Number.isFinite)).toBe(true);
    // A fit window is non-degenerate.
    expect(nums[2]).toBeGreaterThan(0);
    expect(nums[3]).toBeGreaterThan(0);
    // The svg fills its canvas so the viewBox (not the intrinsic size) governs what's shown.
    expect(svg.getAttribute('width')).toBe('100%');
    expect(svg.getAttribute('height')).toBe('100%');
  });

  test('opens at 100% zoom by default (not fitted-to-screen)', async () => {
    const container = ROOT();
    await createSvgRenderer().render(container, oneNodeFile(), 'light', () => true);
    // A freshly opened diagram starts at its natural 100% scale (one content unit per pixel), so the
    // reader sees the diagram at true size rather than scaled to fill the panel.
    expect(pctOf(container)).toBe(100);
  });

  test('zoom-in raises the percent and shrinks the viewBox; zoom-out lowers it; fit re-frames to fill', async () => {
    const container = ROOT();
    await createSvgRenderer().render(container, oneNodeFile(), 'light', () => true);

    const svg = container.querySelector<SVGSVGElement>('.koi-canvas svg')!;
    const zoomIn = container.querySelector<HTMLButtonElement>('.koi-canvas-btn[aria-label="Zoom in"]')!;
    const zoomOut = container.querySelector<HTMLButtonElement>('.koi-canvas-btn[aria-label="Zoom out"]')!;
    const fitBtn = container.querySelector<HTMLButtonElement>('.koi-canvas-btn[aria-label="Fit to screen"]')!;

    const startPct = pctOf(container); // the 100% default
    const startW = viewBoxNumbers(svg)[2];

    zoomIn.click();
    expect(pctOf(container)).toBeGreaterThan(startPct);
    expect(viewBoxNumbers(svg)[2]).toBeLessThan(startW); // smaller window = magnified

    // Fit re-frames to the diagram bounds with margin — a distinct, wider window than the 100% default.
    fitBtn.click();
    const fitW = viewBoxNumbers(svg)[2];
    expect(fitW).toBeGreaterThan(startW); // padding around the content makes the fit window wider than 100%

    zoomOut.click();
    expect(viewBoxNumbers(svg)[2]).toBeGreaterThan(fitW);
  });

  test('renders a minimap thumbnail (reusing the graph content) with a window rectangle', async () => {
    const files: DocsFile[] = [
      file([
        diagram({
          nodes: [
            mkNode({ id: 'a', label: 'Order', kind: 'aggregate-root', qualifiedName: 'Ord.Order' }),
            mkNode({ id: 'b', label: 'Money', kind: 'value-object', qualifiedName: 'Ord.Money' }),
          ],
          edges: [{ from: 'a', to: 'b', label: 'total' }],
        }),
      ]),
    ];

    const container = ROOT();
    await createSvgRenderer().render(container, files, 'light', () => true);

    const minimap = container.querySelector('.koi-minimap');
    expect(minimap).not.toBeNull();
    // The thumbnail reuses the laid-out content — the nodes are cloned into it.
    expect(minimap!.querySelectorAll('.koi-minimap-content .koi-svg-node').length).toBe(2);
    // And it carries the viewport window rectangle.
    expect(minimap!.querySelector('.koi-minimap-window')).not.toBeNull();
  });

  test('the minimap window rectangle is the clamped intersection of the canvas viewBox and content', async () => {
    const container = ROOT();
    await createSvgRenderer().render(container, oneNodeFile(), 'light', () => true);

    const svg = container.querySelector<SVGSVGElement>('.koi-canvas > svg.koi-svg-diagram')!;
    const mini = container.querySelector<SVGSVGElement>('.koi-minimap-svg')!;
    const win = container.querySelector<SVGRectElement>('.koi-minimap-window')!;
    // The minimap's own viewBox IS the content bounds — the window rect must stay clamped inside it.
    const [cx, cy, cw, ch] = (mini.getAttribute('viewBox') ?? '').split(/\s+/).map(Number);

    const expectClampedToView = () => {
      const [vx, vy, vw, vh] = viewBoxNumbers(svg);
      const ix1 = Math.max(vx, cx);
      const iy1 = Math.max(vy, cy);
      const ix2 = Math.min(vx + vw, cx + cw);
      const iy2 = Math.min(vy + vh, cy + ch);
      // The window rect = the visible (view ∩ content) region — tracks the view AND never overflows.
      expect(Number(win.getAttribute('x'))).toBeCloseTo(ix1, 4);
      expect(Number(win.getAttribute('y'))).toBeCloseTo(iy1, 4);
      expect(Number(win.getAttribute('width'))).toBeCloseTo(Math.max(0, ix2 - ix1), 4);
      expect(Number(win.getAttribute('height'))).toBeCloseTo(Math.max(0, iy2 - iy1), 4);
      expect(Number(win.getAttribute('x'))).toBeGreaterThanOrEqual(cx - 1e-6);
      expect(Number(win.getAttribute('width'))).toBeLessThanOrEqual(cw + 1e-6);
    };

    // Holds at the initial fit (window covers the whole content thumbnail) …
    expectClampedToView();
    // … and stays in sync (still clamped) after the canvas zooms.
    container.querySelector<HTMLButtonElement>('.koi-canvas-btn[aria-label="Zoom in"]')!.click();
    expectClampedToView();
  });

  test('a plain wheel leaves the list to scroll (no zoom); ctrl/⌘+wheel zooms', async () => {
    const container = ROOT();
    await createSvgRenderer().render(container, oneNodeFile(), 'light', () => true);
    const canvas = container.querySelector<HTMLElement>('.koi-canvas')!;
    const svg = container.querySelector<SVGSVGElement>('.koi-canvas > svg.koi-svg-diagram')!;

    // A plain wheel must NOT zoom (and must not preventDefault) so the surrounding Diagrams list scrolls.
    const widthBefore = viewBoxNumbers(svg)[2];
    const plain = new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true });
    canvas.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    expect(viewBoxNumbers(svg)[2]).toBe(widthBefore); // unchanged → no zoom

    // ctrl+wheel (and trackpad pinch, which arrives the same way) zooms in — the viewBox window shrinks.
    // happy-dom's WheelEvent ctor drops `ctrlKey`, so set it explicitly on the dispatched event.
    const zoom = new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true });
    Object.defineProperty(zoom, 'ctrlKey', { value: true });
    canvas.dispatchEvent(zoom);
    expect(viewBoxNumbers(svg)[2]).toBeLessThan(widthBefore);
  });

  test('a pointerdown on the minimap does not throw and is not treated as a canvas pan', async () => {
    const container = ROOT();
    await createSvgRenderer().render(container, oneNodeFile(), 'light', () => true);

    const canvas = container.querySelector<HTMLElement>('.koi-canvas')!;
    const minimap = container.querySelector<HTMLElement>('.koi-minimap')!;

    // Pressing on the minimap must not flip the canvas into its panning state.
    minimap.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 }));
    expect(canvas.classList.contains('koi-canvas--panning')).toBe(false);
  });

  test('the node stays inside the canvas and still navigates on click (pan never swallows it)', async () => {
    const files: DocsFile[] = [
      file([
        diagram({
          nodes: [
            mkNode({
              id: 'order',
              label: 'Order',
              kind: 'aggregate-root',
              qualifiedName: 'Ordering.Order',
              sourceSpan: { file: 'file:///ordering.koi', line: 3, column: 5, endLine: 7, endColumn: 10, offset: 20, length: 5 },
            }),
          ],
          edges: [],
        }),
      ]),
    ];

    const container = ROOT();
    await createSvgRenderer().render(container, files, 'light', () => true);

    const node = container.querySelector<SVGGElement>('.koi-canvas .koi-svg-node[data-qname="Ordering.Order"]')!;
    expect(node).not.toBeNull();

    const events: DiagramNodeNavigateDetail[] = [];
    container.addEventListener(NODE_NAVIGATE_EVENT, (e) => events.push((e as CustomEvent<DiagramNodeNavigateDetail>).detail));
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(events).toHaveLength(1);
    expect(events[0].qualifiedName).toBe('Ordering.Order');
  });
});

describe('UML class boxes (issue #93 enrichment)', () => {
  // A node carrying a stereotype + members renders a compartmented class box: the «stereotype» header,
  // a divider, one row element per attribute, then (when methods exist) another divider + method rows.
  test('renders the stereotype, a divider, and one row per member for a class node', async () => {
    const files: DocsFile[] = [
      file([
        diagram({
          nodes: [
            mkNode({
              id: 'order',
              label: 'Order',
              kind: 'aggregate-root',
              qualifiedName: 'Ordering.Order',
              stereotype: 'aggregate root',
              members: [
                { text: 'id: OrderId', kind: 'field' },
                { text: 'customer: CustomerId', kind: 'field' },
                { text: 'submit()', kind: 'method' },
              ],
            }),
          ],
          edges: [],
        }),
      ]),
    ];

    const container = ROOT();
    await createSvgRenderer().render(container, files, 'light', () => true);

    const node = container.querySelector('.koi-svg-node[data-qname="Ordering.Order"]')!;
    expect(node).not.toBeNull();

    // The «stereotype» header text is shown.
    const stereo = node.querySelector('.koi-svg-class-stereotype');
    expect(stereo).not.toBeNull();
    expect(stereo!.textContent).toBe('«aggregate root»');

    // Two dividers (header→attributes, attributes→methods) since the node has methods.
    expect(node.querySelectorAll('.koi-svg-class-divider').length).toBe(2);

    // One row element per member (3), each carrying the formatted text.
    const rows = [...node.querySelectorAll('.koi-svg-class-row')].map((r) => r.textContent);
    expect(rows).toEqual(['id: OrderId', 'customer: CustomerId', 'submit()']);

    // The bold class title is still the node label.
    expect(node.querySelector('.koi-svg-class-title')!.textContent).toBe('Order');
  });

  test('a class node with no methods draws only the single (header) divider', async () => {
    const files: DocsFile[] = [
      file([
        diagram({
          nodes: [
            mkNode({
              id: 'status',
              label: 'OrderStatus',
              kind: 'enum',
              qualifiedName: 'Ordering.OrderStatus',
              stereotype: 'enumeration',
              members: [
                { text: 'Draft', kind: 'value' },
                { text: 'Submitted', kind: 'value' },
              ],
            }),
          ],
          edges: [],
        }),
      ]),
    ];

    const container = ROOT();
    await createSvgRenderer().render(container, files, 'light', () => true);

    const node = container.querySelector('.koi-svg-node[data-qname="Ordering.OrderStatus"]')!;
    // Only the header divider — no method compartment.
    expect(node.querySelectorAll('.koi-svg-class-divider').length).toBe(1);
    const rows = [...node.querySelectorAll('.koi-svg-class-row')].map((r) => r.textContent);
    expect(rows).toEqual(['Draft', 'Submitted']);
  });

  test('a member-less node still renders the simple centered box (no compartments)', async () => {
    const files: DocsFile[] = [
      file([
        diagram({
          nodes: [
            mkNode({ id: 's', label: 'Draft', kind: 'state', qualifiedName: 'Ordering.Order.Draft' }),
          ],
          edges: [],
        }),
      ]),
    ];

    const container = ROOT();
    await createSvgRenderer().render(container, files, 'light', () => true);

    const node = container.querySelector('.koi-svg-node[data-qname="Ordering.Order.Draft"]')!;
    expect(node).not.toBeNull();
    // No class-box artifacts — the simple box has a single centered label and no dividers/rows.
    expect(node.querySelector('.koi-svg-class-box')).toBeNull();
    expect(node.querySelector('.koi-svg-class-divider')).toBeNull();
    expect(node.querySelectorAll('.koi-svg-class-row').length).toBe(0);
    expect(node.querySelector('.koi-svg-node-label')!.textContent).toBe('Draft');
  });

  test('renders a computed member as an italic attribute row', async () => {
    const files: DocsFile[] = [
      file([
        diagram({
          nodes: [
            mkNode({
              id: 'line',
              label: 'Line',
              kind: 'value-object',
              qualifiedName: 'Sales.Line',
              stereotype: 'value object',
              members: [
                { text: 'quantity: Int', kind: 'field' },
                { text: 'subtotal: Int', kind: 'computed' },
              ],
            }),
          ],
          edges: [],
        }),
      ]),
    ];

    const container = ROOT();
    await createSvgRenderer().render(container, files, 'light', () => true);

    const node = container.querySelector('.koi-svg-node')!;
    // Computed members live in the attribute compartment (above the divider), so a value object
    // with only fields + computed members has NO method divider — exactly one divider.
    expect(node.querySelectorAll('.koi-svg-class-divider').length).toBe(1);

    const computed = node.querySelector('.koi-svg-class-row-computed');
    expect(computed).not.toBeNull();
    expect(computed!.textContent).toBe('subtotal: Int');
  });

  test('a spanned class node still navigates on click (the whole box stays clickable)', async () => {
    const files: DocsFile[] = [
      file([
        diagram({
          nodes: [
            mkNode({
              id: 'order',
              label: 'Order',
              kind: 'aggregate-root',
              qualifiedName: 'Ordering.Order',
              stereotype: 'aggregate root',
              members: [{ text: 'id: OrderId', kind: 'field' }],
              sourceSpan: {
                file: 'file:///ordering.koi',
                line: 3,
                column: 5,
                endLine: 7,
                endColumn: 10,
                offset: 20,
                length: 5,
              },
            }),
          ],
          edges: [],
        }),
      ]),
    ];

    const container = ROOT();
    await createSvgRenderer().render(container, files, 'light', () => true);

    const events: DiagramNodeNavigateDetail[] = [];
    container.addEventListener(NODE_NAVIGATE_EVENT, (e) => {
      events.push((e as CustomEvent<DiagramNodeNavigateDetail>).detail);
    });

    const node = container.querySelector<SVGGElement>('.koi-svg-node[data-qname="Ordering.Order"]')!;
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(events).toHaveLength(1);
    expect(events[0].qualifiedName).toBe('Ordering.Order');
  });
});

describe('node navigation event (Task 4)', () => {
  // A spanned node, when clicked, fires exactly one bubbling NODE_NAVIGATE_EVENT carrying the raw
  // 1-based span (straight off the data-attrs). A null-span node is inert — clicking it fires nothing.
  test('clicking a spanned node fires NODE_NAVIGATE_EVENT with the raw 1-based detail', async () => {
    const files: DocsFile[] = [
      file([
        diagram({
          nodes: [
            mkNode({
              id: 'order',
              label: 'Order',
              kind: 'aggregate-root',
              qualifiedName: 'Ordering.Order',
              sourceSpan: {
                file: 'file:///ordering.koi',
                line: 3,
                column: 5,
                endLine: 7,
                endColumn: 10,
                offset: 20,
                length: 5,
              },
            }),
          ],
          edges: [],
        }),
      ]),
    ];

    const container = ROOT();
    await createSvgRenderer().render(container, files, 'light', () => true);

    const events: DiagramNodeNavigateDetail[] = [];
    container.addEventListener(NODE_NAVIGATE_EVENT, (e) => {
      events.push((e as CustomEvent<DiagramNodeNavigateDetail>).detail);
    });

    const node = container.querySelector<SVGGElement>('.koi-svg-node[data-qname="Ordering.Order"]')!;
    expect(node).not.toBeNull();
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // Exactly one event, bubbling up to the container.
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      qualifiedName: 'Ordering.Order',
      file: 'file:///ordering.koi',
      line: 3,
      column: 5,
      endLine: 7,
      endColumn: 10,
    });
  });

  test('a node with sourceSpan: null is inert — clicking it fires nothing', async () => {
    const files: DocsFile[] = [
      file([
        diagram({
          nodes: [
            mkNode({
              id: 'money',
              label: 'Money',
              kind: 'value-object',
              qualifiedName: 'Ordering.Money',
              sourceSpan: null,
            }),
          ],
          edges: [],
        }),
      ]),
    ];

    const container = ROOT();
    await createSvgRenderer().render(container, files, 'light', () => true);

    let fired = 0;
    container.addEventListener(NODE_NAVIGATE_EVENT, () => {
      fired += 1;
    });

    const node = container.querySelector<SVGGElement>('.koi-svg-node[data-qname="Ordering.Money"]')!;
    expect(node).not.toBeNull();
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(fired).toBe(0);
  });

  test('a span with a null file still navigates by qname but carries file: null', async () => {
    // The compiler can emit a span whose `file` is absent (no data-file attr) while line/column are
    // present. The node is still clickable; the detail's `file` is null so ide.ts can no-op safely.
    const files: DocsFile[] = [
      file([
        diagram({
          nodes: [
            mkNode({
              id: 'order',
              label: 'Order',
              kind: 'aggregate-root',
              qualifiedName: 'Ordering.Order',
              sourceSpan: {
                file: null,
                line: 3,
                column: 5,
                endLine: 7,
                endColumn: 10,
                offset: 20,
                length: 5,
              },
            }),
          ],
          edges: [],
        }),
      ]),
    ];

    const container = ROOT();
    await createSvgRenderer().render(container, files, 'light', () => true);

    const events: DiagramNodeNavigateDetail[] = [];
    container.addEventListener(NODE_NAVIGATE_EVENT, (e) => {
      events.push((e as CustomEvent<DiagramNodeNavigateDetail>).detail);
    });

    const node = container.querySelector<SVGGElement>('.koi-svg-node[data-qname="Ordering.Order"]')!;
    expect(node).not.toBeNull();
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(events).toHaveLength(1);
    expect(events[0].file).toBeNull();
    expect(events[0].line).toBe(3);
  });
});

describe('node width cap + text truncation (authoring overhaul, Phase 1)', () => {
  const MAX_NODE_WIDTH = 280; // mirrors the renderer's hard width cap

  test('a node with a very long member clamps its width and ellipsizes the row (full text in a <title>)', async () => {
    const longMember = 'placeAnExtremelyDetailedOrder(customer: CustomerId, lines: List<OrderLine>, coupon: CouponCode): OrderConfirmation';
    const files: DocsFile[] = [
      file([
        diagram({
          nodes: [
            mkNode({
              id: 'order',
              label: 'Order',
              kind: 'aggregate-root',
              qualifiedName: 'Ordering.Order',
              stereotype: 'aggregate root',
              members: [{ text: longMember, kind: 'method' }],
            }),
          ],
          edges: [],
        }),
      ]),
    ];

    const container = ROOT();
    await createSvgRenderer().render(container, files, 'light', () => true);

    const node = container.querySelector('.koi-svg-diagram .koi-svg-node[data-qname="Ordering.Order"]')!;
    // The box never grows past the hard cap, however long the member is.
    const box = node.querySelector('.koi-svg-class-box')!;
    expect(Number(box.getAttribute('width'))).toBeLessThanOrEqual(MAX_NODE_WIDTH);

    // The row's VISIBLE text (the first child node, before the appended <title>) is clipped with an ellipsis…
    const row = node.querySelector('.koi-svg-class-row')!;
    expect(row.childNodes[0].textContent!.endsWith('…')).toBe(true);
    // …and the full text is preserved in a hover <title> so nothing is lost.
    const title = row.querySelector('title');
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe(longMember);
  });

  test('a short member row is NOT given a <title> (only truncated text gets one)', async () => {
    const files: DocsFile[] = [
      file([
        diagram({
          nodes: [
            mkNode({
              id: 'order',
              label: 'Order',
              kind: 'aggregate-root',
              qualifiedName: 'Ordering.Order',
              stereotype: 'aggregate root',
              members: [{ text: 'id: OrderId', kind: 'field' }],
            }),
          ],
          edges: [],
        }),
      ]),
    ];

    const container = ROOT();
    await createSvgRenderer().render(container, files, 'light', () => true);

    const row = container.querySelector('.koi-svg-diagram .koi-svg-class-row')!;
    expect(row.textContent).toBe('id: OrderId');
    expect(row.querySelector('title')).toBeNull();
  });
});

describe('edge markers + dual cardinalities (authoring overhaul, Phase 1)', () => {
  test('a composition edge draws a diamond at the source, an arrow at the target, and a label at each end', async () => {
    const files: DocsFile[] = [
      file([
        diagram({
          nodes: [
            mkNode({ id: 'order', label: 'Order', kind: 'aggregate-root', qualifiedName: 'Ordering.Order' }),
            mkNode({ id: 'line', label: 'OrderLine', kind: 'value-object', qualifiedName: 'Ordering.OrderLine' }),
          ],
          edges: [
            { from: 'order', to: 'line', label: null, cardinality: '0..1', sourceCardinality: '1', arrowKind: 'composition' },
          ],
        }),
      ]),
    ];

    const container = ROOT();
    await createSvgRenderer().render(container, files, 'light', () => true);

    // The marker pair: a diamond at the owner end, an arrow at the part end.
    const line = container.querySelector('.koi-svg-diagram .koi-svg-edge .koi-svg-edge-line')!;
    expect(line.getAttribute('marker-start')).toBe('url(#koi-svg-diamond)');
    expect(line.getAttribute('marker-end')).toBe('url(#koi-svg-arrow)');
    expect(container.querySelector('.koi-svg-diagram #koi-svg-diamond')).not.toBeNull();

    // Both multiplicities are drawn — the owner end ("1") and the part end ("0..1").
    const cards = [...container.querySelectorAll('.koi-svg-diagram .koi-svg-edge-card')].map((c) => c.textContent).sort();
    expect(cards).toEqual(['0..1', '1']);
  });

  test('a plain edge (no arrowKind) has only a target arrow and no cardinality labels', async () => {
    const files: DocsFile[] = [
      file([
        diagram({
          nodes: [
            mkNode({ id: 'a', label: 'A', kind: 'state', qualifiedName: 'Ord.A' }),
            mkNode({ id: 'b', label: 'B', kind: 'state', qualifiedName: 'Ord.B' }),
          ],
          edges: [{ from: 'a', to: 'b', label: 'go' }],
        }),
      ]),
    ];

    const container = ROOT();
    await createSvgRenderer().render(container, files, 'light', () => true);

    const line = container.querySelector('.koi-svg-diagram .koi-svg-edge .koi-svg-edge-line')!;
    expect(line.getAttribute('marker-end')).toBe('url(#koi-svg-arrow)');
    expect(line.hasAttribute('marker-start')).toBe(false);
    expect(container.querySelectorAll('.koi-svg-diagram .koi-svg-edge-card').length).toBe(0);
    // The semantic label still renders mid-edge.
    expect(container.querySelector('.koi-svg-diagram .koi-svg-edge-label')!.textContent).toBe('go');
  });
});

describe('persisted free positioning (authoring overhaul, Phase 2)', () => {
  afterEach(() => {
    setDiagramEditing(false);
    setDiagramPersistScope('scratch');
    localStorage.clear();
  });

  /** A two-node aggregate (Order ◇— OrderLine), used by the positioning tests. */
  function twoNodeFiles(): DocsFile[] {
    return [
      file([
        diagram({
          nodes: [
            mkNode({
              id: 'order',
              label: 'Order',
              kind: 'aggregate-root',
              qualifiedName: 'Ordering.Order',
              sourceSpan: { file: 'file:///ordering.koi', line: 3, column: 5, endLine: 7, endColumn: 10, offset: 20, length: 5 },
            }),
            mkNode({ id: 'line', label: 'OrderLine', kind: 'value-object', qualifiedName: 'Ordering.OrderLine' }),
          ],
          edges: [{ from: 'order', to: 'line', label: null, cardinality: '*', sourceCardinality: '1', arrowKind: 'composition' }],
        }),
      ]),
    ];
  }

  test('places nodes at their saved positions instead of re-flowing with elk (no snap-back)', async () => {
    setDiagramPersistScope('ws-test');
    saveDiagramPositions('ws-test:koi-domain-diagram', {
      'Ordering.Order': { x: 500, y: 120 },
      'Ordering.OrderLine': { x: 820, y: 360 },
    });

    const container = ROOT();
    await createSvgRenderer().render(container, twoNodeFiles(), 'light', () => true);

    const order = container.querySelector('.koi-svg-diagram .koi-svg-node[data-qname="Ordering.Order"]')!;
    expect(order.getAttribute('transform')).toBe('translate(500, 120)');
    const line = container.querySelector('.koi-svg-diagram .koi-svg-node[data-qname="Ordering.OrderLine"]')!;
    expect(line.getAttribute('transform')).toBe('translate(820, 360)');
  });

  test('the auto-arrange button is present only when editing, and clears positions + emits a relayout', async () => {
    setDiagramEditing(true);
    setDiagramPersistScope('ws-arrange');
    saveDiagramPositions('ws-arrange:koi-domain-diagram', { 'Ordering.Order': { x: 10, y: 10 } });

    const container = ROOT();
    let relayouts = 0;
    container.addEventListener(DIAGRAM_RELAYOUT_EVENT, () => (relayouts += 1));
    await createSvgRenderer().render(container, twoNodeFiles(), 'light', () => true);

    const arrange = container.querySelector<HTMLButtonElement>('.koi-canvas-btn[aria-label="Auto-arrange layout"]');
    expect(arrange).not.toBeNull();

    arrange!.click();
    expect(loadDiagramPositions('ws-arrange:koi-domain-diagram')).toEqual({});
    expect(relayouts).toBe(1);
  });

  test('with editing OFF there is no auto-arrange button and nodes are not draggable', async () => {
    setDiagramEditing(false);
    const container = ROOT();
    await createSvgRenderer().render(container, twoNodeFiles(), 'light', () => true);
    expect(container.querySelector('.koi-canvas-btn[aria-label="Auto-arrange layout"]')).toBeNull();
    expect(container.querySelector('.koi-canvas--editing')).toBeNull();
  });

  test('dragging a node moves it, persists every position, and swallows the would-be navigate click', async () => {
    setDiagramEditing(true);
    setDiagramPersistScope('ws-drag');

    const container = ROOT();
    await createSvgRenderer().render(container, twoNodeFiles(), 'light', () => true);

    const canvas = container.querySelector<HTMLElement>('.koi-canvas')!;
    const svg = container.querySelector<SVGSVGElement>('.koi-svg-diagram')!;
    // happy-dom returns zero-size rects; give the canvas a real size so the pixel→content delta is non-zero.
    Object.defineProperty(canvas, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(canvas, 'clientHeight', { value: 600, configurable: true });
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON() {} }) as DOMRect;

    const node = container.querySelector<SVGGElement>('.koi-svg-node[data-qname="Ordering.Order"]')!;
    const before = node.getAttribute('transform');

    const navigated: DiagramNodeNavigateDetail[] = [];
    container.addEventListener(NODE_NAVIGATE_EVENT, (e) => navigated.push((e as CustomEvent<DiagramNodeNavigateDetail>).detail));

    node.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100 }));
    canvas.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 220, clientY: 180 }));
    canvas.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 220, clientY: 180 }));

    // The node moved…
    expect(node.getAttribute('transform')).not.toBe(before);
    // …the whole layout was snapshotted to storage (both nodes), so the next render won't re-flow…
    const saved = loadDiagramPositions('ws-drag:koi-domain-diagram');
    expect(Object.keys(saved).sort()).toEqual(['Ordering.Order', 'Ordering.OrderLine']);
    // …and the click synthesized after the drag does NOT navigate.
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(navigated).toHaveLength(0);
  });
});

describe('canvas authoring: connect & disconnect (Phase 3)', () => {
  afterEach(() => {
    setDiagramEditing(false);
    setDiagramPersistScope('scratch');
    localStorage.clear();
  });

  /** A 16x9 mocked-size canvas so pixel↔content maths is non-degenerate, plus a content→client mapper. */
  function mockCanvasSize(container: HTMLElement): (cx: number, cy: number) => { clientX: number; clientY: number } {
    const canvas = container.querySelector<HTMLElement>('.koi-canvas')!;
    const svg = container.querySelector<SVGSVGElement>('.koi-svg-diagram')!;
    Object.defineProperty(canvas, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(canvas, 'clientHeight', { value: 600, configurable: true });
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON() {} }) as DOMRect;
    // Invert the live viewBox so a content point maps to the client coords that toContent() will undo.
    return (cx, cy) => {
      const [vx, vy, vw, vh] = (svg.getAttribute('viewBox') ?? '0 0 1 1').split(/\s+/).map(Number);
      return { clientX: ((cx - vx) / vw) * 800, clientY: ((cy - vy) / vh) * 600 };
    };
  }

  function aggregateFiles(): DocsFile[] {
    return [
      file([
        diagram({
          nodes: [
            mkNode({
              id: 'order',
              label: 'Order',
              kind: 'aggregate-root',
              qualifiedName: 'Ordering.Order',
              sourceSpan: { file: 'file:///o.koi', line: 3, column: 5, endLine: 4, endColumn: 9, offset: 20, length: 5 },
            }),
            mkNode({ id: 'line', label: 'OrderLine', kind: 'value-object', qualifiedName: 'Ordering.OrderLine' }),
          ],
          edges: [
            {
              from: 'order',
              to: 'line',
              label: null,
              cardinality: '*',
              sourceCardinality: '1',
              arrowKind: 'composition',
              backingMember: 'Ordering.Order.lines',
            },
          ],
        }),
      ]),
    ];
  }

  test('nodes carry a connection port only while editing', async () => {
    const container = ROOT();
    setDiagramEditing(false);
    await createSvgRenderer().render(container, aggregateFiles(), 'light', () => true);
    expect(container.querySelector('.koi-svg-diagram .koi-svg-port')).toBeNull();

    const container2 = ROOT();
    setDiagramEditing(true);
    await createSvgRenderer().render(container2, aggregateFiles(), 'light', () => true);
    // The aggregate-root and the value-object are both field-owning types → both get a port.
    expect(container2.querySelectorAll('.koi-svg-diagram .koi-svg-port').length).toBe(2);
  });

  test('dragging from a node port onto another node dispatches a connect event with both endpoints', async () => {
    setDiagramEditing(true);
    setDiagramPersistScope('ws-connect');
    // Pin known positions so the drop target rect is deterministic.
    saveDiagramPositions('ws-connect:koi-domain-diagram', {
      'Ordering.Order': { x: 0, y: 0 },
      'Ordering.OrderLine': { x: 420, y: 0 },
    });

    const container = ROOT();
    await createSvgRenderer().render(container, aggregateFiles(), 'light', () => true);
    const toClient = mockCanvasSize(container);

    const connects: DiagramConnectDetail[] = [];
    container.addEventListener(DIAGRAM_CONNECT_EVENT, (e) => connects.push((e as CustomEvent<DiagramConnectDetail>).detail));

    const orderNode = container.querySelector<SVGGElement>('.koi-svg-node[data-qname="Ordering.Order"]')!;
    const port = orderNode.querySelector<SVGCircleElement>('.koi-svg-port')!;

    // Drop point: the centre of OrderLine's rendered box (x=420, plus half its width; y mid).
    const lineBox = container.querySelector<SVGRectElement>('.koi-svg-node[data-qname="Ordering.OrderLine"] .koi-svg-node-box')!;
    const w = Number(lineBox.getAttribute('width'));
    const h = Number(lineBox.getAttribute('height'));
    const drop = toClient(420 + w / 2, h / 2);

    port.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
    const canvas = container.querySelector<HTMLElement>('.koi-canvas')!;
    canvas.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: drop.clientX, clientY: drop.clientY }));
    canvas.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: drop.clientX, clientY: drop.clientY }));

    expect(connects).toHaveLength(1);
    expect(connects[0].sourceQualifiedName).toBe('Ordering.Order');
    expect(connects[0].targetQualifiedName).toBe('Ordering.OrderLine');
  });

  test('right-clicking a field-backed edge dispatches a disconnect event with the backing member', async () => {
    setDiagramEditing(true);
    const container = ROOT();
    await createSvgRenderer().render(container, aggregateFiles(), 'light', () => true);

    const disconnects: DiagramDisconnectDetail[] = [];
    container.addEventListener(DIAGRAM_DISCONNECT_EVENT, (e) =>
      disconnects.push((e as CustomEvent<DiagramDisconnectDetail>).detail),
    );

    const edgeLine = container.querySelector<SVGPathElement>('.koi-svg-diagram .koi-svg-edge[data-backing-member] .koi-svg-edge-line')!;
    expect(edgeLine).not.toBeNull();
    edgeLine.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

    expect(disconnects).toHaveLength(1);
    expect(disconnects[0].backingMember).toBe('Ordering.Order.lines');
    expect(disconnects[0].label).toBe('lines');
  });
});
