// The DDD "Domain" navigator (issue #453), migrated to Preact (issue #991 Task 1). A left-rail tree that
// lets a Domain Developer / Architect move through the model the way DDD itself is layered — STRATEGIC
// first (the bounded contexts and the doorways into the cross-context views) and drill into TACTICAL (a
// context's aggregates and their internals) on demand.
//
// SHAPE (a container/presenter split, like GlossaryPanel + inspectorController): the pure levels render
// as keyed JSX sub-components (`StrategicLevel` / `TacticalView`), and the live `mountDomainNavigator`
// FACADE owns the data-fetch + the single synchronous `store.subscribe` that drives re-renders and the
// altitude-reset invariant. The facade renders synchronously (a top-level Preact `render()` per store
// change), so a scope/filter write is reflected in the DOM within the same tick — preserving the
// microtask-flush + synchronous-assertion contract the existing suites pin (see domainNavigator.test.ts /
// .a11y.test.ts). The store subscription lives in the facade (not a `useAppStore` effect) so `unmount()`
// can drop it WITHOUT tearing down the painted DOM — `#1308` pins that the loading placeholder survives an
// unmount-mid-fetch, which `render(null, host)` would erase.
//
// The counts shown here reuse `countsByContext` (the one tally source shared with the Model outline), so
// the two navigators can never disagree on a context's size. Roving-tabindex keyboard routing consumes the
// SHARED `handleTreeKeydown` router (shell/rovingTreeNav.ts, #1105 / #484 item a) — this file keeps only
// the thin DOM glue (item source + focus primitive + the panel-specific ContextMenu affordance).
import { render } from 'preact';
import type { ComponentChildren, VNode } from 'preact';
import type { ContextMapResult, GlossaryModel, ModelNode } from '@/lsp/lsp';
import { constructForKind, constructIcon, countsByContext, type ModelOutlineHandlers } from '@/model/modelOutline';
import { filterGlossaryModel, isAllContexts, type ContextScope } from '@/model/activeContext';
import { createFloatingMenu } from '@atypical/koine-ui';
import { handleTreeKeydown, type RovingTreeNav } from '@/shell/rovingTreeNav';
import { createLifecycleGuard } from '@/shared/lifecycleGuard';
import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import type { NavAltitude } from '@/store/slices/activeContext';

/** Wiring for the strategic level — what each row does when activated. Supplied by the rail controller
 * so this renderer stays free of LSP/editor concerns. */
export interface StrategicHandlers {
  /** Drill into a bounded context's tactical view (its aggregates and internals). */
  onOpenContext(ctx: string): void;
  /** Open the Context Map view (the cross-context relationship graph). */
  onOpenContextMap(): void;
  /** Open the Glossary (the ubiquitous language) view. */
  onOpenGlossary(): void;
}

/** A bounded context's total construct count — the sum of its present construct buckets. Reuses
 * {@link countsByContext} so the badge here and the Model outline's tallies share one source of truth. */
function totalConstructs(counts: { count: number }[]): number {
  return counts.reduce((sum, c) => sum + c.count, 0);
}

/** A small decorative glyph (e.g. the `◈` context diamond, the `⤳` map arrow). Hidden from assistive
 * tech — the surrounding row text already names the destination. */
function Glyph({ symbol }: { symbol: string }): VNode {
  return (
    <span class="koi-domain-glyph" aria-hidden="true">
      {symbol}
    </span>
  );
}

/** A shape-coded construct icon (the SAME markup `modelOutline.ts`'s {@link constructIcon} mints — one
 * source for the glyph shape, #453). Rendered via a ref-append span so the imperative builder stays the
 * single source until #992 componentizes it; the wrapper span has NO JSX children, so Preact never diffs
 * over the appended icon. */
function ConstructIcon({ slug }: { slug: string }): VNode {
  return (
    <span
      class="koi-domain-iconwrap"
      ref={(el) => {
        if (el && !el.firstChild) el.appendChild(constructIcon(slug));
      }}
    />
  );
}

/** One bounded-context row: a `◈` glyph, the context name, and a total-construct count badge. Clicking
 * drills into the context's tactical view. The whole row IS the button, carrying `data-ctx` so the rail
 * controller can address it for cross-axis highlighting.
 *
 * When `scoped` (this context is the active scope, #146), the row carries a persistent marker mirroring
 * the status-bar `Context:` control (ADR 0009): the navigator STAYS the global selector (it never narrows
 * itself), but you can always tell which context is active — `aria-current` + an ", active context" suffix
 * name it to assistive tech, a filled `◆` (vs the outline `◈`) is a shape cue, and `_model.scss` adds an
 * accent rail + wash so the marker doesn't rely on hue alone (WCAG AA). */
