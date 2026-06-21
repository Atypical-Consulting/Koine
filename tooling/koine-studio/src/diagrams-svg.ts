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
import { mergeGraphsForView } from './modelTables';
import { centerOn, clampScale, fit, panBy, viewAtScale, zoomAt, zoomPercent, type Size, type ViewBox } from './canvasView';
import { loadDiagramZoom, saveDiagramZoom } from './store';
import type { DiagramGraph, DiagramMember, DiagramNode, SourceSpan } from './lsp';
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

// Interactive canvas tuning (issue #145). The viewBox math lives in canvasView.ts; these are the
// renderer-side knobs: how much margin a fit leaves, how hard the buttons/wheel zoom, and the scale
// floor/ceiling so the picture can never invert or vanish.
const CANVAS_FIT_PADDING = 24; // content-units of margin around the diagram when fitting
const DEFAULT_CANVAS_SCALE = 1; // a freshly opened diagram starts at 100% (one content unit per pixel)
const ZOOM_BUTTON_STEP = 1.2; // the +/- buttons multiply the zoom by this
const WHEEL_ZOOM_BASE = 1.0016; // per-unit wheel delta → zoom factor (pow(base, -deltaY))
const MIN_CANVAS_SCALE = 0.1; // never shrink below 10% (content unit : screen pixel)
const MAX_CANVAS_SCALE = 8; // never magnify past 800%
const MINIMAP_MAX_W = 180; // the minimap thumbnail is sized to fit within this box, keeping content aspect
const MINIMAP_MAX_H = 140;

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

/** The bounded context of a `Context.Name` qualified name (prefix before the first dot), or '' if none. */
function contextOf(qualifiedName: string): string {
  const dot = qualifiedName.indexOf('.');
  return dot < 0 ? '' : qualifiedName.slice(0, dot);
}

/**
 * Lay out one structured graph with ELK and draw it into a fresh `<svg>`. Throws on layout failure so the
 * caller can surface an error. Nodes are grouped by bounded context: each context becomes a big
 * container holding its elements (a compound ELK layout), context-less nodes (e.g. state-machine states)
 * lay out at the root, composition edges carry a derived cardinality, and the whole hierarchy is drawn
 * recursively (context boxes behind, then edges, then nodes).
 */
