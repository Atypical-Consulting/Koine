import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { render as renderComponent } from '@testing-library/preact';
import { h } from 'preact';
import {
  DomainNavigator,
  mountDomainNavigator,
  renderContextMapLevel,
  renderStrategic,
  renderTactical,
  type DomainNavigatorHandlers,
  type StrategicHandlers,
  type TacticalHandlers,
} from '@/model/domainNavigator';
import { createAppStore } from '@/store/index';
import type { ContextMapResult, GlossaryEntry, GlossaryModel, ModelNode, Range } from '@/lsp/lsp';

afterEach(() => {
  document.body.innerHTML = '';
});

// --- shared fixtures: a strategic glossary + a tactical model graph -------------------------------
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

// One context header + a spread of construct entries per context, so each context row carries a count
// badge and the per-context filter has several names to narrow.
function fakeGlossary(contexts: string[]): GlossaryModel {
  const entries: GlossaryEntry[] = [];
  for (const ctx of contexts) {
    entries.push(entry({ name: ctx, kind: 'context', context: ctx, nameRange: range(0) }));
    entries.push(entry({ name: `${ctx}Order`, kind: 'aggregate', context: ctx }));
    entries.push(entry({ name: `${ctx}Money`, kind: 'value', context: ctx }));
    entries.push(entry({ name: `${ctx}Status`, kind: 'enum', context: ctx }));
  }
  return { entries };
}

const noopStrategicHandlers = (): StrategicHandlers => ({
  onOpenContext: () => {},
  onOpenContextMap: () => {},
  onOpenGlossary: () => {},
});

const noopTacticalHandlers = (): TacticalHandlers => ({
  onSelect: () => {},
  goto: () => {},
  reveal: () => {},
  setAxis: () => {},
});

const node = (kind: string, title: string, children: ModelNode[] = []): ModelNode => ({
  kind,
  qualifiedName: title,
  title,
  members: [],
  children,
});

// The Ordering bounded context as a model graph: one aggregate owning three constructs, plus a
// context-level peer — enough rows for keyboard nav and for the per-level filter to narrow. The
// aggregate carries the realistic `<Ctx>.<Agg>` qualified name production emits (e.g. 'Ordering.Order').
function orderingCtxNode(): ModelNode {
  return node('context', 'Ordering', [
    {
      ...node('aggregate', 'Order', [node('entity', 'Order'), node('value', 'Money'), node('event', 'OrderPlaced')]),
      qualifiedName: 'Ordering.Order',
    },
    node('value', 'Currency'),
  ]);
}

const treeitems = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>('[role="treeitem"]')];

describe('Domain navigator a11y — strategic', () => {
  it('domain navigator is axe-clean and keyboard-navigable', async () => {
    const el = renderStrategic(fakeGlossary(['Ordering', 'Billing']), 4, noopStrategicHandlers());
    document.body.appendChild(el);

    expect(await axe(el)).toHaveNoViolations();

    // Roving tabindex: exactly one treeitem is the tab stop, and it is the first row.
    const items = treeitems(el);
    expect(items.filter((it) => it.tabIndex === 0)).toEqual([items[0]]);

    // ArrowDown / ArrowUp / Home / End move roving focus across the visible treeitems.
    items[0].focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(document.activeElement).toBe(items[1]);

    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
    expect(document.activeElement).toBe(items[items.length - 1]);

    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    expect(document.activeElement).toBe(items[0]);

    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(document.activeElement).toBe(items[0]); // clamps at the top
  });
});

