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
import { constructForKind, constructIcon, countsByContext, type ModelOutlineHandlers } from '@/model/modelOutline';
import { filterGlossaryModel, isAllContexts } from '@/model/activeContext';
import { createFloatingMenu } from '@/shared/floatingMenu';
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

// --- keyboard model: the WAI-ARIA tree pattern (roving tabindex) (#453, Task 6) ---------------------
// Both levels are `role="tree"`s of `role="treeitem"` rows, navigated with Arrow/Home/End and a SINGLE
// tab stop (roving tabindex), mirroring the Files explorer's `visibleItems`/`focusItem`/`onRowKeydown`.
// The navigator's trees never collapse a branch (aggregates render expanded; the filter removes
// non-matching rows from the DOM), so every rendered treeitem is visible and DOM order IS visual order.

/** The visible treeitems of a `role="tree"`, in DOM (visual) order. */
function treeItems(tree: HTMLElement): HTMLElement[] {
  return Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]'));
}

/** Seed/refresh the roving tabindex: every inner control leaves the tab order and exactly one treeitem
 * (the active one, else the first) becomes the lone tab stop — so the whole tree is ONE Tab landing. */
function setRovingItem(tree: HTMLElement, active: HTMLElement | null): void {
  // Inner controls (the leaf activator, the ⋯ overflow, the aggregate head) leave the sequential tab
  // order; mouse clicks still work, and keyboard activation is forwarded from the focused treeitem.
  for (const btn of tree.querySelectorAll<HTMLElement>('button')) btn.tabIndex = -1;
  const items = treeItems(tree);
  const tabbable = active && items.includes(active) ? active : (items[0] ?? null);
  for (const item of items) item.tabIndex = item === tabbable ? 0 : -1;
}

/** Move roving focus to `item` — a single tabbable treeitem at a time, then `.focus()` it. */
function focusTreeItem(tree: HTMLElement, item: HTMLElement): void {
  setRovingItem(tree, item);
  item.focus();
}

/** Wire the WAI-ARIA tree keyboard model onto a `role="tree"` root: roving tabindex (one tab stop) plus
 * ArrowDown/Up across the visible treeitems, Home/End to the first/last, and Enter/Space to activate the
 * focused row (a treeitem that is itself a `<button>` activates natively; a wrapper row forwards to its
 * primary control). The listener is delegated on the root, so a keydown bubbling from any focused row —
 * or dispatched on the root itself — is handled in one place. */