async function drawGraph(graph: DiagramGraph, Elk: ElkConstructor): Promise<SVGSVGElement> {
  const byId = new Map<string, DiagramNode>(graph.nodes.map((n) => [n.id, n]));

  // Edge labels: keep an explicit label (a state-machine guard, a relation kind); otherwise show the
  // composition cardinality the COMPILER derived from the Koine field type (DiagramEdge.cardinality).
  const layoutEdges: ElkExtendedEdge[] = graph.edges.map((e, i) => {
    const text = e.label ?? e.cardinality ?? null;
    return {
      id: `e${i}`,
      sources: [e.from],
      targets: [e.to],
      labels: text ? [{ text, width: text.length * 6.2, height: EDGE_LABEL_HEIGHT }] : undefined,
    };
  });

  // Group nodes by bounded context → one container per context (a compound layout). Context-less nodes
  // lay out directly under the root.
  const CONTEXT_HEADER = 34;
  const CONTEXT_PAD = 16;
  const groups = new Map<string, DiagramNode[]>();
  for (const n of graph.nodes) {
    const ctx = contextOf(n.qualifiedName);
    const arr = groups.get(ctx);
    if (arr) arr.push(n);
    else groups.set(ctx, [n]);
  }
  const rootChildren: ElkNode[] = [];
  for (const [ctx, nodes] of groups) {
    const kids: ElkNode[] = nodes.map((n) => {
      const { width, height } = nodeSize(n);
      return { id: n.id, width, height };
    });
    if (ctx === '') {
      rootChildren.push(...kids);
    } else {
      rootChildren.push({
        id: `ctx:${ctx}`,
        layoutOptions: {
          'elk.padding': `[top=${CONTEXT_HEADER},left=${CONTEXT_PAD},bottom=${CONTEXT_PAD},right=${CONTEXT_PAD}]`,
          'elk.spacing.nodeNode': '26',
          'elk.layered.spacing.nodeNodeBetweenLayers': '52',
        },
        children: kids,
      });
    }
  }

  const layoutGraph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.spacing.nodeNode': '44',
      'elk.layered.spacing.nodeNodeBetweenLayers': '60',
      'elk.spacing.edgeNode': '20',
      'elk.padding': `[top=${SVG_PADDING},left=${SVG_PADDING},bottom=${SVG_PADDING},right=${SVG_PADDING}]`,
    },
    children: rootChildren,
    edges: layoutEdges,
  };

  const elk = new Elk();
  const laid = await elk.layout(layoutGraph);

  const width = Math.max(1, Math.ceil(laid.width ?? 0));
  const height = Math.max(1, Math.ceil(laid.height ?? 0));

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

  // Three layers: context boxes (behind) · edges · nodes (in front).
  const contextLayer = svgEl('g');
  contextLayer.setAttribute('class', 'koi-svg-contexts');
  const edgeLayer = svgEl('g');
  edgeLayer.setAttribute('class', 'koi-svg-edges');
  const nodeLayer = svgEl('g');
  nodeLayer.setAttribute('class', 'koi-svg-nodes');

  // Walk the laid hierarchy, accumulating absolute offsets (a child's coords are parent-relative, and a
  // container's edges sit in the container's own coordinate space).
  const drawLevel = (parent: ElkNode, ox: number, oy: number): void => {
    for (const e of parent.edges ?? []) {
      const section = e.sections?.[0];
      if (!section) continue;
      const pts = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((p) => ({
        x: p.x + ox,
        y: p.y + oy,
      }));
      const g = svgEl('g');
      g.setAttribute('class', 'koi-svg-edge');
      const path = svgEl('path');
      path.setAttribute('class', 'koi-svg-edge-line');
      path.setAttribute('d', polylinePath(pts));
      path.setAttribute('marker-end', 'url(#koi-svg-arrow)');
      g.appendChild(path);
      const label = e.labels?.[0];
      if (label?.text != null && label.x != null && label.y != null) {
        const t = svgEl('text');
        t.setAttribute('class', 'koi-svg-edge-label');
        t.setAttribute('x', String(label.x + ox));
        t.setAttribute('y', String(label.y + oy + EDGE_LABEL_HEIGHT * 0.5));
        t.textContent = label.text;
        g.appendChild(t);
      }
      edgeLayer.appendChild(g);
    }

    for (const child of parent.children ?? []) {
      const ax = ox + (child.x ?? 0);
      const ay = oy + (child.y ?? 0);
      if (child.id.startsWith('ctx:')) {
        const cg = svgEl('g');
        cg.setAttribute('class', 'koi-svg-context');
        cg.setAttribute('transform', `translate(${ax}, ${ay})`);
        const rect = svgEl('rect');
        rect.setAttribute('class', 'koi-svg-context-box');
        rect.setAttribute('width', String(child.width ?? 0));
        rect.setAttribute('height', String(child.height ?? 0));
        rect.setAttribute('rx', '12');
        cg.appendChild(rect);
        const label = svgEl('text');
        label.setAttribute('class', 'koi-svg-context-label');
        label.setAttribute('x', String(CONTEXT_PAD));
        label.setAttribute('y', '22');
        label.textContent = child.id.slice('ctx:'.length);
        cg.appendChild(label);
        contextLayer.appendChild(cg);
        drawLevel(child, ax, ay);
      } else {
        const node = byId.get(child.id);
        if (!node) continue;
        const w = child.width ?? MIN_NODE_WIDTH;
        const h = child.height ?? NODE_HEIGHT;
        const g = svgEl('g');
        g.setAttribute('class', 'koi-svg-node');
        g.setAttribute('transform', `translate(${ax}, ${ay})`);
        tagNode(g, node);
        if (isClassNode(node)) drawClassBox(g, node, w, h);
        else drawSimpleBox(g, node, w, h);
        nodeLayer.appendChild(g);
      }
    }
  };
  drawLevel(laid, 0, 0);

  svg.appendChild(contextLayer);
  svg.appendChild(edgeLayer);
  svg.appendChild(nodeLayer);

  return svg;
}

