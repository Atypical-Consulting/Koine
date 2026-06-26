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
const noopTacticalHandlers = (): TacticalHandlers => ({ onSelect: () => {}, goto: () => {} });

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

  it('delegates the Context Map / Ubiquitous Language doorways to the caller', async () => {
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
});
