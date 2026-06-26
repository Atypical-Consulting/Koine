// The DDD "Domain" navigator (issue #453): a left-rail tree that lets a Domain Developer / Architect
// move through the model the way DDD itself is layered — STRATEGIC first (the bounded contexts and the
// relationships between them) and drill into TACTICAL (a context's aggregates and their internals) on
// demand. This file owns the *strategic* altitude: the list of bounded contexts plus two "doorway" rows
// into the cross-context views (Context Map, Ubiquitous Language).
//
// Pure DOM builders decoupled from the LSP/editor via a `handlers` object, so they unit-test cleanly
// under happy-dom — mirroring `modelOutline.ts` / `glossary.ts`. The counts shown here are NOT computed
// independently: they reuse `countsByContext` (the one tally source shared with the Model outline), so
// the two navigators can never disagree on a context's size.
import type { ContextMapResult, GlossaryModel, ModelNode } from '@/lsp/lsp';
import { constructForKind, countsByContext, type ModelOutlineHandlers } from '@/model/modelOutline';
import { filterGlossaryModel, isAllContexts } from '@/model/activeContext';
import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';

/** Wiring for the strategic level — what each row does when activated. Supplied by the rail controller
 * (Task 3) so this renderer stays free of LSP/editor concerns. */
export interface StrategicHandlers {
  /** Drill into a bounded context's tactical view (its aggregates and internals). */
  onOpenContext(ctx: string): void;
  /** Open the Context Map view (the cross-context relationship graph). */
  onOpenContextMap(): void;
  /** Open the Ubiquitous Language glossary view. */
  onOpenGlossary(): void;
}

/** A bounded context's total construct count — the sum of its present construct buckets. Reuses
 * {@link countsByContext} so the badge here and the Model outline's tallies share one source of truth. */
function totalConstructs(counts: { count: number }[]): number {
  return counts.reduce((sum, c) => sum + c.count, 0);
}

/** A small decorative glyph (e.g. the `◈` context diamond, the `⤳` map arrow). Hidden from assistive
 * tech — the surrounding row text already names the destination. */
function glyph(symbol: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'koi-domain-glyph';
  span.setAttribute('aria-hidden', 'true');
  span.textContent = symbol;
  return span;
}

/** One bounded-context row: a `◈` glyph, the context name, and a total-construct count badge. Clicking
 * drills into the context's tactical view. The whole row IS the button, carrying `data-ctx` so the rail
 * controller can address it for cross-axis highlighting (Task 5). */
function contextRow(context: string, total: number, h: StrategicHandlers): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'koi-ctx-row';
  row.dataset.ctx = context;
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-label', `${context}, ${total} construct${total === 1 ? '' : 's'}`);

  const name = document.createElement('span');
  name.className = 'koi-ctx-name';
  name.textContent = context;

  const count = document.createElement('span');
  count.className = 'koi-ctx-count';
  count.textContent = String(total);

  row.append(glyph('◈'), name, count);
  row.addEventListener('click', () => h.onOpenContext(context));
  return row;
}

/** A "doorway" row into a cross-context view (Context Map, Ubiquitous Language): a glyph, a label, and
 * an optional trailing count badge (e.g. the number of context-map relationships). */
function doorwayRow(opts: {
  door: string;
  symbol: string;
  label: string;
  count?: number;
  onOpen: () => void;
}): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'koi-domain-door';
  row.dataset.door = opts.door;
  row.setAttribute('role', 'treeitem');

  const label = document.createElement('span');
  label.className = 'koi-domain-door-label';
  label.textContent = opts.label;
  row.append(glyph(opts.symbol), label);

  if (opts.count != null) {
    const count = document.createElement('span');
    count.className = 'koi-domain-door-count';
    count.textContent = String(opts.count);
    row.appendChild(count);
  }

  row.addEventListener('click', opts.onOpen);
  return row;
}

/**
 * Build the strategic-level Domain navigator: one `◈` row per bounded context (with its total-construct
 * count badge), then the `⤳ Context Map` and `▤ Ubiquitous Language` doorway rows. `relLinks` is the
 * number of context-map relationships (the caller passes it in — this renderer never fetches it).
 */
