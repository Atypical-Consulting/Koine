// maxGraph-backed domain diagram renderer (replaces the hand-rolled SVG renderer). It consumes the SAME
// structured `{ nodes, edges }` graph the compiler emits (DocsFile.diagrams[].graph), fuses every diagram
// into one deduped domain canvas, and draws it with @maxgraph/core. The renderer↔IDE contract (events,
// editing/persist state) lives in `diagramContract.ts`, so this is a drop-in behind the `DiagramRenderer`
// seam (`diagrams.ts`).
//
// This file is built incrementally; the current slice is the read-only skeleton: select + merge graphs,
// one vertex per node, the empty state, and the superseded-render guard. Styling, bounded-context
// containers, layout, edges, interaction, and persistence land in later tasks.
import type { DiagramRenderer } from '@/diagrams/diagrams';
import type { Graph as MxGraph, Cell as MxCell } from '@maxgraph/core';
import type { DiagramEdge, DiagramGraph, DiagramMember, DiagramNode, DocsFile } from '@/lsp/lsp';
import { mergeGraphsForView } from '@/model/modelTables';
import { buildEmptyState } from '@/diagrams/emptyState';
import { loadDiagramZoom, saveDiagramZoom } from '@/settings/persistence';
import {
  DIAGRAM_CONNECT_EVENT,
  DIAGRAM_DISCONNECT_EVENT,
  DIAGRAM_RELAYOUT_EVENT,
  NODE_EDIT_EVENT,
  NODE_NAVIGATE_EVENT,
  diagramLayoutStore,
  isDiagramEditing,
  isEditableKind,
  setDiagramEditing,
  type DiagramConnectDetail,
  type DiagramDisconnectDetail,
  type DiagramLayoutStore,
  type DiagramNodeEditDetail,
  type DiagramNodeNavigateDetail,
  type DiagramPosition,
} from '@/diagrams/diagramContract';
import { createBrowserLayoutStore } from '@/diagrams/layoutStore';
import { koiConfirm, koiPrompt } from '@/shared/overlay';

// The DDD palette as literal hex (theme-independent — abstracts/_ddd.scss never redefines it per theme),
// used for the maxGraph cell SHAPE fill/stroke. The shape is what the Outline minimap draws and what
// receives pointer events; the HTML label (.koi-node, pointer-events:none) sits opaque on top in the main
// view. Keeping these literal avoids relying on var() resolving inside SVG fill attributes.
const DDD_HEX: Record<string, string> = {
  'aggregate-root': '#8b87f5',
  aggregate: '#8b87f5',
  entity: '#34d399',
  'value-object': '#5aa9f0',
  value: '#5aa9f0',
  enum: '#fbbf24',
  event: '#f472b6',
  'integration-event': '#2dd4bf',
  service: '#fb923c',
  repository: '#94a3b8',
  state: '#94a3b8',
  initial: '#94a3b8',
  final: '#94a3b8',
  context: '#5aa9f0',
};

/** The shape colour for a node kind (drives the minimap + hit-testing). Falls back to slate. */
function kindColor(kind: string): string {
  return DDD_HEX[kind] ?? '#94a3b8';
}

/** The @maxgraph/core module shape, loaded lazily (code-split out of the main bundle). */
type Mx = typeof import('@maxgraph/core');

let mxPromise: Promise<Mx> | null = null;

/** Boot @maxgraph/core once (cached); null the cache on failure so a later visit retries (mirrors elk). */
function getMaxGraph(): Promise<Mx> {
  if (!mxPromise) {
    mxPromise = import('@maxgraph/core');
    mxPromise.catch(() => {
      mxPromise = null;
    });
  }
  return mxPromise;
}

/** A node draws as a UML class box (compartments) iff it has a stereotype or any members; else a simple box. */
export function isClassNode(node: DiagramNode): boolean {
  return node.stereotype != null || (node.members?.length ?? 0) > 0;
}

/** The node kind for a bounded context (the strategic context-map graph). Styled as a prominent territory
 *  tile, distinct from the class/aggregate and value-object boxes. Mirrors {@link CONTEXT_NODE_KIND}. */
export function isContextNode(node: DiagramNode): boolean {
  return node.kind === 'context';
}

// --- node label HTML + sizing -------------------------------------------------
// Nodes render as HTML labels (the maxGraph cell shape is transparent), so the box — border, fill,
// compartments — is drawn by CSS keyed on `data-kind` (see _diagrams-maxgraph.scss). This keeps theming
// pure CSS (no reliance on var() resolving inside SVG fill attributes) and matches the DDD palette the
// SVG renderer used. Sizing mirrors the SVG renderer's geometry so the layout spacing reads the same and
// stays deterministic for headless tests (happy-dom can't measure HTML).
const CHAR_W = 8.2; // px per char at the 13px label font
const MEMBER_CHAR_W = 7; // px per char at the 12px member-row font
const NODE_PAD_X = 28;
const ROW_H = 18;
const HEADER_H = 44;
const COMPARTMENT_PAD = 6;
const CLASS_PAD_X = 16;
const MIN_W = 72;
const MIN_CLASS_W = 120;
const MAX_W = 280;
const SIMPLE_H = 40;
// A bounded context reads as a prominent territory tile — wider minimum and a taller box than a plain
// value/state chip — so the strategic context-map graph's nodes stand out as the headline boxes.
const CONTEXT_MIN_W = 120;
const CONTEXT_H = 56;

