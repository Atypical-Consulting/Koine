// Tests for the hand-rolled, addressable SVG diagram renderer (issue #93, Task 3). The renderer
// consumes the structured `{ nodes, edges }` graph (not the Mermaid markdown) and emits real DOM:
// one `<g class="koi-svg-node">` per node, tagged with the node's provenance so Task 4 can navigate
// without re-querying. Layout coordinates are NOT asserted (layout-lib-dependent); we assert
// structure, the node DOM contract, and the per-diagram fallback robustness only.
import { afterEach, describe, expect, test } from 'vitest';
import { createSvgRenderer, NODE_NAVIGATE_EVENT, type DiagramNodeNavigateDetail } from './diagrams-svg';
import { createMermaidRenderer, mermaidDiagramsFor, stripMermaidFence } from './diagrams';
import type { DocsFile, Diagram } from './lsp';

const EMPTY_STATE = 'No diagrams yet';

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
            {
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
            },
            {
              id: 'money',
              label: 'Money',
              kind: 'value-object',
              qualifiedName: 'Ordering.Money',
              sourceSpan: null,
            },
          ],
          edges: [{ from: 'order', to: 'money', label: 'total' }],
        }),
      ]),
    ];

    const container = ROOT();
    await createSvgRenderer().render(container, files, 'light', () => true);

    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();

    const nodes = container.querySelectorAll('.koi-svg-node');
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
            {
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
            },
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
            {
              id: 'money',
              label: 'Money',
              kind: 'value-object',
              qualifiedName: 'Ordering.Money',
              sourceSpan: null,
            },
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
            { id: 'a', label: 'A', kind: 'state', qualifiedName: 'Ord.A', sourceSpan: null },
            { id: 'b', label: 'B', kind: 'state', qualifiedName: 'Ord.B', sourceSpan: null },
          ],
          edges: [{ from: 'a', to: 'b', label: 'go' }],
        }),
      ]),
    ];

    const container = ROOT();
    await createSvgRenderer().render(container, files, 'light', () => true);

    const edges = container.querySelectorAll('.koi-svg-edge');
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
          nodes: [{ id: 'a', label: 'A', kind: 'state', qualifiedName: 'Ord.A', sourceSpan: null }],
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
            {
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
            },
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
            {
              id: 'money',
              label: 'Money',
              kind: 'value-object',
              qualifiedName: 'Ordering.Money',
              sourceSpan: null,
            },
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
            {
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
            },
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