export function renderStrategic(model: GlossaryModel, relLinks: number, h: StrategicHandlers): HTMLElement {
  const root = document.createElement('div');
  root.className = 'koi-domain koi-domain-strategic';
  root.setAttribute('role', 'tree');
  root.setAttribute('aria-label', 'Domain');

  for (const { context, counts } of countsByContext(model)) {
    root.appendChild(contextRow(context, totalConstructs(counts), h));
  }

  const doors = document.createElement('div');
  doors.className = 'koi-domain-doors';
  doors.appendChild(
    doorwayRow({ door: 'contextmap', symbol: '⤳', label: 'Context Map', count: relLinks, onOpen: h.onOpenContextMap }),
  );
  doors.appendChild(
    doorwayRow({ door: 'glossary', symbol: '▤', label: 'Ubiquitous Language', onOpen: h.onOpenGlossary }),
  );
  root.appendChild(doors);

  return root;
}

// --- the mounted navigator: outside-in drill-to-scope + breadcrumb (#453) -----------------------------
// renderStrategic above is a pure builder; mountDomainNavigator is the LIVE component that owns the
// rail's Domain pane: it reads the store for the current altitude (strategic vs tactical) + scope, paints
// the matching level, and re-paints when those change — the store being the single source of truth so a
// scope switch or a breadcrumb click stays consistent with every other scoped surface (#146).

/** The slim LSP surface the navigator fetches from: the glossary inventory (the strategic context list +
 * per-context counts), the context map (only its relation count is read), and the structured model graph
 * ({@link ModelNode}) the TACTICAL tree walks. A structural interface, so the controller's richer client
 * and a test stub both satisfy it without coupling to the full class. */
export interface DomainNavigatorLsp {
  glossaryModel(): Promise<GlossaryModel>;
  contextMap(): Promise<ContextMapResult>;
  /** The whole structured model graph (root `kind: 'model'` → bounded-context children) — the tactical tree's source. */
  model(): Promise<ModelNode>;
}

/** Wiring for the tactical level — what a leaf (an owned construct or a context-level peer) does when
 * activated, plus the cross-axis links (#453, Task 5). The leaves carry their `data-construct` /
 * `data-name` and `qualifiedName`, so a click resolves to a model element without re-rendering the tree.
 * Supplied by the rail controller, which owns the inspector / editor / Files-axis seams. */
export interface TacticalHandlers {
  /** Select a tactical node — drives the inspector + cross-highlight. */
  onSelect(node: ModelNode): void;
  /** Jump to a node's declaration (the controller resolves the node → 1-based source position). */
  goto(node: ModelNode): void;
  /** Reveal the node's bounded context in the Files axis (the leaf calls {@link setAxis} first). */
  reveal(node: ModelNode): void;
  /** Switch the rail's active navigator axis (the DDD Domain view vs the workspace Files tree). */
  setAxis(axis: 'domain' | 'files'): void;
}

/** A harmless no-op handler set, so a bare {@link mountDomainNavigator} (the unit test) does nothing. */
function noopTacticalHandlers(): TacticalHandlers {
  return { onSelect: () => {}, goto: () => {}, reveal: () => {}, setAxis: () => {} };
}

/**
 * The wiring the rail controller passes in — its `modelOutlineHandlers` verbatim: the two STRATEGIC
 * doorways (`onOpenContextMap` / `onOpenGlossary`, routed to focusContextMap() / focusDocs()) plus the
 * TACTICAL leaf hooks (`onSelect` / `goto`) Task 4 threads through {@link renderTactical}. All optional, so
 * a bare mount (the unit test) is a harmless no-op set.
 */
export type DomainNavigatorHandlers = Partial<ModelOutlineHandlers>;

/** The live handle a mounted navigator returns. {@link reload} re-fetches the strategic data after a
 * model edit; {@link unmount} drops the store subscription so a torn-down host stops re-rendering. */
export interface DomainNavigatorHandle {
  reload(): void;
  unmount(): void;
}

/**
 * Mount the live Domain navigator into `host`: paint the STRATEGIC context list (from {@link renderStrategic})
 * while the store's `navAltitude` is `'strategic'`, and the TACTICAL view (a breadcrumb + the scoped
 * context's body) once a row is drilled into. Clicking a context narrows the scope AND descends to
 * tactical; the breadcrumb climbs back. Re-renders on `navAltitude` / `activeContext` / `outlineFilter`
 * changes (synchronously, from a cached fetch), and {@link DomainNavigatorHandle.reload} re-fetches after
 * an edit. The store is the single source of truth for altitude + scope.
 */
