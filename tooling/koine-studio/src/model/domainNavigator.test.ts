import { afterEach, describe, expect, it, vi } from 'vitest';
import { render as renderComponent } from '@testing-library/preact';
import { h } from 'preact';
import {
  DomainNavigator,
  mountDomainNavigator,
  renderContextMapLevel,
  renderStrategic,
  renderTactical,
  type DomainNavigatorHandlers,
  type DomainNavigatorSeed,
  type TacticalHandlers,
} from '@/model/domainNavigator';
// The EXPLICIT `.tsx` specifier — the exact path the stories import (`DomainNavigator.tsx` and the
// `domainNavigator.ts` barrel differ only by case, so a bare capital import can case-insensitively
// resolve to the lowercase barrel on macOS and hand back `undefined` → Preact renders "[object Object]").
import { DomainNavigator as DomainNavigatorViaTsx } from '@/model/DomainNavigator.tsx';
import { createAppStore } from '@/store/index';
import type { ContextMapResult, GlossaryEntry, GlossaryModel, ModelNode, Range } from '@/lsp/lsp';

afterEach(() => {
  document.body.innerHTML = '';
});

const range = (line: number): Range => ({ start: { line, character: 2 }, end: { line, character: 8 } });

function entry(partial: Partial<GlossaryEntry> & { name: string; kind: string; context: string }): GlossaryEntry {
  return {
    id: `${partial.context}.${partial.name}`,
    qualifiedName: `${partial.context}.${partial.name}`,
    doc: null,
    nameRange: range(1),
    ...partial,
  };
}

// One context header + exactly seven non-context construct entries per context, spread across kinds
// so the per-context total tally is 7 (Aggregates 1, Entities 1, Value Objects 2, Enumerations 1,
// Domain Events 1, Types 1) — matching the expected '7' badge for 'Ordering'.
function fakeGlossary(contexts: string[]): GlossaryModel {
  const entries: GlossaryEntry[] = [];
  for (const ctx of contexts) {
    entries.push(entry({ name: ctx, kind: 'context', context: ctx, nameRange: range(0) }));
    entries.push(entry({ name: `${ctx}Order`, kind: 'aggregate', context: ctx }));
    entries.push(entry({ name: `${ctx}Line`, kind: 'entity', context: ctx }));
    entries.push(entry({ name: `${ctx}Money`, kind: 'value', context: ctx }));
    entries.push(entry({ name: `${ctx}Weight`, kind: 'quantity', context: ctx }));
    entries.push(entry({ name: `${ctx}Status`, kind: 'enum', context: ctx }));
    entries.push(entry({ name: `${ctx}Placed`, kind: 'event', context: ctx }));
    entries.push(entry({ name: `${ctx}Ref`, kind: 'type', context: ctx }));
  }
  return { entries };
}

describe('renderStrategic', () => {
  it('renders ◈ context rows with total-count badges and a context-map link count', () => {
    const onOpenContext = vi.fn();
    const el = renderStrategic(fakeGlossary(['Ordering', 'Billing']), 4,
      { onOpenContext, onOpenContextMap: vi.fn(), onOpenGlossary: vi.fn() });
    expect([...el.querySelectorAll('.koi-ctx-row')].length).toBe(2);
    expect(el.querySelector('[data-ctx="Ordering"] .koi-ctx-count')!.textContent).toBe('7');
    expect(el.textContent).toContain('Context Map');
    expect(el.textContent).toContain('4');
    (el.querySelector('[data-ctx="Ordering"]') as HTMLButtonElement).click();
    expect(onOpenContext).toHaveBeenCalledWith('Ordering');
  });

  // --- the active-context marker (ADR 0009 / #1188) --------------------------------------------------
  const noop = () => ({ onOpenContext: vi.fn(), onOpenContextMap: vi.fn(), onOpenGlossary: vi.fn() });
  const glyphOf = (row: Element | null) => row?.querySelector('.koi-domain-glyph')?.textContent;

  it('marks the active-context row (accent glyph + aria-current) and leaves the rest plain', () => {
    const el = renderStrategic(fakeGlossary(['Ordering', 'Billing']), 4, noop(), 'Ordering');
    const ordering = el.querySelector('[data-ctx="Ordering"]')!;
    const billing = el.querySelector('[data-ctx="Billing"]')!;

    expect(ordering.classList.contains('koi-ctx-row--scoped')).toBe(true);
    expect(ordering.getAttribute('aria-current')).toBe('true');
    expect(glyphOf(ordering)).toBe('◆'); // filled diamond — a non-colour shape cue
    // The label names it "active context" so the marker reads without relying on hue (WCAG AA).
    expect(ordering.getAttribute('aria-label')).toContain('active context');

    // The navigator STAYS the selector: every context is still listed, only Billing is left plain.
    expect(el.querySelectorAll('.koi-ctx-row')).toHaveLength(2);
    expect(billing.classList.contains('koi-ctx-row--scoped')).toBe(false);
    expect(billing.getAttribute('aria-current')).toBeNull();
    expect(glyphOf(billing)).toBe('◈'); // outline diamond
  });

  it('marks no row for the All-contexts view (scope omitted → null)', () => {
    const el = renderStrategic(fakeGlossary(['Ordering', 'Billing']), 4, noop());
    expect(el.querySelector('.koi-ctx-row--scoped')).toBeNull();
    expect(el.querySelector('[aria-current]')).toBeNull();
    expect([...el.querySelectorAll('.koi-ctx-row .koi-domain-glyph')].every((g) => g.textContent === '◈')).toBe(true);
  });

  it('a scope naming no listed context marks nothing — a graceful no-op', () => {
    const el = renderStrategic(fakeGlossary(['Ordering', 'Billing']), 4, noop(), 'Shipping');
    expect(el.querySelector('.koi-ctx-row--scoped')).toBeNull();
    expect(el.querySelectorAll('.koi-ctx-row')).toHaveLength(2); // nothing hidden
  });
});

// --- the tactical body: an aggregate-centric tree over the model graph (Task 4, #453) -----------
// Synthetic `ModelNode`s mirroring `koine/model`'s shape (the production graph is verified separately);
// `data-name` on a leaf is the node's `title`, and an aggregate is named `<Ctx>.<Agg>` like the graph.
function modelNode(kind: string, title: string, children: ModelNode[] = []): ModelNode {
  return { kind, qualifiedName: title, title, members: [], children };
}
const entity = (title: string) => modelNode('entity', title);
const value = (title: string) => modelNode('value', title);
const event = (title: string) => modelNode('event', title);
const aggNode = (title: string, children: ModelNode[]) => modelNode('aggregate', title, children);
// A `context` ModelNode; its aggregate children get the `<Ctx>.<Agg>` qualified name the graph emits.
function ctxNode(name: string, children: ModelNode[]): ModelNode {
  const stamped = children.map((c) =>
    c.kind === 'aggregate' ? { ...c, qualifiedName: `${name}.${c.title}` } : c,
  );
  return { kind: 'context', qualifiedName: name, title: name, members: [], children: stamped };
}
const noopTacticalHandlers = (): TacticalHandlers => ({
  onSelect: () => {},
  goto: () => {},
  reveal: () => {},
  setAxis: () => {},
});