/** Shift an ELK polyline (root-relative) by the SVG padding offset. */
/**
 * Tear an interactive canvas down: disconnect its ResizeObserver and drop its listeners so a detached
 * canvas (and the minimap closure it retains) can be garbage-collected on the next render. The renderer
 * calls this on every prior canvas before rebuilding, so observers don't pile up across tab switches.
 */
type CanvasDispose = () => void;

/** Read a `<svg>`'s `viewBox` as a {@link ViewBox}; falls back to its width/height, then to a unit box. */
function readViewBox(svg: SVGSVGElement): ViewBox {
  const raw = svg.getAttribute('viewBox');
  if (raw) {
    const [x, y, w, h] = raw.split(/[\s,]+/).map(Number);
    if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) return { x, y, w, h };
  }
  const w = Number(svg.getAttribute('width'));
  const h = Number(svg.getAttribute('height'));
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { x: 0, y: 0, w, h };
  return { x: 0, y: 0, w: 1, h: 1 };
}

/** Serialize a {@link ViewBox} for the `viewBox` attribute. */
function viewBoxAttr(vb: ViewBox): string {
  return `${vb.x} ${vb.y} ${vb.w} ${vb.h}`;
}

/** A control-bar button: an icon glyph plus an accessible label (WCAG: every control is named). */
function controlButton(glyph: string, label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'koi-canvas-btn';
  b.textContent = glyph;
  b.setAttribute('aria-label', label);
  b.title = label;
  return b;
}

/**
 * Reframe a window to a new viewport aspect ratio, preserving the current zoom (its width) and center.
 * Used on resize once the user has taken manual control: we keep their zoom but stop the picture from
 * distorting when the panel changes shape. (Before any manual interaction we simply re-fit instead.)
 */
