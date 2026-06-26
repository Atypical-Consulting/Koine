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
import type { ContextMapResult, GlossaryModel } from '@/lsp/lsp';
import { countsByContext, type ModelOutlineHandlers } from '@/model/modelOutline';
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

/** The slim LSP surface the strategic level fetches from: the glossary inventory (the context list +
 * per-context counts) and the context map (only its relation count is read). A structural interface, so
 * the controller's richer client and a test stub both satisfy it without coupling to the full class. */
export interface DomainNavigatorLsp {
  glossaryModel(): Promise<GlossaryModel>;
  contextMap(): Promise<ContextMapResult>;
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
): DomainNavigatorHandle {
  // The strategic data is fetched once and cached; store-driven changes (altitude / scope / filter)
  // re-render synchronously from the cache, and reload() re-fetches after an edit. `null` = not yet
  // loaded (a loading placeholder shows). A monotonic seq drops a superseded fetch (last write wins).
  let cache: { model: GlossaryModel; relLinks: number } | null = null;
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
      host.replaceChildren(renderTacticalView(s.activeContext, store));
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
      const [model, contextMap] = await Promise.all([lsp.glossaryModel(), lsp.contextMap()]);
      if (seq !== fetchSeq) return; // a newer reload superseded this fetch
      cache = { model, relLinks: contextMap.relations.length };
    } catch {
      if (seq !== fetchSeq) return;
      cache = { model: { entries: [] }, relLinks: 0 }; // best-effort: render the empty strategic state
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
 * then the context's aggregate-centric body. The breadcrumb is owned here; the body is the {@link
 * renderTactical} seam Task 4 fills in.
 */
function renderTacticalView(context: string, store: StoreApi<AppState>): HTMLElement {
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

  root.appendChild(renderTactical(context));
  return root;
}

/**
 * The TACTICAL body for a bounded context — its aggregates and their internals. A placeholder for now:
 * the full aggregate-centric tree (the glyph grammar, the drill-down) lands in Task 4 (#453), which fills
 * THIS function in (likely widening its signature to take the context's model node + tactical handlers).
 * The breadcrumb above it is owned by {@link mountDomainNavigator}, so Task 4 only replaces this body.
 */
function renderTactical(context: string): HTMLElement {
  const body = document.createElement('div');
  body.className = 'koi-domain-tactical-body';
  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = `Aggregates and internals of ${context} appear here.`;
  body.appendChild(note);
  return body;
}

/** A muted status/empty line for the navigator host (loading / no-model states). */
function message(className: string, text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = `muted ${className}`;
  p.textContent = text;
  return p;
}