describe('renderTactical', () => {
  it('nests owned constructs under their aggregate; context-level types are peers', () => {
    const ctx = ctxNode('Ordering', [
      aggNode('Order', [entity('Order'), value('Money'), event('OrderPlaced')]),
      value('Currency'),
    ]);
    const el = renderTactical(ctx, noopTacticalHandlers());
    const agg = el.querySelector('[data-qname="Ordering.Order"]')!;
    expect(agg.querySelector('[data-construct="value"][data-name="Money"]')).toBeTruthy();
    expect(agg.querySelector('[data-construct="event"][data-name="OrderPlaced"]')).toBeTruthy();
    expect(el.querySelector('.koi-ctx-peers [data-name="Currency"]')).toBeTruthy();
  });
});

// --- the behavioural vocabulary (#483): the rows the model graph now carries below an aggregate -----
// The round-trip graph emits an aggregate's `repository`/`spec` and an ENTITY's `states`/`command`/
// `factory` children, plus the context-level `policy`/`service`/`spec`/`read-model`/`query` peers. The
// tactical tree used to descend only aggregate → leaf, so everything an entity owned was silently
// dropped; each of these rows must now render with the slug `constructForKind` resolves for its kind.
const behaviouralCtx = (): ModelNode =>
  ctxNode('Ordering', [
    aggNode('Order', [
      modelNode('entity', 'OrderLine', [
        modelNode('states', 'status'),
        modelNode('command', 'place'),
        modelNode('factory', 'draft'),
      ]),
      modelNode('repository', 'repository'),
      modelNode('spec', 'Overdue'),
    ]),
    modelNode('policy', 'NotifyOnPlaced'),
    modelNode('service', 'PricingService'),
    modelNode('read-model', 'OrderSummary'),
    modelNode('query', 'FindOpenOrders'),
    modelNode('spec', 'HighValue'),
  ]);

/** The activation control addressing `name` (a leaf's button, or a branch node's head row). */
const rowFor = (el: HTMLElement, name: string) => el.querySelector<HTMLElement>(`[data-name="${name}"]`);

/** Every rendered `treeitem` in DOM order, named by the control it OWNS (its direct child) — so a branch
 *  row reports its own name, not the first name in its nested spine. */
const rowNames = (el: HTMLElement): (string | undefined)[] =>
  [...el.querySelectorAll<HTMLElement>('[role="treeitem"]')].map(
    (r) => r.querySelector<HTMLElement>(':scope > [data-name]')?.dataset.name,
  );

describe('renderTactical — behavioural vocabulary (#483)', () => {
  it('renders the entity-owned states/command/factory rows with their construct slugs', () => {
    const el = renderTactical(behaviouralCtx(), noopTacticalHandlers());
    const agg = el.querySelector<HTMLElement>('[data-qname="Ordering.Order"]')!;
    // The entity is no longer a dead-end leaf: it owns a nested branch of behavioural rows.
    const entityRow = agg.querySelector<HTMLElement>('[role="treeitem"][data-qname="OrderLine"]')!;
    expect(entityRow).toBeTruthy();

    expect(rowFor(entityRow, 'status')?.getAttribute('data-construct')).toBe('state-machine');
    expect(rowFor(entityRow, 'place')?.getAttribute('data-construct')).toBe('command');
    expect(rowFor(entityRow, 'draft')?.getAttribute('data-construct')).toBe('factory');
    // Each is its own treeitem row (not just decoration inside the entity's row).
    for (const name of ['status', 'place', 'draft']) {
      expect(rowFor(entityRow, name)!.parentElement!.getAttribute('role')).toBe('treeitem');
    }
  });

  it('renders the aggregate-owned repository/spec rows with their construct slugs', () => {
    const el = renderTactical(behaviouralCtx(), noopTacticalHandlers());
    const agg = el.querySelector<HTMLElement>('[data-qname="Ordering.Order"]')!;
    expect(rowFor(agg, 'repository')?.getAttribute('data-construct')).toBe('repository');
    expect(rowFor(agg, 'Overdue')?.getAttribute('data-construct')).toBe('spec');
  });

  it('renders the context-level policy/service/read-model/query/spec peers with their construct slugs', () => {
    const el = renderTactical(behaviouralCtx(), noopTacticalHandlers());
    const peers = el.querySelector<HTMLElement>('.koi-ctx-peers')!;
    expect(rowFor(peers, 'NotifyOnPlaced')?.getAttribute('data-construct')).toBe('policy');
    expect(rowFor(peers, 'PricingService')?.getAttribute('data-construct')).toBe('service');
    expect(rowFor(peers, 'OrderSummary')?.getAttribute('data-construct')).toBe('read-model');
    expect(rowFor(peers, 'FindOpenOrders')?.getAttribute('data-construct')).toBe('query');
    expect(rowFor(peers, 'HighValue')?.getAttribute('data-construct')).toBe('spec');
  });

  it('preserves declaration order across the added depth', () => {
    const el = renderTactical(behaviouralCtx(), noopTacticalHandlers());
    expect(rowNames(el)).toEqual([
      'Order',
      'OrderLine',
      'status',
      'place',
      'draft',
      'repository',
      'Overdue',
      'NotifyOnPlaced',
      'PricingService',
      'OrderSummary',
      'FindOpenOrders',
      'HighValue',
    ]);
  });

  it('keeps every added row reachable by the roving-tabindex tree keyboard model', () => {
    const el = renderTactical(behaviouralCtx(), noopTacticalHandlers());
    document.body.appendChild(el);
    const items = [...el.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    expect(items.length).toBe(12);

    // A single tab stop, seeded on the first row (the nested rows must not steal or duplicate it).
    expect(items.filter((it) => it.tabIndex === 0)).toEqual([items[0]]);

    // ArrowDown walks EVERY row in DOM order — including the entity's nested behavioural rows.
    items[0].focus();
    for (let i = 1; i < items.length; i++) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      expect(document.activeElement).toBe(items[i]);
    }
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    expect(document.activeElement).toBe(items[0]);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it('selecting a nested behavioural row selects + jumps to it', () => {
    const onSelect = vi.fn();
    const goto = vi.fn();
    const el = renderTactical(behaviouralCtx(), { onSelect, goto, reveal: vi.fn(), setAxis: vi.fn() });
    (rowFor(el, 'place') as HTMLButtonElement).click();
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'command', title: 'place' }));
    expect(goto).toHaveBeenCalledWith(expect.objectContaining({ kind: 'command', title: 'place' }));
  });
});