/** Split a class node's members into the attribute compartment (field/value/computed) and methods. */
function partitionMembers(node: DiagramNode): { fields: DiagramMember[]; methods: DiagramMember[] } {
  const fields = node.members.filter((m) => m.kind === 'field' || m.kind === 'value' || m.kind === 'computed');
  const methods = node.members.filter((m) => m.kind === 'method');
  return { fields, methods };
}

/** The pre-layout box size for a node, clamped to a sane width range (mirrors the SVG renderer). */
export function nodeSize(node: DiagramNode): [number, number] {
  if (isContextNode(node)) {
    const w = Math.max(CONTEXT_MIN_W, Math.min(MAX_W, Math.round(node.label.length * CHAR_W) + NODE_PAD_X));
    return [w, CONTEXT_H];
  }
  if (!isClassNode(node)) {
    const w = Math.max(MIN_W, Math.min(MAX_W, Math.round(node.label.length * CHAR_W) + NODE_PAD_X));
    return [w, SIMPLE_H];
  }
  const { fields, methods } = partitionMembers(node);
  const stereoW = node.stereotype ? `«${node.stereotype}»`.length * MEMBER_CHAR_W : 0;
  const titleW = node.label.length * CHAR_W;
  const rowW = node.members.reduce((m, r) => Math.max(m, r.text.length * MEMBER_CHAR_W), 0);
  const w = Math.max(MIN_CLASS_W, Math.min(MAX_W, Math.ceil(Math.max(titleW, stereoW, rowW) + CLASS_PAD_X * 2)));
  let h = HEADER_H + (fields.length > 0 ? fields.length * ROW_H + COMPARTMENT_PAD * 2 : COMPARTMENT_PAD);
  if (methods.length > 0) h += methods.length * ROW_H + COMPARTMENT_PAD * 2;
  return [w, Math.ceil(h)];
}

function memberRow(text: string, computed = false): string {
  return `<div class="koi-node__row${computed ? ' koi-node__row--computed' : ''}">${escapeHtml(text)}</div>`;
}

/** The HTML label for a node: a compartmented UML class box, or a single-line box, tagged with data-kind.
 *  Also carries `koi-svg-node` + `data-qname` so the inspector's selection cross-highlight
 *  (`inspectorController.applySelectionHighlight`, scoped to `.koi-svg-diagram .koi-svg-node[data-qname]`)
 *  keeps working unchanged after the SVG→maxGraph swap. */
export function nodeLabelHtml(node: DiagramNode): string {
  const kind = escapeHtml(node.kind);
  const qname = escapeHtml(node.qualifiedName);
  if (!isClassNode(node)) {
    return `<div class="koi-node koi-svg-node koi-node--simple" data-kind="${kind}" data-qname="${qname}">${escapeHtml(node.label)}</div>`;
  }
  const { fields, methods } = partitionMembers(node);
  const head =
    `<div class="koi-node__head">` +
    (node.stereotype ? `<div class="koi-node__stereo">«${escapeHtml(node.stereotype)}»</div>` : '') +
    `<div class="koi-node__title">${escapeHtml(node.label)}</div>` +
    `</div>`;
  const fieldComp = fields.length
    ? `<div class="koi-node__compartment">${fields.map((m) => memberRow(m.text, m.kind === 'computed')).join('')}</div>`
    : '';
  const methodComp = methods.length
    ? `<div class="koi-node__compartment">${methods.map((m) => memberRow(m.text)).join('')}</div>`
    : '';
  return `<div class="koi-node koi-svg-node koi-node--class" data-kind="${kind}" data-qname="${qname}">${head}${fieldComp}${methodComp}</div>`;
}

/**
 * Select the graphs that belong on the unified domain canvas: every diagram EXCEPT the strategic context
 * map (it has its own bottom tab), keeping only those that actually carry nodes.
 */
export function selectDomainGraphs(files: DocsFile[]): DiagramGraph[] {
  return files
    .flatMap((f) => f.diagrams ?? [])
    .filter((d) => d.kind !== 'contextmap')
    .map((d) => d.graph)
    .filter((g): g is DiagramGraph => !!g && g.nodes.length > 0);
}

/** A live canvas: the graph, a node-id→cell index (for edges + selection), the per-context container
 *  cells, and a teardown closure. */
export interface CanvasHandle {
  graph: MxGraph;
  cells: Map<string, MxCell>;
  containers: Map<string, MxCell>;
  dispose(): void;
}

/** The bounded context of a `Context.Name` qualified name (everything before the first dot); '' if none. */
export function contextOf(qualifiedName: string): string {
  const dot = qualifiedName.indexOf('.');
  return dot < 0 ? '' : qualifiedName.slice(0, dot);
}

// --- editing + position persistence helpers -----------------------------------
// The IDE injects a DiagramLayoutStore (a committable koine.layout.json, or browser storage) before each
// render; when none is set (tests, first boot) we fall back to a browser store so a drag still persists.
let fallbackLayoutStore: DiagramLayoutStore | null = null;
function activeLayoutStore(): DiagramLayoutStore {
  return diagramLayoutStore() ?? (fallbackLayoutStore ??= createBrowserLayoutStore());
}

/** A class-type, context-owned node carrying a source span can be renamed via the diagram (dbl-click). */
function canRename(node: DiagramNode): boolean {
  return node.qualifiedName.includes('.') && isEditableKind(node.kind) && node.sourceSpan != null;
}

