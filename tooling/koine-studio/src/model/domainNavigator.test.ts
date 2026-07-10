import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountDomainNavigator, renderStrategic, renderTactical, type TacticalHandlers } from '@/model/domainNavigator';
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