// --- cross-axis leaf actions: select → goto + the "Reveal in Files" overflow (Task 5, #453) --------
describe('renderTactical — cross-axis leaf actions', () => {
  const ctxWithLeaf = (): ModelNode => ctxNode('Ordering', [value('Currency')]);

  // Open the leaf's ⋯ overflow menu and choose "Reveal in Files". The menu mounts to document.body
  // (mirroring the explorer's floating context menu), so the item is queried globally.
  function revealInFiles(el: HTMLElement): void {
    (el.querySelector('.koi-tactical-more') as HTMLButtonElement).click();
    const item = Array.from(document.querySelectorAll<HTMLButtonElement>('.koi-tactical-menu-item')).find(
      (b) => b.textContent === 'Reveal in Files',
    )!;
    item.click();
  }

  it('selecting a leaf jumps + selects; Reveal in Files switches axis and reveals the file', () => {
    const onSelect = vi.fn();
    const goto = vi.fn();
    const reveal = vi.fn();
    const setAxis = vi.fn();
    const el = renderTactical(ctxWithLeaf(), { onSelect, goto, reveal, setAxis });
    document.body.appendChild(el); // the ⋯ menu mounts to document.body; afterEach clears it

    (el.querySelector('.koi-tactical-leaf') as HTMLButtonElement).click();
    expect(onSelect).toHaveBeenCalled();
    expect(goto).toHaveBeenCalled();

    revealInFiles(el); // open ⋯ menu → Reveal in Files
    expect(setAxis).toHaveBeenCalledWith('files');
    expect(reveal).toHaveBeenCalled();
  });
});

// The leaf ⋯ menu's dismissal contract — pinned so the shared-engine migration (#547) is provably
// behavior-preserving: Escape / outside-pointerdown close it and return focus to the `⋯` trigger.
describe('renderTactical — leaf ⋯ menu dismissal', () => {
  const ctxWithLeaf = (): ModelNode => ctxNode('Ordering', [value('Currency')]);

  function openMore(el: HTMLElement): HTMLButtonElement {
    const more = el.querySelector('.koi-tactical-more') as HTMLButtonElement;
    more.click();
    return more;
  }

  it('Escape dismisses the ⋯ menu and returns focus to the trigger', () => {
    const el = renderTactical(ctxWithLeaf(), noopTacticalHandlers());
    document.body.appendChild(el);
    const more = openMore(el);
    expect(document.querySelector('.koi-tactical-menu')).toBeTruthy();
    expect(more.getAttribute('aria-expanded')).toBe('true');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.koi-tactical-menu')).toBeNull();
    expect(document.activeElement).toBe(more);
    expect(more.getAttribute('aria-expanded')).toBe('false');
  });

  it('an outside pointerdown dismisses the ⋯ menu', () => {
    const el = renderTactical(ctxWithLeaf(), noopTacticalHandlers());
    document.body.appendChild(el);
    openMore(el);
    expect(document.querySelector('.koi-tactical-menu')).toBeTruthy();

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(document.querySelector('.koi-tactical-menu')).toBeNull();
  });
});

// --- the STRATEGIC Context Map graph behind the doorway (#483) ------------------------------------
// A typed context map: one directional customer/supplier relation, one anti-corruption-layer relation,
// and (in the symmetric fixture) a partnership. The per-end `upstreamRole`/`downstreamRole` are derived
// SERVER-side (#483 Task 3) — the navigator only badges what the payload carries, and a null role (the
// symmetric patterns) must render NO badge at all.
const salesSpan = { file: 'file:///sales.koi', line: 3, column: 9, endLine: 3, endColumn: 14, offset: 20, length: 5 };

function typedContextMap(): ContextMapResult {
  return {
    contexts: ['Sales', 'Shipping', 'Legacy'],
    // Sales carries its declaration span (jump-to-declaration); Shipping's is null (a recovered parse).
    contextSpans: { Sales: salesSpan, Shipping: null },
    relations: [
      {
        upstream: 'Sales',
        downstream: 'Shipping',
        kind: 'Customer/Supplier',
        bidirectional: false,
        sharedTypes: ['Address'],
        acl: [],
        upstreamRole: 'Supplier',
        downstreamRole: 'Customer',
      },
      {
        upstream: 'Legacy',
        downstream: 'Shipping',
        kind: 'Anticorruption Layer',
        bidirectional: false,
        sharedTypes: [],
        acl: [{ upstreamContext: 'Legacy', upstreamType: 'Customer', localContext: 'Shipping', localType: 'Recipient' }],
        upstreamRole: 'Upstream',
        downstreamRole: 'Anti-Corruption Layer',
      },
    ],
  };
}

/** A symmetric relation — partnership / shared kernel: neither end has a distinct role (null/null). */
function symmetricContextMap(): ContextMapResult {
  return {
    contexts: ['Sales', 'Support'],
    relations: [
      {
        upstream: 'Sales',
        downstream: 'Support',
        kind: 'Partnership',
        bidirectional: true,
        sharedTypes: [],
        acl: [],
        upstreamRole: null,
        downstreamRole: null,
      },
    ],
  };
}

const ctxmapNodes = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-ctxmap-node]')];
const ctxmapEdges = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.koi-domain-ctxmap-edge')];
const roleAt = (edge: HTMLElement, end: 'upstream' | 'downstream') =>
  edge.querySelector<HTMLElement>(`[data-role-end="${end}"]`)?.textContent;