function reframeToAspect(view: ViewBox, vp: Size): ViewBox {
  const aspect = vp.w > 0 && vp.h > 0 ? vp.w / vp.h : view.w / view.h;
  const cx = view.x + view.w / 2;
  const cy = view.y + view.h / 2;
  const w = view.w;
  const h = w / aspect;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/**
 * Turn a freshly drawn diagram `<svg>` into an interactive canvas (issue #145): a fixed-size viewport
 * with a mutable `viewBox`, a zoom control bar (− / % / + / fit), wheel + pinch zoom anchored at the
 * cursor, and drag-to-pan on empty space. The layout (elkjs) and the per-node click-to-source navigation
 * are untouched — a pan never starts on a `.koi-svg-node`, so node clicks still reach their handler.
 *
 * Geometry is pure (canvasView.ts); this function is the DOM/pointer shell around it. `persistKey`, when
 * given, round-trips this diagram's last zoom through the store so reopening the tab restores it.
 */
function mountInteractiveCanvas(surface: HTMLElement, svg: SVGSVGElement, persistKey?: string): CanvasDispose {
  const contentBounds = readViewBox(svg);

  // The svg now fills its canvas; the viewBox we mutate decides what's shown. Matching the viewBox aspect
  // to the viewport (fit/reframe/zoomAt all preserve it) means 'meet' never letterboxes, so the cursor →
  // content mapping below stays a simple linear transform.
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const canvas = document.createElement('div');
  canvas.className = 'koi-canvas';

  const controls = document.createElement('div');
  controls.className = 'koi-canvas-controls';
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Diagram zoom controls');
  const zoomOut = controlButton('−', 'Zoom out'); // − (minus sign)
  const pct = document.createElement('span');
  pct.className = 'koi-canvas-zoom-pct';
  pct.setAttribute('aria-live', 'polite');
  const zoomIn = controlButton('+', 'Zoom in');
  const fitBtn = controlButton('⤢', 'Fit to screen'); // ⤢
  controls.append(zoomOut, pct, zoomIn, fitBtn);

  canvas.append(svg, controls);
  surface.appendChild(canvas);

  const listeners: ((view: ViewBox) => void)[] = [];

  // Cached layout metrics. `clientWidth`/`getBoundingClientRect` force a synchronous reflow, so we read
  // them once per resize (the ResizeObserver) and once at the start of each gesture — never per frame in
  // paint()/pan, which would thrash layout during a continuous pan or pinch.
  let vp: Size = { w: contentBounds.w, h: contentBounds.h };
  let svgRect = { left: 0, top: 0, width: 0, height: 0 };

  /** Re-measure the viewport + svg rect from the DOM. Falls back to the content size while detached. */
  function refreshMetrics(): void {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    vp = w > 0 && h > 0 ? { w, h } : { w: contentBounds.w, h: contentBounds.h };
    const r = svg.getBoundingClientRect();
    svgRect = { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  refreshMetrics();
  let view: ViewBox = viewAtScale(contentBounds, vp, DEFAULT_CANVAS_SCALE);
  // How a resize re-derives the view while the user hasn't manually zoomed/panned:
  //   'default' → keep the 100% default, re-centered; 'fit' → keep the diagram fitted to the panel.
  // Once the user zooms/pans (setView), the mode goes null and a resize only re-aspects (keeps their zoom).
  let autoMode: 'default' | 'fit' | null = 'default';
  // A persisted zoom can only be honoured once the canvas has a real pixel size (zoom % is relative to
  // it), so it waits for the first ResizeObserver measurement rather than the (sizeless) mount.
  const pendingRestorePct = persistKey ? loadDiagramZoom(persistKey) : null;
  let initialized = false;

  function paint(): void {
    svg.setAttribute('viewBox', viewBoxAttr(view));
    pct.textContent = `${zoomPercent(view, vp)}%`;
    for (const fn of listeners) fn(view);
  }

  /** Remember this diagram's current zoom % (best-effort) so a tab re-open restores it. */
  function persist(): void {
    if (persistKey) saveDiagramZoom(persistKey, zoomPercent(view, vp));
  }

  function setView(next: ViewBox): void {
    view = next;
    autoMode = null;
    paint();
  }

  function fitToScreen(): void {
    view = fit(contentBounds, vp, CANVAS_FIT_PADDING);
    autoMode = 'fit'; // a resize keeps tracking the fit until the user zooms/pans
    paint();
    persist();
  }

  /** Map a client (pixel) point to content coordinates within the current window (uses the cached rect). */
  function toContent(clientX: number, clientY: number): { x: number; y: number } {
    if (svgRect.width <= 0 || svgRect.height <= 0) {
      return { x: view.x + view.w / 2, y: view.y + view.h / 2 };
    }
    return {
      x: view.x + ((clientX - svgRect.left) / svgRect.width) * view.w,
      y: view.y + ((clientY - svgRect.top) / svgRect.height) * view.h,
    };
  }

  /** Zoom by `factor` around a content anchor, clamped to the scale bounds. */
  function zoomBy(factor: number, anchorX: number, anchorY: number): void {
    const f = clampScale(view, vp, factor, MIN_CANVAS_SCALE, MAX_CANVAS_SCALE);
    setView(zoomAt(view, f, anchorX, anchorY));
  }

  /** A button zooms about the window's center (no cursor to anchor on). */
  function zoomAboutCenter(factor: number): void {
    zoomBy(factor, view.x + view.w / 2, view.y + view.h / 2);
  }

  /** Restore a saved zoom % by zooming about the current center to reach that scale (clamped). */
  function applyZoomPercent(percent: number): void {
    if (vp.w <= 0 || percent <= 0) return;
    const currentScale = vp.w / view.w;
    zoomAboutCenter(percent / 100 / currentScale);
  }

  zoomIn.addEventListener('click', () => {
    zoomAboutCenter(ZOOM_BUTTON_STEP);
    persist();
  });
  zoomOut.addEventListener('click', () => {
    zoomAboutCenter(1 / ZOOM_BUTTON_STEP);
    persist();
  });
  fitBtn.addEventListener('click', () => fitToScreen());

  // Zoom on ctrl/⌘+wheel (and trackpad pinch, which the browser delivers as a ctrl+wheel), anchored at
  // the cursor. A PLAIN wheel is left alone so it scrolls the surrounding Diagrams list — a tall canvas
  // must not trap the page scroll. Wheels over the overlay chrome are ignored (the minimap owns its own).
  canvas.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      const target = e.target as Element | null;
      if (target?.closest('.koi-minimap') || target?.closest('.koi-canvas-controls')) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      refreshMetrics();
      const anchor = toContent(e.clientX, e.clientY);
      zoomBy(Math.pow(WHEEL_ZOOM_BASE, -e.deltaY), anchor.x, anchor.y);
      persist();
    },
    { passive: false },
  );

  // Pointer plumbing: 1 pointer on empty space = pan; 2 pointers = pinch zoom about their midpoint. A
  // pointer that lands on a node is ignored here so the node's own click-to-source handler still fires.
  const pointers = new Map<number, { x: number; y: number }>();
  let panLast: { x: number; y: number } | null = null;
  let pinchPrev = 0;

  function distance(): number {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  function midpoint(): { x: number; y: number } {
    const [a, b] = [...pointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    const target = e.target as Element | null;
    // Don't hijack a click on a navigable node (let it reach the navigate handler) or on the overlay
    // chrome — the control bar and the minimap own their own pointer behaviour.
    if (target?.closest('.koi-svg-node') || target?.closest('.koi-canvas-controls') || target?.closest('.koi-minimap')) {
      return;
    }
    refreshMetrics(); // freshen the cached rect/viewport once, for the whole gesture
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      panLast = { x: e.clientX, y: e.clientY };
      canvas.classList.add('koi-canvas--panning');
      try {
        canvas.setPointerCapture?.(e.pointerId);
      } catch {
        // setPointerCapture unsupported (older/headless DOM) — pan still works via document-level moves.
      }
    } else if (pointers.size === 2) {
      panLast = null; // a second finger ends the pan and begins a pinch
      pinchPrev = distance();
    }
  });

  canvas.addEventListener('pointermove', (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size >= 2) {
      const dist = distance();
      if (pinchPrev > 0 && dist > 0) {
        const mid = midpoint();
        const anchor = toContent(mid.x, mid.y);
        zoomBy(dist / pinchPrev, anchor.x, anchor.y);
      }
      pinchPrev = dist;
      return;
    }

    if (panLast) {
      const sx = svgRect.width > 0 ? view.w / svgRect.width : 0;
      const sy = svgRect.height > 0 ? view.h / svgRect.height : 0;
      // Drag the content with the cursor: the window moves opposite the drag.
      setView(panBy(view, -(e.clientX - panLast.x) * sx, -(e.clientY - panLast.y) * sy));
      panLast = { x: e.clientX, y: e.clientY };
    }
  });

  function endPointer(e: PointerEvent): void {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size < 2) pinchPrev = 0;
    if (pointers.size === 1) {
      const [p] = [...pointers.values()];
      panLast = { x: p.x, y: p.y }; // lifting one finger of a pinch resumes a pan with the other
    }
    if (pointers.size === 0) {
      panLast = null;
      canvas.classList.remove('koi-canvas--panning');
      persist(); // a pinch settles here; pan doesn't change zoom, so this is a no-op write after a drag
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  // The minimap thumbnail (Task 3) lives in the same canvas; it reads the live window and recenters it.
  buildMinimap(canvas, svg, contentBounds, () => view, (next) => setView(next), (fn) => listeners.push(fn));

  // Re-derive the view on resize per the auto mode (re-center at 100% by default, or re-fit if the user
  // hit "Fit to screen"); once they've zoomed/panned, keep their zoom but re-aspect so the picture never
  // distorts. The very first real measurement also honours a persisted zoom (which needs the true pixel
  // size to be exact) — it starts from the 100% default, then applies the saved percent on top.
  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      refreshMetrics();
      if (vp.w <= 0 || vp.h <= 0) return;
      if (!initialized) {
        initialized = true;
        view = viewAtScale(contentBounds, vp, DEFAULT_CANVAS_SCALE);
        paint();
        if (pendingRestorePct != null) applyZoomPercent(pendingRestorePct);
        return;
      }
      view =
        autoMode === 'default'
          ? viewAtScale(contentBounds, vp, DEFAULT_CANVAS_SCALE)
          : autoMode === 'fit'
            ? fit(contentBounds, vp, CANVAS_FIT_PADDING)
            : reframeToAspect(view, vp);
      paint();
    });
    ro.observe(canvas);
  }

  paint();

  // Teardown: disconnect the observer and drop the listeners so a re-render's detached canvas (and the
  // minimap closure it holds) is collectable. The canvas's own event listeners die with the element.
  return () => {
    ro?.disconnect();
    listeners.length = 0;
  };
}

