// The DDD "Domain" navigator (issue #453), migrated to Preact (issue #991 Task 1). A left-rail tree that
// lets a Domain Developer / Architect move through the model the way DDD itself is layered — STRATEGIC
// first (the bounded contexts and the doorways into the cross-context views) and drill into TACTICAL (a
// context's aggregates and their internals) on demand.
//
// The strategic level's `⤳ Context Map` doorway opens a THIRD level in the rail (#483): the context map
// as a graph — the bounded contexts as nodes, the typed relationships as edges badged with the DDD role
// each END plays (Supplier/Customer, Upstream/Conformist, …). It shapes its data with the SHARED
// `buildContextMapGraph` the inspector's maxGraph canvas uses, and falls back to the caller's docs
// hand-off when the model declares no relationships (nothing to graph). The rail level is a SUMMARY, not
// a replacement: the center-deck view still owns the maxGraph canvas, the Graph/Table toggle and the
// shared-types / anti-corruption detail strip, so the level carries its own `Open full Context Map` row
// that hands off there — the doorway is a two-way street, not a one-way trip away from the rich view.
//
// SHAPE (a container/presenter split, like GlossaryPanel + inspectorController): the pure levels render
// as keyed JSX sub-components (`StrategicLevel` / `TacticalView` / `ContextMapView`), and the live
// `mountDomainNavigator` FACADE owns the data-fetch + the single synchronous `store.subscribe` that
// drives re-renders and the altitude-reset invariant (and the view-local Context Map toggle, which is
// scoped to one instance and so has no business in the store). The facade renders synchronously (a
// top-level Preact `render()` per store
// change), so a scope/filter write is reflected in the DOM within the same tick — preserving the
// microtask-flush + synchronous-assertion contract the existing suites pin (see domainNavigator.test.ts /
// .a11y.test.ts). The store subscription lives in the facade (not a `useAppStore` effect) so `unmount()`
// can drop it WITHOUT tearing down the painted DOM — `#1308` pins that the loading placeholder survives an
// unmount-mid-fetch, which `render(null, host)` would erase.
//
// The counts shown here reuse `countsByContext` (the one tally source shared with the Model outline), so
// the two navigators can never disagree on a context's size. Roving-tabindex keyboard routing consumes the
// SHARED `handleTreeKeydown` router and `createRovingTabIndex` seed/resolve helper (shell/rovingTreeNav.ts,
// #1105 / #484 item a / #1365) — this file keeps only the item source (via a ref helper) and the
// panel-specific ContextMenu affordance.
import { render } from 'preact';
import type { ComponentChildren, VNode } from 'preact';
import type { ContextMapResult, DiagramNode, GlossaryModel, ModelNode } from '@/lsp/lsp';
import { constructForKind, constructIcon, countsByContext, type ModelOutlineHandlers } from '@/model/modelOutline';
import { filterGlossaryModel, isAllContexts, type ContextScope } from '@/model/activeContext';
import { buildContextMapGraph, type ContextMapEdge } from '@/diagrams/contextMapGraph';
import { createFloatingMenu } from '@atypical/koine-ui';
import { createRovingTabIndex, handleTreeKeydown, type RovingTabIndexHelper, type RovingTreeNav } from '@/shell/rovingTreeNav';
import { createLifecycleGuard } from '@/shared/lifecycleGuard';
import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import type { NavAltitude } from '@/store/slices/activeContext';

/** Wiring for the strategic level — what each row does when activated. Supplied by the rail controller
 * so this renderer stays free of LSP/editor concerns. */
