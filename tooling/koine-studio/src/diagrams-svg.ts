// Hand-rolled, themeable, *addressable* SVG diagram renderer (issue #93, Task 3). Unlike the Mermaid
// renderer (diagrams.ts), this consumes the structured `{ nodes, edges }` graph the compiler now emits
// alongside each diagram (DocsFile.diagrams[].graph) and draws real, queryable DOM: one
// `<g class="koi-svg-node" data-qname="…">` per node and one `<path class="koi-svg-edge">` per edge.
//
// Every node is tagged with its provenance (data-qname + raw 1-based source span as data-attributes) so
// Task 4 can wire jump-to-source by reading those attributes off the clicked group — no re-query of the
// model needed. Nodes whose sourceSpan is null get NO span attributes (Task 4 leaves them inert).
//
// Layout is delegated to elkjs' bundled, worker-less build, dynamically imported and cached so it
// code-splits out of the main bundle (same discipline as Mermaid) and dodges Tauri's strict CSP (the
// non-bundled build spawns a Web Worker from a blob: URL, which CSP forbids).
import type { DiagramRenderer } from './diagrams';
import { createMermaidRenderer } from './diagrams';
import type { Diagram, DiagramGraph, DiagramNode, DocsFile, SourceSpan } from './lsp';
// Type-only import (erased at build time) of elkjs' own API surface, so our layout graph type-checks
// against the real `ELK.layout` signature. The *value* is dynamically imported from the bundled build.
import type { ELK, ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk-api';

type ElkConstructor = new () => ELK;

/**
 * The bubbling `CustomEvent` a node group dispatches when clicked (issue #93, Task 4). `ide.ts`
 * listens for it ONCE on the diagrams container (delegated) and jumps the editor caret to the node's
 * `.koi` declaration. Only nodes that carry a source span (i.e. have a `data-line`) dispatch it;
 * span-less nodes stay inert.
 */
export const NODE_NAVIGATE_EVENT = 'koi-diagram-node-click';

/**
 * The `detail` of a {@link NODE_NAVIGATE_EVENT}: the node's qualified name plus its RAW 1-based source
 * span, read straight off the node's data-attributes (no conversion here — `ide.ts` converts to a
 * 0-based LSP position). `file` is the `data-file` `file://` uri, or `null` when the span had no file.
 */
export interface DiagramNodeNavigateDetail {
  qualifiedName: string;
  file: string | null;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

let elkPromise: Promise<ElkConstructor> | null = null;

/** Boot elkjs once (cached). The bundled build runs in-thread (no Worker) so it survives Tauri CSP. */
async function getElk(): Promise<ElkConstructor> {
  if (!elkPromise) {
    // Dynamic import → a separate chunk; the heavy layout engine never touches the main bundle.
    elkPromise = import('elkjs/lib/elk.bundled.js').then((m) => m.default);
    // Don't cache a rejected import — null it so a later visit retries (mirrors the Mermaid cache).
    elkPromise.catch(() => {
      elkPromise = null;
    });
  }
  return elkPromise;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// Node box sizing. Width grows with the label so long names don't overflow; ELK only needs the box
// dimensions, it places everything else.
const NODE_HEIGHT = 40;
const NODE_PADDING_X = 28;
const CHAR_WIDTH = 8.2; // rough advance for the label font at the size used below
const MIN_NODE_WIDTH = 72;
const EDGE_LABEL_HEIGHT = 16;
const SVG_PADDING = 12;

function nodeWidth(label: string): number {
  return Math.max(MIN_NODE_WIDTH, Math.round(label.length * CHAR_WIDTH) + NODE_PADDING_X);
}

/** The page title: the docs file's first level-1 heading, else a humanised file name. */
function pageTitle(file: DocsFile): string {
  const h1 = file.contents.match(/^#\s+(.*)$/m);
  if (h1) return h1[1].trim();
  const name = file.path.split('/').pop() ?? file.path;
  return name.replace(/\.md$/, '');
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

/** Stamp a node's provenance onto its `<g>` so Task 4 can navigate by reading these attributes. */
function tagNode(g: SVGGElement, node: DiagramNode): void {
  g.setAttribute('data-qname', node.qualifiedName);
  if (node.kind) g.setAttribute('data-kind', node.kind);
  const span: SourceSpan | null = node.sourceSpan;
  // A node with no position gets NO span attributes AND no click handler — it stays inert.
  if (span) {
    if (span.file != null) g.setAttribute('data-file', span.file);
    g.setAttribute('data-line', String(span.line));
    g.setAttribute('data-column', String(span.column));
    g.setAttribute('data-end-line', String(span.endLine));
    g.setAttribute('data-end-column', String(span.endColumn));

    // Spanned nodes are navigable: dispatch a bubbling event carrying the RAW 1-based span so a
    // single delegated listener on the container (ide.ts) can jump to the `.koi` declaration. The
    // detail mirrors the data-attrs exactly — no coordinate conversion happens here.
    g.addEventListener('click', () => {
      const detail: DiagramNodeNavigateDetail = {
        qualifiedName: node.qualifiedName,
        file: span.file,
        line: span.line,
        column: span.column,
        endLine: span.endLine,
        endColumn: span.endColumn,
      };
      g.dispatchEvent(new CustomEvent<DiagramNodeNavigateDetail>(NODE_NAVIGATE_EVENT, {
        bubbles: true,
        detail,
      }));
    });
  }
}

function polylinePath(points: { x: number; y: number }[]): string {
  if (!points.length) return '';
  const [head, ...rest] = points;
  return `M ${head.x} ${head.y} ` + rest.map((p) => `L ${p.x} ${p.y}`).join(' ');
}

/**
 * Lay out one structured graph with ELK and draw it into a fresh `<svg>`. Throws on layout failure so
 * the caller can fall back to Mermaid for just that diagram.
 */
async function drawGraph(graph: DiagramGraph, Elk: ElkConstructor): Promise<SVGSVGElement> {
  const layoutEdges: ElkExtendedEdge[] = graph.edges.map((e, i) => ({
    id: `e${i}`,
    sources: [e.from],
    targets: [e.to],
    labels: e.label ? [{ text: e.label, width: e.label.length * 6.2, height: EDGE_LABEL_HEIGHT }] : undefined,
  }));
  const layoutGraph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '28',
      'elk.layered.spacing.nodeNodeBetweenLayers': '56',
      'elk.spacing.edgeNode': '20',
    },
    children: graph.nodes.map((n) => ({
      id: n.id,
      width: nodeWidth(n.label),
      height: NODE_HEIGHT,
    })),
    edges: layoutEdges,
  };

  const elk = new Elk();
  const laid = await elk.layout(layoutGraph);

  const byId = new Map<string, DiagramNode>(graph.nodes.map((n) => [n.id, n]));
  const width = Math.max(1, Math.ceil(laid.width ?? 0) + SVG_PADDING * 2);
  const height = Math.max(1, Math.ceil(laid.height ?? 0) + SVG_PADDING * 2);

  const svg = svgEl('svg');
  svg.setAttribute('class', 'koi-svg-diagram');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('role', 'img');

  // Arrowhead marker, themed via CSS (currentColor / stroke from .koi-svg-edge).
  const defs = svgEl('defs');
  const marker = svgEl('marker');
  marker.setAttribute('id', 'koi-svg-arrow');
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '9');
  marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '7');
  marker.setAttribute('markerHeight', '7');
  marker.setAttribute('orient', 'auto-start-reverse');
  const arrow = svgEl('path');
  arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
  arrow.setAttribute('class', 'koi-svg-arrowhead');
  marker.appendChild(arrow);
  defs.appendChild(marker);
  svg.appendChild(defs);

  // Edges first so nodes paint on top of the lines.
  const edgeLayer = svgEl('g');
  edgeLayer.setAttribute('class', 'koi-svg-edges');
  for (const e of laid.edges ?? []) {
    const g = svgEl('g');
    g.setAttribute('class', 'koi-svg-edge');

    const section = e.sections?.[0];
    const points = section
      ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
      : [];
    const path = svgEl('path');
    path.setAttribute('class', 'koi-svg-edge-line');
    path.setAttribute('d', points.length ? offsetPath(points) : '');
    path.setAttribute('marker-end', 'url(#koi-svg-arrow)');
    g.appendChild(path);

    const label = e.labels?.[0];
    if (label?.text != null && label.x != null && label.y != null) {
      const t = svgEl('text');
      t.setAttribute('class', 'koi-svg-edge-label');
      t.setAttribute('x', String(label.x + SVG_PADDING));
      t.setAttribute('y', String(label.y + SVG_PADDING + EDGE_LABEL_HEIGHT * 0.5));
      t.textContent = label.text;
      g.appendChild(t);
    }
    edgeLayer.appendChild(g);
  }
  svg.appendChild(edgeLayer);

  const nodeLayer = svgEl('g');
  nodeLayer.setAttribute('class', 'koi-svg-nodes');
  for (const ln of laid.children ?? []) {
    const node = byId.get(ln.id);
    if (!node) continue;
    const x = (ln.x ?? 0) + SVG_PADDING;
    const y = (ln.y ?? 0) + SVG_PADDING;
    const w = ln.width ?? MIN_NODE_WIDTH;
    const h = ln.height ?? NODE_HEIGHT;

    const g = svgEl('g');
    g.setAttribute('class', 'koi-svg-node');
    g.setAttribute('transform', `translate(${x}, ${y})`);
    tagNode(g, node);

    const rect = svgEl('rect');
    rect.setAttribute('class', 'koi-svg-node-box');
    rect.setAttribute('width', String(w));
    rect.setAttribute('height', String(h));
    rect.setAttribute('rx', '7');
    rect.setAttribute('ry', '7');
    g.appendChild(rect);

    const text = svgEl('text');
    text.setAttribute('class', 'koi-svg-node-label');
    text.setAttribute('x', String(w / 2));
    text.setAttribute('y', String(h / 2));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.textContent = node.label;
    g.appendChild(text);

    nodeLayer.appendChild(g);
  }
  svg.appendChild(nodeLayer);

  return svg;
}

/** Shift an ELK polyline (root-relative) by the SVG padding offset. */
function offsetPath(points: { x: number; y: number }[]): string {
  return polylinePath(points.map((p) => ({ x: p.x + SVG_PADDING, y: p.y + SVG_PADDING })));
}

/**
 * The SVG renderer: draws each diagram's structured graph as addressable SVG. A diagram whose graph is
 * empty, or whose layout throws, falls back to the Mermaid renderer for *that diagram only* so one bad
 * graph never blanks the tab. The empty-state note and the isCurrent() superseded-render guard match the
 * Mermaid renderer's behaviour exactly.
 */
export function createSvgRenderer(): DiagramRenderer {
  // The Mermaid renderer is the per-diagram fallback (bad graph / layout failure / empty graph).
  const fallback = createMermaidRenderer();

  return {
    async render(container, files, theme, isCurrent = () => true): Promise<void> {
      const pages = files
        .map((f) => ({ title: pageTitle(f), diagrams: f.diagrams ?? [] }))
        .filter((p) => p.diagrams.length > 0);

      if (!pages.length) {
        if (isCurrent()) {
          container.innerHTML =
            '<p class="muted">No diagrams yet — add an aggregate, a state machine, or a context map to your model.</p>';
        }
        return;
      }

      let Elk: ElkConstructor;
      try {
        Elk = await getElk();
      } catch (e) {
        if (isCurrent()) {
          container.innerHTML = `<p class="doc-error">Could not load the diagram renderer: ${escapeHtml(String(e))}</p>`;
        }
        return;
      }

      const root = document.createElement('div');
      root.className = 'koi-diagrams';

      // Diagrams that need the Mermaid fallback are collected and rendered in one pass at the end (the
      // Mermaid renderer takes a DocsFile[], so we wrap each failed diagram as a single-diagram file).
      const fallbackTargets: { mount: HTMLElement; diagram: Diagram; title: string }[] = [];

      for (const page of pages) {
        const section = document.createElement('section');
        section.className = 'koi-diagram-page';

        const h = document.createElement('h2');
        h.className = 'koi-diagram-title';
        h.textContent = page.title;
        section.appendChild(h);

        for (const diagram of page.diagrams) {
          const card = document.createElement('figure');
          card.className = 'koi-diagram';

          if (diagram.caption && diagram.caption !== page.title) {
            const cap = document.createElement('figcaption');
            cap.className = 'koi-diagram-caption';
            cap.textContent = diagram.caption;
            card.appendChild(cap);
          }

          const surface = document.createElement('div');
          surface.className = 'koi-diagram-surface';

          const graph = diagram.graph;
          if (!graph || graph.nodes.length === 0) {
            // No structured nodes to draw → hand this one to Mermaid.
            fallbackTargets.push({ mount: surface, diagram, title: page.title });
          } else {
            try {
              const svg = await drawGraph(graph, Elk);
              surface.appendChild(svg);
            } catch {
              // Layout/draw failed for this graph → fall back to Mermaid for this diagram only.
              surface.replaceChildren();
              fallbackTargets.push({ mount: surface, diagram, title: page.title });
            }
          }

          card.appendChild(surface);
          section.appendChild(card);
        }

        root.appendChild(section);
      }

      // Render any fallbacks through the real Mermaid renderer. The Mermaid renderer (now sourcing from
      // the structured `file.diagrams`) builds its own page/figure shell, so we render into a detached
      // scratch element and lift just the rendered `.koi-diagram-surface` content into our own surface —
      // avoiding a nested `.koi-diagrams` shell inside an already-built figure. The diagram's own caption
      // is used as the synthetic page title so the Mermaid renderer doesn't add a duplicate figcaption.
      for (const { mount, diagram } of fallbackTargets) {
        const oneFile: DocsFile = {
          path: `${diagram.caption || 'diagram'}.md`,
          contents: `# ${diagram.caption || 'diagram'}\n`,
          diagrams: [diagram],
        };
        const scratch = document.createElement('div');
        // The scratch mount is detached, so the isCurrent() guard there is always-true; our top-level
        // isCurrent() guard below still decides whether the whole tree reaches the page.
        await fallback.render(scratch, [oneFile], theme, () => true);
        const inner = scratch.querySelector('.koi-diagram-surface');
        if (inner) {
          mount.replaceChildren(...Array.from(inner.childNodes));
        } else {
          // No surface (e.g. the Mermaid renderer's empty-state note) — keep whatever it produced so the
          // diagram never silently blanks.
          mount.replaceChildren(...Array.from(scratch.childNodes));
        }
      }

      // A newer render may have started while we awaited ELK/Mermaid (theme flip / edit / refresh) — drop
      // this superseded result rather than letting it win the last DOM write with a stale model/theme.
      if (isCurrent()) container.replaceChildren(root);
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