export function mountDomainNavigator(
  host: HTMLElement,
  store: StoreApi<AppState>,
  lsp: DomainNavigatorLsp,
  handlers: DomainNavigatorHandlers = {},
  tacticalHandlers: TacticalHandlers = noopTacticalHandlers(),
): DomainNavigatorHandle {
  // The navigator data is fetched once and cached; store-driven changes (altitude / scope / filter)
  // re-render synchronously from the cache, and reload() re-fetches after an edit. `null` = not yet
  // loaded (a loading placeholder shows). A monotonic seq drops a superseded fetch (last write wins).
  // `tree` is the structured model graph the TACTICAL view walks (best-effort: `null` if it failed).
  let cache: { model: GlossaryModel; relLinks: number; tree: ModelNode | null } | null = null;
  let fetchSeq = 0;

  const strategicHandlers: StrategicHandlers = {
    // Drilling in is one gesture across two store fields: narrow the scope AND descend to tactical. The
    // store subscription below repaints the navigator (the breadcrumb + the context's tactical body).
    onOpenContext: (ctx) => {
      const s = store.getState();
      s.setActiveContext(ctx);
      s.setNavAltitude('tactical');
    },
    onOpenContextMap: () => handlers.onOpenContextMap?.(),
    onOpenGlossary: () => handlers.onOpenGlossary?.(),
  };

  function render(): void {
    const s = store.getState();
    // Tactical only when a real context is in scope; the unscoped sentinel falls back to strategic.
    if (s.navAltitude === 'tactical' && !isAllContexts(s.activeContext)) {
      // Resolve the scoped context's node from the cached model graph; a missing node (not yet fetched,
      // or absent) yields an empty tactical body under the breadcrumb rather than a crash.
      const ctxNode = findContextNode(cache?.tree, s.activeContext);
      host.replaceChildren(renderTacticalView(s.activeContext, store, ctxNode, tacticalHandlers));
      return;
    }
    if (!cache) {
      host.replaceChildren(message('koi-domain-loading', 'Loading domain…'));
      return;
    }
    if (!cache.model.entries.length) {
      host.replaceChildren(
        message('koi-domain-empty', 'No elements yet — declare some types, or fix syntax errors to populate the model.'),
      );
      return;
    }
    // The type-to-filter box narrows the strategic context list (a context drops out once none of its
    // constructs match) — the same filter the Explorer outline uses, so the two never disagree.
    const model = filterGlossaryModel(cache.model, s.outlineFilter);
    host.replaceChildren(renderStrategic(model, cache.relLinks, strategicHandlers));
  }

  async function doFetch(): Promise<void> {
    const seq = ++fetchSeq;
    try {
      // The model graph is fetched alongside the strategic data (and degrades to an empty tactical tree
      // on its own failure) so a drill-in repaints synchronously from cache, like every other altitude.
      const [model, contextMap, tree] = await Promise.all([
        lsp.glossaryModel(),
        lsp.contextMap(),
        lsp.model().catch(() => null),
      ]);
      if (seq !== fetchSeq) return; // a newer reload superseded this fetch
      cache = { model, relLinks: contextMap.relations.length, tree };
    } catch {
      if (seq !== fetchSeq) return;
      cache = { model: { entries: [] }, relLinks: 0, tree: null }; // best-effort: render the empty strategic state
    }
    render();
  }

  // Re-render only when the navigator's own inputs change reference — altitude, scope, or the outline
  // filter — mirroring the controller's `subscribe((s, prev) => …)` discipline (an unrelated slice write
  // doesn't repaint the navigator).
  const unsubscribe = store.subscribe((s, prev) => {
    if (
      s.navAltitude === prev.navAltitude &&
      s.activeContext === prev.activeContext &&
      s.outlineFilter === prev.outlineFilter
    ) {
      return;
    }
    render();
  });

  render(); // paint the loading placeholder (or the cache, if a reload pre-seeded it) right away
  void doFetch(); // then fetch the strategic data and repaint

  return {
    reload: () => void doFetch(),
    unmount: () => unsubscribe(),
  };
}

/**
 * The TACTICAL view for a bounded context: a breadcrumb that zooms back to the strategic context list,
 * then the context's aggregate-centric body ({@link renderTactical}). The breadcrumb is owned here; the
 * body walks `ctxNode` (the context's structured model node, or `null` while it loads / when absent).
 */
function renderTacticalView(
  context: string,
  store: StoreApi<AppState>,
  ctxNode: ModelNode | null,
  h: TacticalHandlers,
): HTMLElement {
  const root = document.createElement('div');
  root.className = 'koi-domain koi-domain-tactical';

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'koi-breadcrumb-back';
  back.setAttribute('aria-label', `Back to all contexts (in ${context})`);
  const name = document.createElement('span');
  name.className = 'koi-breadcrumb-back-name';
  name.textContent = context;
  back.append(glyph('‹'), name);
  back.addEventListener('click', () => store.getState().setNavAltitude('strategic'));
  root.appendChild(back);

  root.appendChild(renderTactical(ctxNode, h));
  return root;
}