export interface StrategicHandlers {
  /** Drill into a bounded context's tactical view (its aggregates and internals). */
  onOpenContext(ctx: string): void;
  /** Open the Context Map view (the cross-context relationship graph) — the navigator's own graph level
   *  when the model declares relationships, else the caller's docs hand-off (#483). */
  onOpenContextMap: () => void;
  /** Open the Glossary (the ubiquitous language) view. */
  onOpenGlossary: () => void;
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
// tab stop (roving tabindex). The navigator's trees never collapse a branch (every branch row — an
// aggregate, or an owning entity below it (#483) — renders expanded; the filter removes non-matching rows
// from the DOM), so every rendered treeitem is visible AT ANY DEPTH and DOM order IS visual order — which
// is why the item source stays a plain `querySelectorAll('[role="treeitem"]')` even now that the tree
// nests. The key ROUTING is the shared `handleTreeKeydown` (rovingTreeNav.ts, #1105); the
// seed-the-tab-stop/resolve-event-to-treeitem glue is the shared `createRovingTabIndex`
// (rovingTreeNav.ts, #1365) — this file supplies only the item source (via a ref helper) and the
// panel-specific ContextMenu affordance. `nestedButtonSelector: 'button'` pulls this navigator's inner
// controls (the leaf activator, the ⋯ overflow, a branch head) out of the tab order — mouse clicks
// still work, and keyboard activation is forwarded from the focused treeitem.

/** A {@link RovingTreeNav} over `rovingTabIndex`'s live treeitems, built per keydown so it can read the
 *  event's target. The navigator has no ArrowRight/Left (its trees never collapse a branch), so it omits
 *  `expand`/`collapse` and keeps the default Home/End + Space-activation. */
function treeNav(rovingTabIndex: RovingTabIndexHelper, ev: KeyboardEvent): RovingTreeNav<HTMLElement> {
  // Snapshot the treeitems once per keydown: the navigator's trees never mutate mid-handler (it has no
  // expand/collapse), so a single querySelectorAll serves items()/activeIndex()/focusIndex().
  const items = rovingTabIndex.visibleTreeItems();
  return {
    items: () => items,
    activeIndex: () => {
      const current = rovingTabIndex.currentTreeItem(ev);
      return current ? items.indexOf(current) : -1;
    },
    focusIndex: (i) => {
      const item = items[i];
      if (item) rovingTabIndex.focusItem(item);
    },
    activate: () => {
      // A `<button>` treeitem activates natively (leave the key to the browser); a wrapper row (the
      // tactical rows) forwards Enter/Space to the primary control inside it. A wrapper row with NO
      // control to forward to — the context-map relation rows, which are pure information — reports the
      // key UNCONSUMED so the router leaves it to the browser: claiming it would `preventDefault()` and
      // silently swallow Space's native scroll while doing nothing at all.
      const current = rovingTabIndex.currentTreeItem(ev);
      if (!current || current.tagName === 'BUTTON') return false;
      const inner = current.querySelector<HTMLElement>('button');
      if (!inner) return false;
      inner.click();
      return true;
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
  const rovingTabIndex = createRovingTabIndex(tree, { nestedButtonSelector: 'button' });
  rovingTabIndex.setRovingItem(null); // seed the first treeitem as the single tab stop (re-run on every commit)
  if (wiredTrees.has(tree)) return;
  wiredTrees.add(tree);
  tree.addEventListener('keydown', (ev) => {
    // Context-menu affordance: the dedicated ContextMenu key (or Shift+F10) opens the focused row's `⋯`
    // overflow, so keyboard users reach its cross-axis actions ("Reveal in Files") the mouse gets from the
    // `⋯` button (which roving tabindex keeps out of the tab order).
    if (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) {
      // Only the row's OWN ⋯ qualifies (a leaf row appends it as a direct child). A bare descendant
      // lookup on a BRANCH treeitem (an aggregate, or an owning entity below it) would descend into its
      // nested group and open the first owned leaf's menu — a wrongly-targeted action; a branch row has
      // no overflow of its own, so the key no-ops there.
      const more = rovingTabIndex.currentTreeItem(ev)?.querySelector<HTMLElement>(':scope > .koi-tactical-more');
      if (more) {
        ev.preventDefault();
        more.click();
      }
      return;
    }
    handleTreeKeydown(treeNav(rovingTabIndex, ev), ev);
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
  contextMap: () => Promise<ContextMapResult>;
  /** The whole structured model graph (root `kind: 'model'` → bounded-context children) — the tactical tree's source. */
  model(): Promise<ModelNode>;
}

/** Wiring for the tactical level — what a leaf (an owned construct or a context-level peer) does when
 * activated, plus the cross-axis links (#453). The leaves carry their `data-construct` / `data-name` and
 * `qualifiedName`, so a click resolves to a model element without re-rendering the tree. Supplied by the
 * rail controller, which owns the inspector / editor / Files-axis seams. */
export interface TacticalHandlers {
  /** Select a tactical node — drives the inspector + cross-highlight. */
  onSelect: (node: ModelNode) => void;
  /** Jump to a node's declaration (the controller resolves the node → 1-based source position). */
  goto: (node: ModelNode) => void;
  /** Reveal the node's bounded context in the Files axis (the leaf calls {@link setAxis} first). */
  reveal(node: ModelNode): void;
  /** Switch the rail's active navigator axis (the DDD Domain view vs the workspace Files tree). */
  setAxis: (axis: 'domain' | 'files') => void;
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

/** One tactical leaf — a construct that owns nothing itself, at any depth (under an aggregate or an
 * entity below it) or as a context-level peer. The row IS the
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
          openLeafMenu(ev.currentTarget, node, handlers);
        }}
      >
        ⋯
      </button>
    </div>
  );
}

/** One OWNING node — an aggregate, or anything below it that owns constructs of its own (an entity with
 * its state machines / commands / factories, #483): a head row (the construct glyph + name, carrying the
 * node's qualified name) with its children nested beneath in a spine, so ownership reads as containment.
 * The container carries `data-qname` for the cross-highlight; the head is the selectable row for the node
 * itself, and each child recurses through {@link TacticalNode} so depth is unbounded rather than fixed at
 * aggregate → leaf. `nested` marks a branch BELOW an aggregate, which tightens its spacing (`_model.scss`)
 * so the aggregate stays the visually dominant boundary. */
function TacticalBranch({
  node,
  handlers,
  nested = false,
}: {
  node: ModelNode;
  handlers: TacticalHandlers;
  nested?: boolean;
}): VNode {
  const { slug } = constructForKind(node.kind);
  return (
    // Isolate the accessible name to this node's title — otherwise it concatenates every owned child's
    // text (the nested role="group" spine) into the node's announced name.
    <div
      class={'koi-agg' + (nested ? ' koi-agg--nested' : '')}
      data-qname={node.qualifiedName}
      role="treeitem"
      aria-expanded="true"
      aria-label={node.title}
    >
      <button
        type="button"
        class="koi-agg-head"
        data-construct={slug}
        data-name={node.title}
        onClick={() => {
          handlers.onSelect(node);
          handlers.goto(node);
        }}
      >
        <ConstructIcon slug={slug} />
        <span class="koi-agg-name">{node.title}</span>
      </button>
      {/* The owned constructs, nested in a bracketed spine that makes the owner's boundary visible. */}
      <div class="koi-agg-spine" role="group">
        {node.children.map((child) => (
          <TacticalNode key={child.qualifiedName} node={child} handlers={handlers} />
        ))}
      </div>
    </div>
  );
}

/** One tactical row, leaf-or-branch: a node that owns nothing renders as a {@link TacticalLeaf} (with its
 * cross-axis `⋯` overflow); a node that owns constructs renders as a {@link TacticalBranch} so its
 * children get their own treeitem rows instead of being dropped. This is what lights up the behavioural
 * vocabulary (#483) — an entity's `states`/`command`/`factory` children, and any future owned depth. */
function TacticalNode({ node, handlers }: { node: ModelNode; handlers: TacticalHandlers }): VNode {
  return node.children.length ? (
    <TacticalBranch node={node} handlers={handlers} nested />
  ) : (
    <TacticalLeaf node={node} handlers={handlers} />
  );
}

/**
 * The TACTICAL body for a bounded context — aggregate-centric: each `aggregate` child becomes a branch
 * node with its owned constructs nested beneath ({@link TacticalBranch}); every OTHER top-level child (a
 * value object, enum, event, or a behavioural `policy`/`service`/`spec`/`read-model`/`query`, declared at
 * the context level rather than inside an aggregate) is a peer under a quiet `context` divider — no orphan
 * "Aggregates" header. Both spines recurse through {@link TacticalNode}, so an owner at ANY depth (an
 * entity's commands/factories/state machines, #483) gets its children as rows rather than dropping them.
 * A `null`/empty `ctxNode` (loading, or a context with no declarations) renders an empty body, not a crash.
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
      {/* An aggregate is ALWAYS a branch — the boundary owner reads as one even when it owns nothing. */}
      {aggregates.map((agg) => (
        <TacticalBranch key={agg.qualifiedName} node={agg} handlers={handlers} />
      ))}
      {peers.length ? (
        <div class="koi-ctx-peers" role="group">
          {peers.map((peer) => (
            <TacticalNode key={peer.qualifiedName} node={peer} handlers={handlers} />
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

// --- the STRATEGIC Context Map graph, behind the `⤳ Context Map` doorway (#483) ---------------------
// A context map read the way DDD teaches it: the bounded contexts as nodes, and the typed relationships
// between them as edges whose BOTH ends carry the role that end plays (Supplier/Customer,
// Upstream/Conformist, Open Host Service/Downstream, …). The roles are derived ONCE, server-side
// (`ContextRelationRoles`, #483 Task 3) and ride the payload, so every surface badges a relation
// identically.
//
// REUSE, not a second renderer: the ContextMapResult → `{ nodes, edges }` shaping is the SHARED
// `buildContextMapGraph` (`@/diagrams/contextMapGraph`) the inspector's maxGraph canvas already feeds
// from — same node set (declared contexts + any dangling relation endpoint), same declaration spans
// (#290), same edge metadata. Only the PRESENTATION differs: the canvas mounts a maxGraph diagram, while
// the left rail needs a light, keyboard-navigable DOM tree that costs nothing to paint in a 260px rail.
// So the mapper is shared and only the DOM is navigator-specific — a relation can't be badged one way
// here and another way there.

/** Wiring for the strategic Context Map graph — what a context node does when activated. */
export interface ContextMapHandlers {
  /** Jump the editor to a 1-based line/column: the navigator's EXISTING jump-to-declaration seam
   *  ({@link ModelOutlineHandlers.goto}, already wired to `editor.goto`), fed from the context's
   *  declaration span in `contextSpans` (#290). A span-less context stays inert. */
  goto: (line: number, column: number) => void;
  /** Hand off to the caller's FULL Context Map view — the center-deck destination
   *  ({@link StrategicHandlers.onOpenContextMap}) with the maxGraph canvas, the Graph/Table toggle and
   *  the shared-types / anti-corruption detail strip this 260px rail level deliberately summarizes away.
   *  Wired to the level's own `Open full Context Map` row, so the richer view stays one step from here. */
  openFullMap: () => void;
}

/** One bounded-context node. The whole row IS the button (and the treeitem), like {@link ContextRow};
 * clicking it jumps to the context's `.koi` declaration. A node with no span (a dangling relation
 * endpoint, or a recovered parse) still renders — the map never dangles — but stays inert to navigation. */
function ContextMapNode({ node, handlers }: { node: DiagramNode; handlers: ContextMapHandlers }): VNode {
  const span = node.sourceSpan;
  return (
    <button
      type="button"
      class="koi-domain-ctxmap-node"
      data-ctxmap-node={node.qualifiedName}
      role="treeitem"
      aria-label={span ? `${node.label}, go to declaration` : node.label}
      onClick={() => {
        if (span) handlers.goto(span.line, span.column);
      }}
    >
      <Glyph symbol="◈" />
      <span class="koi-ctx-name">{node.label}</span>
    </button>
  );
}

/** The DDD role one END of a relation plays. A `null` role — the SYMMETRIC patterns (partnership /
 * shared kernel), where the two contexts are peers — renders NO badge at all, rather than an empty pill
 * or the string "null". */
function RoleBadge({ end, role }: { end: 'upstream' | 'downstream'; role: string | null }): VNode | null {
  return role ? (
    <span class="koi-domain-ctxmap-role" data-role-end={end}>
      {role}
    </span>
  ) : null;
}

/** One typed relationship: `‹upstream› [role] → ‹downstream› [role]` plus the relationship kind. The
 * arrow glyph is decorative (`↔` for a symmetric relation), so the row carries an explicit accessible
 * name that reads the same information in words — "Sales as Supplier to Shipping as Customer,
 * Customer/Supplier" — instead of concatenating the badge fragments.
 *
 * `data-ctxmap-edge` addresses the row as `‹from›→‹to›#‹index›`: a context PAIR alone is ambiguous (two
 * contexts may declare several relations), so the declaration index disambiguates it — the same key the
 * list renders each row with. */
function ContextMapEdgeRow({ edge, index }: { edge: ContextMapEdge; index: number }): VNode {
  const kind = edge.label ?? 'relation';
  const end = (name: string, role: string | null): string => (role ? `${name} as ${role}` : name);
  const label = `${end(edge.from, edge.upstreamRole)} ${edge.bidirectional ? 'and' : 'to'} ${end(
    edge.to,
    edge.downstreamRole,
  )}, ${kind}`;
  return (
    <div
      class="koi-domain-ctxmap-edge"
      data-ctxmap-edge={`${edge.from}→${edge.to}#${String(index)}`}
      role="treeitem"
      aria-label={label}
    >
      <span class="koi-domain-ctxmap-end">
        <span class="koi-domain-ctxmap-end-name">{edge.from}</span>
        <RoleBadge end="upstream" role={edge.upstreamRole} />
      </span>
      <Glyph symbol={edge.bidirectional ? '↔' : '→'} />
      <span class="koi-domain-ctxmap-end">
        <span class="koi-domain-ctxmap-end-name">{edge.to}</span>
        <RoleBadge end="downstream" role={edge.downstreamRole} />
      </span>
      <span class="koi-domain-ctxmap-kind">{kind}</span>
    </div>
  );
}

/**
 * The Context Map GRAPH body: one node row per bounded context, then the typed relations as edge rows
 * under a quiet group, and last the `Open full Context Map` door — the same `role="tree"` +
 * roving-tabindex keyboard model as the navigator's other levels (so the whole rail navigates
 * identically), with the context nodes and that door as the focusable, activatable rows. An empty map
 * renders a quiet note, NOT an empty `role="tree"` (which would break aria-required-children and leave a
 * keyboard-unreachable tree) — mirroring {@link TacticalLevel}.
 *
 * The closing door is deliberate: this level SUMMARIZES the map for a 260px rail (nodes + role-badged
 * edges), while the center-deck Context Map view owns the maxGraph canvas, the Graph/Table toggle and the
 * shared-types / anti-corruption detail strip. Without it, opening the rail level would strand a reader
 * away from the richer view — so it's a row here, in the same tree, reachable by the same keyboard model.
 */
export function ContextMapLevel({ map, handlers }: { map: ContextMapResult; handlers: ContextMapHandlers }): VNode {
  const graph = buildContextMapGraph(map);

  if (!graph.nodes.length) {
    return (
      <div class="koi-domain-ctxmap-body" role="note">
        <p class="muted koi-tactical-empty">No context map declared.</p>
      </div>
    );
  }

  return (
    <div
      class="koi-domain-ctxmap-body"
      role="tree"
      aria-label="Context map"
      ref={(el) => {
        if (el) wireTreeNav(el);
      }}
    >
      {graph.nodes.map((n) => (
        <ContextMapNode key={n.id} node={n} handlers={handlers} />
      ))}
      {graph.edges.length ? (
        <div class="koi-domain-ctxmap-edges" role="group">
          {graph.edges.map((e, i) => (
            <ContextMapEdgeRow key={`${e.from}→${e.to}#${String(i)}`} edge={e} index={i} />
          ))}
        </div>
      ) : null}
      {/* The way OUT to the richer view — reusing the strategic level's {@link DoorwayRow} idiom so it
          looks, reads and keyboards like every other door in the rail (a `treeitem` button in this same
          tree, with the destination woven into its accessible name via `hint`). Owned by a group for the
          same reason the strategic doors are, and last so the map itself stays the level's headline. */}
      <div class="koi-domain-ctxmap-doors" role="group">
        <DoorwayRow
          door="contextmap-full"
          symbol="⤢"
          label="Open full Context Map"
          hint="the canvas, table and shared-type details"
          onOpen={handlers.openFullMap}
        />
      </div>
    </div>
  );
}

/** The Context Map VIEW: the breadcrumb that climbs back to the strategic context list (the same row the
 * tactical view uses, so both doors out of a level look and behave alike), then the graph body. */
function ContextMapView({
  map,
  handlers,
  onBack,
}: {
  map: ContextMapResult;
  handlers: ContextMapHandlers;
  onBack: () => void;
}): VNode {
  return (
    <div class="koi-domain koi-domain-ctxmap">
      <button type="button" class="koi-breadcrumb-back" aria-label="Back to all contexts (in Context Map)" onClick={onBack}>
        <Glyph symbol="‹" />
        <span class="koi-breadcrumb-back-name">Context Map</span>
      </button>
      <ContextMapLevel map={map} handlers={handlers} />
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

/**
 * Build the strategic Context Map LEVEL as a detached DOM tree (see {@link ContextMapLevel}): one node
 * per bounded context, one edge per typed relation badged with the role each END plays, and the
 * `Open full Context Map` door.
 *
 * Named for the rail LEVEL it builds — a sibling of {@link renderStrategic} / {@link renderTactical} —
 * and deliberately not `renderContextMapGraph`, which `@/diagrams/diagrams-maxgraph` already exports for
 * the interactive canvas mount. Two same-named exports would collide on the `domainNavigator.ts` barrel's
 * `export *`, which ESM resolves by silently DROPPING the ambiguous name rather than erroring. Both
 * surfaces still shape their data with the SAME `buildContextMapGraph` mapper, so they can never disagree
 * about a relation; only the rendering differs.
 */
export function renderContextMapLevel(map: ContextMapResult, h: ContextMapHandlers): HTMLElement {
  const host = document.createElement('div');
  render(<ContextMapLevel map={map} handlers={h} />, host);
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
 * substring) — the TACTICAL counterpart of {@link filterGlossaryModel}. An OWNING node (an aggregate, or
 * an entity owning commands/factories/state machines — #483) survives when it matches OR owns a surviving
 * descendant, keeping ALL of its children when its own name is the hit; a node that owns nothing survives
 * on its own match. Prunes at every depth (not just aggregate → child), so a behavioural row keeps its
 * whole ownership chain visible. A blank query is the identity. */
function filterContextNode(ctx: ModelNode | null, query: string): ModelNode | null {
  if (!ctx) return ctx;
  const q = query.trim().toLowerCase();
  if (!q) return ctx;
  const prune = (n: ModelNode): ModelNode | null => {
    if (n.title.toLowerCase().includes(q)) return n; // a self-match keeps the node's whole subtree
    const children = n.children.map(prune).filter((c): c is ModelNode => c !== null);
    return children.length ? { ...n, children } : null;
  };
  return { ...ctx, children: ctx.children.map(prune).filter((c): c is ModelNode => c !== null) };
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
  /** The fetched context map (#483) — what the `⤳ Context Map` doorway graphs in-navigator; `relLinks`
   *  above stays the doorway's count badge. Optional/`null` for a hand-built cache (the presenter tests)
   *  and for a failed fetch: with no map to draw, the doorway falls back to the caller's docs hand-off. */
  contextMap?: ContextMapResult | null;
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
  contextMapOpen = false,
  onSetContextMapOpen,
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
  /** Whether the strategic Context Map graph is the open level (#483). A view-local toggle owned by the
   *  facade — NOT store state: it is scoped to one navigator instance and never outlives an altitude or
   *  scope move. Defaults to closed, so an existing caller is unaffected. */
  contextMapOpen?: boolean;
  /** Open/close the Context Map graph level. Omitted (a bare presenter render) ⇒ the doorway always falls
   *  back to the caller's `onOpenContextMap` hand-off, exactly as it did before #483. */
  onSetContextMapOpen?: (open: boolean) => void;
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
    // The doorway has TWO destinations (#483). A model that actually declares relationships opens the
    // navigator's OWN strategic graph (nodes + role-badged edges) — the rail is where you read the map
    // while you navigate. With no relations there is no graph to draw, so it keeps the pre-#483 hand-off
    // to the caller's docs/center-deck Context Map view, which owns the "no context map declared" story
    // (and the dense table + canvas). Same fallback when the map failed to fetch or the presenter was
    // rendered without the open/close seam. Opening the rail level is never a dead end either way: the
    // level's own `Open full Context Map` row hands off to that same center-deck view (see
    // `contextMapHandlers.openFullMap` below).
    onOpenContextMap: () => {
      const map = cache?.contextMap;
      if (map && map.relations.length > 0 && onSetContextMapOpen) onSetContextMapOpen(true);
      else handlers.onOpenContextMap?.();
    },
    onOpenGlossary: () => handlers.onOpenGlossary?.(),
  };

  /** The graph's jump-to-declaration, routed through the navigator's existing `goto(line, col)` seam,
   *  plus the level's escape hatch to the caller's FULL Context Map view — the SAME hand-off the doorway
   *  falls back to when there's nothing to graph, so the richer destination is reachable either way. */
  const contextMapHandlers: ContextMapHandlers = {
    goto: (line, column) => handlers.goto?.(line, column),
    openFullMap: () => handlers.onOpenContextMap?.(),
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
  } else if (contextMapOpen && cache?.contextMap) {
    // The strategic Context Map graph (#483). The per-level filter narrows constructs BY NAME, which a
    // cross-context relationship graph has none of — so it hides here, like it does while loading.
    filterHidden = true;
    level = (
      <ContextMapView
        key={`contextmap:${contentToken}`}
        map={cache.contextMap}
        handlers={contextMapHandlers}
        onBack={() => onSetContextMapOpen?.(false)}
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
        onInput={(e) => store.getState().setOutlineFilter(e.currentTarget.value)}
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

  // Whether the strategic Context Map graph is the open level (#483). View-local, not store state: it
  // belongs to THIS navigator instance and never survives an altitude / scope move (see the subscription).
  let contextMapOpen = false;

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
        contextMapOpen={contextMapOpen}
        onSetContextMapOpen={setContextMapOpen}
      />,
      host,
    );
  }

  /** Open / close the strategic Context Map graph. A level swap like a drill / climb, so it repaints and
   *  then runs the same focus-continuity step (the door row it was activated from is torn down by the
   *  repaint, which would otherwise drop keyboard focus to `<body>` — WCAG 2.4.3). */
  function setContextMapOpen(open: boolean): void {
    if (contextMapOpen === open) return;
    contextMapOpen = open;
    renderNow();
    onLevelChanged();
  }

  // A LEVEL swap — a drill / climb, or opening / closing the Context Map graph (#483), and ONLY that,
  // not a filter keystroke or the first content paint — plays the reduced-motion-guarded zoom entrance on
  // the freshly-mounted level, and lands focus on its first row. Runs AFTER renderNow(), when the new
  // level is already committed as `.koi-domain-body`'s child.
  function onLevelChanged(): void {
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
    // The Context Map graph (#483) is a STRATEGIC-level view of the whole model, so it must not survive a
    // move to another altitude or scope (a drill from elsewhere, the top-bar switcher): reset it BEFORE
    // the repaint, so the fresh paint shows the level `navAltitude` actually names.
    const closedContextMap =
      contextMapOpen && (s.navAltitude !== prev.navAltitude || s.activeContext !== prev.activeContext);
    if (closedContextMap) contextMapOpen = false;
    renderNow();
    if (s.navAltitude !== paintedAltitude) {
      paintedAltitude = s.navAltitude;
      onLevelChanged();
    } else if (closedContextMap) {
      // The graph gave way WITHOUT an altitude change (an external scope switch made while reading it):
      // it's still a level swap, so the focused row was torn down — recover focus the same way.
      onLevelChanged();
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
      // The whole context map is cached (not just its relation count) so the doorway can graph it
      // in-navigator without a second fetch (#483).
      cache = { model, relLinks: contextMap.relations.length, tree, contextMap };
    } catch {
      if (!isCurrent()) return;
      // best-effort: render the empty strategic state (and, with no map, a doorway that hands off)
      cache = { model: { entries: [] }, relLinks: 0, tree: null, contextMap: null };
      // …and CLOSE the Context Map level with it (#483 review). With `cache.contextMap` null the
      // presenter's `contextMapOpen && cache?.contextMap` guard falls through anyway, so leaving the flag
      // set would keep an invisible "open" state: no graph, no breadcrumb — and then the next SUCCESSFUL
      // reload would silently re-enter the level nobody asked for, with no entrance animation or focus
      // continuity (doFetch never runs onLevelChanged). Dropping it here keeps flag and paint in step.
      contextMapOpen = false;
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
