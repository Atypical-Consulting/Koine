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
import type { Diagram, DiagramEdge, DiagramGraph, DiagramMember, DiagramNode, DocsFile } from '@/lsp/lsp';
import { mergeGraphsForView, type EventFlowEdge, type EventFlowNode } from '@/model/modelTables';
// Concept Colors (ADR 0004): the single-source palette. The canvas shape fill/stroke needs literal hex
// (var() doesn't resolve inside SVG fill attrs), so it reads CONCEPT_COLORS[slug].dark — the SAME hex the
// explorer/editor render as `var(--koi-ddd-<slug>)`, so one concept is one color everywhere.
import { CONCEPT_COLORS, CONCEPT_SLUGS } from '@/model/conceptColors.generated';
import { diagramToMermaid } from '@/export/diagramExport';
import { buildEmptyState } from '@/diagrams/emptyState';
import { loadDiagramPositions, loadDiagramZoom, saveDiagramPositions, saveDiagramZoom } from '@/settings/persistence';
import {
  DIAGRAM_ANNOTATION_CREATE_EVENT,
  DIAGRAM_CONNECT_EVENT,
  DIAGRAM_DISCONNECT_EVENT,
  DIAGRAM_REFIT_EVENT,
  DIAGRAM_RELAYOUT_EVENT,
  NODE_EDIT_EVENT,
  NODE_NAVIGATE_EVENT,
  diagramLayoutStore,
  diagramPersistScope,
  getDefaultCanvasZoom,
  isDiagramEditing,
  isDiagramTouchMode,
  isEditableKind,
  type CanvasAnnotationKind,
  type DiagramAnnotationCreateDetail,
  type DiagramConnectDetail,
  type DiagramDisconnectDetail,
  type DiagramGroup,
  type DiagramLayout,
  type DiagramLayoutStore,
  type DiagramNodeEditDetail,
  type DiagramNodeNavigateDetail,
  type DiagramNote,
  type DiagramPosition,
} from '@/diagrams/diagramContract';
import { createBrowserLayoutStore } from '@/diagrams/layoutStore';
import { koiConfirm, koiPrompt } from '@atypical/koine-ui';
import { prefixedId } from '@/shared/ids';

/** The neutral slate fallback for a node kind with no concept color (state nodes, unknown kinds). */
const SLATE = '#94a3b8';

// The DDD palette as literal hex — the maxGraph cell SHAPE fill/stroke can't use var(), which doesn't
// resolve inside SVG fill attributes. DERIVED from the single-source Concept Colors palette
// (design/concept-colors.json → CONCEPT_COLORS): every value is CONCEPT_COLORS[slug].dark, which equals
// `var(--koi-ddd-<slug>)` in every theme — the @atypical/koine-ui palette keeps the DDD vars dark-only (no
// html[data-theme='light'] override), so the SVG shape, the HTML node label, and the explorer icon all
// stay on the one canonical concept hue. The two alias keys the graph emits (`aggregate-root`,
// `value-object`) map onto the aggregate/value hues; state-machine node kinds (state/initial/final) and a
// bounded `context` stay structural slate/value-blue (a context hue is a deferred follow-up).
const DDD_HEX: Record<string, string> = {
  ...Object.fromEntries(CONCEPT_SLUGS.map((slug) => [slug, CONCEPT_COLORS[slug].dark])),
  'aggregate-root': CONCEPT_COLORS.aggregate.dark,
  'value-object': CONCEPT_COLORS.value.dark,
  state: SLATE,
  initial: SLATE,
  final: SLATE,
  context: CONCEPT_COLORS.value.dark,
};

/** The shape colour for a node kind (drives the minimap + hit-testing). Falls back to slate. */
export function kindColor(kind: string): string {
  return DDD_HEX[kind] ?? SLATE;
}

// The Event Flow canvas (#270) now speaks the ONE concept palette (ADR 0004 retired the separate
// event-storming sticky hues, `EVENT_FLOW_HEX`): a card takes its concept's color, so an aggregate is the
// same indigo here as on the domain canvas and in the explorer. The docs page carries the Event-Storming ↔
// Koine mapping table for orientation. Literal hex (var() doesn't resolve inside SVG fill/stroke attrs).
const EVENT_FLOW_SLUG: Record<EventFlowNode['kind'], (typeof CONCEPT_SLUGS)[number]> = {
  command: 'command',
  aggregate: 'aggregate',
  'domain-event': 'event',
  policy: 'policy',
  'integration-event': 'integration-event',
};

/** The event-flow card colour for a flow card kind, drawn from the concept palette. Falls back to slate. */
export function eventFlowColor(kind: EventFlowNode['kind']): string {
  const slug = EVENT_FLOW_SLUG[kind];
  return slug ? CONCEPT_COLORS[slug].dark : SLATE;
}

// Canvas-only annotation styling (#255). Literal hex like DDD_HEX — var() doesn't resolve inside SVG
// fill/stroke attrs; the HTML labels are themed via CSS classes (.koi-annotation*). A note is a soft
// sticky; a group is a faint dashed region drawn behind its member nodes.
const NOTE_FILL = '#fde68a'; // amber sticky
const NOTE_STROKE = '#f59e0b';
const GROUP_FILL = '#8b87f5'; // tinted via fillOpacity so the grid reads through
const GROUP_STROKE = '#8b87f5';
/** Breathing room between a group's border and the bounding box of its member nodes. */
const GROUP_PAD = 28;
/** Default size of a freshly-created note (#255 Task 3); also the fallback when a saved note lacks size. */
export const NOTE_DEFAULT_W = 180;
export const NOTE_DEFAULT_H = 96;

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

// The three ranked HierarchicalLayouts (domain-canvas inner layout, context map, event flow) all pin the
// upstream/root nodes to this one edge so a dependency reads left→right. One shared constant instead of
// three independent literals — the #1209 regression was exactly these three sites drifting out of sync.
const UPSTREAM_ORIENTATION = 'west';

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
  return selectDomainDiagrams(files).map((d) => d.graph);
}

/**
 * The full {@link Diagram}s (caption / kind / mermaid / graph) behind {@link selectDomainGraphs} — every
 * non-contextmap diagram that carries nodes. Kept alongside the graph selector so export (#271) can recover
 * the source captions and Mermaid that {@link mergeGraphsForView} discards when it fuses the graphs.
 *
 * The context diagram's graph also carries the event-flow chain's `command` / `policy` nodes (#439); those
 * belong on the Events → Flow canvas, NOT on the structural domain/class canvas (a command already shows as
 * a method row on its aggregate, a policy isn't a class), so they're stripped here. The strip is a no-op for
 * graphs without them, so pre-#439 callers are unaffected.
 */
export function selectDomainDiagrams(files: DocsFile[]): Diagram[] {
  return files
    .flatMap((f) => f.diagrams ?? [])
    .filter((d) => d.kind !== 'contextmap' && !!d.graph && d.graph.nodes.length > 0)
    .map((d) => ({ ...d, graph: withoutEventFlowOnlyNodes(d.graph) }));
}

/** The diagram-node kinds that exist only for the event-flow chain (#439) and are not drawn on the
 *  structural domain canvas. */