describe('renderContextMapLevel', () => {
  it('renders one node per context and one edge per relation, badging BOTH ends with its derived roles', () => {
    const el = renderContextMapLevel(typedContextMap(), { goto: vi.fn(), openFullMap: vi.fn() });

    // Nodes = contexts (declaration order), each addressable by name.
    expect(ctxmapNodes(el).map((n) => n.dataset.ctxmapNode)).toEqual(['Sales', 'Shipping', 'Legacy']);

    // Edges = the typed relations, in declaration order, each naming both ends + the relationship kind.
    const edges = ctxmapEdges(el);
    expect(edges).toHaveLength(2);
    expect(edges[0].textContent).toContain('Sales');
    expect(edges[0].textContent).toContain('Shipping');
    expect(edges[0].textContent).toContain('Customer/Supplier');

    // …and BOTH ends carry the DDD role badge the payload derived for them.
    expect(roleAt(edges[0], 'upstream')).toBe('Supplier');
    expect(roleAt(edges[0], 'downstream')).toBe('Customer');
    expect(roleAt(edges[1], 'upstream')).toBe('Upstream');
    expect(roleAt(edges[1], 'downstream')).toBe('Anti-Corruption Layer');

    // The row's accessible name carries the same reading (the `→` glyph is decorative).
    expect(edges[0].getAttribute('aria-label')).toBe('Sales as Supplier to Shipping as Customer, Customer/Supplier');
  });

  it('a symmetric relation (partnership / shared kernel) renders NO role badge at either end', () => {
    const el = renderContextMapLevel(symmetricContextMap(), { goto: vi.fn(), openFullMap: vi.fn() });
    const edge = ctxmapEdges(el)[0];

    // A null role is an ABSENT badge — not an empty pill, and never the string "null".
    expect(edge.querySelectorAll('.koi-domain-ctxmap-role')).toHaveLength(0);
    expect(edge.textContent).not.toContain('null');
    // Both ends are still named, and the undirected glyph replaces the arrow.
    expect(edge.getAttribute('aria-label')).toBe('Sales and Support, Partnership');
  });

  it('a context-node click jumps to its declaration (contextSpans); a span-less node stays inert', () => {
    const goto = vi.fn();
    const el = renderContextMapLevel(typedContextMap(), { goto, openFullMap: vi.fn() });

    (el.querySelector('[data-ctxmap-node="Sales"]') as HTMLButtonElement).click();
    expect(goto).toHaveBeenCalledWith(salesSpan.line, salesSpan.column); // the raw 1-based span

    goto.mockClear();
    (el.querySelector('[data-ctxmap-node="Shipping"]') as HTMLButtonElement).click();
    expect(goto).not.toHaveBeenCalled(); // no span (recovered parse) ⇒ inert, not a crash
  });

  it('an empty context map renders a quiet note, not an empty tree', () => {
    const el = renderContextMapLevel({ contexts: [], relations: [] }, { goto: vi.fn(), openFullMap: vi.fn() });
    expect(el.getAttribute('role')).toBe('note');
    expect(el.querySelector('[role="treeitem"]')).toBeNull();
  });

  // Two relations between the SAME pair of contexts: the row address must still tell them apart, so it
  // carries the declaration index alongside the pair (a bare `from→to` collided).
  it('addresses each edge row unambiguously when two relations share a context pair', () => {
    const el = renderContextMapLevel(
      {
        contexts: ['Sales', 'Shipping'],
        relations: [
          {
            upstream: 'Sales',
            downstream: 'Shipping',
            kind: 'Customer/Supplier',
            bidirectional: false,
            sharedTypes: [],
            acl: [],
            upstreamRole: 'Supplier',
            downstreamRole: 'Customer',
          },
          {
            upstream: 'Sales',
            downstream: 'Shipping',
            kind: 'Open Host Service',
            bidirectional: false,
            sharedTypes: [],
            acl: [],
            upstreamRole: 'Open Host Service',
            downstreamRole: 'Downstream',
          },
        ],
      },
      { goto: vi.fn(), openFullMap: vi.fn() },
    );
    expect(ctxmapEdges(el).map((e) => e.dataset.ctxmapEdge)).toEqual(['Sales→Shipping#0', 'Sales→Shipping#1']);
  });

  // The rail level SUMMARIZES the map; the center-deck view owns the canvas, the Graph/Table toggle and
  // the shared-type / ACL detail strip. So the level closes with a door back to it — otherwise opening
  // the rail level would strand a reader away from the richer destination.
  it('closes with an "Open full Context Map" row that hands off to the caller', () => {
    const openFullMap = vi.fn();
    const el = renderContextMapLevel(typedContextMap(), { goto: vi.fn(), openFullMap });

    const door = el.querySelector<HTMLButtonElement>('[data-door="contextmap-full"]')!;
    expect(door).toBeTruthy();
    // Same treeitem idiom as every other row, so the roving-tabindex model reaches it…
    expect(door.getAttribute('role')).toBe('treeitem');
    // …and it names both the action and where it lands (the row text alone would be ambiguous).
    expect(door.getAttribute('aria-label')).toBe('Open full Context Map — the canvas, table and shared-type details');
    expect([...el.querySelectorAll<HTMLElement>('[role="treeitem"]')].at(-1)).toBe(door); // last, after the map

    door.click();
    expect(openFullMap).toHaveBeenCalledTimes(1);
  });
});