function ContextRow({
  context,
  total,
  handlers,
  scoped,
}: {
  context: string;
  total: number;
  handlers: StrategicHandlers;
  scoped: boolean;
}): VNode {
  return (
    <button
      type="button"
      class={'koi-ctx-row' + (scoped ? ' koi-ctx-row--scoped' : '')}
      data-ctx={context}
      role="treeitem"
      aria-current={scoped ? 'true' : undefined}
      aria-label={`${context}, ${total} construct${total === 1 ? '' : 's'}${scoped ? ', active context' : ''}`}
      onClick={() => handlers.onOpenContext(context)}
    >
      <Glyph symbol={scoped ? '◆' : '◈'} />
      <span class="koi-ctx-name">{context}</span>
      <span class="koi-ctx-count">{String(total)}</span>
    </button>
  );
}

/** A "doorway" row into a cross-context view (Context Map, Glossary): a glyph, a label, and an optional
 * trailing count badge (e.g. the number of context-map relationships). An optional `hint` names the DDD
 * concept behind a renamed door (e.g. "the ubiquitous language" for the Glossary): it becomes the row's
 * tooltip and is woven into its accessible name, so renaming the visible label never drops the vocabulary. */
function DoorwayRow({
  door,
  symbol,
  label,
  hint,
  count,
  onOpen,
}: {
  door: string;
  symbol: string;
  label: string;
  hint?: string;
  count?: number;
  onOpen: () => void;
}): VNode {
  return (
    <button
      type="button"
      class="koi-domain-door"
      data-door={door}
      role="treeitem"
      // Tooltip + accessible name keep the DDD term ("the ubiquitous language") even though the visible
      // door now reads "Glossary" — the door and its destination match, the vocabulary is preserved.
      title={hint}
      aria-label={hint ? `${label} — ${hint}` : undefined}
      onClick={onOpen}
    >
      <Glyph symbol={symbol} />
      <span class="koi-domain-door-label">{label}</span>
      {count != null ? <span class="koi-domain-door-count">{String(count)}</span> : null}
    </button>
  );
}

// --- keyboard model: the WAI-ARIA tree pattern (roving tabindex) (#453) -----------------------------
// Both levels are `role="tree"`s of `role="treeitem"` rows, navigated with Arrow/Home/End and a SINGLE
// tab stop (roving tabindex). The navigator's trees never collapse a branch (aggregates render expanded;
// the filter removes non-matching rows from the DOM), so every rendered treeitem is visible and DOM order
// IS visual order. The key ROUTING is the shared `handleTreeKeydown` (rovingTreeNav.ts, #1105); this file
// supplies only the item source + focus primitive + the ContextMenu affordance, attached via a ref helper.

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

/** The treeitem a keydown targets: the event target's nearest treeitem, else the focused element's
 *  (the listener is delegated on the root, so a keydown dispatched on the root carries the root as its
 *  target and we fall back to `document.activeElement`). */
function currentTreeItem(ev: KeyboardEvent): HTMLElement | null {
  const focused = document.activeElement as HTMLElement | null;
  return (
    (ev.target as HTMLElement | null)?.closest<HTMLElement>('[role="treeitem"]') ??
    focused?.closest<HTMLElement>('[role="treeitem"]') ??
    null
  );
}

/** A {@link RovingTreeNav} over a `role="tree"` root's live treeitems, built per keydown so it can read
 *  the event's target. The navigator has no ArrowRight/Left (its trees never collapse a branch), so it
 *  omits `expand`/`collapse` and keeps the default Home/End + Space-activation. */
function treeNav(tree: HTMLElement, ev: KeyboardEvent): RovingTreeNav<HTMLElement> {
  // Snapshot the treeitems once per keydown: the navigator's trees never mutate mid-handler (it has no
  // expand/collapse), so a single querySelectorAll serves items()/activeIndex()/focusIndex().
  const items = treeItems(tree);
  return {
    items: () => items,
    activeIndex: () => {
      const current = currentTreeItem(ev);
      return current ? items.indexOf(current) : -1;
    },
    focusIndex: (i) => {
      const item = items[i];
      if (item) focusTreeItem(tree, item);
    },
    activate: () => {
      // A `<button>` treeitem activates natively (leave the key to the browser); a wrapper row (the
      // tactical rows) forwards Enter/Space to the primary control inside it.
      const current = currentTreeItem(ev);
      if (current && current.tagName !== 'BUTTON') {
        current.querySelector<HTMLElement>('button')?.click();
        return true;
      }
      return false;
    },
  };
}

