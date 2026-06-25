// The renderer↔IDE contract for the domain diagram canvas: the bubbling `CustomEvent` names a renderer
// dispatches, their `detail` shapes, the empty-canvas doorways, and the small module-level state the IDE
// flips into the renderer (editing on/off, per-workspace persist scope). It is deliberately FREE of any
// DOM, any renderer (SVG or maxGraph), and any layout engine — so the IDE-side delegated listeners
// (ide.tsx) and the persistence scope (inspectorController.tsx) couple to this stable contract, not to a
// particular renderer implementation file. Swapping the renderer is then a one-line factory change.

/**
 * The bubbling `CustomEvent` a node group dispatches when clicked (issue #93, Task 4). `ide.ts`
 * listens for it ONCE on the diagrams container (delegated) and jumps the editor caret to the node's
 * `.koi` declaration. Only nodes that carry a source span (i.e. have a `data-line`) dispatch it;
 * span-less nodes stay inert.
 */
export const NODE_NAVIGATE_EVENT = 'koi-diagram-node-click';

/**
 * The `detail` of a {@link NODE_NAVIGATE_EVENT}: the node's qualified name plus its RAW 1-based source
 * span. `file` is the `file://` uri, or `null` when the span had no file. `ide.ts` converts to a
 * 0-based LSP position.
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
  /** The 1-based line of the declaration's name (a rename uses the editor's cross-file rename at this position). */
  line?: number;
  /** The 1-based column of the declaration's name. */
  column?: number;
}

/**
 * Bubbling event the canvas dispatches when the user resets the layout (the "Auto-arrange" button): the
 * saved positions are cleared and `ide.ts` re-renders the diagram so it lays out fresh.
 */
export const DIAGRAM_RELAYOUT_EVENT = 'koi-diagram-relayout';

/**
 * Bubbling event the canvas dispatches when the user drags from one node to another to draw a
 * relationship (authoring). `ide.ts` turns it into an `addField` structured edit — a field on the source
 * whose type is the target — so the new composition round-trips into `.koi` (and re-draws as an edge).
 */
export const DIAGRAM_CONNECT_EVENT = 'koi-diagram-connect';

/** The `detail` of a {@link DIAGRAM_CONNECT_EVENT}: the two endpoints' qualified names + display labels. */
export interface DiagramConnectDetail {
  sourceQualifiedName: string;
  targetQualifiedName: string;
  sourceLabel: string;
  targetLabel: string;
}

/**
 * Bubbling event the canvas dispatches when the user removes a field-backed relationship (right-click an
 * edge). `ide.ts` turns it into a `removeMember` edit on the edge's backing field.
 */
export const DIAGRAM_DISCONNECT_EVENT = 'koi-diagram-disconnect';

/** The `detail` of a {@link DIAGRAM_DISCONNECT_EVENT}: the backing field's qualified name + a label. */
export interface DiagramDisconnectDetail {
  backingMember: string;
  label: string;
}

/**
 * Global event the palette → IDE raises to ask the canvas to create a canvas-only annotation (#255). The
 * renderer — the only holder of the live graph + current selection — prompts for the note text / group
 * label, places the cell behind the nodes, and persists it. Dispatched on `document` so it reaches the
 * active canvas wherever it mounted. No `.koi` round-trip: annotations are a pure view concern.
 */
export const DIAGRAM_ANNOTATION_CREATE_EVENT = 'koi-canvas-annotation-create';

/** The `detail` of a {@link DIAGRAM_ANNOTATION_CREATE_EVENT}: which annotation kind to author. */
export interface DiagramAnnotationCreateDetail {
  kind: CanvasAnnotationKind;
}

/** The DDD constructs the canvas palette can author. Mirrors the construct keyword the compiler's
 *  `addType` edit carries in `StructuredEdit.Type`. */
export type AddNodeKind = 'aggregate' | 'entity' | 'value' | 'enum' | 'event' | 'service';

/**
 * Constructs that live INSIDE an aggregate (#254): the palette inserts them into the SELECTED aggregate
 * via the compiler's `addAggregateMember` edit (carried in `StructuredEdit.Type`), not the context-scoped
 * `addType`. `repository` adds the root's repository block; `rule` adds an aggregate-scoped `spec` — a
 * named, reusable boolean rule over the root.
 */