/** Any context-owned, non-context node can be deleted via the diagram (right-click). */
function canDelete(node: DiagramNode): boolean {
  return node.qualifiedName.includes('.') && node.kind !== 'context';
}

/** A cell carries a DiagramNode (vs a DiagramEdge / a container string) iff its value has a qualifiedName. */
function nodeValue(cell: MxCell | null | undefined): DiagramNode | null {
  const v = cell?.value as DiagramNode | undefined;
  return v && typeof v === 'object' && 'qualifiedName' in v ? v : null;
}

/** Snapshot every node cell's geometry, keyed by qualified name — the shape the layout store persists. */
function snapshotPositions(cells: Map<string, MxCell>): Record<string, DiagramPosition> {
  const out: Record<string, DiagramPosition> = {};
  for (const cell of cells.values()) {
    const v = nodeValue(cell);
    const g = cell.getGeometry();
    if (v && g) out[v.qualifiedName] = { x: g.x, y: g.y };
  }
  return out;
}

/** Override laid-out node geometries with the saved positions (by qualified name), keeping each box's size. */
function applySavedPositions(graph: MxGraph, cells: Map<string, MxCell>, saved: Record<string, DiagramPosition>): void {
  if (!Object.keys(saved).length) return;
  const model = graph.getDataModel();
  graph.batchUpdate(() => {
    for (const cell of cells.values()) {
      const v = nodeValue(cell);
      const g = cell.getGeometry();
      if (!v || !g) continue;
      const pos = saved[v.qualifiedName];
      if (!pos) continue;
      const next = g.clone();
      next.x = pos.x;
      next.y = pos.y;
      model.setGeometry(cell, next);
    }
  });
}

/**
 * Lay out the domain canvas in two levels — REPLACING elkjs. Each bounded-context container's members are
 * arranged left→right by an inner {@link HierarchicalLayout} that resizes the container to fit; then the
 * containers (and any context-less root nodes) are arranged by an outer layout. Runs inside one batch.
 * Wrapped so a headless/measure-less environment (vitest) can't blank the canvas on a layout hiccup —
 * the model (nodes, parenting) is the tested contract; pixel placement is verified in the running studio.
 */
function runTwoLevelLayout(mx: Mx, graph: MxGraph): void {
  const { HierarchicalLayout } = mx;
  const model = graph.getDataModel();
  const root = graph.getDefaultParent();
  try {
    graph.batchUpdate(() => {
      const count = root.getChildCount();
      // Inner: arrange each context container's members left→right and resize the box to wrap them.
      for (let i = 0; i < count; i++) {
        const child = root.getChildAt(i);
        if (child?.isVertex() && child.getChildCount() > 0) {
          const inner = new HierarchicalLayout(graph, 'east');
          inner.resizeParent = true;
          inner.parentBorder = 40; // clears the swimlane header (startSize 30) with breathing room
          inner.intraCellSpacing = 30;
          inner.interRankCellSpacing = 60;
          inner.execute(child);
        }
      }
      // Outer: lay the containers (and any context-less root nodes) out left→right in a row. Done MANUALLY
      // rather than with a HierarchicalLayout: there are no inter-container edges to rank on, and an
      // edgeless layout scatters the boxes and desyncs them from their (relative-positioned) children.
      let x = 0;
      const GAP = 64;
      for (let i = 0; i < count; i++) {
        const child = root.getChildAt(i);
        if (!child?.isVertex()) continue;
        const g = child.getGeometry();
        if (!g) continue;
        const next = g.clone();
        next.x = x;
        next.y = 0;
        model.setGeometry(child, next);
        x += next.width + GAP;
      }
    });
  } catch {
    // A layout failure (e.g. no measurable DOM under happy-dom) must not break the render; the nodes are
    // still present and addressable, just unarranged until the next relayout.
  }
}

/**
 * Place a small multiplicity label near one end of an edge — ON the connector, but clear of the
 * arrowhead/diamond AND clear of the node box. The relative x runs -1 (source) → +1 (target); ±0.78
 * sits ~11% in from the end (past the marker, which lives at the very tip), and an upward perpendicular
 * lift floats it just above the line (most edges enter a node horizontally). A pill-style background
 * keeps it legible where it crosses the line.
 */
function addEndLabel(mx: Mx, graph: MxGraph, edge: MxCell, text: string, at: -1 | 1): void {
  const lbl = graph.insertVertex({
    parent: edge,
    value: text,
    position: [at * 0.78, 0],
    size: [0, 0],
    relative: true,
    style: { fontColor: 'var(--koi-fg)', labelBackgroundColor: 'var(--koi-paper)', fontSize: 11, fontStyle: 1, resizable: false },
  });
  const geo = lbl.getGeometry();
  if (geo) {
    geo.offset = new mx.Point(0, -12); // lift clear of the line + the arrowhead at the tip
    graph.getDataModel().setGeometry(lbl, geo);
  }
}

/**
 * Build the maxGraph canvas for one merged domain graph into `container`. Kept free of the render
 * lifecycle so tests can drive it directly and assert on the model (`graph.getDataModel()`), per the
 * headless-testing discipline (happy-dom can't measure pixels). The maxGraph module is injected so this
 * stays synchronous and the dynamic import lives only in `render()`.
 */