// Guard against re-attaching the delegated keydown listener when the SAME tree element is handed to
// `wireTreeNav` twice (the roving re-seed is idempotent, but a second addEventListener would double-fire).
const wiredTrees = new WeakSet<HTMLElement>();

/** Wire the WAI-ARIA tree keyboard model onto a `role="tree"` root: roving tabindex (one tab stop) plus
 * ArrowDown/Up across the visible treeitems, Home/End to the first/last, and Enter/Space to activate the
 * focused row — the shared router (`shell/rovingTreeNav.ts`, #1105) owns that key routing; this only
 * supplies the item source and the panel-specific ContextMenu affordance. Attached via a callback ref, so
 * it runs synchronously when the fresh tree commits. */
function wireTreeNav(tree: HTMLElement): void {
  setRovingItem(tree, null); // seed the first treeitem as the single tab stop (re-run on every commit)
  if (wiredTrees.has(tree)) return;
  wiredTrees.add(tree);
  tree.addEventListener('keydown', (ev) => {
    // Context-menu affordance: the dedicated ContextMenu key (or Shift+F10) opens the focused row's `⋯`
    // overflow, so keyboard users reach its cross-axis actions ("Reveal in Files") the mouse gets from the
    // `⋯` button (which roving tabindex keeps out of the tab order).
    if (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) {
      // Only the row's OWN ⋯ qualifies (a leaf row appends it as a direct child). A bare descendant
      // lookup on an aggregate treeitem would descend into its nested group and open the first owned
      // leaf's menu — a wrongly-targeted action; an aggregate has no overflow, so the key no-ops there.
      const more = currentTreeItem(ev)?.querySelector<HTMLElement>(':scope > .koi-tactical-more');
      if (more) {
        ev.preventDefault();
        more.click();
      }
      return;
    }
    handleTreeKeydown(treeNav(tree, ev), ev);
  });
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

/**
 * The STRATEGIC level: one `◈` row per bounded context (with its total-construct count badge), then the
 * `⤳ Context Map` and `▤ Glossary` doorway rows. The Glossary door routes to the same destination the
 * Docs facet calls "Glossary" (#146) — so it carries that label, keeping "the ubiquitous language" as its
 * tooltip / accessible name. `relLinks` is the number of context-map relationships (passed in — this
 * renderer never fetches it).
 *
 * `activeContext` is the bounded context currently in scope (or `null` for the *All contexts* view): its
 * row gets a persistent "active" marker mirroring the status-bar `Context:` control (ADR 0009 / #1188).
 * The navigator itself is NOT narrowed — it stays the global *selector*, so every context is always
 * listed; only the marker moves.
 */
export function StrategicLevel({
  model,
  relLinks,
  handlers,
  activeContext = null,
}: {
  model: GlossaryModel;
  relLinks: number;
  handlers: StrategicHandlers;
  activeContext?: string | null;
}): VNode {
  const contexts = countsByContext(model);
  return (
    <div class="koi-domain koi-domain-strategic" role="tree" aria-label="Domain" ref={(el) => { if (el) wireTreeNav(el); }}>
      {contexts.map(({ context, counts }) => (
        <ContextRow
          key={context}
          context={context}
          total={totalConstructs(counts)}
          handlers={handlers}
          scoped={context === activeContext}
        />
      ))}
      {/* The doorway treeitems need an owning group (aria-required-parent) — mirror the tactical peers list. */}
      <div class="koi-domain-doors" role="group">
        <DoorwayRow door="contextmap" symbol="⤳" label="Context Map" count={relLinks} onOpen={handlers.onOpenContextMap} />
        <DoorwayRow
          door="glossary"
          symbol="▤"
          label="Glossary"
          hint="the ubiquitous language"
          onOpen={handlers.onOpenGlossary}
        />
      </div>
    </div>
  );
}

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
 * activated, plus the cross-axis links (#453). The leaves carry their `data-construct` / `data-name` and
 * `qualifiedName`, so a click resolves to a model element without re-rendering the tree. Supplied by the
 * rail controller, which owns the inspector / editor / Files-axis seams. */
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
 * doorways (`onOpenContextMap` / `onOpenGlossary`) plus the TACTICAL leaf hooks (`onSelect` / `goto`). All
 * optional, so a bare mount (the unit test) is a harmless no-op set.
 */
export type DomainNavigatorHandlers = Partial<ModelOutlineHandlers>;

/** A pre-fetched seed for {@link DomainNavigatorHandle.reload}: the glossary + structured model the
 * caller already has in flight (or has), so the navigator's reload reuses them instead of re-issuing its
 * own `glossaryModel()`/`model()` requests. Promises (not resolved values) so the caller can hand off an
 * ALREADY-STARTED fetch — the navigator awaits the same in-flight request rather than delaying its own
 * kickoff to wait for the caller's fetch to settle first. `contextMap()` is still fetched directly (its
 * relation count is navigator-only, so there's nothing to de-dupe there). */
export interface DomainNavigatorSeed {
  glossaryModel: Promise<GlossaryModel>;
  model: Promise<ModelNode | null>;
}

/** The live handle a mounted navigator returns. {@link reload} re-fetches the strategic data after a
 * model edit — optionally seeded (#484 follow-up on #460's review) to halve the per-edit fetch when the
 * caller already fetched the same two endpoints; omit the seed and it self-fetches as before, so a bare
 * `reload()` call (e.g. the unit tests) stays a no-op change. {@link unmount} drops the store subscription
 * so a torn-down host stops re-rendering. */
export interface DomainNavigatorHandle {
  reload(seed?: DomainNavigatorSeed): void;
  unmount(): void;
}

/** One tactical leaf — an owned construct (under an aggregate) or a context-level peer. The row IS the
 * `treeitem`; inside it the activation button (`.koi-tactical-leaf`, carrying `data-construct` + `data-name`
 * so a click resolves to the model element + cross-highlights) selects-and-jumps, and a trailing `⋯`
 * overflow opens the cross-axis menu ("Reveal in Files", #453). Icon first, then the name text, so
 * `leaf.textContent === node.title`. */
function TacticalLeaf({ node, handlers }: { node: ModelNode; handlers: TacticalHandlers }): VNode {
  const { slug } = constructForKind(node.kind);
  return (
    // The wrapper's accessible name is otherwise computed from ALL descendant text (the leaf + the `⋯`
    // button's "Actions for …" label), so isolate it to the node title with an explicit aria-label.
    <div class="koi-tactical-leaf-row" role="treeitem" aria-label={node.title}>
      <button
        type="button"
        class="koi-tactical-leaf"
        data-construct={slug}
        data-name={node.title}
        onClick={() => {
          handlers.onSelect(node);
          handlers.goto(node);
        }}
      >
        <ConstructIcon slug={slug} />
        {node.title}
      </button>
      {/* The per-leaf `⋯` overflow: a real, keyboard-activatable button opening the cross-axis menu. */}
      <button
        type="button"
        class="koi-tactical-more"
        aria-label={`Actions for ${node.title}`}
        aria-haspopup="menu"
        aria-expanded="false"
        onClick={(ev) => {
          ev.stopPropagation();
          openLeafMenu(ev.currentTarget as HTMLElement, node, handlers);
        }}
      >
        ⋯
      </button>
    </div>
  );
}

/** One aggregate node: a head row (the aggregate glyph + name, carrying the aggregate's qualified name)
 * with its owned constructs nested beneath in a {@link TacticalLeaf} spine, so ownership reads as
 * containment. The container carries `data-qname` for the cross-highlight; the head is the selectable row
 * for the aggregate itself. */
function AggregateNode({ agg, handlers }: { agg: ModelNode; handlers: TacticalHandlers }): VNode {
  const { slug } = constructForKind(agg.kind);
  return (
    // Isolate the accessible name to the aggregate title — otherwise it concatenates every owned child's
    // text (the nested role="group" spine) into the aggregate's announced name.
    <div class="koi-agg" data-qname={agg.qualifiedName} role="treeitem" aria-expanded="true" aria-label={agg.title}>
      <button
        type="button"
        class="koi-agg-head"
        data-construct={slug}
        onClick={() => {
          handlers.onSelect(agg);
          handlers.goto(agg);
        }}
      >
        <ConstructIcon slug={slug} />
        <span class="koi-agg-name">{agg.title}</span>
      </button>
      {/* The owned constructs, nested in a bracketed spine that makes the aggregate's boundary visible. */}
      <div class="koi-agg-spine" role="group">
        {agg.children.map((child) => (
          <TacticalLeaf key={child.qualifiedName} node={child} handlers={handlers} />
        ))}
      </div>
    </div>
  );
}

/**
 * The TACTICAL body for a bounded context — aggregate-centric: each `aggregate` child becomes a node with
 * its owned constructs nested beneath ({@link AggregateNode}); every OTHER top-level child (a value object,
 * enum, event, … declared at the context level rather than inside an aggregate) is a peer under a quiet
 * `context` divider — no orphan "Aggregates" header. A `null`/empty `ctxNode` (loading, or a context with
 * no declarations) renders an empty body, not a crash.
 */
export function TacticalLevel({
  ctxNode,
  handlers,
}: {
  ctxNode: ModelNode | null | undefined;
  handlers: TacticalHandlers;
}): VNode {
  const children = ctxNode?.children ?? [];
  const aggregates = children.filter((c) => c.kind === 'aggregate');
  const peers = children.filter((c) => c.kind !== 'aggregate');

  // An empty context (no aggregates/types, or the filter excluded everything) renders a plain status
  // note — NOT an empty `role="tree"`, which would both violate aria-required-children AND leave a
  // keyboard-unreachable tree (no tabbable treeitem). So the role is added only once there are rows.
  if (!aggregates.length && !peers.length) {
    return (
      <div class="koi-domain-tactical-body" role="note">
        <p class="muted koi-tactical-empty">No aggregates or types here yet.</p>
      </div>
    );
  }

  return (
    <div
      class="koi-domain-tactical-body"
      role="tree"
      aria-label={ctxNode ? `${ctxNode.title} aggregates` : undefined}
      ref={(el) => { if (el) wireTreeNav(el); }}
    >
      {aggregates.map((agg) => (
        <AggregateNode key={agg.qualifiedName} agg={agg} handlers={handlers} />
      ))}
      {peers.length ? (
        <div class="koi-ctx-peers" role="group">
          {peers.map((peer) => (
            <TacticalLeaf key={peer.qualifiedName} node={peer} handlers={handlers} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The TACTICAL view for a bounded context: a breadcrumb that zooms back to the strategic context list,
 * then the context's aggregate-centric body ({@link TacticalLevel}). The breadcrumb is owned here; the
 * body walks `ctxNode` (the context's structured model node, or `null` while it loads / when absent).
 */
function TacticalView({
  context,
  store,
  ctxNode,
  handlers,
}: {
  context: string;
  store: StoreApi<AppState>;
  ctxNode: ModelNode | null;
  handlers: TacticalHandlers;
}): VNode {
  return (
    <div class="koi-domain koi-domain-tactical">
      <button
        type="button"
        class="koi-breadcrumb-back"
        aria-label={`Back to all contexts (in ${context})`}
        onClick={() => store.getState().setNavAltitude('strategic')}
      >
        <Glyph symbol="‹" />
        <span class="koi-breadcrumb-back-name">{context}</span>
      </button>
      <TacticalLevel ctxNode={ctxNode} handlers={handlers} />
    </div>
  );
}

// --- pure-DOM builder facades (kept for direct-call tests + the public API) --------------------------
// `renderStrategic` / `renderTactical` render the level component into a detached host and return the
// concrete `role="tree"` element — so callers that want a one-shot DOM tree (the characterization tests,
// any future consumer) keep the SAME `HTMLElement`-returning signature, while the markup flows from ONE
// JSX source (the components above). The callback-ref `wireTreeNav` runs synchronously at commit, so the
// returned element already carries its roving tabindex + keydown listener.

/** Build the strategic-level Domain navigator as a detached DOM tree (see {@link StrategicLevel}). */
export function renderStrategic(
  model: GlossaryModel,
  relLinks: number,
  h: StrategicHandlers,
  activeContext: string | null = null,
): HTMLElement {
  const host = document.createElement('div');
  render(<StrategicLevel model={model} relLinks={relLinks} handlers={h} activeContext={activeContext} />, host);
  return host.firstElementChild as HTMLElement;
}

/** Build the tactical body for a bounded context as a detached DOM tree (see {@link TacticalLevel}). */
export function renderTactical(ctxNode: ModelNode | null | undefined, h: TacticalHandlers): HTMLElement {
  const host = document.createElement('div');
  render(<TacticalLevel ctxNode={ctxNode} handlers={h} />, host);
  return host.firstElementChild as HTMLElement;
}

/** Find the bounded-context node for `context` in the model graph: the root's `kind: 'context'` child
 * whose name matches. The graph names a context by both `title` and `qualifiedName`, so match either. */
function findContextNode(root: ModelNode | null | undefined, context: string): ModelNode | null {
  return (
    root?.children.find((c) => c.kind === 'context' && (c.title === context || c.qualifiedName === context)) ?? null
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

/** A muted status/empty line for the navigator host (loading / no-model states). */
function Message({ className, children }: { className: string; children: ComponentChildren }): VNode {
  return <p class={`muted ${className}`}>{children}</p>;
}

/** The cached strategic data — fetched once, repainted from on altitude / scope / filter changes. `tree`
 *  is the structured model graph the TACTICAL view walks (best-effort: `null` if it failed). */
interface NavCache {
  model: GlossaryModel;
  relLinks: number;
  tree: ModelNode | null;
}

/**
 * The Domain navigator PRESENTER (props-driven): given the current altitude / scope / filter and the
 * fetched `cache`, it paints either the STRATEGIC context list or the TACTICAL view for the scoped
 * context — a loading / empty placeholder until the cache arrives. The persistent filter input lives
 * OUTSIDE the keyed level body (a stable sibling) so typing into it never tears down + refocuses the
 * field and the query survives an altitude change; only the body swaps.
 *
 * All of altitude / scope / filter flow in as PROPS — the live `store.subscribe` that feeds them lives in
 * {@link mountDomainNavigator} (a synchronous re-render per store change), not a `useAppStore` effect, for
 * the reasons in this file's header.
 */
export function DomainNavigator({
  store,
  navAltitude,
  activeContext,
  outlineFilter,
  cache,
  contentToken,
  handlers,
  tacticalHandlers,
}: {
  store: StoreApi<AppState>;
  navAltitude: NavAltitude;
  activeContext: ContextScope;
  outlineFilter: string;
  cache: NavCache | null;
  /** Bumped by the facade on every data change, so a keyed level rebuilds (re-seeding roving tabindex). */
  contentToken: number;
  handlers: DomainNavigatorHandlers;
  tacticalHandlers: TacticalHandlers;
}): VNode {
  // Drilling in is one gesture across two store fields: narrow the scope AND descend to tactical. The
  // facade's subscription repaints the navigator; because a drill always starts from the STRATEGIC level,
  // the paired write's context-change lands while the altitude is still strategic — so the facade's
  // external-scope-reset invariant (which only fires when the altitude is already tactical) leaves it
  // alone. No re-entrancy flag needed (the old `drilling` guard).
  const strategicHandlers: StrategicHandlers = {
    onOpenContext: (ctx) => {
      const s = store.getState();
      s.setActiveContext(ctx);
      s.setNavAltitude('tactical');
    },
    onOpenContextMap: () => handlers.onOpenContextMap?.(),
    onOpenGlossary: () => handlers.onOpenGlossary?.(),
  };

  let filterHidden: boolean;
  let level: VNode;

  // Tactical only when a real context is in scope; the unscoped sentinel falls back to strategic.
  if (navAltitude === 'tactical' && !isAllContexts(activeContext)) {
    // Resolve the scoped context's node from the cached model graph, then narrow it by the per-level
    // filter; a missing node (not yet fetched, or absent) yields an empty tactical body rather than a crash.
    const ctxNode = filterContextNode(findContextNode(cache?.tree, activeContext), outlineFilter);
    filterHidden = false;
    level = (
      <TacticalView
        key={`tactical:${contentToken}:${activeContext}:${outlineFilter}`}
        context={activeContext}
        store={store}
        ctxNode={ctxNode}
        handlers={tacticalHandlers}
      />
    );
  } else if (!cache) {
    filterHidden = true;
    level = <Message className="koi-domain-loading">Loading domain…</Message>;
  } else if (!cache.model.entries.length) {
    filterHidden = true;
    level = (
      <Message className="koi-domain-empty">
        No elements yet — declare some types, or fix syntax errors to populate the model.
      </Message>
    );
  } else {
    // The type-to-filter box narrows the strategic context list (a context drops out once none of its
    // constructs match) — the same filter the Explorer outline uses, so the two never disagree.
    const model = filterGlossaryModel(cache.model, outlineFilter);
    filterHidden = false;
    // Mark the active-context row (ADR 0009 / #1188); the unscoped sentinel passes `null` (no row marked).
    const scope = isAllContexts(activeContext) ? null : activeContext;
    level = (
      <StrategicLevel
        key={`strategic:${contentToken}:${outlineFilter}`}
        model={model}
        relLinks={cache.relLinks}
        handlers={strategicHandlers}
        activeContext={scope}
      />
    );
  }

  return (
    <>
      <input
        type="search"
        class="koi-domain-filter"
        placeholder="Filter domain…"
        aria-label="Filter the domain by name"
        spellcheck={false}
        hidden={filterHidden}
        value={outlineFilter}
        onInput={(e) => store.getState().setOutlineFilter((e.currentTarget as HTMLInputElement).value)}
      />
      <div class="koi-domain-body">{level}</div>
    </>
  );
}

/**
 * Mount the live Domain navigator into `host`: paint the STRATEGIC context list while the store's
 * `navAltitude` is `'strategic'`, and the TACTICAL view (a breadcrumb + the scoped context's body) once a
 * row is drilled into. Clicking a context narrows the scope AND descends to tactical; the breadcrumb
 * climbs back. Re-renders on `navAltitude` / `activeContext` / `outlineFilter` changes (synchronously,
 * from a cached fetch), and {@link DomainNavigatorHandle.reload} re-fetches after an edit. The store is
 * the single source of truth for altitude + scope.
 *
 * The facade owns the fetch (a monotonic sequence drops a superseded / post-dispose fetch) and the single
 * synchronous `store.subscribe` that both enforces the altitude-reset invariant and drives the Preact
 * re-render — see this file's header for why the subscription lives here rather than in a `useAppStore`
 * effect.
 *
 * `seed` (#1397) mirrors {@link DomainNavigatorHandle.reload}'s seed: a caller that already started the
 * glossaryModel()/model() fetch (e.g. `ensureDomainNavigator()`'s memoized promises) hands them in so the
 * first-mount `doFetch()` reuses them instead of issuing a duplicate pair. One-shot — consumed only here,
 * never retained, so a later unseeded `reload()` self-fetches exactly as it does without a seed.
 */
export function mountDomainNavigator(
  host: HTMLElement,
  store: StoreApi<AppState>,
  lsp: DomainNavigatorLsp,
  handlers: DomainNavigatorHandlers = {},
  tacticalHandlers: TacticalHandlers = noopTacticalHandlers(),
  seed?: DomainNavigatorSeed,
): DomainNavigatorHandle {
  // The navigator data is fetched once and cached; store-driven changes (altitude / scope / filter)
  // re-render synchronously from the cache, and reload() re-fetches after an edit. `null` = not yet
  // loaded (a loading placeholder shows). A monotonic seq drops a superseded fetch (last write wins).
  let cache: NavCache | null = null;
  // Bumped on every cache write, so the keyed level rebuilds (re-seeding roving tabindex) when the data
  // changes even if altitude/scope/filter did not.
  let contentToken = 0;
  const lifecycle = createLifecycleGuard();
  const fetchGen = lifecycle.createSequence();
  // lifecycle.dispose() is called as unmount()'s first statement, mirroring contextMapPanel.tsx's
  // `dispose()` shape (#1261): the seq check alone only drops a fetch superseded by a NEWER
  // doFetch()/reload() call, not one whose owning navigator was torn down outright while it was in flight.

  // The altitude the last render painted, so a drill / climb (and ONLY that — not a filter keystroke or
  // the first content paint) lands focus on the freshly-mounted level (WCAG 2.4.3).
  let paintedAltitude = store.getState().navAltitude;

  function renderNow(): void {
    closeLeafMenu(false); // a re-render orphans any open ⋯ menu; drop it (its trigger is about to be torn down)
    const s = store.getState();
    render(
      <DomainNavigator
        store={store}
        navAltitude={s.navAltitude}
        activeContext={s.activeContext}
        outlineFilter={s.outlineFilter}
        cache={cache}
        contentToken={contentToken}
        handlers={handlers}
        tacticalHandlers={tacticalHandlers}
      />,
      host,
    );
  }

  // A drill / climb (and ONLY that — not a filter keystroke or the first content paint) plays the
  // reduced-motion-guarded zoom entrance on the freshly-mounted level, and lands focus on its first row.
  // Runs AFTER renderNow(), when the new level is already committed as `.koi-domain-body`'s child.
  function onAltitudeChanged(): void {
    const body = host.querySelector<HTMLElement>('.koi-domain-body');
    const level = body?.firstElementChild as HTMLElement | null;
    // Tag the fresh level `koi-domain-enter` (the zoom entrance) — CSS, gated behind
    // `prefers-reduced-motion: no-preference` in `_leftrail.scss`, so a drill / climb animates.
    level?.classList.add('koi-domain-enter');
    // A drill / climb tears down the level holding the focused row, so the browser drops keyboard focus
    // to <body>. Detect that and land focus on the fresh level's first row (the tactical breadcrumb, or
    // the first strategic treeitem) so the Tab order continues inside the navigator instead of restarting
    // at the app chrome (WCAG 2.4.3). Focus parked elsewhere (editor, top bar, the filter input) is left
    // alone.
    const active = document.activeElement;
    const focusTornDown = active === null || active === document.body || (!!body && body.contains(active));
    if (!focusTornDown) return;
    level?.querySelector<HTMLElement>('[role="treeitem"], .koi-breadcrumb-back')?.focus();
  }

  // Re-render only when the navigator's own inputs change reference — altitude, scope, or the outline
  // filter — mirroring the controller's `subscribe((s, prev) => …)` discipline (an unrelated slice write
  // doesn't repaint the navigator).
  const unsubscribe = store.subscribe((s, prev) => {
    // An EXTERNAL scope change (the top-bar switcher, not the in-navigator drill) must land on strategic:
    // reset the altitude so the navigator shows what `navAltitude` says rather than auto-drilling into the
    // freshly-picked context. A drill's paired write changes the context while the altitude is still
    // strategic (so `navAltitude === prev.navAltitude === 'tactical'` is false for it) — this only fires
    // for a lone scope change made while already tactical. Resetting re-enters this subscription with the
    // altitude change, which paints the strategic level — so return and let that nested render do the work.
    if (
      s.activeContext !== prev.activeContext &&
      s.navAltitude === prev.navAltitude &&
      s.navAltitude === 'tactical'
    ) {
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
    renderNow();
    if (s.navAltitude !== paintedAltitude) {
      paintedAltitude = s.navAltitude;
      onAltitudeChanged();
    }
  });

  async function doFetch(seed?: DomainNavigatorSeed): Promise<void> {
    const seq = fetchGen.next();
    // fetchGen.isCurrent(seq) is false if EITHER the navigator was unmounted outright while this fetch
    // was in flight, OR a newer doFetch()/reload() call superseded this one — either alone is
    // insufficient (#1308).
    const isCurrent = () => fetchGen.isCurrent(seq);
    try {
      // The model graph is fetched alongside the strategic data (and degrades to an empty tactical tree
      // on its own failure) so a drill-in repaints synchronously from cache, like every other altitude.
      // A seed (#484 follow-up) reuses the caller's already-in-flight glossary/model fetch instead of
      // issuing a second one; contextMap() is always fetched here (navigator-only data).
      const [model, contextMap, tree] = await Promise.all([
        seed ? seed.glossaryModel : lsp.glossaryModel(),
        lsp.contextMap(),
        seed ? seed.model : lsp.model().catch(() => null),
      ]);
      if (!isCurrent()) return;
      cache = { model, relLinks: contextMap.relations.length, tree };
    } catch {
      if (!isCurrent()) return;
      cache = { model: { entries: [] }, relLinks: 0, tree: null }; // best-effort: render the empty strategic state
    }
    contentToken += 1;
    renderNow();
  }

  renderNow(); // paint the loading placeholder (or the cache, if a reload pre-seeded it) right away
  void doFetch(seed); // then fetch the strategic data and repaint — reusing the mount-time seed, if any

  return {
    reload: (seed) => void doFetch(seed),
    unmount: () => {
      // dispose() must be first: doFetch()'s post-await tail consults this via isCurrent(). We drop the
      // subscription + fetch guard + any open ⋯ menu, but deliberately DO NOT `render(null, host)` — the
      // last-painted DOM is left in place (a torn-down host is the controller's to clear), which keeps the
      // loading placeholder visible if a fetch was still in flight (#1308).
      lifecycle.dispose();
      closeLeafMenu(false); // a torn-down host must not leave an orphaned floating menu + global listeners
      unsubscribe();
    },
  };
}