describe('Domain navigator a11y — tactical', () => {
  it('tactical render is axe-clean and keyboard-navigable', async () => {
    const el = renderTactical(orderingCtxNode(), noopTacticalHandlers());
    document.body.appendChild(el);

    expect(await axe(el)).toHaveNoViolations();

    const items = treeitems(el);
    expect(items.filter((it) => it.tabIndex === 0)).toEqual([items[0]]);

    items[0].focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(document.activeElement).toBe(items[1]);
  });

  // The behavioural vocabulary (#483) added a THIRD level to the tactical tree — an entity branch owning
  // its state machines / commands / factories, i.e. a `treeitem` nested inside a `group` inside a
  // `treeitem`. Audit that depth explicitly: the WAI-ARIA tree pattern must still hold (aria-required-
  // parent/children, no nested-interactive violation from the head buttons), and every added row must
  // stay reachable by the single-tab-stop roving model.
  it('the entity-owned behavioural depth is axe-clean and every added row is keyboard-reachable', async () => {
    const el = renderTactical(
      node('context', 'Ordering', [
        {
          ...node('aggregate', 'Order', [
            node('entity', 'OrderLine', [node('states', 'status'), node('command', 'place'), node('factory', 'draft')]),
            node('repository', 'repository'),
            node('spec', 'Overdue'),
          ]),
          qualifiedName: 'Ordering.Order',
        },
        node('policy', 'NotifyOnPlaced'),
        node('service', 'PricingService'),
      ]),
      noopTacticalHandlers(),
    );
    document.body.appendChild(el);

    expect(await axe(el)).toHaveNoViolations();

    const items = treeitems(el);
    expect(items).toHaveLength(9);
    expect(items.filter((it) => it.tabIndex === 0)).toEqual([items[0]]); // still ONE tab stop

    // ArrowDown reaches every row, including the ones two levels deep in the aggregate's spine.
    items[0].focus();
    for (let i = 1; i < items.length; i++) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      expect(document.activeElement).toBe(items[i]);
    }
  });

  it('the ContextMenu / Shift+F10 key opens the focused leaf row’s ⋯ overflow (keyboard-reachable)', () => {
    const el = renderTactical(orderingCtxNode(), noopTacticalHandlers());
    document.body.appendChild(el); // the ⋯ menu mounts to document.body; afterEach clears it

    // Focus a tactical-leaf wrapper row (the one carrying a ⋯ overflow), then press the context-menu key.
    const leafRow = el.querySelector<HTMLElement>('.koi-tactical-leaf-row')!;
    leafRow.tabIndex = 0;
    leafRow.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));

    // The overflow menu is now open with its "Reveal in Files" item — reachable without a mouse.
    const menu = document.querySelector('.koi-tactical-menu');
    expect(menu).toBeTruthy();
    expect(menu!.textContent).toContain('Reveal in Files');
  });

  it('the ContextMenu key on an AGGREGATE row is a no-op — it must not open an owned child’s ⋯ menu', () => {
    const el = renderTactical(orderingCtxNode(), noopTacticalHandlers());
    document.body.appendChild(el);

    // Focus the aggregate treeitem itself (it carries no ⋯ overflow of its own).
    const agg = el.querySelector<HTMLElement>('.koi-agg')!;
    agg.tabIndex = 0;
    agg.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));

    // A descendant lookup would find (and open) the FIRST OWNED LEAF's menu — the wrong target.
    expect(document.querySelector('.koi-tactical-menu')).toBeNull();
  });
});

