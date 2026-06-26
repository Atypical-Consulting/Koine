import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import {
  mountDomainNavigator,
  renderStrategic,
  renderTactical,
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