/**
 * Build the minimap overlay (issue #145, Task 3): a scaled-down thumbnail of the *same* laid-out graph
 * with a window rectangle that tracks the main canvas's `viewBox`, and click/drag-to-recenter. It reuses
 * the controller's view (read via `getView`, command via `setView`, subscribe via `onChange`) so there's
 * one source of truth — the thumbnail can never drift from the main canvas.
 */
function buildMinimap(
  canvas: HTMLElement,
  svg: SVGSVGElement,
  contentBounds: ViewBox,
  getView: () => ViewBox,
  setView: (v: ViewBox) => void,
  onChange: (fn: (view: ViewBox) => void) => void,
): void {
  // Size the thumbnail to fit within the max box while keeping the diagram's aspect ratio (so the svg
  // element aspect == its viewBox aspect → 'meet' never letterboxes → the click→content map is linear).
  const aspect = contentBounds.h > 0 ? contentBounds.w / contentBounds.h : 1;
  let mw = MINIMAP_MAX_W;
  let mh = MINIMAP_MAX_W / aspect;
  if (mh > MINIMAP_MAX_H) {
    mh = MINIMAP_MAX_H;
    mw = MINIMAP_MAX_H * aspect;
  }

  const mini = document.createElement('div');
  mini.className = 'koi-minimap';
  mini.setAttribute('aria-hidden', 'true'); // a decorative overview; the control bar is the keyboard path

  const miniSvg = svgEl('svg');
  miniSvg.setAttribute('class', 'koi-minimap-svg');
  miniSvg.setAttribute('viewBox', viewBoxAttr(contentBounds));
  miniSvg.setAttribute('width', String(Math.round(mw)));
  miniSvg.setAttribute('height', String(Math.round(mh)));
  miniSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // Reuse the laid-out content at thumbnail size: clone the edge + node layers (NOT <defs>, so there are
  // no duplicate element ids). The clones are inert — cloneNode drops listeners and CSS makes the whole
  // thumbnail click-through — so only the minimap's own recenter gesture drives it.
  const content = svgEl('g');
  content.setAttribute('class', 'koi-minimap-content');
  for (const sel of ['.koi-svg-edges', '.koi-svg-nodes']) {
    const layer = svg.querySelector(sel);
    if (layer) content.appendChild(layer.cloneNode(true));
  }
  // The clones keep their visual classes (so the thumbnail looks like the diagram) but shed their
  // *addressable* identity — no qname/span — so the minimap can never be mistaken for a real, navigable
  // node by selection-highlight or jump-to-source queries (which scope to `.koi-svg-diagram` anyway).
  for (const node of content.querySelectorAll('.koi-svg-node')) {
    for (const attr of ['data-qname', 'data-file', 'data-line', 'data-column', 'data-end-line', 'data-end-column']) {
      node.removeAttribute(attr);
    }
  }
  miniSvg.appendChild(content);

  const windowRect = svgEl('rect');
  windowRect.setAttribute('class', 'koi-minimap-window');
  miniSvg.appendChild(windowRect);

  mini.appendChild(miniSvg);
  canvas.appendChild(mini);

  /**
   * Mirror the main window onto the thumbnail rectangle (in content coordinates), CLAMPED to the content
   * bounds. The fitted view is grown beyond the content (padding + aspect slack), so drawing it raw would
   * push the rect outside the minimap's viewBox and clip its border; clamping to the visible intersection
   * keeps a crisp frame at every zoom — full thumbnail when fit, a sub-region when zoomed/panned in.
   */
  function paintWindow(view: ViewBox): void {
    const x1 = Math.max(view.x, contentBounds.x);
    const y1 = Math.max(view.y, contentBounds.y);
    const x2 = Math.min(view.x + view.w, contentBounds.x + contentBounds.w);
    const y2 = Math.min(view.y + view.h, contentBounds.y + contentBounds.h);
    windowRect.setAttribute('x', String(x1));
    windowRect.setAttribute('y', String(y1));
    windowRect.setAttribute('width', String(Math.max(0, x2 - x1)));
    windowRect.setAttribute('height', String(Math.max(0, y2 - y1)));
  }
  onChange(paintWindow);
  paintWindow(getView());

  // Click / drag inside the thumbnail recenters the main canvas on that content point (zoom unchanged).
  let dragging = false;
  function recenterFrom(clientX: number, clientY: number): void {
    const rect = miniSvg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const cx = contentBounds.x + ((clientX - rect.left) / rect.width) * contentBounds.w;
    const cy = contentBounds.y + ((clientY - rect.top) / rect.height) * contentBounds.h;
    setView(centerOn(getView(), cx, cy));
  }
  mini.addEventListener('pointerdown', (e: PointerEvent) => {
    e.stopPropagation(); // the canvas must not treat a minimap drag as a pan
    dragging = true;
    try {
      mini.setPointerCapture?.(e.pointerId);
    } catch {
      // setPointerCapture unsupported (older/headless DOM) — recenter still works on subsequent moves.
    }
    recenterFrom(e.clientX, e.clientY);
  });
  mini.addEventListener('pointermove', (e: PointerEvent) => {
    if (dragging) recenterFrom(e.clientX, e.clientY);
  });
  function endDrag(): void {
    dragging = false;
  }
  mini.addEventListener('pointerup', endDrag);
  mini.addEventListener('pointercancel', endDrag);
}