/** Find the bounded-context node for `context` in the model graph: the root's `kind: 'context'` child
 * whose name matches. The graph names a context by both `title` and `qualifiedName`, so match either. */
function findContextNode(root: ModelNode | null | undefined, context: string): ModelNode | null {
  return (
    root?.children.find((c) => c.kind === 'context' && (c.title === context || c.qualifiedName === context)) ??
    null
  );
}

/** A small shape-coded construct glyph, keyed by the slug the shared grammar ({@link constructForKind})
 * resolves — the SAME `.koi-model-icon[data-construct]` the Explorer outline + diagram nodes wear, so a
 * value object reads as the same blue lozenge everywhere. */
function constructGlyph(slug: string): HTMLElement {
  const icon = document.createElement('span');
  icon.className = 'koi-model-icon';
  icon.dataset.construct = slug;
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

/** One tactical leaf — an owned construct (under an aggregate) or a context-level peer. The row IS the
 * `treeitem`; inside it the activation button (`.koi-tactical-leaf`, carrying `data-construct` + `data-name`
 * so a click resolves to the model element + cross-highlights) selects-and-jumps, and a trailing `⋯`
 * overflow opens the cross-axis menu ("Reveal in Files", #453). Icon first, then the name text, so
 * `leaf.textContent === node.title`. */
function tacticalLeaf(node: ModelNode, h: TacticalHandlers): HTMLElement {
  const { slug } = constructForKind(node.kind);
  const row = document.createElement('div');
  row.className = 'koi-tactical-leaf-row';
  row.setAttribute('role', 'treeitem');

  const leaf = document.createElement('button');
  leaf.type = 'button';
  leaf.className = 'koi-tactical-leaf';
  leaf.dataset.construct = slug;
  leaf.dataset.name = node.title;
  leaf.append(constructGlyph(slug), node.title);
  leaf.addEventListener('click', () => {
    h.onSelect(node);
    h.goto(node);
  });

  row.append(leaf, leafOverflowButton(node, h));
  return row;
}

/** The per-leaf `⋯` overflow: a real, keyboard-activatable button that opens a small menu of cross-axis
 * actions for the node. Today the menu holds a single item — "Reveal in Files" — which switches the rail
 * to the Files axis ({@link TacticalHandlers.setAxis}) and reveals the node's `.koi` ({@link
 * TacticalHandlers.reveal}). Full keyboard tree-nav is Task 6; this stays accessible (aria-haspopup +
 * an arrow/Escape-navigable menu) without pre-building it. */
function leafOverflowButton(node: ModelNode, h: TacticalHandlers): HTMLElement {
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'koi-tactical-more';
  more.textContent = '⋯';
  more.setAttribute('aria-label', `Actions for ${node.title}`);
  more.setAttribute('aria-haspopup', 'menu');
  more.setAttribute('aria-expanded', 'false');
  more.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openLeafMenu(more, node, h);
  });
  return more;
}

// The single floating leaf menu (mounted to document.body and reused), mirroring the explorer's context
// menu: positioned at the trigger, dismissed on outside-click / Escape / action, with focus returned to
// the trigger. Module-scoped so opening one closes any other.
let leafMenuEl: HTMLElement | null = null;
let leafMenuTrigger: HTMLElement | null = null;

function closeLeafMenu(): void {
  if (!leafMenuEl) return;
  leafMenuEl.remove();
  leafMenuEl = null;
  document.removeEventListener('pointerdown', onLeafMenuPointerDown, true);
  document.removeEventListener('keydown', onLeafMenuKeydown, true);
  const trigger = leafMenuTrigger;
  leafMenuTrigger = null;
  if (trigger) {
    trigger.setAttribute('aria-expanded', 'false');
    if (trigger.isConnected) trigger.focus();
  }
}

function onLeafMenuPointerDown(ev: PointerEvent): void {
  if (leafMenuEl && !leafMenuEl.contains(ev.target as Node)) closeLeafMenu();
}

function onLeafMenuKeydown(ev: KeyboardEvent): void {
  if (!leafMenuEl) return;
  const items = Array.from(leafMenuEl.querySelectorAll<HTMLElement>('.koi-tactical-menu-item'));
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (ev.key === 'Escape' || ev.key === 'Tab') {
    ev.preventDefault();
    closeLeafMenu();
  } else if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    items[Math.min(items.length - 1, i + 1)]?.focus();
  } else if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    items[Math.max(0, i - 1)]?.focus();
  }
}

