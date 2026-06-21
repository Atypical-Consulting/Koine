// Tests for the hand-rolled, addressable SVG diagram renderer (issue #93, Task 3). The renderer
// consumes the structured `{ nodes, edges }` graph (not the Mermaid markdown) and emits real DOM:
// one `<g class="koi-svg-node">` per node, tagged with the node's provenance so Task 4 can navigate
// without re-querying. Layout coordinates are NOT asserted (layout-lib-dependent); we assert
// structure, the node DOM contract, and the per-diagram fallback robustness only.
import { afterEach, describe, expect, test } from 'vitest';
import { createSvgRenderer, NODE_NAVIGATE_EVENT, type DiagramNodeNavigateDetail } from './diagrams-svg';
import { createMermaidRenderer, mermaidDiagramsFor, stripMermaidFence } from './diagrams';
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

  test('a malformed/empty graph does not throw and does not blank the container', async () => {
    // An edge that references node ids that do not exist, and an empty node list — the renderer must
    // not throw and must still leave SOMETHING in the container (caption / fallback), never blank it.
    const files: DocsFile[] = [
      file(
        [
          diagram(
            {
              nodes: [],
              edges: [{ from: 'ghost', to: 'phantom', label: null }],
            },
            { caption: 'Broken', mermaid: 'not a valid mermaid graph @#$' },
          ),
        ],
        { contents: '# Broken\n' },
      ),
    ];

    const container = ROOT();
    await expect(createSvgRenderer().render(container, files, 'light', () => true)).resolves.toBeUndefined();
    // Page title still rendered → container is not blank.
    expect(container.textContent).toContain('Broken');
  });

  test('an empty graph routes to the Mermaid fallback — NOT the empty-state note', async () => {
    // Regression for the fallback-source bug: a diagram whose `graph` is empty (nodes: []) but which
    // carries a valid `mermaid` string must be handed to the Mermaid renderer and actually rendered.
    // Before the fix the synthetic fallback file had no ```mermaid fence in `contents`, so the Mermaid
    // renderer found no pages and wrote "No diagrams yet…" into that diagram's surface instead.
    const files: DocsFile[] = [
      file([
        diagram(
          { nodes: [], edges: [] },
          { caption: 'Ordering', mermaid: 'graph TD\n  A[Order] --> B[Money]' },
        ),
      ]),
    ];

    const container = ROOT();
    await createSvgRenderer().render(container, files, 'light', () => true);

    // The figure/surface shell IS built (the diagram was found and routed to the Mermaid path)…
    const surface = container.querySelector('.koi-diagram-surface');
    expect(surface).not.toBeNull();
    // …and the empty-state note is NOT shown anywhere in the tab.
    expect(container.textContent).not.toContain(EMPTY_STATE);
    // The fallback also must not nest a second `.koi-diagrams` shell inside the surface.
    expect(surface!.querySelector('.koi-diagrams')).toBeNull();
  });

  test('the Mermaid renderer sources from structured file.diagrams (no fence needed in contents)', async () => {
    // Direct coverage of the seam: given a file whose markdown `contents` has NO ```mermaid fence but
    // whose structured `diagrams` is populated, the Mermaid renderer must render it (build the page
    // shell) rather than fall through to the empty-state note. This is what makes the SVG renderer's
    // fallback wrapper — which passes a fence-less synthetic file — work, and also feeds the
    // DIAGRAM_RENDERER='mermaid' path from the same structured source.
    const fenceless: DocsFile = {
      path: 'Ordering.md',
      contents: '# Ordering\n', // deliberately NO ```mermaid fence
      diagrams: [
        {
          caption: 'Ordering',
          kind: 'aggregate',
          mermaid: 'graph TD\n  A[Order] --> B[Money]',
          graph: { nodes: [], edges: [] },
        },
      ],
    };

    const container = ROOT();
    await createMermaidRenderer().render(container, [fenceless], 'light', () => true);

    expect(container.textContent).not.toContain(EMPTY_STATE);
    // Page shell built from the structured diagram → the diagram was found, not skipped.
    expect(container.querySelector('.koi-diagram-page')).not.toBeNull();
    expect(container.querySelector('.koi-diagram-surface')).not.toBeNull();
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

  test('zoom-in raises the percent and shrinks the viewBox; zoom-out lowers it; fit restores it', async () => {
    const container = ROOT();
    await createSvgRenderer().render(container, oneNodeFile(), 'light', () => true);

    const svg = container.querySelector<SVGSVGElement>('.koi-canvas svg')!;
    const zoomIn = container.querySelector<HTMLButtonElement>('.koi-canvas-btn[aria-label="Zoom in"]')!;
    const zoomOut = container.querySelector<HTMLButtonElement>('.koi-canvas-btn[aria-label="Zoom out"]')!;
    const fitBtn = container.querySelector<HTMLButtonElement>('.koi-canvas-btn[aria-label="Fit to screen"]')!;

    const startPct = pctOf(container);
    const startW = viewBoxNumbers(svg)[2];

    zoomIn.click();
    expect(pctOf(container)).toBeGreaterThan(startPct);
    expect(viewBoxNumbers(svg)[2]).toBeLessThan(startW); // smaller window = magnified

    fitBtn.click();
    expect(pctOf(container)).toBe(startPct);
    expect(viewBoxNumbers(svg)[2]).toBeCloseTo(startW, 6);

    zoomOut.click();
    expect(pctOf(container)).toBeLessThan(startPct);
    expect(viewBoxNumbers(svg)[2]).toBeGreaterThan(startW);
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

describe('mermaid source from the structured field', () => {
  // The compiler emits `Diagram.mermaid` as the EXACT fenced block embedded in the Markdown
  // (` ```mermaid\n…\n``` `), but `mermaid.render(id, code)` expects the raw inner source. Feeding the
  // fenced block to mermaid.render throws a parse error → every Mermaid-path diagram (the
  // DIAGRAM_RENDERER='mermaid' value AND the SVG renderer's per-diagram fallback) would render the
  // `<pre>` error block in a real browser. happy-dom hides this (mermaid.render yields empty output),
  // so we test the fence-stripping directly to give it teeth.
  test('stripMermaidFence returns the inner source, fence markers removed', () => {
    const fenced = '```mermaid\nflowchart LR\n  A --> B\n```';
    const code = stripMermaidFence(fenced);
    expect(code).toBe('flowchart LR\n  A --> B');
    expect(code).not.toContain('```');
    expect(code).toContain('flowchart LR');
  });

  test('stripMermaidFence passes through an already-unfenced string (trimmed)', () => {
    expect(stripMermaidFence('flowchart LR\n  A --> B')).toBe('flowchart LR\n  A --> B');
    expect(stripMermaidFence('  graph TD\n  X --> Y  \n')).toBe('graph TD\n  X --> Y');
  });

  test('mermaidDiagramsFor strips the fence off the structured mermaid (matches the regex path)', () => {
    const f: DocsFile = {
      path: 'Ordering.md',
      contents: '# Ordering\n', // no fence in contents — only the structured diagrams carry mermaid
      diagrams: [
        {
          caption: 'Ordering',
          kind: 'aggregate',
          mermaid: '```mermaid\nflowchart LR\n  A --> B\n```',
          graph: { nodes: [], edges: [] },
        },
      ],
    };
    const out = mermaidDiagramsFor(f);
    expect(out).toHaveLength(1);
    expect(out[0].caption).toBe('Ordering');
    // The code handed to mermaid.render must be the raw source — NOT the fenced block.
    expect(out[0].code).toBe('flowchart LR\n  A --> B');
    expect(out[0].code).not.toContain('```mermaid');
    expect(out[0].code).not.toContain('```');
  });

  test('mermaidDiagramsFor falls back to extracting fences from contents when diagrams is empty', () => {
    const f: DocsFile = {
      path: 'Legacy.md',
      contents: '## Legacy\n\n```mermaid\nflowchart TD\n  P --> Q\n```\n',
      diagrams: [],
    };
    const out = mermaidDiagramsFor(f);
    expect(out).toHaveLength(1);
    expect(out[0].code).toBe('flowchart TD\n  P --> Q');
    expect(out[0].caption).toBe('Legacy');
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