/**
 * The SVG renderer: draws each diagram's structured graph as addressable SVG. A diagram whose graph is
 * empty, or whose layout throws, falls back to the Mermaid renderer for *that diagram only* so one bad
 * graph never blanks the tab. The empty-state note and the isCurrent() superseded-render guard match the
 * Mermaid renderer's behaviour exactly.
 */
export function createSvgRenderer(): DiagramRenderer {
  // Disposers for the canvases currently committed to the DOM. The renderer is cached across renders
  // (diagrams.ts), so these survive between calls; we tear them down when this render replaces them.
  let activeDisposers: CanvasDispose[] = [];

  return {
    // `theme` is part of the renderer seam but unused here — the SVG nodes are themed entirely via CSS
    // custom properties, so a theme flip restyles the live DOM without a re-render.
    async render(container, files, _theme, isCurrent = () => true): Promise<void> {
      // Disposers for the canvases built in THIS render (committed only if we're still current).
      const disposers: CanvasDispose[] = [];

      // ONE big diagram: fuse every structured graph across the (already context-scoped) files into a
      // single deduped graph, so the visual editor shows the whole domain on one canvas instead of many
      // small per-aggregate figures. The strategic context map lives in its own bottom tab, so it's
      // excluded here to keep this canvas a pure domain model.
      const renderable = files.flatMap((f) => f.diagrams ?? []).filter((d) => d.kind !== 'contextmap');
      const graphs = renderable
        .map((d) => d.graph)
        .filter((g): g is DiagramGraph => !!g && g.nodes.length > 0);

      if (!graphs.length) {
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
      root.className = 'koi-diagrams koi-diagrams-single';

      const surface = document.createElement('div');
      surface.className = 'koi-diagram-surface';
      root.appendChild(surface);

      const merged = mergeGraphsForView(graphs);
      try {
        const svg = await drawGraph(merged, Elk);
        // Layer the interactive canvas (pan/zoom/fit + minimap) over the drawn SVG. Pure geometry lives
        // in canvasView.ts; the elkjs layout and node click-to-source stay untouched.
        disposers.push(mountInteractiveCanvas(surface, svg, 'koi-domain-diagram'));
      } catch (e) {
        surface.innerHTML = `<p class="doc-error">Could not lay out the diagram: ${escapeHtml(String(e))}</p>`;
      }

      // A newer render may have started while we awaited ELK/Mermaid (theme flip / edit / refresh) — drop
      // this superseded result rather than letting it win the last DOM write with a stale model/theme.
      if (isCurrent()) {
        // Commit: tear down the canvases this render replaces, then adopt ours as the live set.
        for (const dispose of activeDisposers) dispose();
        activeDisposers = disposers;
        container.replaceChildren(root);
      } else {
        // Superseded: our canvases never reach the page — dispose them so their observers don't leak,
        // and leave the still-displayed render's disposers (activeDisposers) untouched.
        for (const dispose of disposers) dispose();
      }
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
