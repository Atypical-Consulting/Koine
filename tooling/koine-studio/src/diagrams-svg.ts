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
import type { Diagram, DiagramGraph, DiagramMember, DiagramNode, DocsFile, SourceSpan } from './lsp';
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

/**
 * The bubbling `CustomEvent` a node dispatches for a drag-to-edit gesture (issue #93, Task 5):
 * double-click = rename, right-click = delete. `ide.ts` listens once on the diagrams container, maps
 * the detail to a `StructuredEdit`, and round-trips it through the model→`.koi` seam (#91). Inert
 * unless {@link setDiagramEditing} has enabled editing AND the node is editable (a class-type node with
 * a real span — never a context, and never a state for rename).
 */
export const NODE_EDIT_EVENT = 'koi-diagram-node-edit';

/** The `detail` of a {@link NODE_EDIT_EVENT}: which node, which action, and (for rename) the new name. */
export interface DiagramNodeEditDetail {
  qualifiedName: string;
  /** The gesture: rename the declaration, or delete it. */
  action: 'rename' | 'delete';
  /** The new identifier for a rename (omitted for a delete). */
  newName?: string;
  /** The node's display label (for status messages). */
  label: string;
}

/**
 * Whether diagram nodes accept drag-to-edit gestures (issue #93, Task 5). Off by default so the
 * read-only Diagrams tab (Tasks 1–4) is byte-identical when editing is off; `ide.ts` flips it on once
 * the model→`.koi` round-trip seam (#91) is reachable.
 */
let editingEnabled = false;

/** Enable/disable drag-to-edit gestures on diagram nodes (issue #93, Task 5). */
export function setDiagramEditing(enabled: boolean): void {
  editingEnabled = enabled;
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

// Node box sizing. Width grows with the widest row so long names/members don't overflow; ELK only needs
// the box dimensions, it places everything else.
const NODE_HEIGHT = 40;
const NODE_PADDING_X = 28;
const CHAR_WIDTH = 8.2; // rough advance for the label font (13px) at the size used below
const MEMBER_CHAR_WIDTH = 7; // rough advance for the smaller (12px) monospace-ish member rows
const MIN_NODE_WIDTH = 72;
const EDGE_LABEL_HEIGHT = 16;
const SVG_PADDING = 12;

// UML class-box compartments (issue #93 follow-up). A class node draws a header (stereotype + bold
// label), then an attribute compartment, then — when present — a method compartment, each row a line.
const HEADER_HEIGHT = 44; // stereotype line + bold label, with breathing room
const ROW_HEIGHT = 18; // one attribute / method / value row
const COMPARTMENT_PAD_Y = 6; // vertical padding inside each compartment
const CLASS_PADDING_X = 16; // horizontal text inset inside a class box
const MIN_CLASS_WIDTH = 120;

/** A class node carries a stereotype + member rows; a simple node renders as a single centered box. */
function isClassNode(node: DiagramNode): boolean {
  return node.stereotype != null || (node.members?.length ?? 0) > 0;
}

function nodeWidth(label: string): number {
  return Math.max(MIN_NODE_WIDTH, Math.round(label.length * CHAR_WIDTH) + NODE_PADDING_X);
}

/** Partition a class node's members into the attribute (field/value) and method compartments, in order. */
function partitionMembers(members: DiagramMember[]): { attributes: DiagramMember[]; methods: DiagramMember[] } {
  const attributes = members.filter((m) => m.kind === 'field' || m.kind === 'value');
  const methods = members.filter((m) => m.kind === 'method');
  return { attributes, methods };
}

/** A class box's size: width from the widest of (stereotype, label, every row); height from the row count. */
function classNodeSize(node: DiagramNode): { width: number; height: number } {
  const members = node.members ?? [];
  const { attributes, methods } = partitionMembers(members);

  // Widest content: the bold label (13px), the «stereotype» line, and each member row (12px).
  const labelW = node.label.length * CHAR_WIDTH;
  const stereoText = node.stereotype ? `«${node.stereotype}»` : '';
  const stereoW = stereoText.length * MEMBER_CHAR_WIDTH;
  const rowW = members.reduce((max, m) => Math.max(max, m.text.length * MEMBER_CHAR_WIDTH), 0);
  const width = Math.max(MIN_CLASS_WIDTH, Math.ceil(Math.max(labelW, stereoW, rowW)) + CLASS_PADDING_X * 2);

  // Header + attribute compartment (+ its padding) + method compartment (+ its padding) when methods exist.
  let height = HEADER_HEIGHT;
  height += attributes.length * ROW_HEIGHT + (attributes.length > 0 ? COMPARTMENT_PAD_Y * 2 : COMPARTMENT_PAD_Y);
  if (methods.length > 0) {
    height += methods.length * ROW_HEIGHT + COMPARTMENT_PAD_Y * 2;
  }
  return { width, height: Math.ceil(height) };
}

/** The pre-layout box size for any node (a UML class box, or the simple single-line box). */
function nodeSize(node: DiagramNode): { width: number; height: number } {
  return isClassNode(node) ? classNodeSize(node) : { width: nodeWidth(node.label), height: NODE_HEIGHT };
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

    wireEditGestures(g, node);
  }
}

/** A class-type node (entity/value/event/enum/integration event) — addressable by `Context.SimpleName`. */
function isEditableKind(kind: string): boolean {
  return kind !== '' && kind !== 'context' && kind !== 'state';
}