const EVENT_FLOW_ONLY_KINDS = new Set(['command', 'policy']);

/** A copy of `graph` with the event-flow-only nodes (commands/policies, #439) and any edge touching one
 *  removed, so the domain/class canvas stays structural. Returns the input unchanged when there are none. */
function withoutEventFlowOnlyNodes(graph: DiagramGraph): DiagramGraph {
  const dropped = new Set(graph.nodes.filter((n) => EVENT_FLOW_ONLY_KINDS.has(n.kind)).map((n) => n.id));
  if (dropped.size === 0) return graph;
  return {
    nodes: graph.nodes.filter((n) => !dropped.has(n.id)),
    edges: graph.edges.filter((e) => !dropped.has(e.from) && !dropped.has(e.to)),
  };
}

/**
 * Synthesize the single {@link Diagram} that represents the fused domain canvas for export (#271). The
 * canvas merges several source diagrams into one CLASS-SHAPED view (nodes with members, composition edges),
 * so all four exports describe that one view: `kind` is `'aggregate'` (the PlantUML/Mermaid class family);
 * `graph` is the already-merged graph that's actually drawn; `mermaid` is generated from that merged graph
 * as ONE valid Mermaid document (concatenating the per-source snippets would stack multiple `classDiagram`
 * headers, which Mermaid rejects). `caption` is the lone source caption when there's exactly one, else a
 * generic `'Domain model'` — it seeds the download filename AND the PlantUML `title`.
 */
function synthDomainExportDiagram(sources: Diagram[], merged: DiagramGraph): Diagram {
  const caption = sources.length === 1 ? sources[0].caption : 'Domain model';
  return { caption, kind: 'aggregate', mermaid: diagramToMermaid(merged), graph: merged };
}

/** The currently-committed domain canvas exposed for export (#271): the live {@link CanvasHandle} (for SVG/
 *  PNG of the actual drawing) plus a synthesized {@link Diagram} (for PlantUML + Mermaid + the filename), or
 *  null when no domain canvas is shown (empty model / context map). */
let activeDomainExport: { diagram: Diagram; handle: CanvasHandle } | null = null;

/** The active domain canvas for export, or null when none is shown. Read at export time by the IDE shell. */
export function getActiveDomainExport(): { diagram: Diagram; handle: CanvasHandle } | null {
  return activeDomainExport;
}

/** A live canvas: the graph, a node-id→cell index (for edges + selection), the per-context container
 *  cells, the canvas-only annotation cells (note-id / group-id → cell), and a teardown closure. */