export function buildCanvas(
  mx: Mx,
  container: HTMLElement,
  merged: DiagramGraph,
  savedPositions?: Record<string, DiagramPosition>,
): CanvasHandle {
  const { Graph } = mx;
  const editing = isDiagramEditing();
  const graph = new Graph(container);
  // CSP-safe: never fall through to the single `eval` path for unregistered style names (Tauri strict CSP).
  graph.getView().allowEval = false;
  graph.setHtmlLabels(true); // labels render as HTML so class nodes can use compartment markup.
  graph.setCellsEditable(false); // no in-place label editing (renames go through the model round-trip).
  graph.setCellsResizable(false); // node size is derived from content, not hand-resized.
  // Drag-to-reposition + drag-to-connect are authoring gestures, gated on editing so the read-only tab is
  // inert. ide.tsx flips editing on at boot (the model→.koi round-trip seam is reachable).
  graph.setCellsMovable(editing);
  if (editing) {
    graph.setConnectable(true); // hover a node → drag to another to draw a relationship (→ addField)
    graph.setAllowDanglingEdges(false); // a connection must land on a node; no edges to empty space
    const conn = graph.getPlugin('ConnectionHandler') as unknown as { setCreateTarget?: (v: boolean) => void } | undefined;
    conn?.setCreateTarget?.(false); // never auto-create a target node; only connect existing nodes
    // Drag feedback: maxGraph's default move preview is a dashed rectangle drawn in `previewColor`
    // (default 'black') and only kicks in past `maxLivePreview` (default 0) — so on the dark canvas a
    // drag showed NOTHING. Raise maxLivePreview so the REAL node (themed HTML label and all) moves live
    // under the cursor, and give the fallback dashed outline a visible accent stroke just in case.
    const selection = graph.getPlugin('SelectionHandler') as unknown as
      | { maxLivePreview?: number; previewColor?: string }
      | undefined;
    if (selection) {
      selection.maxLivePreview = 1024; // live-move the actual cell(s); our graphs are far smaller than this
      selection.previewColor = '#5aa9f0'; // visible accent (matches --koi-accent) for the dashed fallback
    }
  }
  // Render each cell's stored value: a DiagramNode → its UML/simple HTML label (a `.koi-node` div themed
  // by CSS); a DiagramEdge → its mid label text; anything else (container name, cardinality) → the string.
  graph.convertValueToString = (cell): string => {
    const v = cell.value as DiagramNode | DiagramEdge | string | null;
    if (v && typeof v === 'object') {
      if ('qualifiedName' in v) return nodeLabelHtml(v);
      if ('from' in v && 'to' in v) return v.label ?? '';
    }
    return String(v ?? '');
  };

  // Click a node → bubble NODE_NAVIGATE_EVENT; ide.tsx selects it (Properties panel) and jumps to source.
  // Not gated by editing — navigation works in read-only too. Span-less nodes are inert.
  graph.addListener(mx.InternalEvent.CLICK, (_sender: unknown, evt: { getProperty(name: string): unknown }) => {
    const v = nodeValue(evt.getProperty('cell') as MxCell | null);
    if (v && v.sourceSpan) {
      const s = v.sourceSpan;
      container.dispatchEvent(
        new CustomEvent<DiagramNodeNavigateDetail>(NODE_NAVIGATE_EVENT, {
          bubbles: true,
          detail: {
            qualifiedName: v.qualifiedName,
            file: s.file,
            line: s.line,
            column: s.column,
            endLine: s.endLine,
            endColumn: s.endColumn,
          },
        }),
      );
    }
  });

  // Double-click an editable node → rename it (prompt), round-tripped through the model→.koi rename (#91).
  // Gated on editing; only class-type, context-owned, spanned nodes (never a context / state) rename.
  graph.addListener(mx.InternalEvent.DOUBLE_CLICK, (_sender: unknown, evt: { getProperty(name: string): unknown }) => {
    if (!isDiagramEditing()) return;
    const v = nodeValue(evt.getProperty('cell') as MxCell | null);
    if (!v || !canRename(v)) return;
    const current = v.label;
    const s = v.sourceSpan!; // canRename guarantees a span; line/column is the name position for LSP rename
    // Koine's own prompt (not window.prompt): the field carries the identifier, so it wears the mono face.
    void koiPrompt({
      title: 'Rename',
      message: 'Updates every reference in the .koi source.',
      label: 'New name',
      initialValue: current,
      mono: true,
      confirmLabel: 'Rename',
    }).then((next) => {
      if (!next || next === current) return;
      container.dispatchEvent(
        new CustomEvent<DiagramNodeEditDetail>(NODE_EDIT_EVENT, {
          bubbles: true,
          detail: { qualifiedName: v.qualifiedName, action: 'rename', newName: next, label: current, line: s.line, column: s.column },
        }),
      );
    });
  });

  // Right-click a node → delete it; right-click a field-backed edge → remove that field. Gated on editing.
  // A DOM contextmenu listener (capture phase, so it beats maxGraph's own handlers) hit-tests the cell.
  const onContextMenu = (evt: MouseEvent): void => {
    if (!isDiagramEditing()) return;
    const rect = container.getBoundingClientRect();
    const cell = graph.getCellAt(evt.clientX - rect.left, evt.clientY - rect.top);
    if (!cell) return;
    const node = nodeValue(cell);
    if (node) {
      if (!canDelete(node)) return;
      evt.preventDefault(); // suppress the native menu now, regardless of the async confirm's outcome
      void koiConfirm({
        title: `Delete ${node.label}?`,
        message: 'This rewrites the .koi source.',
        confirmLabel: 'Delete',
        danger: true,
      }).then((ok) => {
        if (!ok) return;
        container.dispatchEvent(
          new CustomEvent<DiagramNodeEditDetail>(NODE_EDIT_EVENT, {
            bubbles: true,
            detail: { qualifiedName: node.qualifiedName, action: 'delete', label: node.label },
          }),
        );
      });
      return;
    }
    const edge = cell.value as DiagramEdge | undefined;
    if (edge && typeof edge === 'object' && 'from' in edge && 'to' in edge && edge.backingMember) {
      const backing = edge.backingMember;
      evt.preventDefault();
      container.dispatchEvent(
        new CustomEvent<DiagramDisconnectDetail>(DIAGRAM_DISCONNECT_EVENT, {
          bubbles: true,
          detail: { backingMember: backing, label: backing.slice(backing.lastIndexOf('.') + 1) },
        }),
      );
    }
  };
  container.addEventListener('contextmenu', onContextMenu, { capture: true });

  // Drag from one node to another → bubble DIAGRAM_CONNECT_EVENT (ide.tsx turns it into an addField on the
  // source whose type is the target). The temporary edge maxGraph inserts is removed — the real edge comes
  // back via the .koi round-trip + re-render. Only meaningful while connectable (editing).
  const connHandler = graph.getPlugin('ConnectionHandler') as unknown as
    | { addListener?: (name: string, fn: (s: unknown, e: { getProperty(n: string): unknown }) => void) => void }
    | undefined;
  connHandler?.addListener?.(mx.InternalEvent.CONNECT, (_sender, evt) => {
    const edge = evt.getProperty('cell') as MxCell | null;
    const source = nodeValue(edge?.getTerminal(true));
    const target = nodeValue(edge?.getTerminal(false)) ?? nodeValue(evt.getProperty('terminal') as MxCell | null);
    if (edge) {
      try {
        graph.getDataModel().remove(edge);
      } catch {
        /* the temp edge is best-effort to remove; a stray one is corrected by the next re-render */
      }
    }
    if (!isDiagramEditing() || !source || !target || source === target) return;
    container.dispatchEvent(
      new CustomEvent<DiagramConnectDetail>(DIAGRAM_CONNECT_EVENT, {
        bubbles: true,
        detail: {
          sourceQualifiedName: source.qualifiedName,
          targetQualifiedName: target.qualifiedName,
          sourceLabel: source.label,
          targetLabel: target.label,
        },
      }),
    );
  });

  const cells = new Map<string, MxCell>();
  const containers = new Map<string, MxCell>();
  const root = graph.getDefaultParent();

  // Group nodes by bounded context (the qualified-name prefix). Context-less nodes (states, bare context
  // nodes) have no dot and live at the root level.
  const byContext = new Map<string, DiagramNode[]>();
  for (const node of merged.nodes) {
    const ctx = contextOf(node.qualifiedName);
    const bucket = byContext.get(ctx);
    if (bucket) bucket.push(node);
    else byContext.set(ctx, [node]);
  }

  graph.batchUpdate(() => {
    // A swimlane container per non-empty NAMED context: a subtle bounding box with the context name as its
    // header bar. Nodes are parented INTO their context; the inner layout grows the box to fit them.
    for (const [ctx, nodes] of byContext) {
      if (ctx === '' || nodes.length === 0) continue;
      const container = graph.insertVertex({
        parent: root,
        id: `ctx:${ctx}`,
        // A bounded context is a CONCEPTUAL boundary, so its name reads as a territory label (uppercase,
        // matching the Explorer's context headings) and the box is drawn DASHED — a region of the model,
        // not another node. Fill stays transparent so the shared drafting-grid reads straight through it.
        value: ctx.toUpperCase(),
        position: [0, 0],
        size: [240, 160],
        style: {
          shape: 'swimlane',
          startSize: 30,
          fillColor: 'none',
          swimlaneFillColor: 'none',
          strokeColor: 'var(--koi-line)',
          strokeWidth: 1.5,
          dashed: true,
          dashPattern: '6 5',
          fontColor: 'var(--koi-muted)',
          fontStyle: 1, // bold header
          fontSize: 12,
          // The context name sits centred in its header band — both axes (the title is the territory's
          // banner, not a tab pinned to a corner).
          verticalAlign: 'middle',
          align: 'center',
          rounded: true,
        },
      });
      containers.set(ctx, container);
    }

    for (const node of merged.nodes) {
      const ctx = contextOf(node.qualifiedName);
      const parent = (ctx && containers.get(ctx)) || root;
      const [w, h] = nodeSize(node);
      const color = kindColor(node.kind);
      const cell = graph.insertVertex({
        parent,
        id: node.id,
        value: node,
        position: [0, 0],
        size: [w, h],
        // The cell SHAPE carries a kind-coloured fill so the Outline minimap shows recognisable boxes and
        // the shape receives pointer events (click/drag). overflow:'fill' stretches the opaque HTML label
        // (.koi-node, pointer-events:none) over it, so the main view shows the themed compartments while the
        // events fall through to this shape.
        style: { fillColor: color, strokeColor: color, rounded: true, overflow: 'fill', verticalAlign: 'top', align: 'left' },
      });
      cells.set(node.id, cell);
    }

    // Edges between the merged endpoints. Composition gets a filled diamond at the owner (source) end + a
    // target arrow + per-end multiplicity labels; every other relationship is a single target arrow. The
    // DiagramEdge is kept as the cell value so a later disconnect gesture can read its backingMember.
    for (const edge of merged.edges) {
      const source = cells.get(edge.from);
      const target = cells.get(edge.to);
      if (!source || !target) continue;
      const composition = edge.arrowKind === 'composition';
      // A symmetric context-map relation (Partnership / Shared Kernel) reads as undirected — an open
      // arrowhead at BOTH ends — vs. a directional relation's single head at the (downstream) target.
      const bidirectional = edge.arrowKind === 'bidirectional';
      const e = graph.insertEdge({
        parent: root,
        source,
        target,
        value: edge,
        style: {
          edgeStyle: 'orthogonalEdgeStyle', // registered name → CSP-safe (no eval)
          rounded: true,
          strokeColor: 'var(--koi-diagram-edge)', // assertive enough to trace across the canvas
          strokeWidth: 1.4,
          fontColor: 'var(--koi-fg)',
          startArrow: composition ? 'diamond' : bidirectional ? 'open' : 'none',
          startFill: composition,
          startSize: 13,
          endArrow: 'open',
          endSize: 11,
        },
      });
      if (composition) {
        if (edge.sourceCardinality) addEndLabel(mx, graph, e, edge.sourceCardinality, -1);
        if (edge.cardinality) addEndLabel(mx, graph, e, edge.cardinality, 1);
      }
    }
  });

  runTwoLevelLayout(mx, graph);
  // A saved manual layout overrides the auto-arrange (so a hand-positioned diagram doesn't snap back).
  if (savedPositions) applySavedPositions(graph, cells, savedPositions);

  // Persist a drag: snapshot ALL node positions on move (one drag freezes the layout to manual, matching
  // the SVG renderer) and hand them to the active layout store. Attached AFTER layout/apply so neither
  // triggers a spurious save (both use setGeometry, not moveCells — but order keeps the intent clear).
  graph.addListener(mx.InternalEvent.CELLS_MOVED, () => {
    activeLayoutStore().save(snapshotPositions(cells));
  });

  return {
    graph,
    cells,
    containers,
    dispose: () => graph.destroy(),
  };
}