export type AggregateMemberKind = 'repository' | 'rule';

/**
 * The three doorways the empty-canvas state offers. Each maps to a starting `.koi` shape (ide.tsx seeds
 * a guaranteed-valid starter for the picked kind), so a brand-new model can fill its canvas in one click.
 */
export type EmptyConceptKind = 'aggregate' | 'stateMachine' | 'contextMap';

/**
 * Bubbling event a concept tile in the empty-canvas state dispatches when chosen. `ide.ts` listens once
 * on the diagrams container and seeds the matching starter into the active buffer, which re-renders the
 * canvas with real nodes.
 */
export const EMPTY_STATE_PICK_EVENT = 'koi-canvas-empty-pick';

/** The `detail` of an {@link EMPTY_STATE_PICK_EVENT}: which doorway the modeller picked. */
export interface EmptyStatePickDetail {
  kind: EmptyConceptKind;
}

/**
 * Whether diagram nodes accept drag-to-edit gestures (issue #93, Task 5). Off by default so the
 * read-only Diagrams tab is byte-identical when editing is off; `ide.ts` flips it on once the
 * model→`.koi` round-trip seam (#91) is reachable.
 */
let editingEnabled = false;

/** Enable/disable drag-to-edit gestures on diagram nodes. */
export function setDiagramEditing(enabled: boolean): void {
  editingEnabled = enabled;
}

/** Whether drag-to-edit gestures are currently enabled (read by the active renderer). */
export function isDiagramEditing(): boolean {
  return editingEnabled;
}

/**
 * Whether the canvas is in TOUCH mode (issue #221, Task 3): the mobile presentation where freehand
 * gestures are disabled (no drag-to-move, drag-to-connect, double-click-rename or right-click-delete) so a
 * single tap selects/navigates a node instead and a drag pans the viewport. Off by default — `ide.ts`
 * flips it on below `$bp-narrow` and off above it. Deliberately INDEPENDENT of {@link isDiagramEditing}:
 * the mobile shell stays editing-capable (the palette + auto-arrange still author), it just swaps freehand
 * manipulation for tap-to-edit. The renderer reads this alongside the editing flag when wiring gestures.
 */
let touchMode = false;

/** Enable/disable touch (tap-to-edit) presentation on the diagram canvas. */
export function setDiagramTouchMode(on: boolean): void {
  touchMode = on;
}

/** Whether the canvas is currently in touch mode (read by the active renderer). */
export function isDiagramTouchMode(): boolean {
  return touchMode;
}

/**
 * The per-workspace scope for persisted node positions (the authoring canvas). `ide.ts` sets it to the
 * folder identity (or 'scratch') before each render so positions never bleed across projects.
 */
let persistScope = 'scratch';

/** Set the workspace scope for persisted node positions (folder identity, or 'scratch'). */
export function setDiagramPersistScope(scope: string): void {
  persistScope = scope || 'scratch';
}

/** The current per-workspace persist scope (folder identity, or 'scratch'). */
export function diagramPersistScope(): string {
  return persistScope;
}

/** The storage key for the unified domain canvas's node positions, scoped to the active workspace. */
export function positionKey(): string {
  return `${persistScope}:koi-domain-diagram`;
}

/**
 * Whether a node kind can be renamed via the diagram: a real construct (never the empty/unknown kind),
 * never a bounded context, and never a state-machine pseudo-state. The canonical editability rule shared
 * by the renderer's rename gesture and (historically) the SVG renderer. Delete is broader — see the
 * renderer's `canDelete` (anything owned and non-context).
 */
export function isEditableKind(kind: string): boolean {
  return kind !== '' && kind !== 'context' && kind !== 'state';
}

/** A persisted node position on the authoring canvas (relative to the node's parent container). */
export interface DiagramPosition {
  x: number;
  y: number;
}

/**
 * A free-text canvas annotation: text plus a position/size in diagram content coordinates. Canvas-only —
 * it has NO `.koi` backing and is never written to source; it persists alongside node positions in
 * `koine.layout.json` (folder mode) or localStorage (browser mode). See issue #255 / the #148 go/no-go.
 */