// --- the strategic Context Map graph (#483) -------------------------------------------------------
// The graph's context nodes are FOCUSABLE rows, which rules out the listbox/option pattern (axe forbids
// a focusable descendant there, and role="group" doesn't dodge it). It reuses the navigator's own
// WAI-ARIA TREE pattern instead — `role="tree"` of `role="treeitem"` rows (the context nodes are the
// buttons; the relation rows are static) under the shared roving-tabindex model — so the whole rail
// navigates identically and the audit below is the proof it stays axe-clean with the role badges on.
function typedContextMap(): ContextMapResult {
  return {
    contexts: ['Sales', 'Shipping', 'Support'],
    contextSpans: { Sales: { file: 'file:///s.koi', line: 3, column: 9, endLine: 3, endColumn: 14, offset: 20, length: 5 } },
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
      // Symmetric — both ends un-badged, so the audit covers the badge-less row shape too.
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

describe('Domain navigator a11y — the strategic Context Map graph', () => {
  it('the context-map graph is axe-clean and keyboard-navigable', async () => {
    const el = renderContextMapLevel(typedContextMap(), { gotoSourceSpan: () => {}, openFullMap: () => {} });
    document.body.appendChild(el);

    expect(await axe(el)).toHaveNoViolations();

    // One row per context, one per relation, and the closing `Open full Context Map` door — all
    // reachable through the single-tab-stop roving model.
    const items = treeitems(el);
    expect(items).toHaveLength(6);
    expect(items.at(-1)!.dataset.door).toBe('contextmap-full'); // the escape hatch is a row like any other
    expect(items.filter((it) => it.tabIndex === 0)).toEqual([items[0]]);

    items[0].focus();
    for (let i = 1; i < items.length; i++) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      expect(document.activeElement).toBe(items[i]);
    }
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    expect(document.activeElement).toBe(items[0]);
  });

  it('an empty context map renders a note, not an empty (keyboard-unreachable) tree', async () => {
    const el = renderContextMapLevel({ contexts: [], relations: [] }, { gotoSourceSpan: () => {}, openFullMap: () => {} });
    document.body.appendChild(el);

    expect(await axe(el)).toHaveNoViolations();
    expect(el.getAttribute('role')).toBe('note');
  });
});

// --- the per-level filter narrows the active level (reuses the outlineFilter slice) --------------
function fakeLsp() {
  return {
    glossaryModel: vi.fn(async (): Promise<GlossaryModel> => fakeGlossary(['Ordering', 'Billing'])),
    contextMap: vi.fn(async (): Promise<ContextMapResult> => ({ contexts: ['Ordering', 'Billing'], relations: [] })),
    model: vi.fn(async (): Promise<ModelNode> => node('model', '', [orderingCtxNode()])),
  };
}

/** Let the navigator's microtask-chained fetch settle so its synchronous render runs. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe('Domain navigator a11y — per-level filter', () => {
  it('the filter narrows the strategic context rows by name', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const store = createAppStore();
    mountDomainNavigator(host, store, fakeLsp());
    await flush();

    expect(host.querySelectorAll('.koi-ctx-row').length).toBe(2);
    // A persistent, labelled filter input drives the outlineFilter slice.
    expect(host.querySelector<HTMLInputElement>('input.koi-domain-filter')).toBeTruthy();

    store.getState().setOutlineFilter('Bill');
    expect(host.querySelectorAll('.koi-ctx-row').length).toBe(1);
    expect(host.querySelector('[data-ctx="Billing"]')).toBeTruthy();
    expect(host.querySelector('[data-ctx="Ordering"]')).toBeNull();
  });

  it('the filter narrows the tactical leaves/aggregates by name', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const store = createAppStore();
    mountDomainNavigator(host, store, fakeLsp());
    await flush();

    (host.querySelector('[data-ctx="Ordering"]') as HTMLButtonElement).click();
    await flush();
    expect(host.querySelectorAll('.koi-tactical-leaf').length).toBeGreaterThan(1);

    store.getState().setOutlineFilter('Money');
    expect(host.querySelector('[data-name="Money"]')).toBeTruthy();
    expect(host.querySelector('[data-name="Currency"]')).toBeNull();
    expect(host.querySelector('[data-name="OrderPlaced"]')).toBeNull();
  });
});

// --- drill/climb keeps keyboard focus inside the navigator (WCAG 2.4.3) ---------------------------
// Activating a context row (or the breadcrumb) repaints the level, tearing the focused row out of the
// DOM — which drops focus to <body> unless the paint moves it into the fresh level.
describe('Domain navigator a11y — focus continuity across drill/climb', () => {
  it('keeps focus in the navigator when drilling into a context and climbing back', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const store = createAppStore();
    mountDomainNavigator(host, store, fakeLsp());
    await flush();

    // Keyboard flow: the context row has focus, then Enter activates it (a <button> treeitem clicks natively).
    const row = host.querySelector<HTMLElement>('[data-ctx="Ordering"]')!;
    row.focus();
    row.click();
    await flush();

    // The tactical level painted — focus must land inside it (on the breadcrumb, the level's first
    // row), not drop to <body> and restart the Tab order at the app chrome.
    const back = host.querySelector<HTMLElement>('.koi-breadcrumb-back')!;
    expect(document.activeElement).toBe(back);

    // Climb back out: focus lands on the strategic level's first treeitem, not <body>.
    back.click();
    await flush();
    expect(document.activeElement).toBe(host.querySelector('[data-ctx="Ordering"]'));
  });

  // Opening / closing the Context Map graph (#483) is the same kind of level swap as a drill / climb: the
  // row that was activated is torn down by the repaint, so focus must land in the fresh level.
  it('keeps focus in the navigator when opening the Context Map graph and closing it again', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const store = createAppStore();
    mountDomainNavigator(host, store, { ...fakeLsp(), contextMap: vi.fn(async () => typedContextMap()) });
    await flush();

    const door = host.querySelector<HTMLElement>('[data-door="contextmap"]')!;
    door.focus();
    door.click(); // the graph level paints synchronously (it is drawn from the cached context map)

    const back = host.querySelector<HTMLElement>('.koi-breadcrumb-back')!;
    expect(document.activeElement).toBe(back);

    back.click(); // climb back out: focus lands on the strategic level's first row, not <body>
    expect(document.activeElement).toBe(host.querySelector('[data-ctx="Ordering"]'));
  });

  it('a filter keystroke repaint does NOT steal focus from the filter input', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const store = createAppStore();
    mountDomainNavigator(host, store, fakeLsp());
    await flush();

    const filter = host.querySelector<HTMLInputElement>('input.koi-domain-filter')!;
    filter.focus();
    store.getState().setOutlineFilter('Bill'); // same-altitude repaint (what typing triggers)
    expect(document.activeElement).toBe(filter);
  });
});

// --- component-level axe on BOTH altitudes (#991 Task 1) ------------------------------------------
// The direct-DOM `renderStrategic` / `renderTactical` audits above cover the level builders in isolation;
// this exercises the whole `DomainNavigator` presenter (the persistent filter input + the keyed level
// body) at each altitude, seeding the cache + altitude directly the way the live facade does.
const noopHandlers: DomainNavigatorHandlers = {};

const strategicCache = {
  model: fakeGlossary(['Ordering', 'Billing']),
  relLinks: 4,
  tree: node('model', '', [orderingCtxNode()]),
};

describe('DomainNavigator component a11y', () => {
  it('the strategic altitude is axe-clean', async () => {
    const { container } = renderComponent(
      h(DomainNavigator, {
        store: createAppStore(),
        navAltitude: 'strategic',
        activeContext: 'all',
        outlineFilter: '',
        cache: strategicCache,
        contentToken: 0,
        handlers: noopHandlers,
        tacticalHandlers: noopTacticalHandlers(),
      }),
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('the Context Map graph level is axe-clean inside the presenter (breadcrumb + graph)', async () => {
    const { container } = renderComponent(
      h(DomainNavigator, {
        store: createAppStore(),
        navAltitude: 'strategic',
        activeContext: 'all',
        outlineFilter: '',
        cache: { ...strategicCache, contextMap: typedContextMap() },
        contentToken: 0,
        handlers: noopHandlers,
        tacticalHandlers: noopTacticalHandlers(),
        contextMapOpen: true,
      }),
    );
    // The graph level replaced the context list, breadcrumb and all — and the whole presenter (including
    // the hidden filter input) has no violations.
    expect(container.querySelector('.koi-breadcrumb-back')).toBeTruthy();
    expect(container.querySelectorAll('.koi-domain-ctxmap-edge')).toHaveLength(2);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('the tactical altitude is axe-clean', async () => {
    const { container } = renderComponent(
      h(DomainNavigator, {
        store: createAppStore(),
        navAltitude: 'tactical',
        activeContext: 'Ordering',
        outlineFilter: '',
        cache: strategicCache,
        contentToken: 0,
        handlers: noopHandlers,
        tacticalHandlers: noopTacticalHandlers(),
      }),
    );
    // The breadcrumb-backed tactical view (breadcrumb + the aggregate/leaf tree) has no violations.
    expect(container.querySelector('.koi-breadcrumb-back')).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });
});