/** The localStorage key for the domain canvas zoom level (not workspace-scoped — matches the old renderer). */
const ZOOM_PERSIST_KEY = 'koi-domain-diagram';

/**
 * Mount the interactive chrome around a built canvas: left-drag panning, a zoom control bar (−/%/+/fit),
 * Ctrl/⌘+wheel zoom, and the Outline minimap. Returns a teardown that detaches them. Kept out of
 * buildCanvas so the model stays unit-testable; the visual chrome is verified in the running studio.
 */
function mountChrome(mx: Mx, handle: CanvasHandle, host: HTMLElement): { dispose: () => void; fit: () => void } {
  const { Outline } = mx;
  const graph = handle.graph;

  // Left-drag pans. When editing, panning must NOT claim drags that start on a cell (ignoreCell=false) —
  // otherwise the pan handler eats the drag and a node can never be moved (it just pans the viewport). So:
  // editing ⇒ drag empty = pan, drag node = move/connect; read-only ⇒ nothing is movable, so drag anywhere
  // pans (ignoreCell=true). A plain click still registers in both modes (panning needs an actual drag).
  graph.setPanning(true);
  const panning = graph.getPlugin('PanningHandler') as unknown as
    | { useLeftButtonForPanning?: boolean; ignoreCell?: boolean }
    | undefined;
  if (panning) {
    panning.useLeftButtonForPanning = true;
    panning.ignoreCell = !isDiagramEditing();
  }
  graph.centerZoom = false;
  graph.zoomFactor = 1.2;

  const fitPlugin = graph.getPlugin('fit') as unknown as
    | { fit?: (o?: unknown) => void; fitCenter?: (o?: unknown) => void }
    | undefined;
  const fit = (): void => {
    // The layout can place content at negative/large coordinates; scale it to fit then center BOTH axes
    // (fitCenter alone left it hugging the top). No-op until the surface is measurable in the live DOM.
    try {
      const g = graph as unknown as { fit?: (b?: number) => void; center?: (h?: boolean, v?: boolean) => void };
      if (fitPlugin?.fit) fitPlugin.fit({ border: 24 });
      else if (typeof g.fit === 'function') g.fit(24);
      g.center?.(true, true);
    } catch {
      /* container not measurable yet — ignore */
    }
  };

  // Restore the saved zoom level (best-effort).
  const saved = loadDiagramZoom(ZOOM_PERSIST_KEY);
  if (saved != null) graph.zoomTo(saved / 100, false);

  // --- control bar -----------------------------------------------------------
  const controls = document.createElement('div');
  controls.className = 'koi-canvas-controls';
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Diagram zoom controls');

  const pct = document.createElement('span');
  pct.className = 'koi-canvas-zoom-pct';
  pct.setAttribute('aria-live', 'polite');
  const syncPct = (): void => {
    const p = Math.round(graph.getView().scale * 100);
    pct.textContent = `${p}%`;
    saveDiagramZoom(ZOOM_PERSIST_KEY, p);
  };

  const button = (glyph: string, label: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'koi-canvas-btn';
    b.textContent = glyph;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  };

  controls.append(
    button('−', 'Zoom out', () => {
      graph.zoomOut();
      syncPct();
    }),
    pct,
    button('+', 'Zoom in', () => {
      graph.zoomIn();
      syncPct();
    }),
    button('⤢', 'Fit to screen', () => {
      fit();
      syncPct();
    }),
  );

  // Authoring controls (editing only): reset the manual layout. The read-only canvas shows only the zoom controls.
  if (isDiagramEditing()) {
    host.classList.add('koi-canvas--editing');
    controls.append(
      button('⟲', 'Auto-arrange layout', () => {
        // Clear the saved positions, then ask ide.tsx to re-render — it lays out fresh from an empty store.
        activeLayoutStore().clear();
        host.dispatchEvent(new CustomEvent(DIAGRAM_RELAYOUT_EVENT, { bubbles: true }));
      }),
    );
  }

  host.appendChild(controls);
  syncPct();

  // Ctrl/⌘ + wheel zooms the canvas; a plain wheel is left to scroll the page.
  const onWheel = (evt: WheelEvent): void => {
    if (!evt.ctrlKey && !evt.metaKey) return;
    evt.preventDefault();
    if (evt.deltaY < 0) graph.zoomIn();
    else graph.zoomOut();
    syncPct();
  };
  host.addEventListener('wheel', onWheel, { passive: false });

  // --- minimap (Outline) -----------------------------------------------------
  const outlineDiv = document.createElement('div');
  outlineDiv.className = 'koi-canvas-outline';
  outlineDiv.setAttribute('aria-hidden', 'true');
  host.appendChild(outlineDiv);
  let outline: { destroy(): void } | null = null;
  try {
    outline = new Outline(graph, outlineDiv);
  } catch {
    // Outline reads laid-out geometry; under a measure-less headless DOM it may fail — skip it there.
    outlineDiv.remove();
  }

  return {
    dispose: () => {
      host.removeEventListener('wheel', onWheel);
      outline?.destroy();
    },
    fit,
  };
}