function openLeafMenu(trigger: HTMLElement, node: ModelNode, h: TacticalHandlers): void {
  closeLeafMenu();
  const menu = document.createElement('ul');
  menu.className = 'koi-tactical-menu';
  menu.setAttribute('role', 'menu');
  const rect = trigger.getBoundingClientRect();
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.bottom}px`;

  const li = document.createElement('li');
  li.setAttribute('role', 'none');
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'koi-tactical-menu-item';
  item.setAttribute('role', 'menuitem');
  item.textContent = 'Reveal in Files';
  item.addEventListener('click', () => {
    closeLeafMenu();
    h.setAxis('files');
    h.reveal(node);
  });
  li.appendChild(item);
  menu.appendChild(li);

  leafMenuTrigger = trigger;
  trigger.setAttribute('aria-expanded', 'true');
  document.body.appendChild(menu);
  leafMenuEl = menu;
  item.focus();
  document.addEventListener('pointerdown', onLeafMenuPointerDown, true);
  document.addEventListener('keydown', onLeafMenuKeydown, true);
}

/** One aggregate node: a head row (the `⬡` aggregate glyph + name, carrying the aggregate's qualified
 * name) with its owned constructs nested beneath in a {@link tacticalLeaf} spine, so ownership reads as
 * containment. The container carries `data-qname` for Task 5's cross-highlight; the head is the selectable
 * row for the aggregate itself. */
function aggregateNode(agg: ModelNode, h: TacticalHandlers): HTMLElement {
  const node = document.createElement('div');
  node.className = 'koi-agg';
  node.dataset.qname = agg.qualifiedName;
  node.setAttribute('role', 'treeitem');
  node.setAttribute('aria-expanded', 'true');

  const { slug } = constructForKind(agg.kind);
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'koi-agg-head';
  head.dataset.construct = slug;
  const headName = document.createElement('span');
  headName.className = 'koi-agg-name';
  headName.textContent = agg.title;
  head.append(constructGlyph(slug), headName);
  head.addEventListener('click', () => {
    h.onSelect(agg);
    h.goto(agg);
  });
  node.appendChild(head);

  // The owned constructs (entity / value / enum / event / state machine), nested in a bracketed spine
  // that makes the aggregate's boundary visible.
  const spine = document.createElement('div');
  spine.className = 'koi-agg-spine';
  spine.setAttribute('role', 'group');
  for (const child of agg.children) spine.appendChild(tacticalLeaf(child, h));
  node.appendChild(spine);
  return node;
}

/**
 * The TACTICAL body for a bounded context — aggregate-centric: each `aggregate` child becomes a node with
 * its owned constructs nested beneath ({@link aggregateNode}); every OTHER top-level child (a value object,
 * enum, event, … declared at the context level rather than inside an aggregate) is a peer under a quiet
 * `context` divider — no orphan "Aggregates" header. A `null`/empty `ctxNode` (loading, or a context with
 * no declarations) renders an empty body, not a crash.
 */
export function renderTactical(ctxNode: ModelNode | null | undefined, h: TacticalHandlers): HTMLElement {
  const body = document.createElement('div');
  body.className = 'koi-domain-tactical-body';
  body.setAttribute('role', 'tree');
  if (ctxNode) body.setAttribute('aria-label', `${ctxNode.title} aggregates`);

  const children = ctxNode?.children ?? [];
  const aggregates = children.filter((c) => c.kind === 'aggregate');
  const peers = children.filter((c) => c.kind !== 'aggregate');

  for (const agg of aggregates) body.appendChild(aggregateNode(agg, h));

  if (peers.length) {
    const peerGroup = document.createElement('div');
    peerGroup.className = 'koi-ctx-peers';
    peerGroup.setAttribute('role', 'group');
    for (const peer of peers) peerGroup.appendChild(tacticalLeaf(peer, h));
    body.appendChild(peerGroup);
  }

  if (!aggregates.length && !peers.length) {
    const note = document.createElement('p');
    note.className = 'muted koi-tactical-empty';
    note.textContent = 'No aggregates or types here yet.';
    body.appendChild(note);
  }
  return body;
}

/** A muted status/empty line for the navigator host (loading / no-model states). */
function message(className: string, text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = `muted ${className}`;
  p.textContent = text;
  return p;
}