export interface CanvasHandle {
  graph: MxGraph;
  cells: Map<string, MxCell>;
  containers: Map<string, MxCell>;
  /** Note-id → note cell (#255). */
  noteCells: Map<string, MxCell>;
  /** Group-id → group cell (#255). */
  groupCells: Map<string, MxCell>;
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

// --- canvas-only annotations (notes, groups; #255) ---------------------------
// Notes and groups are a VIEW concern persisted in koine.layout.json alongside positions — never `.koi`.
// Each rides a maxGraph cell tagged with an AnnotationCellValue so it is excluded from node layout and
// node gestures (nodeValue() returns null for them) yet still paints, snapshots, and (notes) drags.

/** The tagged value an annotation cell carries — distinguishing it from a node (DiagramNode) or edge. */
interface AnnotationCellValue {
  annotationKind: CanvasAnnotationKind;
  id: string;
  /** A note's text, or a group's label. */
  text: string;
  /** The grouped node qualified names (groups only). */
  members?: string[];
  /** An optional accent-colour key (groups only). */
  color?: string;
}

/** The annotation value a cell carries, or null when the cell is a node / edge / container. */
function annotationValue(cell: MxCell | null | undefined): AnnotationCellValue | null {
  const v = cell?.value as AnnotationCellValue | undefined;
  return v && typeof v === 'object' && 'annotationKind' in v ? v : null;
}

/** True for a note or group cell (kept out of node layout + node gestures). */
function isAnnotationCell(cell: MxCell | null | undefined): boolean {
  return annotationValue(cell) != null;
}

/** A unique id for a freshly-authored annotation, e.g. `note-1a2b…` / `group-3` (#255). */
function newAnnotationId(kind: CanvasAnnotationKind): string {
  return prefixedId(kind);
}

/** The HTML label for an annotation cell: a sticky note's text, or a group's corner label. */
function annotationLabelHtml(v: AnnotationCellValue): string {
  const cls = v.annotationKind === 'note' ? 'koi-annotation--note' : 'koi-annotation--group';
  return `<div class="koi-annotation ${cls}">${escapeHtml(v.text)}</div>`;
}

/** Snapshot every note cell to a DiagramNote — geometry is authoritative (the user may have moved/resized it). */
function snapshotNotes(noteCells: Map<string, MxCell>): DiagramNote[] {
  const out: DiagramNote[] = [];
  for (const [id, cell] of noteCells) {
    const v = annotationValue(cell);
    const g = cell.getGeometry();
    if (!v || !g) continue;
    out.push({ id, text: v.text, x: g.x, y: g.y, width: g.width, height: g.height });
  }
  return out;
}

/** Snapshot every group cell to a DiagramGroup — membership + styling only; the rect is DERIVED, not stored. */
function snapshotGroups(groupCells: Map<string, MxCell>): DiagramGroup[] {
  const out: DiagramGroup[] = [];
  for (const [id, cell] of groupCells) {
    const v = annotationValue(cell);
    if (!v) continue;
    const group: DiagramGroup = { id, label: v.text, members: v.members ?? [] };
    if (v.color) group.color = v.color;
    out.push(group);
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
          const inner = new HierarchicalLayout(graph, UPSTREAM_ORIENTATION);
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
        if (isAnnotationCell(child)) continue; // annotations keep their own (note) / derived (group) geometry
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
  savedLayout?: DiagramLayout,
  options?: { readOnly?: boolean; touch?: boolean },
): CanvasHandle {
  const { Graph } = mx;
  // `readOnly` forces a non-authoring canvas regardless of the global editing flag (the strategic
  // context map renders read-only while the domain canvas stays editable) — so the read-only contract is
  // a local parameter, not a coincidence of global-flag timing. Every authoring gesture below honours it.
  const readOnly = options?.readOnly ?? false;
  const editing = !readOnly && isDiagramEditing();
  // Touch mode (#221 Task 3) is the mobile presentation: editing stays on (the palette + auto-arrange still
  // author), but FREEHAND manipulation — drag-to-move/connect, double-click-rename, right-click-delete — is
  // off, so a tap selects/navigates and a drag pans. `freehand` is the authoring-gesture predicate every
  // such gesture honours; it requires editing AND not-touch. The context map (readOnly) ignores touch — it
  // is already a non-authoring, pan-anywhere surface. Independent of `editing` per the contract. Touch is a
  // per-canvas OPTION (like `readOnly`) — fixed at build time so the canvas's gestures can't drift with the
  // global flag's timing; the caller passes isDiagramTouchMode() at render.
  const touch = !readOnly && (options?.touch ?? false);
  const freehand = editing && !touch;
  const graph = new Graph(container);
  // CSP-safe: never fall through to the single `eval` path for unregistered style names (Tauri strict CSP).
  graph.getView().allowEval = false;
  graph.setHtmlLabels(true); // labels render as HTML so class nodes can use compartment markup.
  graph.setCellsEditable(false); // no in-place label editing (renames go through the model round-trip).
  graph.setCellsResizable(false); // node size is derived from content, not hand-resized.
  // Drag-to-reposition + drag-to-connect are FREEHAND authoring gestures, gated so the read-only tab is
  // inert AND so touch mode (mobile) swaps them for tap-to-edit. ide.tsx flips editing on at boot (the
  // model→.koi round-trip seam is reachable) and touch on below $bp-narrow.
  graph.setCellsMovable(freehand);
  if (freehand) {
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
  // Canvas-only annotations (#255): a GROUP is an inert region — never movable/selectable/resizable, since
  // its rect is DERIVED from its members; a NOTE is movable + resizable when editing (even though nodes are
  // neither — node size is content-derived). Layer these rules over the node rules via the per-cell predicates.
  const baseIsCellMovable = graph.isCellMovable.bind(graph);
  graph.isCellMovable = (cell) => {
    const av = annotationValue(cell);
    if (av) return freehand && av.annotationKind === 'note';
    return baseIsCellMovable(cell);
  };
  const baseIsCellSelectable = graph.isCellSelectable.bind(graph);
  graph.isCellSelectable = (cell) => {
    const av = annotationValue(cell);
    if (av) return freehand && av.annotationKind === 'note'; // notes select (for the resize handles) only when freehand-editing
    return baseIsCellSelectable(cell);
  };
  const baseIsCellResizable = graph.isCellResizable.bind(graph);
  graph.isCellResizable = (cell) => {
    const av = annotationValue(cell);
    if (av) return freehand && av.annotationKind === 'note';
    return baseIsCellResizable(cell);
  };
  // Render each cell's stored value: an annotation → its sticky/region HTML label; a DiagramNode → its
  // UML/simple HTML label (a `.koi-node` div themed by CSS); a DiagramEdge → its mid label; else the string.
  graph.convertValueToString = (cell): string => {
    const v = cell.value as DiagramNode | DiagramEdge | AnnotationCellValue | string | null;
    if (v && typeof v === 'object') {
      if ('annotationKind' in v) return annotationLabelHtml(v);
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
  // A double-click on a canvas annotation edits its note text / group label instead (#255, no `.koi` edit).
  // Gated on editing; only class-type, context-owned, spanned nodes (never a context / state) rename.
  graph.addListener(mx.InternalEvent.DOUBLE_CLICK, (_sender: unknown, evt: { getProperty(name: string): unknown }) => {
    if (readOnly || !isDiagramEditing() || touch) return; // touch mode: a tap navigates, no freehand rename
    const cell = evt.getProperty('cell') as MxCell | null;
    if (annotationValue(cell)) {
      void editAnnotation(cell!);
      return;
    }
    const v = nodeValue(cell);
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
    if (readOnly || !isDiagramEditing() || touch) return; // touch mode: no freehand delete/disconnect
    const rect = container.getBoundingClientRect();
    const cell = graph.getCellAt(evt.clientX - rect.left, evt.clientY - rect.top);
    if (!cell) return;
    const annotation = annotationValue(cell);
    if (annotation) {
      evt.preventDefault(); // suppress the native menu regardless of the async confirm's outcome
      void koiConfirm({
        title: `Delete this ${annotation.annotationKind}?`,
        message: 'Removes the canvas annotation. Your .koi source is untouched.',
        confirmLabel: 'Delete',
        danger: true,
      }).then((ok) => {
        if (ok) deleteAnnotation(cell);
      });
      return;
    }
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
    if (readOnly || !isDiagramEditing() || touch || !source || !target || source === target) return;
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
  const noteCells = new Map<string, MxCell>();
  const groupCells = new Map<string, MxCell>();
  const root = graph.getDefaultParent();

  // The canvas-only annotations restored from the saved layout (#255). Notes carry their own geometry;
  // group rects are derived from member positions after layout (see layoutGroups below).
  const savedNotes = savedLayout?.notes ?? [];
  const savedGroups = savedLayout?.groups ?? [];

  // Group nodes by bounded context (the qualified-name prefix). Context-less nodes (states, bare context
  // nodes) have no dot and live at the root level.
  const byContext = new Map<string, DiagramNode[]>();
  for (const node of merged.nodes) {
    const ctx = contextOf(node.qualifiedName);
    const bucket = byContext.get(ctx);
    if (bucket) bucket.push(node);
    else byContext.set(ctx, [node]);
  }

  // Insert one annotation cell. Used both to restore the saved layout (in the build batch, before the
  // nodes so it paints behind) and to author a new annotation later (sendAnnotationsToBack keeps it behind).
  function insertGroupCell(group: DiagramGroup): MxCell {
    const cell = graph.insertVertex({
      parent: root,
      id: `group:${group.id}`,
      value: { annotationKind: 'group', id: group.id, text: group.label, members: [...group.members], color: group.color },
      position: [0, 0],
      size: [1, 1], // placeholder; layoutGroups() derives the real rect from the members before first paint
      style: {
        shape: 'rectangle',
        rounded: true,
        fillColor: GROUP_FILL,
        fillOpacity: 8,
        strokeColor: GROUP_STROKE,
        strokeWidth: 1.5,
        dashed: true,
        dashPattern: '4 4',
        verticalAlign: 'top',
        align: 'left',
        spacingLeft: 8,
        spacingTop: 6,
      },
    });
    groupCells.set(group.id, cell);
    return cell;
  }
  function insertNoteCell(note: DiagramNote): MxCell {
    const cell = graph.insertVertex({
      parent: root,
      id: `note:${note.id}`,
      value: { annotationKind: 'note', id: note.id, text: note.text },
      position: [note.x, note.y],
      size: [note.width || NOTE_DEFAULT_W, note.height || NOTE_DEFAULT_H],
      // The shape carries the sticky fill + receives pointer events; the HTML label (.koi-annotation,
      // pointer-events:none) overlays it with the wrapped text — mirroring the node label pattern.
      style: {
        shape: 'rectangle',
        rounded: true,
        fillColor: NOTE_FILL,
        strokeColor: NOTE_STROKE,
        strokeWidth: 1,
        overflow: 'fill',
        whiteSpace: 'wrap',
        verticalAlign: 'top',
        align: 'left',
      },
    });
    noteCells.set(note.id, cell);
    return cell;
  }

  graph.batchUpdate(() => {
    // Annotations are inserted FIRST so they paint BEHIND every container/node/edge (root child order ==
    // SVG paint order). Groups (regions) go in before notes, so a note over a group reads on top — both
    // still sit behind the nodes.
    for (const group of savedGroups) insertGroupCell(group);
    for (const note of savedNotes) insertNoteCell(note);

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
  if (savedLayout?.positions) applySavedPositions(graph, cells, savedLayout.positions);

  // A qualified-name → node-cell index, for deriving each group's bounding box from its members (#255).
  const nodesByQname = new Map<string, MxCell>();
  for (const cell of cells.values()) {
    const v = nodeValue(cell);
    if (v) nodesByQname.set(v.qualifiedName, cell);
  }

  /** Absolute (root-space) geometry of a node cell: its container offset plus its own geometry. Nesting is
   *  at most root → container → node, so a single parent offset suffices. */
  function absoluteRect(cell: MxCell): { x: number; y: number; w: number; h: number } | null {
    const g = cell.getGeometry();
    if (!g) return null;
    let ox = 0;
    let oy = 0;
    const parent = cell.getParent();
    if (parent && parent !== root) {
      const pg = parent.getGeometry();
      if (pg) {
        ox = pg.x;
        oy = pg.y;
      }
    }
    return { x: g.x + ox, y: g.y + oy, w: g.width, h: g.height };
  }

  /** Re-derive each group's rectangle as the padded bounding box of its resolved members; a group with no
   *  resolvable members is hidden (there is nothing to enclose). Called after layout and on every move. */
  function layoutGroups(): void {
    if (!groupCells.size) return;
    const model = graph.getDataModel();
    graph.batchUpdate(() => {
      for (const cell of groupCells.values()) {
        const members = annotationValue(cell)?.members ?? [];
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let found = 0;
        for (const qn of members) {
          const member = nodesByQname.get(qn);
          const r = member && absoluteRect(member);
          if (!r) continue;
          found++;
          minX = Math.min(minX, r.x);
          minY = Math.min(minY, r.y);
          maxX = Math.max(maxX, r.x + r.w);
          maxY = Math.max(maxY, r.y + r.h);
        }
        model.setVisible(cell, found > 0);
        const geo = cell.getGeometry();
        if (found === 0 || !geo) continue;
        const next = geo.clone();
        next.x = minX - GROUP_PAD;
        next.y = minY - GROUP_PAD;
        next.width = maxX - minX + GROUP_PAD * 2;
        next.height = maxY - minY + GROUP_PAD * 2;
        model.setGeometry(cell, next);
      }
    });
  }

  layoutGroups();

  // Persist a drag/resize: snapshot ALL node positions + note geometries (one gesture freezes the layout to
  // manual, matching the SVG renderer) and re-derive group rects so a group follows its moved members. Then
  // hand the whole layout to the active store. Attached AFTER layout/apply so neither fires a spurious save
  // (both use setGeometry, not moveCells — but order keeps the intent clear).
  const persist = (): void => {
    layoutGroups();
    activeLayoutStore().save({
      positions: snapshotPositions(cells),
      notes: snapshotNotes(noteCells),
      groups: snapshotGroups(groupCells),
    });
  };
  graph.addListener(mx.InternalEvent.CELLS_MOVED, persist);
  graph.addListener(mx.InternalEvent.CELLS_RESIZED, persist);

  // --- annotation authoring (create / edit / delete; #255 Task 3) ------------
  // Annotations are a view concern, so the renderer owns their whole lifecycle (no `.koi` round-trip): it
  // mutates the live graph and persists via the store. Create is driven by a document event the palette →
  // IDE raises; edit/delete reuse the node double-click / right-click gestures (branches added above).

  /** Keep every annotation behind the nodes after an author action (groups before notes, both at the back). */
  function sendAnnotationsToBack(): void {
    const ordered = [...groupCells.values(), ...noteCells.values()];
    if (ordered.length) graph.orderCells(true, ordered);
  }

  async function createNote(): Promise<void> {
    const text = await koiPrompt({ title: 'New note', label: 'Note text', initialValue: '', confirmLabel: 'Add note' });
    if (!text) return; // cancelled or empty
    const offset = 32 + noteCells.size * 24; // cascade so successive notes don't stack exactly
    insertNoteCell({ id: newAnnotationId('note'), text, x: offset, y: offset, width: NOTE_DEFAULT_W, height: NOTE_DEFAULT_H });
    sendAnnotationsToBack();
    persist();
  }

  async function createGroup(): Promise<void> {
    // Group the current node selection; if nothing is selected, group every node on the canvas (so the
    // button always produces a visible region the user can then edit/delete).
    const selected = graph.getSelectionCells().map(nodeValue).filter((v): v is DiagramNode => v != null);
    const source = selected.length ? selected : [...cells.values()].map(nodeValue).filter((v): v is DiagramNode => v != null);
    const members = source.map((v) => v.qualifiedName);
    if (!members.length) return; // nothing to enclose
    const label = await koiPrompt({ title: 'New group', label: 'Group label', initialValue: 'Group', confirmLabel: 'Add group' });
    if (!label) return;
    insertGroupCell({ id: newAnnotationId('group'), label, members });
    sendAnnotationsToBack();
    persist(); // persist() re-derives every group's rect (layoutGroups) before saving
  }

  /** Edit a note's text / a group's label via the modal prompt (double-click gesture). */
  async function editAnnotation(cell: MxCell): Promise<void> {
    const av = annotationValue(cell);
    if (!av) return;
    const isNote = av.annotationKind === 'note';
    const next = await koiPrompt({
      title: isNote ? 'Edit note' : 'Rename group',
      label: isNote ? 'Note text' : 'Group label',
      initialValue: av.text,
      confirmLabel: 'Save',
    });
    if (!next || next === av.text) return; // cancelled, blank, or unchanged → no-op (note text / group label required)
    graph.getDataModel().setValue(cell, { ...av, text: next });
    persist();
  }

  /** Remove a note/group from the canvas and the saved layout (right-click gesture). */
  function deleteAnnotation(cell: MxCell): void {
    const av = annotationValue(cell);
    if (!av) return;
    graph.getDataModel().remove(cell);
    if (av.annotationKind === 'note') noteCells.delete(av.id);
    else groupCells.delete(av.id);
    persist();
  }

  const onCreateAnnotation = (e: Event): void => {
    // Gated on this canvas's OWN readOnly contract like every other authoring gesture: the event is
    // document-wide, so a mounted read-only canvas (context map) would otherwise answer it too and its
    // persist() would overwrite the domain canvas's saved layout with this canvas's cells.
    if (readOnly || !isDiagramEditing()) return;
    const detail = (e as CustomEvent<DiagramAnnotationCreateDetail>).detail;
    if (detail?.kind === 'note') void createNote();
    else if (detail?.kind === 'group') void createGroup();
  };
  document.addEventListener(DIAGRAM_ANNOTATION_CREATE_EVENT, onCreateAnnotation);

  return {
    graph,
    cells,
    containers,
    noteCells,
    groupCells,
    dispose: () => {
      document.removeEventListener(DIAGRAM_ANNOTATION_CREATE_EVENT, onCreateAnnotation);
      graph.destroy();
    },
  };
}

/** Per-canvas-type localStorage keys for persisted zoom levels (not workspace-scoped). */
const DOMAIN_ZOOM_KEY = 'koi-domain-diagram';
const CONTEXT_MAP_ZOOM_KEY = 'koi-context-map';
const EVENT_FLOW_ZOOM_KEY = 'koi-event-flow';

/**
 * Mount the interactive chrome around a built canvas: left-drag panning, a zoom control bar (−/%/+/fit),
 * Ctrl/⌘+wheel zoom, and the Outline minimap. Returns a teardown that detaches them. Kept out of
 * buildCanvas so the model stays unit-testable; the visual chrome is verified in the running studio.
 */
function mountChrome(mx: Mx, handle: CanvasHandle, host: HTMLElement, readOnly = false, zoomKey: string = DOMAIN_ZOOM_KEY): { dispose: () => void; fit: () => void; refit: () => void; applyInitialZoom: () => void } {
  const { Outline } = mx;
  const graph = handle.graph;
  // `readOnly` (the context-map canvas) is never an authoring surface regardless of the global editing
  // flag — so panning claims drags anywhere and the authoring controls are omitted.
  const editing = !readOnly && isDiagramEditing();
  // Touch mode (#221 Task 3): freehand manipulation is off, so — like the read-only canvas — a drag
  // anywhere pans (there is no node to drag/connect). `freehand` mirrors buildCanvas: editing AND not-touch.
  const touch = !readOnly && isDiagramTouchMode();
  const freehand = editing && !touch;

  // Left-drag pans. When freehand authoring, panning must NOT claim drags that start on a cell
  // (ignoreCell=false) — otherwise the pan handler eats the drag and a node can never be moved (it just
  // pans the viewport). So: freehand ⇒ drag empty = pan, drag node = move/connect; read-only OR touch ⇒
  // nothing is freehand-movable, so drag anywhere pans (ignoreCell=true). A plain click/tap still registers
  // in every mode (panning needs an actual drag).
  graph.setPanning(true);
  const panning = graph.getPlugin('PanningHandler') as unknown as
    | { useLeftButtonForPanning?: boolean; ignoreCell?: boolean }
    | undefined;
  if (panning) {
    panning.useLeftButtonForPanning = true;
    panning.ignoreCell = !freehand;
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

  // Capture the saved per-diagram zoom ONCE, here at construction — BEFORE `syncPct()` (below) can
  // auto-save the current scale over the key and erase the "nothing saved yet" signal. `applyInitialZoom`
  // reads this captured value so a freshly-opened diagram falls back to the configurable default (#762),
  // not to whatever scale the readout happened to save first. We don't zoom-to it here: the domain canvas
  // applies it via `applyInitialZoom()` and the read-only canvases auto-fit, so a construction-time
  // restore would be immediately overwritten either way.
  const saved = loadDiagramZoom(zoomKey);

  // --- control bar -----------------------------------------------------------
  const controls = document.createElement('div');
  controls.className = 'koi-canvas-controls';
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Diagram zoom controls');

  const pct = document.createElement('span');
  pct.className = 'koi-canvas-zoom-pct';
  pct.setAttribute('aria-live', 'polite');
  // Sync the % readout to the live scale WITHOUT persisting — for scales nobody chose (construction,
  // the read-only fit-on-open fallback). Persisting those would erase the "nothing saved yet" signal
  // that applyInitialZoom's read-only fit() fallback keys on, so the fallback could only ever fire once.
  const showPct = (): void => {
    pct.textContent = `${Math.round(graph.getView().scale * 100)}%`;
  };
  const syncPct = (): void => {
    showPct();
    // Each canvas type persists zoom under its own key (zoomKey). The readOnly save-guard that was here
    // before was only needed because all canvases shared one key ('koi-domain-diagram'); now that every
    // canvas gets its own key, every canvas can save and restore its zoom independently (#769).
    saveDiagramZoom(zoomKey, Math.round(graph.getView().scale * 100));
  };

  // Open the domain canvas at a PREDICTABLE zoom (#762): the per-diagram saved zoom if there is one, else
  // the configurable default (100% out of the box). Centers BOTH axes (without rescaling) so a layout at
  // negative/large coordinates is still framed — the part `fit()` does that we keep — while dropping the
  // rescale-to-fit that made the canvas open at an arbitrary scale (e.g. 114% for the six-context
  // pizzeria). `syncPct()` runs LAST so the `%` readout always equals the resulting `graph.getView().scale`,
  // making `+`/`−`/wheel monotonic from a known starting point. Guarded like `fit()` against a
  // not-yet-measurable DOM. `render()` calls this where it used to call `chrome.fit()`.
  // Read-only canvases (context-map, event-flow): if a saved zoom exists restore it; otherwise fit the
  // content to the viewport (the default "see everything" experience). Domain canvas: saved ?? default.
  // True once applyInitialZoom has framed the canvas at its chosen open zoom WHILE the host was
  // measurable. It signals the ResizeObserver below that the initial 0→measurable transition — which
  // fires when render() inserts this canvas into the DOM, right after applyInitialZoom — has already been
  // framed, so that transition must NOT re-fit: re-fitting there stomped the intended open zoom (#762)
  // with a fit-to-viewport and left the % readout stale. A canvas mounted hidden (mobile zone) is not
  // measurable here, so the flag stays false and the genuine reveal-refit (#529) still fires.
  let initialZoomApplied = false;
  const applyInitialZoom = (): void => {
    // Read-only with no saved zoom: fall back to fit() so the content frames to the viewport. The readout
    // syncs display-only — persisting the fitted scale would count as a chosen zoom and kill the fallback.
    if (saved === null && readOnly) { fit(); showPct(); if (isMeasurable()) initialZoomApplied = true; return; }
    const target = saved ?? getDefaultCanvasZoom();
    try {
      graph.zoomTo(target / 100, false);
      (graph as unknown as { center?: (h?: boolean, v?: boolean) => void }).center?.(true, true);
    } catch {
      /* container not measurable yet — ignore; the readout still syncs to the real scale below */
    }
    syncPct();
    if (isMeasurable()) initialZoomApplied = true;
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
  if (editing) {
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
  showPct();

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
  const buildOutline = (): void => {
    try {
      outline = new Outline(graph, outlineDiv);
    } catch {
      // Outline reads laid-out geometry; under a measure-less headless DOM it may fail — skip it there.
      outline = null;
    }
  };
  buildOutline();
  // If the host was zero-size at construction, the Outline read no geometry and `outlineDiv` stays empty
  // (it renders as an oversized empty box). It's removed only if it could never construct; otherwise it's
  // kept so `refit()` can rebuild it once the host is measurable.
  if (!outline && outlineDiv.childElementCount === 0) outlineDiv.remove();

  // True only when the host has a real, measurable box — false while it sits in a hidden (display:none)
  // zone. Mirrors fit()'s "no-op until measurable" discipline.
  const isMeasurable = (): boolean => {
    const r = host.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // Re-fit + re-lay-out the minimap once the surface is measurable again (#529). The canvas is built once
  // and shown/hidden via CSS, so when a hidden zone (the mobile Diagram tab) is revealed nothing re-frames
  // the content or re-measures the Outline. `refit()` re-frames the VIEW (scale/center) and rebuilds the
  // Outline against the now-sized host — it never reloads the layout or rebuilds nodes, so manual node
  // positions and pan are preserved.
  // Rebuild the minimap against the now-measured host, WITHOUT touching the view scale/center. The
  // Outline reads laid-out geometry at construction; a minimap first built against a zero-size host (the
  // oversized empty box) must be replaced by a correct thumbnail once the surface is measurable. No-op
  // while still hidden: the refit event is broadcast on `document` and can reach a still-hidden sibling
  // canvas (the read-only context-map / event-flow chrome), where rebuilding against a zero-size host
  // would just recreate the empty box — that sibling rebuilds when IT is revealed.
  const rebuildOutline = (): void => {
    if (!isMeasurable()) return;
    if (!outlineDiv.isConnected) host.appendChild(outlineDiv);
    outline?.destroy();
    buildOutline();
  };
  const refit = (): void => {
    fit();
    rebuildOutline();
    showPct(); // keep the % readout truthful after a reframe (display-only: a fit isn't a chosen zoom)
  };

  // A canvas first painted inside a hidden mobile zone mounts at zero size, so `fit()` no-op'd and the
  // Outline read no geometry. Watch the host and refit ONCE when it transitions 0 → measurable, covering
  // every reveal path (mobile zone switch, split toggle, orientation) — not just the mobile-zone event.
  // Guarded to a genuine 0→non-zero transition so it never thrashes on a live user resize/pan/zoom.
  let wasMeasurable = isMeasurable();
  let ro: { disconnect(): void } | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => {
      const measurable = isMeasurable();
      if (measurable && !wasMeasurable) {
        wasMeasurable = true;
        // The FIRST measurable transition is render() inserting this canvas into the DOM, right after
        // applyInitialZoom already framed it (desktop open). Keep that zoom — only rebuild the minimap
        // against the now-measured host and refresh the readout; re-fitting here is what stomped the
        // intended open zoom (#762). Consume the flag so a genuine later hide→reveal still refits (#529).
        // A canvas mounted hidden (mobile) never got the initial framing, so it refits on its reveal.
        if (initialZoomApplied) {
          initialZoomApplied = false;
          rebuildOutline();
          showPct();
        } else {
          refit();
        }
      } else if (!measurable) {
        wasMeasurable = false;
      }
    });
    try {
      observer.observe(host);
      ro = observer;
    } catch {
      /* environments without a working observer — the document event still drives refit */
    }
  }

  // The IDE asks the live canvas to refit when it reveals a hidden zone (#529). Dispatched on `document`
  // (mirroring the annotation-create seam) so it reaches whichever canvas is mounted; a disposed chrome
  // detaches its listener, so only the live canvas responds.
  const onRefit = (): void => refit();
  document.addEventListener(DIAGRAM_REFIT_EVENT, onRefit);

  return {
    dispose: () => {
      host.removeEventListener('wheel', onWheel);
      document.removeEventListener(DIAGRAM_REFIT_EVENT, onRefit);
      ro?.disconnect();
      outline?.destroy();
    },
    fit,
    refit,
    applyInitialZoom,
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
          activeDomainExport = null; // nothing drawn → nothing to export (#271)
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
      // storage) — node positions plus canvas-only annotations. Async — re-check isCurrent() after it so
      // a superseded render bails before touching DOM.
      const savedLayout = await activeLayoutStore().load();
      if (!isCurrent()) return;

      // Build into a detached host so a superseded render never half-paints the live canvas.
      const root = document.createElement('div');
      // `koi-svg-diagram` is kept so the inspector's selection cross-highlight selector still scopes here.
      root.className = 'koi-diagrams koi-diagrams-single koi-svg-diagram';
      const surface = document.createElement('div');
      surface.className = 'koi-canvas';
      root.appendChild(surface);

      // Pass touch-ness as a per-canvas option (fixed for this render) rather than letting buildCanvas read
      // the global; the global getter is still read HERE, at the render call site (and by mountChrome below).
      const handle = buildCanvas(mx, surface, merged, savedLayout, { touch: isDiagramTouchMode() });
      // Chrome (zoom bar + minimap) mounts on `root`, NOT the maxGraph container (`surface`): maxGraph's
      // panGraph reparents every non-SVG child of its container into a shifted preview div while panning
      // (e.g. dragging the minimap), which would yank the controls/minimap to the top-left. Keeping them on
      // the outer wrapper makes them immune. `root` is position:relative (scss) so they still anchor to it.
      const chrome = mountChrome(mx, handle, root, false, DOMAIN_ZOOM_KEY);
      const dispose = (): void => {
        chrome.dispose();
        handle.dispose();
        // Don't leave the export pointer dangling at a torn-down canvas (#271): once this handle is disposed
        // — superseded by a newer render, or the view switched away — Export/Copy-Mermaid must no-op rather
        // than serialize a detached/empty SVG and report a false success.
        if (activeDomainExport?.handle === handle) activeDomainExport = null;
      };

      if (isCurrent()) {
        activeDispose?.();
        activeDispose = dispose;
        // Expose this committed canvas for export (#271): the live handle + a synthesized Diagram carrying
        // the source captions/Mermaid that the merge dropped.
        activeDomainExport = { diagram: synthDomainExportDiagram(selectDomainDiagrams(files), merged), handle };
        container.replaceChildren(root);
        handle.graph.getView().revalidate(); // re-render now that the surface is in the live DOM
        // Open at the saved-or-default zoom, centered — NOT auto-fitted (#762). `fit()` stays the explicit
        // ⤢ "Fit to screen" action and the mobile reveal-refit (#529); only the initial open changes.
        chrome.applyInitialZoom();
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
  /** The view re-rendered its cell states (zoom, pan, or any other scale/translate change) AFTER the
   *  initial mount — maxGraph recreates each cell's HTML label DOM on a view refresh, discarding any
   *  DOM-level marks a caller applied post-paint (`.is-scoped` / `aria-current`, #1210). The caller
   *  re-applies those marks here; NOT called for the initial render (the caller does that itself once
   *  {@link renderContextMapGraph} resolves). */
  onAfterRender?(): void;
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
 *  upstream → downstream edge reads left→right (matching the domain canvas's inner layout). Wrapped so a
 *  measure-less headless DOM can't blank it. */
function runContextMapLayout(mx: Mx, graph: MxGraph): void {
  try {
    const layout = new mx.HierarchicalLayout(graph, UPSTREAM_ORIENTATION);
    layout.intraCellSpacing = 40;
    layout.interRankCellSpacing = 90;
    graph.batchUpdate(() => layout.execute(graph.getDefaultParent()));
  } catch {
    // Unmeasurable DOM (vitest/happy-dom) — the nodes are still present and addressable, just unarranged.
  }
}

/**
 * Render a standalone strategic context-map graph into `container`, reusing {@link buildCanvas} and the
 * pan/zoom/minimap chrome. The map is a READ-ONLY topology view — `buildCanvas`/`mountChrome` are passed
 * `readOnly`, so contexts are never movable / connectable / renamable regardless of the global editing
 * flag (the domain canvas stays editable). A superseded render (`isCurrent()` false) tears itself down
 * rather than clobbering a newer one. Returns a teardown handle (or null when nothing was committed) so
 * the inspector can dispose the canvas on toggle.
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

  const handle = buildCanvas(mx, surface, graph, undefined, { readOnly: true });
  if (graph.edges.length > 0) runContextMapLayout(mx, handle.graph); // override buildCanvas's row with a topology rank
  const chrome = mountChrome(mx, handle, root, true, CONTEXT_MAP_ZOOM_KEY);

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

  const view = handle.graph.getView();
  const rerunAfterRender = (): void => hooks.onAfterRender?.();

  const dispose = (): void => {
    if (hooks.onAfterRender) view.removeListener(rerunAfterRender);
    chrome.dispose();
    handle.dispose();
  };

  if (isCurrent()) {
    container.replaceChildren(root);
    view.revalidate(); // re-render now that the surface is in the live DOM
    // Restore saved zoom when available; fall back to fit() when nothing is saved (#769).
    chrome.applyInitialZoom();
    // Re-run the caller's post-paint DOM marks (`.is-scoped` / `aria-current`) after every LATER view
    // refresh (#1210): maxGraph recreates each cell's HTML label on scale/translate, silently dropping
    // them on the very next zoom or pan. Registered AFTER applyInitialZoom() — whose fit()/zoomTo() path
    // fires these same events synchronously — so onAfterRender genuinely never fires for the initial
    // render (the caller re-applies its own marks once this promise resolves), matching the contract
    // documented on the hook itself. SCALE/TRANSLATE cover a direct view mutation (fit(), programmatic
    // zoomTo); SCALE_AND_TRANSLATE covers the combined centered-zoom path the chrome's +/−/wheel buttons
    // take.
    if (hooks.onAfterRender) {
      for (const evt of [mx.InternalEvent.SCALE, mx.InternalEvent.TRANSLATE, mx.InternalEvent.SCALE_AND_TRANSLATE]) {
        view.addListener(evt, rerunAfterRender);
      }
    }
    return { dispose };
  }
  dispose();
  return null;
}

// --- event flow canvas (event storming; #270) --------------------------------
// A model-derived event-storming flow rendered on the SAME maxGraph engine as the domain canvas: cards
// (command/aggregate/domain-event/policy/integration-event) connected by flow arrows, with integration
// events bridging bounded-context swimlanes via publish/subscribe arrows. It consumes the `extractEventFlow`
// projection (modelTables.ts) — no compiler/LSP round trip. Like the domain canvas, the BUILDER is kept
// free of the async render lifecycle so tests assert on the model (cells/edges), never on pixels.

/** The size of an event-storming card — reuses {@link nodeSize} via a simple-box {@link DiagramNode} shim
 *  (a card has no stereotype/members, so it sizes as a single-line box keyed on its label). */
function eventFlowCardSize(node: EventFlowNode): [number, number] {
  return nodeSize({
    id: node.id,
    label: node.label,
    kind: node.kind,
    qualifiedName: node.qualifiedName,
    sourceSpan: node.span,
    stereotype: null,
    members: [],
  });
}

/** The HTML label for an event-storming card: a simple `.koi-node` box tagged with `data-kind` (the card
 *  kind) and given the kind's sticky colour inline, plus `koi-svg-node` + `data-qname` so the inspector's
 *  selection cross-highlight keeps working (mirrors {@link nodeLabelHtml} for simple nodes). */
function eventFlowCardHtml(node: EventFlowNode): string {
  const color = eventFlowColor(node.kind);
  const kind = escapeHtml(node.kind);
  const qname = escapeHtml(node.qualifiedName);
  return (
    `<div class="koi-node koi-svg-node koi-node--simple koi-eventflow-card" data-kind="${kind}" data-qname="${qname}"` +
    ` style="background:${color};border-color:${color}">${escapeHtml(node.label)}</div>`
  );
}

/** A cell carries an EventFlowNode (a card) iff its value has a `qualifiedName` (edges carry `from`/`to`,
 *  swimlanes carry a plain string). */
function cardValue(cell: MxCell | null | undefined): EventFlowNode | null {
  const v = cell?.value as EventFlowNode | undefined;
  return v && typeof v === 'object' && 'qualifiedName' in v ? v : null;
}

/**
 * The localStorage key for the event-flow canvas's hand-arranged positions (#270). It shares the domain
 * canvas's per-workspace persist SCOPE ({@link diagramPersistScope}, so a layout never bleeds across
 * projects) but a DISTINCT view suffix — `koi-event-flow` vs the domain canvas's `koi-domain-diagram` (see
 * {@link positionKey}). The two views key positions by the SAME qualified names (an event/aggregate appears
 * in both), so a shared key would have each view clobber the other's layout (and a full-layout save would
 * even wipe the domain canvas's notes/groups). A separate key keeps each view's arrangement independent.
 */
function eventFlowPositionKey(): string {
  return `${diagramPersistScope()}:koi-event-flow`;
}

/** Arrange the event flow left→right by its edges — a dependency-ranked {@link HierarchicalLayout} so
 *  command→event→policy reads as a causal chain. Wrapped so a measure-less headless DOM (vitest) can't
 *  blank it — the model is the tested contract. */
function runEventFlowLayout(mx: Mx, graph: MxGraph): void {
  try {
    const layout = new mx.HierarchicalLayout(graph, UPSTREAM_ORIENTATION);
    layout.intraCellSpacing = 40;
    layout.interRankCellSpacing = 80;
    graph.batchUpdate(() => layout.execute(graph.getDefaultParent()));
  } catch {
    // Unmeasurable DOM (vitest/happy-dom) — the cards are still present and addressable, just unarranged.
  }
}

/**
 * Build the event-storming flow canvas for one {@link EventFlowNode}/{@link EventFlowEdge} projection into
 * `container`. Mirrors {@link buildCanvas}: the maxGraph module is injected so this stays synchronous and
 * unit-testable. Cards become one vertex each (coloured by kind); each context referenced by a
 * publish/subscribe arrow (an endpoint that isn't a card) becomes a swimlane vertex the integration events
 * bridge. A card click bubbles {@link NODE_NAVIGATE_EVENT} (the inspector routes it to select-and-goto,
 * exactly like a diagram-node click). A hand-arranged layout persists per element under
 * {@link eventFlowPositionKey} and is re-applied on the next build, so a dragged flow survives a reload.
 * The returned {@link CanvasHandle} reuses the domain-canvas shape so the persist path reuses
 * {@link snapshotPositions} / {@link applySavedPositions}; notes/groups are unused here.
 */
export function buildEventFlowCanvas(
  mx: Mx,
  container: HTMLElement,
  flow: { nodes: EventFlowNode[]; edges: EventFlowEdge[] },
): CanvasHandle {
  const { Graph } = mx;
  const graph = new Graph(container);
  graph.getView().allowEval = false; // CSP-safe (Tauri strict CSP), matching buildCanvas
  graph.setHtmlLabels(true);
  graph.setCellsEditable(false); // no in-place editing — the flow is model-derived
  graph.setCellsResizable(false); // card size is content-derived
  graph.setCellsMovable(true); // cards drag freely — the flow is a layout-only whiteboard (positions persist)

  // Render each cell's value: a card → its event-storming HTML label; an edge → its label; a swimlane → its string.
  graph.convertValueToString = (cell): string => {
    const v = cell.value as EventFlowNode | EventFlowEdge | string | null;
    if (v && typeof v === 'object') {
      if ('qualifiedName' in v) return eventFlowCardHtml(v);
      if ('from' in v && 'to' in v) return v.label ?? '';
    }
    return String(v ?? '');
  };

  // Click a card → bubble NODE_NAVIGATE_EVENT; the inspector selects it + jumps to source. Span-less cards
  // (commands/policies with no declaration today) are inert, mirroring buildCanvas's span-less nodes.
  graph.addListener(mx.InternalEvent.CLICK, (_sender: unknown, evt: { getProperty(name: string): unknown }) => {
    const v = cardValue(evt.getProperty('cell') as MxCell | null);
    if (v && v.span) {
      const s = v.span;
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

  const cells = new Map<string, MxCell>();
  const containers = new Map<string, MxCell>();
  const root = graph.getDefaultParent();
  const cardIds = new Set(flow.nodes.map((n) => n.id));

  // The contexts that need a swimlane: every publish/subscribe endpoint that isn't a card (those are
  // bounded-context names — the integration-event arrows bridge them).
  const swimlaneContexts = new Set<string>();
  for (const e of flow.edges) {
    if (e.kind === 'flow') continue;
    if (!cardIds.has(e.from)) swimlaneContexts.add(e.from);
    if (!cardIds.has(e.to)) swimlaneContexts.add(e.to);
  }

  graph.batchUpdate(() => {
    // A swimlane per bridged context — a faint dashed territory tile (mirrors the domain canvas containers).
    for (const ctx of swimlaneContexts) {
      const cell = graph.insertVertex({
        parent: root,
        id: `ctx:${ctx}`,
        value: ctx.toUpperCase(),
        position: [0, 0],
        size: [CONTEXT_MIN_W, CONTEXT_H],
        style: {
          shape: 'rectangle',
          rounded: true,
          dashed: true,
          dashPattern: '6 5',
          fillColor: 'none',
          strokeColor: 'var(--koi-line)',
          fontColor: 'var(--koi-muted)',
          fontStyle: 1,
          fontSize: 12,
          verticalAlign: 'middle',
          align: 'center',
        },
      });
      containers.set(ctx, cell);
    }

    // Event-storming cards, coloured by kind. The cell SHAPE carries the kind colour (so the Outline minimap
    // shows recognisable boxes); the opaque HTML label overlays it with the same colour.
    for (const node of flow.nodes) {
      const color = eventFlowColor(node.kind);
      const [w, h] = eventFlowCardSize(node);
      const cell = graph.insertVertex({
        parent: root,
        id: node.id,
        value: node,
        position: [0, 0],
        size: [w, h],
        style: { fillColor: color, strokeColor: color, rounded: true, overflow: 'fill', verticalAlign: 'top', align: 'left' },
      });
      cells.set(node.id, cell);
    }

    // Edges: a `flow` arrow (card→card) is solid; `publish`/`subscribe` arrows (swimlane↔card) are dashed so
    // the cross-context bridge reads distinctly. The EventFlowEdge stays on the cell as its value.
    for (const e of flow.edges) {
      const source = cells.get(e.from) ?? containers.get(e.from);
      const target = cells.get(e.to) ?? containers.get(e.to);
      if (!source || !target) continue;
      graph.insertEdge({
        parent: root,
        source,
        target,
        value: e,
        style: {
          edgeStyle: 'orthogonalEdgeStyle', // registered name → CSP-safe (no eval)
          rounded: true,
          strokeColor: 'var(--koi-diagram-edge)',
          strokeWidth: 1.4,
          fontColor: 'var(--koi-fg)',
          startArrow: 'none',
          endArrow: 'open',
          endSize: 11,
          dashed: e.kind !== 'flow', // publish/subscribe bridge arrows read dashed
        },
      });
    }
  });

  runEventFlowLayout(mx, graph);
  // A saved manual layout overrides the auto-arrange, so a hand-positioned flow doesn't snap back on reload.
  applySavedPositions(graph, cells, loadDiagramPositions(eventFlowPositionKey()));

  // Persist a card drag: snapshot every card's geometry (one gesture freezes the layout to manual, matching
  // the domain canvas) and save it under the event-flow key. Attached AFTER layout/apply so neither fires a
  // spurious save (both use setGeometry, not moveCells — but the order keeps the intent clear).
  graph.addListener(mx.InternalEvent.CELLS_MOVED, () => saveDiagramPositions(eventFlowPositionKey(), snapshotPositions(cells)));

  return {
    graph,
    cells,
    containers,
    noteCells: new Map(),
    groupCells: new Map(),
    dispose: () => graph.destroy(),
  };
}

/** A teardown handle for a mounted event-flow canvas (mirrors {@link ContextMapGraphHandle}). */
export interface EventFlowGraphHandle {
  dispose(): void;
}

/**
 * Render a standalone event-flow canvas into `container`, reusing {@link buildEventFlowCanvas} and the
 * pan/zoom/minimap chrome. The Events panel (#270 Task 3) mounts this in its Flow view. A superseded render
 * (`isCurrent()` false) tears itself down rather than clobbering a newer one, and returns null. A dragged
 * card's position persists per element via {@link buildEventFlowCanvas} (#270 Task 4).
 */
export async function renderEventFlowGraph(
  container: HTMLElement,
  flow: { nodes: EventFlowNode[]; edges: EventFlowEdge[] },
  isCurrent: () => boolean,
): Promise<EventFlowGraphHandle | null> {
  let mx: Mx;
  try {
    mx = await getMaxGraph();
  } catch (e) {
    if (isCurrent()) container.innerHTML = `<p class="doc-error">Could not load the diagram renderer: ${escapeHtml(String(e))}</p>`;
    return null;
  }
  if (!isCurrent()) return null;

  const root = document.createElement('div');
  // Deliberately WITHOUT `koi-svg-diagram`: that class scopes the domain canvas's selection cross-highlight,
  // and an event-flow card shouldn't be cross-highlighted from the domain canvas.
  root.className = 'koi-diagrams-single koi-eventflow-graph';
  const surface = document.createElement('div');
  surface.className = 'koi-canvas';
  root.appendChild(surface);

  const handle = buildEventFlowCanvas(mx, surface, flow);
  // Read-only chrome (zoom bar + minimap, no domain authoring controls), but the cards themselves ARE
  // movable: let a drag that starts on a card MOVE it while a drag on empty space pans (the read-only chrome
  // would otherwise pan over a card and the card could never be dragged).
  const chrome = mountChrome(mx, handle, root, true, EVENT_FLOW_ZOOM_KEY);
  const panning = handle.graph.getPlugin('PanningHandler') as unknown as { ignoreCell?: boolean } | undefined;
  if (panning) panning.ignoreCell = false;

  const dispose = (): void => {
    chrome.dispose();
    handle.dispose();
  };

  if (isCurrent()) {
    container.replaceChildren(root);
    handle.graph.getView().revalidate(); // re-render now that the surface is in the live DOM
    // Restore saved zoom when available; fall back to fit() when nothing is saved (#769).
    chrome.applyInitialZoom();
    return { dispose };
  }
  dispose();
  return null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