/**
 * The maxGraph renderer behind the {@link DiagramRenderer} seam. Fuses the (already context-scoped) files
 * into one domain canvas; an empty model shows the inviting empty state; a superseded render (isCurrent()
 * false) disposes itself rather than clobbering a newer one.
 */
export function createMaxGraphRenderer(): DiagramRenderer {
  // Teardown for the canvas + chrome currently committed (the renderer is cached across renders).
  let activeDispose: (() => void) | null = null;

  return {
    // `theme` is part of the seam but unused — cells are themed via CSS custom properties, so a theme
    // flip restyles the live SVG without a re-render.
    async render(container, files, _theme, isCurrent = () => true): Promise<void> {
      const graphs = selectDomainGraphs(files);

      if (!graphs.length) {
        if (isCurrent()) {
          activeDispose?.();
          activeDispose = null;
          container.replaceChildren(buildEmptyState());
        }
        return;
      }

      let mx: Mx;
      try {
        mx = await getMaxGraph();
      } catch (e) {
        if (isCurrent()) {
          container.innerHTML = `<p class="doc-error">Could not load the diagram renderer: ${escapeHtml(String(e))}</p>`;
        }
        return;
      }

      const merged = mergeGraphsForView(graphs);

      // Restore any saved manual layout for this workspace (committable koine.layout.json, or browser
      // storage). Async — re-check isCurrent() after it so a superseded render bails before touching DOM.
      const savedPositions = await activeLayoutStore().load();
      if (!isCurrent()) return;

      // Build into a detached host so a superseded render never half-paints the live canvas.
      const root = document.createElement('div');
      // `koi-svg-diagram` is kept so the inspector's selection cross-highlight selector still scopes here.
      root.className = 'koi-diagrams koi-diagrams-single koi-svg-diagram';
      const surface = document.createElement('div');
      surface.className = 'koi-canvas';
      root.appendChild(surface);

      const handle = buildCanvas(mx, surface, merged, savedPositions);
      // Chrome (zoom bar + minimap) mounts on `root`, NOT the maxGraph container (`surface`): maxGraph's
      // panGraph reparents every non-SVG child of its container into a shifted preview div while panning
      // (e.g. dragging the minimap), which would yank the controls/minimap to the top-left. Keeping them on
      // the outer wrapper makes them immune. `root` is position:relative (scss) so they still anchor to it.
      const chrome = mountChrome(mx, handle, root);
      const dispose = (): void => {
        chrome.dispose();
        handle.dispose();
      };

      if (isCurrent()) {
        activeDispose?.();
        activeDispose = dispose;
        container.replaceChildren(root);
        handle.graph.getView().revalidate(); // re-render now that the surface is in the live DOM
        chrome.fit(); // frame the laid-out content (it can sit at negative coords) into the viewport
      } else {
        // Superseded: never reached the page — dispose so its listeners/observers don't leak.
        dispose();
      }
    },
  };
}

