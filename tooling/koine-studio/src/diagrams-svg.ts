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
import { centerOn, clampScale, fit, panBy, zoomAt, zoomPercent, type Size, type ViewBox } from './canvasView';
import { loadDiagramZoom, saveDiagramZoom } from './store';
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
 * The handle `mountInteractiveCanvas` returns so a later layer (the minimap, Task 3) can read the live
 * window and command the canvas without re-deriving any of the pan/zoom plumbing.
 */
export interface CanvasController {
  /** The full content bounds (the diagram's natural viewBox) — what "fit to screen" frames. */
  readonly contentBounds: ViewBox;
  /** The current visible window in content coordinates. */
  view(): ViewBox;
  /** The canvas viewport size in pixels (falls back to the content size when not yet laid out). */
  viewport(): Size;
  /** Replace the window (clamped) and repaint the canvas + any registered observers. */
  setView(next: ViewBox): void;
  /** Frame the whole diagram with padding, centered. */
  fitToScreen(): void;
  /** Register a callback fired after every view change (the minimap subscribes to keep its rect in sync). */
  onChange(fn: (view: ViewBox) => void): void;
}

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
function mountInteractiveCanvas(surface: HTMLElement, svg: SVGSVGElement, persistKey?: string): CanvasController {
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

  /** Viewport in pixels; falls back to the content size while detached/pre-layout (tests, first paint). */
  function viewport(): Size {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w > 0 && h > 0) return { w, h };
    return { w: contentBounds.w, h: contentBounds.h };
  }

  let view: ViewBox = fit(contentBounds, viewport(), CANVAS_FIT_PADDING);
  // Until the user zooms/pans, a resize re-fits; after, a resize only re-aspects (keeps their zoom).
  let userAdjusted = false;
  // A persisted zoom can only be honoured once the canvas has a real pixel size (zoom % is relative to
  // it), so it waits for the first ResizeObserver measurement rather than the (sizeless) mount.
  const pendingRestorePct = persistKey ? loadDiagramZoom(persistKey) : null;
  let initialized = false;

  function paint(): void {
    svg.setAttribute('viewBox', viewBoxAttr(view));
    pct.textContent = `${zoomPercent(view, viewport())}%`;
    for (const fn of listeners) fn(view);
  }

  /** Remember this diagram's current zoom % (best-effort) so a tab re-open restores it. */
  function persist(): void {
    if (persistKey) saveDiagramZoom(persistKey, zoomPercent(view, viewport()));
  }

  function setView(next: ViewBox): void {
    view = next;
    userAdjusted = true;
    paint();
  }

  function fitToScreen(): void {
    view = fit(contentBounds, viewport(), CANVAS_FIT_PADDING);
    userAdjusted = false;
    paint();
    persist();
  }

  /** Map a client (pixel) point to content coordinates within the current window. */
  function toContent(clientX: number, clientY: number): { x: number; y: number } {
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return { x: view.x + view.w / 2, y: view.y + view.h / 2 };
    }
    return {
      x: view.x + ((clientX - rect.left) / rect.width) * view.w,
      y: view.y + ((clientY - rect.top) / rect.height) * view.h,
    };
  }

  /** Zoom by `factor` around a content anchor, clamped to the scale bounds. */
  function zoomBy(factor: number, anchorX: number, anchorY: number): void {
    const f = clampScale(view, viewport(), factor, MIN_CANVAS_SCALE, MAX_CANVAS_SCALE);
    setView(zoomAt(view, f, anchorX, anchorY));
  }

  /** A button zooms about the window's center (no cursor to anchor on). */
  function zoomAboutCenter(factor: number): void {
    zoomBy(factor, view.x + view.w / 2, view.y + view.h / 2);
  }

  /** Restore a saved zoom % by zooming about the current center to reach that scale (clamped). */
  function applyZoomPercent(percent: number): void {
    const vp = viewport();
    if (vp.w <= 0 || percent <= 0) return;
    const currentScale = vp.w / view.w;
    const targetScale = percent / 100;
    zoomBy(targetScale / currentScale, view.x + view.w / 2, view.y + view.h / 2);
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

  // Wheel (and trackpad pinch, which arrives as ctrl+wheel) zoom, anchored at the cursor.
  canvas.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      e.preventDefault();
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
      const rect = svg.getBoundingClientRect();
      const sx = rect.width > 0 ? view.w / rect.width : 0;
      const sy = rect.height > 0 ? view.h / rect.height : 0;
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

  // Re-fit while the canvas is auto (e.g. it first gets a real size after mount); once the user has taken
  // over, keep their zoom but re-aspect so the picture never distorts when the panel is resized. The very
  // first real measurement also honours a persisted zoom (which needs the true pixel size to be exact).
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      const vp = viewport();
      if (vp.w <= 0 || vp.h <= 0) return;
      if (!initialized) {
        initialized = true;
        view = fit(contentBounds, vp, CANVAS_FIT_PADDING);
        paint();
        if (pendingRestorePct != null) applyZoomPercent(pendingRestorePct);
        return;
      }
      view = userAdjusted ? reframeToAspect(view, vp) : fit(contentBounds, vp, CANVAS_FIT_PADDING);
      paint();
    });
    ro.observe(canvas);
  }

  paint();

  return {
    contentBounds,
    view: () => view,
    viewport,
    setView,
    fitToScreen,
    onChange: (fn) => {
      listeners.push(fn);
    },
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

  /** Mirror the main window onto the thumbnail rectangle (in content coordinates). */
  function paintWindow(view: ViewBox): void {
    windowRect.setAttribute('x', String(view.x));
    windowRect.setAttribute('y', String(view.y));
    windowRect.setAttribute('width', String(Math.max(0, view.w)));
    windowRect.setAttribute('height', String(Math.max(0, view.h)));
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
              // Layer the interactive canvas (pan/zoom/fit + minimap) over the drawn SVG. Pure geometry
              // lives in canvasView.ts; the elkjs layout and node click-to-source stay untouched. The
              // page/caption pair keys this diagram's persisted zoom so a tab re-open restores it.
              mountInteractiveCanvas(surface, svg, `${page.title} / ${diagram.caption}`);
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