/**
 * Attach the drag-to-edit gestures (issue #93, Task 5) to a navigable node: double-click renames,
 * right-click (context menu) deletes. Gated at render time so the read-only tab (editing off) is
 * byte-identical — no class, no listeners. Both gestures dispatch a bubbling {@link NODE_EDIT_EVENT}
 * that `ide.ts` round-trips through the #91 seam. Rename is offered only for class-type nodes (not
 * states); delete also for states. A node without a dotted qualified name (a context) is never editable.
 */
function wireEditGestures(g: SVGGElement, node: DiagramNode): void {
  if (!editingEnabled) return;

  const hasOwner = node.qualifiedName.includes('.');
  const canRename = hasOwner && isEditableKind(node.kind);
  const canDelete = hasOwner && node.kind !== 'context';
  if (!canRename && !canDelete) return;

  g.classList.add('koi-svg-node-editable');

  if (canRename) {
    g.addEventListener('dblclick', (e) => {
      e.preventDefault();
      const current = node.label;
      const newName = window.prompt(`Rename ${current} to:`, current)?.trim();
      if (!newName || newName === current) return;
      g.dispatchEvent(
        new CustomEvent<DiagramNodeEditDetail>(NODE_EDIT_EVENT, {
          bubbles: true,
          detail: { qualifiedName: node.qualifiedName, action: 'rename', newName, label: current },
        }),
      );
    });
  }

  if (canDelete) {
    g.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!window.confirm(`Delete ${node.label}? This rewrites the .koi source.`)) return;
      g.dispatchEvent(
        new CustomEvent<DiagramNodeEditDetail>(NODE_EDIT_EVENT, {
          bubbles: true,
          detail: { qualifiedName: node.qualifiedName, action: 'delete', label: node.label },
        }),
      );
    });
  }
}

/** Draw a simple single-line node: a rounded rect with a centered, bold label (the non-class default). */
function drawSimpleBox(g: SVGGElement, node: DiagramNode, w: number, h: number): void {
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
}

/**
 * Draw a UML-style compartmented class box: a header (the «stereotype» above the bold label), a divider,
 * the left-aligned attribute rows (fields + enum values), and — when methods exist — another divider and
 * the method rows. The whole `<g>` stays clickable (Task 4): the rows have `pointer-events: none` so a
 * click on any of them still lands on the group and dispatches the navigate event.
 */
function drawClassBox(g: SVGGElement, node: DiagramNode, w: number, h: number): void {
  const members = node.members ?? [];
  const { attributes, methods } = partitionMembers(members);

  const rect = svgEl('rect');
  rect.setAttribute('class', 'koi-svg-node-box koi-svg-class-box');
  rect.setAttribute('width', String(w));
  rect.setAttribute('height', String(h));
  rect.setAttribute('rx', '7');
  rect.setAttribute('ry', '7');
  g.appendChild(rect);

  // Header: the stereotype (smaller, italic) over the bold label, both centered.
  if (node.stereotype) {
    const stereo = svgEl('text');
    stereo.setAttribute('class', 'koi-svg-class-stereotype');
    stereo.setAttribute('x', String(w / 2));
    stereo.setAttribute('y', '16');
    stereo.setAttribute('text-anchor', 'middle');
    stereo.textContent = `«${node.stereotype}»`;
    g.appendChild(stereo);
  }

  const title = svgEl('text');
  title.setAttribute('class', 'koi-svg-node-label koi-svg-class-title');
  title.setAttribute('x', String(w / 2));
  title.setAttribute('y', node.stereotype ? '34' : '26');
  title.setAttribute('text-anchor', 'middle');
  title.textContent = node.label;
  g.appendChild(title);

  // Divider under the header, then the attribute rows. Enum-only classes have no methods → just one body.
  let y = HEADER_HEIGHT;
  divider(g, w, y);
  y += COMPARTMENT_PAD_Y + ROW_HEIGHT * 0.75;
  for (const m of attributes) {
    appendRow(g, m.text, y, w);
    y += ROW_HEIGHT;
  }
  if (attributes.length > 0) {
    y += COMPARTMENT_PAD_Y - ROW_HEIGHT * 0.75;
  }

  // A second divider + the method compartment, only when there are methods.
  if (methods.length > 0) {
    divider(g, w, y);
    y += COMPARTMENT_PAD_Y + ROW_HEIGHT * 0.75;
    for (const m of methods) {
      appendRow(g, m.text, y, w);
      y += ROW_HEIGHT;
    }
  }
}

/** A full-width horizontal divider line between two class compartments. */
function divider(g: SVGGElement, w: number, y: number): void {
  const line = svgEl('line');
  line.setAttribute('class', 'koi-svg-class-divider');
  line.setAttribute('x1', '0');
  line.setAttribute('x2', String(w));
  line.setAttribute('y1', String(y));
  line.setAttribute('y2', String(y));
  g.appendChild(line);
}

/** One left-aligned member row inside a compartment. */
function appendRow(g: SVGGElement, text: string, y: number, _w: number): void {
  const row = svgEl('text');
  row.setAttribute('class', 'koi-svg-class-row');
  row.setAttribute('x', String(CLASS_PADDING_X));
  row.setAttribute('y', String(y));
  row.textContent = text;
  g.appendChild(row);
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
    children: graph.nodes.map((n) => {
      const { width, height } = nodeSize(n);
      return { id: n.id, width, height };
    }),
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

    if (isClassNode(node)) {
      drawClassBox(g, node, w, h);
    } else {
      drawSimpleBox(g, node, w, h);
    }

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