// --- standalone strategic context-map graph -----------------------------------
// The context map renders on the SAME maxGraph engine as the domain canvas (buildCanvas + the pan/zoom/
// minimap chrome) — there is deliberately no second diagram engine. It differs from the domain canvas in
// three ways: it is read-only (contexts aren't authored here), it lays out by relations (a dependency
// rank, not bounded-context swimlanes), and a click filters/inspects rather than navigates to source.

/** Interaction hooks for the context-map graph: a context-node click (filter to that context), a
 *  relation-edge selection (`null` clears it), and a per-cell hover tooltip builder. */
export interface ContextMapGraphHooks {
  /** A bounded-context node was clicked — the inspector filters the workspace to that context. */
  onContextClick?(node: DiagramNode): void;
  /** A relation edge was selected, or selection cleared (`null`) — the inspector shows its shared types / ACL. */
  onRelationSelect?(edge: DiagramEdge | null): void;
  /** Hover-tooltip text (plain string) for a cell value (a context node or a relation edge), or null for none. */
  tooltip?(value: DiagramNode | DiagramEdge): string | null;
}

/** A teardown handle for a mounted context-map graph. */
export interface ContextMapGraphHandle {
  dispose(): void;
}

/** Route a clicked cell value to the right hook: a context node (has a `qualifiedName`) filters to that
 *  context; a relation edge (has `from`/`to`) is selected; anything else clears the selection. Extracted
 *  pure so the routing is unit-tested without driving maxGraph. */