// --- Enter/Space activation only claims the key when there IS something to activate ----------------
// The navigator's `treeNav.activate` forwards Enter/Space from a wrapper `treeitem` to the button inside
// it. A wrapper with no button (a context-map relation row — pure information) must report the key
// UNCONSUMED: the shared router calls `preventDefault()` on a `true`, which would swallow Space's native
// scroll while doing nothing at all.
describe('Domain navigator — Enter/Space activation', () => {
  const press = (el: HTMLElement, key: string): KeyboardEvent => {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev;
  };

  it('a relation row has nothing to activate — Space is left to the browser', () => {
    const el = renderContextMapLevel(typedContextMap(), { goto: vi.fn(), openFullMap: vi.fn() });
    document.body.appendChild(el);
    const edge = ctxmapEdges(el)[0];
    edge.focus();

    expect(press(edge, ' ').defaultPrevented).toBe(false);
    expect(press(edge, 'Enter').defaultPrevented).toBe(false);
  });

  it('a tactical leaf row still forwards Space to its activation button (the key IS consumed)', () => {
    const onSelect = vi.fn();
    const el = renderTactical(ctxNode('Ordering', [value('Currency')]), {
      onSelect,
      goto: vi.fn(),
      reveal: vi.fn(),
      setAxis: vi.fn(),
    });
    document.body.appendChild(el);
    const row = el.querySelector<HTMLElement>('.koi-tactical-leaf-row')!;
    row.focus();

    expect(press(row, ' ').defaultPrevented).toBe(true);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

// A fresh app store — the single source of truth for the navigator's altitude + scope.
const makeTestStore = () => createAppStore();

// A minimal LSP stub: the two endpoints the strategic level reads (glossaryModel + contextMap), plus
// model() for parity with the controller's seam. Each resolves async, so the navigator's first fetch
// is genuinely asynchronous — the test flushes a microtask round after mount/clicks (the realistic path).
function fakeLsp() {
  return {
    glossaryModel: vi.fn(async (): Promise<GlossaryModel> => fakeGlossary(['Ordering', 'Billing'])),
    contextMap: vi.fn(async (): Promise<ContextMapResult> => ({ contexts: ['Ordering', 'Billing'], relations: [] })),
    model: vi.fn(async () => ({ kind: 'model', qualifiedName: '', title: '', members: [], children: [] })),
  };
}

/** Let the navigator's microtask-chained fetch settle so its synchronous render runs. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe('mountDomainNavigator', () => {
  it('drills into a context and the breadcrumb zooms back out', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const store = makeTestStore();
    mountDomainNavigator(host, store, fakeLsp());
    await flush(); // the initial strategic fetch resolves and paints the context rows

    (host.querySelector('[data-ctx="Ordering"]') as HTMLButtonElement).click();
    expect(store.getState().navAltitude).toBe('tactical');
    expect(store.getState().activeContext).toBe('Ordering');
    await flush();

    // The tactical view carries a breadcrumb that zooms back out to the strategic context list.
    (host.querySelector('.koi-breadcrumb-back') as HTMLButtonElement).click();
    expect(store.getState().navAltitude).toBe('strategic');
  });

  it('a top-bar scope change lands on strategic — no surprise auto-drill (navAltitude reset)', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const store = makeTestStore();
    mountDomainNavigator(host, store, fakeLsp());
    await flush(); // strategic context rows painted

    // Drill into Ordering via the in-navigator row → tactical.
    (host.querySelector('[data-ctx="Ordering"]') as HTMLButtonElement).click();
    expect(store.getState().navAltitude).toBe('tactical');
    await flush();

    // A top-bar scope change drives the store's setActiveContext DIRECTLY (not the in-navigator drill).
    // The navigator must reset to strategic — it shows what navAltitude says, never auto-drilling into
    // the freshly-picked context with a stale 'tactical'.
    store.getState().setActiveContext('Billing');
    expect(store.getState().navAltitude).toBe('strategic');
    expect(host.querySelector('.koi-breadcrumb-back')).toBeNull(); // not the tactical view
    expect(host.querySelector('[data-ctx="Ordering"]')).toBeTruthy(); // the strategic context list is shown
  });

  it('delegates the Context Map / Glossary doorways to the caller', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onOpenContextMap = vi.fn();
    const onOpenGlossary = vi.fn();
    mountDomainNavigator(host, makeTestStore(), fakeLsp(), { onOpenContextMap, onOpenGlossary });
    await flush();

    (host.querySelector('[data-door="contextmap"]') as HTMLButtonElement).click();
    (host.querySelector('[data-door="glossary"]') as HTMLButtonElement).click();
    expect(onOpenContextMap).toHaveBeenCalledTimes(1);
    expect(onOpenGlossary).toHaveBeenCalledTimes(1);
  });

  // --- the Context Map doorway opens the in-navigator strategic graph (#483) ----------------------
  // The doorway now has TWO destinations: a model that declares relationships gets the navigator's own
  // graph level (nodes + typed, role-badged edges); a model with none keeps the pre-#483 hand-off to the
  // caller's docs/center-deck view, which is where "no context map declared" belongs.
  const typedLsp = () => ({
    glossaryModel: vi.fn(async (): Promise<GlossaryModel> => fakeGlossary(['Ordering', 'Billing'])),
    contextMap: vi.fn(async (): Promise<ContextMapResult> => typedContextMap()),
    model: vi.fn(async () => ({ kind: 'model', qualifiedName: '', title: '', members: [], children: [] })),
  });

  it('the Context Map doorway opens the in-navigator graph when the model declares relations', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onOpenContextMap = vi.fn();
    mountDomainNavigator(host, makeTestStore(), typedLsp(), { onOpenContextMap });
    await flush();

    // The doorway badge counts the relations…
    expect(host.querySelector('[data-door="contextmap"] .koi-domain-door-count')?.textContent).toBe('2');
    (host.querySelector('[data-door="contextmap"]') as HTMLButtonElement).click();

    // …and opening it paints the graph level IN the navigator (no hand-off to the docs view).
    expect(onOpenContextMap).not.toHaveBeenCalled();
    expect(host.querySelectorAll('[data-ctxmap-node]')).toHaveLength(3);
    expect(host.querySelectorAll('.koi-domain-ctxmap-edge')).toHaveLength(2);
    expect(host.querySelector('.koi-ctx-row')).toBeNull(); // the strategic list gave way to the graph

    // The breadcrumb climbs back to the strategic context list, like the tactical level's.
    (host.querySelector('.koi-breadcrumb-back') as HTMLButtonElement).click();
    expect(host.querySelector('.koi-domain-ctxmap-edge')).toBeNull();
    expect(host.querySelector('[data-ctx="Ordering"]')).toBeTruthy();
  });

  it('a context-node click in the graph jumps to its declaration through the navigator\'s goto seam', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const goto = vi.fn();
    mountDomainNavigator(host, makeTestStore(), typedLsp(), { goto });
    await flush();

    (host.querySelector('[data-door="contextmap"]') as HTMLButtonElement).click();
    (host.querySelector('[data-ctxmap-node="Sales"]') as HTMLButtonElement).click();
    expect(goto).toHaveBeenCalledWith(salesSpan.line, salesSpan.column);
  });

  it('a model with NO relations keeps the docs hand-off — the doorway delegates to the caller', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onOpenContextMap = vi.fn();
    // fakeLsp()'s context map declares contexts but no relations — nothing to graph.
    mountDomainNavigator(host, makeTestStore(), fakeLsp(), { onOpenContextMap });
    await flush();

    (host.querySelector('[data-door="contextmap"]') as HTMLButtonElement).click();
    expect(onOpenContextMap).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.koi-domain-ctxmap-body')).toBeNull(); // no in-navigator graph
    expect(host.querySelector('[data-ctx="Ordering"]')).toBeTruthy(); // still the strategic list
  });

  // The rail level summarizes the map; the center-deck view owns the canvas, the Graph/Table toggle and
  // the shared-type / ACL detail strip. The doorway prefers the rail level whenever there's something to
  // graph — so the level itself must carry the way on to the richer destination, or opening it would be a
  // one-way trip away from the very view it used to reach.
  it('the graph level\'s "Open full Context Map" row still reaches the caller\'s center-deck view', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onOpenContextMap = vi.fn();
    mountDomainNavigator(host, makeTestStore(), typedLsp(), { onOpenContextMap });
    await flush();

    (host.querySelector('[data-door="contextmap"]') as HTMLButtonElement).click();
    expect(onOpenContextMap).not.toHaveBeenCalled(); // the doorway opened the rail level, not the hand-off
    expect(host.querySelector('.koi-domain-ctxmap-body')).toBeTruthy();

    (host.querySelector('[data-door="contextmap-full"]') as HTMLButtonElement).click();
    expect(onOpenContextMap).toHaveBeenCalledTimes(1); // …and the level's own door hands off anyway
  });

  it('an external scope change leaves the graph — it is a strategic-level view, not a sticky one', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const store = makeTestStore();
    mountDomainNavigator(host, store, typedLsp());
    await flush();

    (host.querySelector('[data-door="contextmap"]') as HTMLButtonElement).click();
    expect(host.querySelector('.koi-domain-ctxmap-body')).toBeTruthy();

    store.getState().setActiveContext('Billing'); // the top-bar switcher
    expect(host.querySelector('.koi-domain-ctxmap-body')).toBeNull();
    expect(host.querySelector('[data-ctx="Ordering"]')).toBeTruthy();
  });

  // The other half of the same reset: an ALTITUDE change (a drill driven from outside the navigator)
  // must drop the graph too — the scope-change half above shares one `closedContextMap` condition with it.
  it('an external altitude change leaves the graph as well', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const store = makeTestStore();
    mountDomainNavigator(host, store, typedLsp());
    await flush();

    (host.querySelector('[data-door="contextmap"]') as HTMLButtonElement).click();
    expect(host.querySelector('.koi-domain-ctxmap-body')).toBeTruthy();

    store.getState().setNavAltitude('tactical'); // an altitude move with the scope left alone
    expect(host.querySelector('.koi-domain-ctxmap-body')).toBeNull();
    expect(host.querySelector('[data-ctx="Ordering"]')).toBeTruthy(); // unscoped ⇒ the strategic list
  });

  // Closing the graph WITHOUT an altitude change tears the focused row down all the same, so the
  // subscription's `else if (closedContextMap)` arm has to recover focus into the fresh level (WCAG 2.4.3)
  // — the `navAltitude !== paintedAltitude` arm above it never fires for a same-altitude scope switch.
  it('a scope switch made while reading the graph lands focus in the fresh strategic level', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const store = makeTestStore();
    mountDomainNavigator(host, store, typedLsp());
    await flush();

    (host.querySelector('[data-door="contextmap"]') as HTMLButtonElement).click();
    const salesNode = host.querySelector<HTMLElement>('[data-ctxmap-node="Sales"]')!;
    salesNode.focus();
    expect(document.activeElement).toBe(salesNode);

    store.getState().setActiveContext('Billing'); // the top-bar switcher, at the SAME altitude
    expect(host.querySelector('.koi-domain-ctxmap-body')).toBeNull();
    // Focus follows the level swap instead of dropping to <body> and restarting the Tab order at the chrome.
    expect(document.activeElement).toBe(host.querySelector('[data-ctx="Ordering"]'));
  });

  // A reload that FAILS leaves no map to draw, so the presenter's `contextMapOpen && cache?.contextMap`
  // guard falls through and the graph vanishes. The flag has to fall with it — otherwise it stays `true`
  // invisibly and the next SUCCESSFUL reload teleports the reader back into a level they never re-opened.
  it('a failed reload closes the Context Map level — a later good reload does NOT re-enter it', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const lsp = typedLsp();
    const handle = mountDomainNavigator(host, makeTestStore(), lsp);
    await flush();

    (host.querySelector('[data-door="contextmap"]') as HTMLButtonElement).click();
    expect(host.querySelector('.koi-domain-ctxmap-body')).toBeTruthy();

    lsp.contextMap.mockRejectedValueOnce(new Error('boom')); // a dropped connection mid-session
    handle.reload();
    await flush();
    expect(host.querySelector('.koi-domain-ctxmap-body')).toBeNull();
    expect(host.querySelector('.koi-domain-empty')).toBeTruthy(); // the best-effort empty strategic state

    handle.reload(); // …and the model comes back
    await flush();
    expect(host.querySelector('.koi-domain-ctxmap-body')).toBeNull(); // no silent re-entry
    expect(host.querySelector('[data-ctx="Ordering"]')).toBeTruthy(); // the level navAltitude names
  });

  it('labels the glossary doorway "Glossary" but keeps "the ubiquitous language" in its accessible name', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    mountDomainNavigator(host, makeTestStore(), fakeLsp());
    await flush();

    const door = host.querySelector('[data-door="glossary"]') as HTMLButtonElement;
    // The visible label matches the destination the Docs facet calls "Glossary" (#146)…
    expect(door.querySelector('.koi-domain-door-label')?.textContent).toBe('Glossary');
    // …while the DDD vocabulary survives in the tooltip + accessible name.
    expect(door.title).toBe('the ubiquitous language');
    expect(door.getAttribute('aria-label')).toBe('Glossary — the ubiquitous language');
  });

  it('unmount drops the store subscription so later changes stop re-rendering', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const store = makeTestStore();
    const handle = mountDomainNavigator(host, store, fakeLsp());
    await flush();
    handle.unmount();
    // After unmount a scope/altitude change must not resurrect a tactical view in the detached host.
    store.getState().setActiveContext('Ordering');
    store.getState().setNavAltitude('tactical');
    expect(host.querySelector('.koi-breadcrumb-back')).toBeNull();
  });

  // Same disposal-race shape #1261 fixed in contextMapPanel.tsx's paintContextMap: doFetch()'s seq
  // guard alone only drops a SUPERSEDED fetch, not one whose owning navigator was unmounted outright.
  it('unmounting mid-fetch skips the cache write and the trailing render() once the in-flight fetch resolves (#1308)', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const store = makeTestStore();

    let resolveGlossary!: (m: GlossaryModel) => void;
    const pendingGlossary = new Promise<GlossaryModel>((resolve) => {
      resolveGlossary = resolve;
    });
    const lsp = {
      glossaryModel: vi.fn(() => pendingGlossary),
      contextMap: vi.fn(async (): Promise<ContextMapResult> => ({ contexts: ['Ordering', 'Billing'], relations: [] })),
      model: vi.fn(async () => ({ kind: 'model', qualifiedName: '', title: '', members: [], children: [] })),
    };

    const handle = mountDomainNavigator(host, store, lsp);
    await flush(); // the mount-time render painted the loading placeholder; doFetch()'s Promise.all is left pending on glossaryModel
    expect(host.querySelector('.koi-domain-loading')).toBeTruthy(); // sanity: nothing painted yet

    handle.unmount(); // torn down while doFetch() is still in flight — the seq check alone won't catch this

    resolveGlossary(fakeGlossary(['Ordering', 'Billing'])); // the stale fetch resolves anyway, mirroring the real race
    await flush();

    // The disposed guard must have skipped both the cache write and the trailing render() call — the
    // host stays on the loading placeholder rather than painting the now-stale strategic context rows.
    expect(host.querySelector('[data-ctx="Ordering"]')).toBeNull();
    expect(host.querySelector('.koi-domain-loading')).toBeTruthy();
  });

  // The catch tail's own best-effort empty-state write needs the same coverage as the success tail
  // above — both were converted from `seq !== fetchSeq` to `isCurrent()`, mirroring contextMapPanel.tsx's
  // paired success/error-tail tests (#1261).
  it('unmounting mid-fetch skips the catch tail\'s empty-state cache write and the trailing render() once the in-flight fetch rejects (#1308)', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const store = makeTestStore();

    let rejectGlossary!: (e: unknown) => void;
    const pendingGlossary = new Promise<GlossaryModel>((_resolve, reject) => {
      rejectGlossary = reject;
    });
    const lsp = {
      glossaryModel: vi.fn(() => pendingGlossary),
      contextMap: vi.fn(async (): Promise<ContextMapResult> => ({ contexts: ['Ordering', 'Billing'], relations: [] })),
      model: vi.fn(async () => ({ kind: 'model', qualifiedName: '', title: '', members: [], children: [] })),
    };

    const handle = mountDomainNavigator(host, store, lsp);
    await flush(); // the mount-time render painted the loading placeholder; doFetch()'s Promise.all is left pending on glossaryModel
    expect(host.querySelector('.koi-domain-loading')).toBeTruthy(); // sanity: nothing painted yet

    handle.unmount(); // torn down while doFetch() is still in flight

    rejectGlossary(new Error('boom')); // the stale fetch rejects anyway, mirroring the real race
    await flush();

    // The disposed guard must have skipped the catch tail's best-effort empty-state cache write and the
    // trailing render() call — the host stays on the loading placeholder rather than painting the
    // now-stale "no elements yet" empty state.
    expect(host.querySelector('.koi-domain-empty')).toBeNull();
    expect(host.querySelector('.koi-domain-loading')).toBeTruthy();
  });

  // #1397: the mount-time seed mirrors the existing reload-seed (#484) — a caller that already started
  // the glossaryModel()/model() fetch (e.g. ensureDomainNavigator()'s memoized promises) hands them in so
  // the navigator's own first-mount doFetch() reuses them instead of issuing a duplicate pair.
  it('a mount-time seed skips the navigator\'s own glossaryModel()/model() fetch', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const store = makeTestStore();
    const lsp = fakeLsp();
    const seed: DomainNavigatorSeed = {
      glossaryModel: Promise.resolve(fakeGlossary(['Ordering', 'Billing'])),
      model: Promise.resolve(null),
    };

    mountDomainNavigator(host, store, lsp, undefined, undefined, seed);
    await flush();

    expect(lsp.glossaryModel).not.toHaveBeenCalled();
    expect(lsp.model).not.toHaveBeenCalled();
    expect(lsp.contextMap).toHaveBeenCalledTimes(1); // navigator-only data, always fetched directly
    expect(host.querySelector('[data-ctx="Ordering"]')).toBeTruthy();
    expect(host.querySelector('[data-ctx="Billing"]')).toBeTruthy();
  });

  // The seed is one-shot: it's consumed only by the initial mount-time doFetch(), never retained — a
  // later unseeded reload() (e.g. after an edit) must self-fetch exactly as it does today.
  it('the mount seed is not retained — an unseeded reload() after a seeded mount still self-fetches', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const store = makeTestStore();
    const lsp = fakeLsp();
    const seed: DomainNavigatorSeed = {
      glossaryModel: Promise.resolve(fakeGlossary(['Ordering', 'Billing'])),
      model: Promise.resolve(null),
    };

    const handle = mountDomainNavigator(host, store, lsp, undefined, undefined, seed);
    await flush();
    expect(lsp.glossaryModel).not.toHaveBeenCalled();

    handle.reload();
    await flush();

    expect(lsp.glossaryModel).toHaveBeenCalledTimes(1);
    expect(lsp.model).toHaveBeenCalledTimes(1);
  });

  // Same disposal-race shape #1308 already covers for an UNSEEDED mount (below) — a seeded mount's
  // `doFetch` runs through the identical isCurrent()/fetchGen guard, but nothing pinned that for the
  // seed path specifically until now.
  it('unmounting a SEEDED mount mid-fetch skips the cache write once the seed resolves late (#1397)', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const store = makeTestStore();
    const lsp = fakeLsp();

    let resolveSeed!: (m: GlossaryModel) => void;
    const seed: DomainNavigatorSeed = {
      glossaryModel: new Promise((resolve) => {
        resolveSeed = resolve;
      }),
      model: Promise.resolve(null),
    };

    const handle = mountDomainNavigator(host, store, lsp, undefined, undefined, seed);
    await flush(); // the mount-time render painted the loading placeholder; doFetch()'s Promise.all is pending on the seed
    expect(host.querySelector('.koi-domain-loading')).toBeTruthy();

    handle.unmount(); // torn down while the seeded doFetch() is still in flight

    resolveSeed(fakeGlossary(['Ordering', 'Billing'])); // the stale seed resolves anyway
    await flush();

    // The disposed guard must have skipped the cache write and the trailing render() call — the host
    // stays on the loading placeholder rather than painting the now-stale strategic context rows.
    expect(host.querySelector('[data-ctx="Ordering"]')).toBeNull();
    expect(host.querySelector('.koi-domain-loading')).toBeTruthy();
  });

  // A seeded mount's glossaryModel promise is a caller-supplied fetch (e.g. the real
  // fetchGlossaryModel(), which has no internal catch) and so CAN reject — doFetch's outer try/catch
  // must degrade it to the empty strategic state exactly like an unseeded lsp.glossaryModel() rejection.
  it('a mount-time seed whose glossaryModel promise rejects degrades to the empty strategic state', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const store = makeTestStore();
    const lsp = fakeLsp();
    const seed: DomainNavigatorSeed = {
      glossaryModel: Promise.reject(new Error('boom')),
      model: Promise.resolve(null),
    };

    mountDomainNavigator(host, store, lsp, undefined, undefined, seed);
    await flush();

    expect(host.querySelector('.koi-domain-empty')).toBeTruthy();
    expect(host.querySelector('[data-ctx="Ordering"]')).toBeNull();
  });

  // #760: the navigator takes its store as a parameter (never the `appStore` singleton) precisely so two
  // instances can run side by side without leaking into one another. Pin that guarantee explicitly: two
  // navigators, each built with its OWN createAppStore(), and a drill through the first must never be
  // visible on the second's store or DOM.
  it('two instances built with separate createAppStore()s do not see each other\'s writes (no shared global)', async () => {
    const host1 = document.createElement('div');
    const host2 = document.createElement('div');
    document.body.append(host1, host2);
    const store1 = makeTestStore();
    const store2 = makeTestStore();
    mountDomainNavigator(host1, store1, fakeLsp());
    mountDomainNavigator(host2, store2, fakeLsp());
    await flush(); // both instances' initial strategic fetches resolve and paint independently

    // Drill into Ordering through the FIRST navigator only.
    (host1.querySelector('[data-ctx="Ordering"]') as HTMLButtonElement).click();
    expect(store1.getState().navAltitude).toBe('tactical');
    expect(store1.getState().activeContext).toBe('Ordering');
    await flush();

    // The second instance's store — and its DOM — must be completely untouched by the first's write.
    expect(store2.getState().navAltitude).toBe('strategic');
    expect(store2.getState().activeContext).not.toBe('Ordering');
    expect(host2.querySelector('.koi-breadcrumb-back')).toBeNull(); // still the strategic (non-drilled) view
    expect(host2.querySelector('[data-ctx="Ordering"]')).toBeTruthy(); // strategic context list, unaffected
  });
});

// --- the DomainNavigator PRESENTER: a pure function of its props (#991 Task 1) ---------------------
// The facade tests above drive the component through the store; these render it directly to pin that it
// paints the level its altitude/scope props name and that the filter input is CONTROLLED by outlineFilter.
describe('DomainNavigator component (props-driven)', () => {
  const noopHandlers: DomainNavigatorHandlers = {};
  const tacticalHandlers = noopTacticalHandlers();
  const cache = {
    model: fakeGlossary(['Ordering', 'Billing']),
    relLinks: 4,
    tree: ctxNode('Ordering', [aggNode('Order', [value('Money')]), value('Currency')]),
  };
  // The tactical branch resolves the scoped context from cache.tree — root children are the contexts.
  const cacheWithModelRoot = { ...cache, tree: modelNode('model', '', [cache.tree]) };

  it('renders the strategic context list + doorways when navAltitude is strategic', () => {
    const { container } = renderComponent(
      h(DomainNavigator, {
        store: createAppStore(),
        navAltitude: 'strategic',
        activeContext: 'all',
        outlineFilter: '',
        cache,
        contentToken: 0,
        handlers: noopHandlers,
        tacticalHandlers,
      }),
    );
    expect(container.querySelectorAll('.koi-ctx-row').length).toBe(2);
    expect(container.querySelector('[data-door="glossary"]')).toBeTruthy();
    expect(container.querySelector('.koi-breadcrumb-back')).toBeNull();
  });

  it('renders the tactical view for the scoped context when navAltitude is tactical', () => {
    const { container } = renderComponent(
      h(DomainNavigator, {
        store: createAppStore(),
        navAltitude: 'tactical',
        activeContext: 'Ordering',
        outlineFilter: '',
        cache: cacheWithModelRoot,
        contentToken: 0,
        handlers: noopHandlers,
        tacticalHandlers,
      }),
    );
    expect(container.querySelector('.koi-breadcrumb-back')).toBeTruthy();
    expect(container.querySelector('[data-qname="Ordering.Order"]')).toBeTruthy();
    expect(container.querySelector('.koi-ctx-row')).toBeNull(); // not the strategic list
  });

  // The strategic Context Map graph is a third level the presenter can paint (#483): opened through the
  // doorway, it replaces the context list until its breadcrumb closes it. The per-level filter doesn't
  // apply to a cross-context graph, so it hides — the same way it does for the loading placeholder.
  it('renders the Context Map graph level when contextMapOpen is set', () => {
    const { container } = renderComponent(
      h(DomainNavigator, {
        store: createAppStore(),
        navAltitude: 'strategic',
        activeContext: 'all',
        outlineFilter: '',
        cache: { ...cache, contextMap: typedContextMap() },
        contentToken: 0,
        handlers: noopHandlers,
        tacticalHandlers,
        contextMapOpen: true,
      }),
    );
    expect(container.querySelectorAll('.koi-domain-ctxmap-edge')).toHaveLength(2);
    expect(container.querySelector('.koi-ctx-row')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('input.koi-domain-filter')!.hidden).toBe(true);
  });

  it('the explicit `.tsx` import resolves to a real component (not the case-collision barrel) and renders rows', () => {
    expect(typeof DomainNavigatorViaTsx).toBe('function');
    const { container } = renderComponent(
      h(DomainNavigatorViaTsx, {
        store: createAppStore(),
        navAltitude: 'strategic',
        activeContext: 'all',
        outlineFilter: '',
        cache,
        contentToken: 0,
        handlers: noopHandlers,
        tacticalHandlers,
      }),
    );
    // A `undefined` component would make Preact render the literal "[object Object]" with no error.
    expect(container.textContent).not.toContain('[object Object]');
    expect(container.querySelectorAll('.koi-ctx-row').length).toBe(2);
  });

  // The tactical filter must reach the depth the behavioural vocabulary added (#483): a nested row that
  // matches keeps its OWNING chain visible, and a branch that matches by name keeps its whole subtree.
  function tacticalWithFilter(outlineFilter: string): HTMLElement {
    const { container } = renderComponent(
      h(DomainNavigator, {
        store: createAppStore(),
        navAltitude: 'tactical',
        activeContext: 'Ordering',
        outlineFilter,
        cache: { ...cache, tree: modelNode('model', '', [behaviouralCtx()]) },
        contentToken: 0,
        handlers: noopHandlers,
        tacticalHandlers,
      }),
    );
    return container as HTMLElement;
  }

  it('a matching nested behavioural row keeps its aggregate + entity ancestors visible', () => {
    const el = tacticalWithFilter('draft');
    expect(rowFor(el, 'draft')).toBeTruthy();
    expect(el.querySelector('[data-qname="Ordering.Order"]')).toBeTruthy(); // the owning aggregate survives…
    expect(el.querySelector('[data-qname="OrderLine"]')).toBeTruthy(); // …and so does the owning entity
    // Only the matching chain survives: the row's non-matching siblings, the aggregate's other owned
    // constructs, and every context-level peer are pruned.
    expect(rowNames(el)).toEqual(['Order', 'OrderLine', 'draft']);
  });

  it('a matching entity keeps its whole behavioural subtree', () => {
    const el = tacticalWithFilter('OrderLine');
    expect(rowNames(el)).toEqual(['Order', 'OrderLine', 'status', 'place', 'draft']);
  });

  it('a matching context-level behavioural peer shows on its own', () => {
    const el = tacticalWithFilter('Pricing');
    expect(rowNames(el)).toEqual(['PricingService']);
  });

  it('the filter input is controlled by the outlineFilter prop', () => {
    const { container } = renderComponent(
      h(DomainNavigator, {
        store: createAppStore(),
        navAltitude: 'strategic',
        activeContext: 'all',
        outlineFilter: 'Bill',
        cache,
        contentToken: 0,
        handlers: noopHandlers,
        tacticalHandlers,
      }),
    );
    const filter = container.querySelector<HTMLInputElement>('input.koi-domain-filter')!;
    expect(filter.value).toBe('Bill');
    expect(filter.hidden).toBe(false);
  });
});