export interface DiagramNote {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A labelled grouping of nodes drawn as a region behind them. Canvas-only (no `.koi` backing). Only the
 * membership + styling persist; the rendered rectangle is DERIVED from the bounding box of the member
 * nodes' positions, so a group follows its members as they move.
 */
export interface DiagramGroup {
  id: string;
  label: string;
  /** Qualified names of the member nodes the group encloses. */
  members: string[];
  /** Optional accent-colour key for the group's fill/border (a CSS custom-property suffix). */
  color?: string;
}

/**
 * The canvas-only annotation kinds the palette can author. Deliberately DISTINCT from {@link AddNodeKind}
 * (which round-trips a construct into `.koi`): notes and groups live only in the layout file.
 */
export type CanvasAnnotationKind = 'note' | 'group';

/** The full persisted authoring-canvas layout: node positions plus the canvas-only annotations. */
export interface DiagramLayout {
  positions: Record<string, DiagramPosition>;
  notes: DiagramNote[];
  groups: DiagramGroup[];
}

/** A fresh, empty layout (the "nothing saved" value every backend returns on a miss). */
export function emptyDiagramLayout(): DiagramLayout {
  return { positions: {}, notes: [], groups: [] };
}

/** True for a finite number (the coordinate guard shared by the annotation sanitizers). */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Coerce an unknown into a valid {@link DiagramNote}[], dropping malformed entries — the defensive parse
 * for both the committable `koine.layout.json` and the browser-storage blob (either may be hand-edited).
 */
export function sanitizeNotes(value: unknown): DiagramNote[] {
  if (!Array.isArray(value)) return [];
  const out: DiagramNote[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const n = item as Record<string, unknown>;
    if (typeof n.id !== 'string' || n.id.length === 0) continue;
    if (typeof n.text !== 'string') continue;
    if (!isFiniteNumber(n.x) || !isFiniteNumber(n.y) || !isFiniteNumber(n.width) || !isFiniteNumber(n.height)) continue;
    out.push({ id: n.id, text: n.text, x: n.x, y: n.y, width: n.width, height: n.height });
  }
  return out;
}

/** Coerce an unknown into a valid {@link DiagramGroup}[], dropping malformed entries (see {@link sanitizeNotes}). */
export function sanitizeGroups(value: unknown): DiagramGroup[] {
  if (!Array.isArray(value)) return [];
  const out: DiagramGroup[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const g = item as Record<string, unknown>;
    if (typeof g.id !== 'string' || g.id.length === 0) continue;
    if (typeof g.label !== 'string') continue;
    if (!Array.isArray(g.members)) continue;
    const members = g.members.filter((m): m is string => typeof m === 'string' && m.length > 0);
    const group: DiagramGroup = { id: g.id, label: g.label, members };
    if (typeof g.color === 'string' && g.color.length > 0) group.color = g.color;
    out.push(group);
  }
  return out;
}

/**
 * The persistence backend for the authoring canvas's layout — node positions PLUS the canvas-only
 * annotations (notes, groups). The IDE injects the concrete store (a committable `koine.layout.json` at
 * the models-folder root when a folder is open, else browser storage) via {@link setDiagramLayoutStore}
 * before each render; the renderer reads it to restore a saved layout, to persist a drag or an
 * annotation edit, and to reset on "Auto-arrange". Positions are keyed by qualified name; annotations
 * carry their own ids. Everything here is a VIEW concern — it never round-trips into `.koi`.
 */
export interface DiagramLayoutStore {
  /** Load the saved layout (empty positions/notes/groups when none / unreadable). */
  load(): Promise<DiagramLayout>;
  /** Persist the full layout (the backend decides immediate vs debounced). */
  save(layout: DiagramLayout): void;
  /** Reset the saved node positions (the "Auto-arrange" re-layout); canvas annotations are PRESERVED. */
  clear(): void;
}

let layoutStore: DiagramLayoutStore | null = null;

/** Inject the layout-persistence backend for the active workspace (null ⇒ the renderer falls back to
 *  browser storage keyed by {@link positionKey}). Set by `inspectorController` before each render. */
export function setDiagramLayoutStore(store: DiagramLayoutStore | null): void {
  layoutStore = store;
}

/** The injected layout store, or null when none is set (the renderer then uses a browser-storage fallback). */
export function diagramLayoutStore(): DiagramLayoutStore | null {
  return layoutStore;
}