function wireTreeNav(tree: HTMLElement): void {
  setRovingItem(tree, null); // seed the first treeitem as the single tab stop
  tree.addEventListener('keydown', (ev) => {
    const items = treeItems(tree);
    if (!items.length) return;
    const focused = document.activeElement as HTMLElement | null;
    const current =
      (ev.target as HTMLElement | null)?.closest<HTMLElement>('[role="treeitem"]') ??
      focused?.closest<HTMLElement>('[role="treeitem"]') ??
      null;
    // Context-menu affordance: the dedicated ContextMenu key (or Shift+F10) opens the focused row's `⋯`
    // overflow, so keyboard users reach its cross-axis actions ("Reveal in Files") the mouse gets from the
    // `⋯` button (which roving tabindex keeps out of the tab order).
    if (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) {
      const more = current?.querySelector<HTMLElement>('.koi-tactical-more');
      if (more) {
        ev.preventDefault();
        more.click();
      }
      return;
    }
    const idx = current ? items.indexOf(current) : -1;
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault();
        focusTreeItem(tree, items[Math.min(items.length - 1, idx + 1)] ?? items[0]);
        break;
      case 'ArrowUp':
        ev.preventDefault();
        focusTreeItem(tree, items[Math.max(0, idx - 1)] ?? items[0]);
        break;
      case 'Home':
        ev.preventDefault();
        focusTreeItem(tree, items[0]);
        break;
      case 'End':
        ev.preventDefault();
        focusTreeItem(tree, items[items.length - 1]);
        break;
      case 'Enter':
      case ' ':
        // A `<button>` treeitem activates natively; a wrapper row (the tactical rows) forwards to the
        // primary control inside it.
        if (current && current.tagName !== 'BUTTON') {
          ev.preventDefault();
          current.querySelector<HTMLElement>('button')?.click();
        }
        break;
    }
  });
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
  // The doorway treeitems need an owning group (aria-required-parent) — mirror the tactical peers list.
  doors.setAttribute('role', 'group');
  doors.appendChild(
    doorwayRow({ door: 'contextmap', symbol: '⤳', label: 'Context Map', count: relLinks, onOpen: h.onOpenContextMap }),
  );
  doors.appendChild(
    doorwayRow({ door: 'glossary', symbol: '▤', label: 'Ubiquitous Language', onOpen: h.onOpenGlossary }),
  );
  root.appendChild(doors);

  wireTreeNav(root); // roving tabindex + Arrow/Home/End across the context + doorway rows
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

  // True only WHILE the in-navigator drill sets the scope+altitude together (onOpenContext below). It lets
  // the store subscription tell that drill apart from an EXTERNAL `activeContext` change (the top-bar scope
  // switcher), which must reset the altitude to strategic instead of surprise-drilling into the new scope.
  let drilling = false;

  const strategicHandlers: StrategicHandlers = {
    // Drilling in is one gesture across two store fields: narrow the scope AND descend to tactical. The
    // store subscription below repaints the navigator (the breadcrumb + the context's tactical body); the
    // `drilling` guard keeps that subscription from treating this paired write as an external scope change.
    onOpenContext: (ctx) => {
      const s = store.getState();
      drilling = true;
      try {
        s.setActiveContext(ctx);
        s.setNavAltitude('tactical');
      } finally {
        drilling = false;
      }
    },
    onOpenContextMap: () => handlers.onOpenContextMap?.(),
    onOpenGlossary: () => handlers.onOpenGlossary?.(),
  };

  // Persistent navigator chrome: a type-to-filter input plus the body the levels paint into. The input
  // drives the SHARED `outlineFilter` slice (the same one the Explorer outline reads, so the two never
  // disagree), and it lives OUTSIDE the re-rendered body — like the explorer's head — so typing into it
  // never tears down + refocuses the field, and the query survives an altitude change. Only `body` is
  // replaceChildren'd; the input persists across every re-render.
  const filterInput = document.createElement('input');
  filterInput.type = 'search';
  filterInput.className = 'koi-domain-filter';
  filterInput.placeholder = 'Filter domain…';
  filterInput.setAttribute('aria-label', 'Filter the domain by name');
  filterInput.spellcheck = false;
  filterInput.value = store.getState().outlineFilter;
  filterInput.addEventListener('input', () => store.getState().setOutlineFilter(filterInput.value));

  const body = document.createElement('div');
  body.className = 'koi-domain-body';
  host.replaceChildren(filterInput, body);

  // The altitude the last render painted, so a drill / climb (and ONLY that — not a filter keystroke or
  // the first content paint) plays the reduced-motion-guarded zoom entrance on the freshly-mounted level.
  let paintedAltitude = store.getState().navAltitude;

  // Swap the body to a freshly-built level, tagging it `koi-domain-enter` (the zoom entrance) only when
  // the ALTITUDE changed — so a drill / climb animates but a filter keystroke doesn't flicker. The
  // animation is CSS, gated behind `prefers-reduced-motion: no-preference` in `_leftrail.scss`.
  function paint(level: HTMLElement, altitude: typeof paintedAltitude): void {
    closeLeafMenu(false); // a body swap orphans any open ⋯ menu; drop it (its trigger is about to be torn down)
    if (altitude !== paintedAltitude) level.classList.add('koi-domain-enter');
    paintedAltitude = altitude;
    body.replaceChildren(level);
  }

  function render(): void {
    closeLeafMenu(false); // the loading/empty branches below replaceChildren directly — close any stale ⋯ menu first
    const s = store.getState();
    if (filterInput.value !== s.outlineFilter) filterInput.value = s.outlineFilter;

    // Tactical only when a real context is in scope; the unscoped sentinel falls back to strategic.
    if (s.navAltitude === 'tactical' && !isAllContexts(s.activeContext)) {
      // Resolve the scoped context's node from the cached model graph, then narrow it by the per-level
      // filter; a missing node (not yet fetched, or absent) yields an empty tactical body rather than a
      // crash.
      const ctxNode = filterContextNode(findContextNode(cache?.tree, s.activeContext), s.outlineFilter);
      filterInput.hidden = false;
      paint(renderTacticalView(s.activeContext, store, ctxNode, tacticalHandlers), 'tactical');
      return;
    }
    if (!cache) {
      filterInput.hidden = true;
      body.replaceChildren(message('koi-domain-loading', 'Loading domain…'));
      paintedAltitude = s.navAltitude;
      return;
    }
    if (!cache.model.entries.length) {
      filterInput.hidden = true;
      body.replaceChildren(
        message('koi-domain-empty', 'No elements yet — declare some types, or fix syntax errors to populate the model.'),
      );
      paintedAltitude = s.navAltitude;
      return;
    }
    // The type-to-filter box narrows the strategic context list (a context drops out once none of its
    // constructs match) — the same filter the Explorer outline uses, so the two never disagree.
    const model = filterGlossaryModel(cache.model, s.outlineFilter);
    filterInput.hidden = false;
    paint(renderStrategic(model, cache.relLinks, strategicHandlers), 'strategic');
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
    // An EXTERNAL scope change (the top-bar switcher, not the in-navigator drill) must land on strategic:
    // reset the altitude so the navigator shows what `navAltitude` says rather than auto-drilling into the
    // freshly-picked context. Resetting re-enters this subscription with the altitude change, which paints
    // the strategic level — so we return here and let that nested render do the work.
    if (s.activeContext !== prev.activeContext && !drilling && s.navAltitude === 'tactical') {
      store.getState().setNavAltitude('strategic');
      return;
    }
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
    unmount: () => {
      closeLeafMenu(false); // a torn-down host must not leave an orphaned floating menu + global listeners
      unsubscribe();
    },
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

/** Narrow a context node to the constructs whose name matches a free-text query (case-insensitive
 * substring) — the TACTICAL counterpart of {@link filterGlossaryModel}. An aggregate survives when it
 * matches OR owns a surviving construct (keeping all of its children when the aggregate name itself is
 * the hit); a context-level peer survives on its own match. A blank query is the identity. */
function filterContextNode(ctx: ModelNode | null, query: string): ModelNode | null {
  if (!ctx) return ctx;
  const q = query.trim().toLowerCase();
  if (!q) return ctx;
  const matches = (n: ModelNode): boolean => n.title.toLowerCase().includes(q);
  const children: ModelNode[] = [];
  for (const child of ctx.children) {
    if (child.kind === 'aggregate') {
      const selfMatch = matches(child);
      const keptKids = selfMatch ? child.children : child.children.filter(matches);
      if (selfMatch || keptKids.length) children.push({ ...child, children: keptKids });
    } else if (matches(child)) {
      children.push(child);
    }
  }
  return { ...ctx, children };
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
  // The wrapper's accessible name is otherwise computed from ALL descendant text (the leaf + the `⋯`
  // button's "Actions for …" label), so isolate it to the node title with an explicit aria-label.
  row.setAttribute('aria-label', node.title);

  const leaf = document.createElement('button');
  leaf.type = 'button';
  leaf.className = 'koi-tactical-leaf';
  leaf.dataset.construct = slug;
  leaf.dataset.name = node.title;
  leaf.append(constructIcon(slug), node.title);
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

// The single floating leaf menu (mounted to document.body and reused), built on the shared
// `createFloatingMenu` engine (#547): positioned under the `⋯` trigger, dismissed on outside-click /
// Escape / Tab / action, with focus returned to the trigger. Module-scoped so opening one closes any
// other. `refocusTriggerOnActivate` stays at the engine default (false) because "Reveal in Files" hides
// the Domain pane — the `⋯` trigger included — and the Files reveal owns focus next; refocusing the
// now-hidden trigger would strand focus on `<body>`.
const leafMenu = createFloatingMenu({
  menuClass: 'koi-tactical-menu',
  itemClass: 'koi-tactical-menu-item',
});

/** Tear down the floating leaf menu. Idempotent — a no-op when nothing is open, so it's safe to call on
 *  every re-render / unmount. `refocus` returns focus to the `⋯` trigger (the normal dismiss); callers
 *  about to tear the trigger down pass `false`. */
function closeLeafMenu(refocus = true): void {
  leafMenu.close(refocus);
}

function openLeafMenu(trigger: HTMLElement, node: ModelNode, h: TacticalHandlers): void {
  leafMenu.open({
    trigger,
    align: 'left',
    items: [
      {
        id: 'reveal-in-files',
        label: 'Reveal in Files',
        run: () => {
          h.setAxis('files');
          h.reveal(node);
        },
      },
    ],
  });
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
  // Isolate the accessible name to the aggregate title — otherwise it concatenates every owned child's
  // text (the nested role="group" spine) into the aggregate's announced name.
  node.setAttribute('aria-label', agg.title);

  const { slug } = constructForKind(agg.kind);
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'koi-agg-head';
  head.dataset.construct = slug;
  const headName = document.createElement('span');
  headName.className = 'koi-agg-name';
  headName.textContent = agg.title;
  head.append(constructIcon(slug), headName);
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

  const children = ctxNode?.children ?? [];
  const aggregates = children.filter((c) => c.kind === 'aggregate');
  const peers = children.filter((c) => c.kind !== 'aggregate');

  // An empty context (no aggregates/types, or the filter excluded everything) renders a plain status
  // note — NOT an empty `role="tree"`, which would both violate aria-required-children AND leave a
  // keyboard-unreachable tree (no tabbable treeitem). So the role is added only once there are rows.
  if (!aggregates.length && !peers.length) {
    body.setAttribute('role', 'note');
    const note = document.createElement('p');
    note.className = 'muted koi-tactical-empty';
    note.textContent = 'No aggregates or types here yet.';
    body.appendChild(note);
    return body;
  }

  body.setAttribute('role', 'tree');
  if (ctxNode) body.setAttribute('aria-label', `${ctxNode.title} aggregates`);

  for (const agg of aggregates) body.appendChild(aggregateNode(agg, h));

  if (peers.length) {
    const peerGroup = document.createElement('div');
    peerGroup.className = 'koi-ctx-peers';
    peerGroup.setAttribute('role', 'group');
    for (const peer of peers) peerGroup.appendChild(tacticalLeaf(peer, h));
    body.appendChild(peerGroup);
  }

  wireTreeNav(body); // roving tabindex + Arrow/Home/End across the aggregate + leaf rows
  return body;
}

/** A muted status/empty line for the navigator host (loading / no-model states). */
function message(className: string, text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = `muted ${className}`;
  p.textContent = text;
  return p;
}