export function routeContextMapClick(value: unknown, hooks: ContextMapGraphHooks): void {
  if (value && typeof value === 'object' && 'qualifiedName' in value) hooks.onContextClick?.(value as DiagramNode);
  else if (value && typeof value === 'object' && 'from' in value && 'to' in value) hooks.onRelationSelect?.(value as DiagramEdge);
  else hooks.onRelationSelect?.(null);
}

/** Arrange the context-map graph by its relations: a dependency-ranked {@link HierarchicalLayout} so an
 *  upstream → downstream edge reads left→right. Wrapped so a measure-less headless DOM can't blank it. */
function runContextMapLayout(mx: Mx, graph: MxGraph): void {
  try {
    const layout = new mx.HierarchicalLayout(graph, 'west');
    layout.intraCellSpacing = 40;
    layout.interRankCellSpacing = 90;
    graph.batchUpdate(() => layout.execute(graph.getDefaultParent()));
  } catch {
    // Unmeasurable DOM (vitest/happy-dom) — the nodes are still present and addressable, just unarranged.
  }
}

/**
 * Render a standalone strategic context-map graph into `container`, reusing {@link buildCanvas} and the
 * pan/zoom/minimap chrome. The map is a READ-ONLY topology view, so editing is forced off for the
 * (synchronous) build and restored after — contexts must not be movable / connectable / renamable. A
 * superseded render (`isCurrent()` false) tears itself down rather than clobbering a newer one. Returns a
 * teardown handle (or null when nothing was committed) so the inspector can dispose the canvas on toggle.
 */
export async function renderContextMapGraph(
  container: HTMLElement,
  graph: DiagramGraph,
  isCurrent: () => boolean,
  hooks: ContextMapGraphHooks = {},
): Promise<ContextMapGraphHandle | null> {
  let mx: Mx;
  try {
    mx = await getMaxGraph();
  } catch (e) {
    if (isCurrent()) container.innerHTML = `<p class="doc-error">Could not load the diagram renderer: ${escapeHtml(String(e))}</p>`;
    return null;
  }
  if (!isCurrent()) return null;

  const root = document.createElement('div');
  // Deliberately WITHOUT `koi-svg-diagram`: the inspector's selection cross-highlight scopes to that class
  // on the domain canvas, and a context node's bare name shouldn't be cross-highlighted here.
  root.className = 'koi-diagrams-single koi-ctxmap-graph';
  const surface = document.createElement('div');
  surface.className = 'koi-canvas';
  root.appendChild(surface);

  // Force editing off for the synchronous build (no awaits between set and restore, so no render can
  // interleave), then restore the global flag for the authoring domain canvas.
  const prevEditing = isDiagramEditing();
  setDiagramEditing(false);
  let handle: CanvasHandle;
  let chrome: { dispose(): void; fit(): void };
  try {
    handle = buildCanvas(mx, surface, graph);
    if (graph.edges.length > 0) runContextMapLayout(mx, handle.graph); // override buildCanvas's row with a topology rank
    chrome = mountChrome(mx, handle, root);
  } finally {
    setDiagramEditing(prevEditing);
  }

  // Hover tooltips (kind + shared types / ACL) — best-effort chrome; a measure-less headless DOM may skip it.
  if (hooks.tooltip) {
    try {
      handle.graph.setTooltips(true);
      (handle.graph as unknown as { getTooltipForCell: (cell: MxCell) => string }).getTooltipForCell = (cell) => {
        const v = cell?.value as DiagramNode | DiagramEdge | undefined;
        return (v && typeof v === 'object' && hooks.tooltip!(v)) || '';
      };
    } catch {
      // tooltips are non-essential — selection still surfaces the same detail in the inspector
    }
  }

  // Click routing: a context node → filter to that context; a relation edge → show its details; an empty
  // click → clear the selection. (buildCanvas's own span-navigate listener is inert here — context nodes
  // carry no source span.)
  handle.graph.addListener(mx.InternalEvent.CLICK, (_sender: unknown, evt: { getProperty(name: string): unknown }) => {
    routeContextMapClick((evt.getProperty('cell') as MxCell | null)?.value, hooks);
  });

  const dispose = (): void => {
    chrome.dispose();
    handle.dispose();
  };

  if (isCurrent()) {
    container.replaceChildren(root);
    handle.graph.getView().revalidate(); // re-render now that the surface is in the live DOM
    chrome.fit(); // frame the laid-out content into the viewport
    return { dispose };
  }
  dispose();
  return null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
