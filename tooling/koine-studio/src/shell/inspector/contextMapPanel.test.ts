// Tests for the Context Map panel — extracted from inspectorController (Task 1 of #985's
// decomposition). Behavior is pinned two ways: HERE (the panel's own contract, in isolation) and in
// inspectorController.test.ts's pre-existing "Output — Context Map tab" describe block (the facade's
// delegation to this module, unmodified by this extraction).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createContextMapPanel, type ContextMapPanelLsp } from '@/shell/inspector/contextMapPanel';
import { createAppStore } from '@/store/index';
import * as maxgraphRenderer from '@/diagrams/diagrams-maxgraph';
import type { ContextMapResult } from '@/lsp/lsp';

function makeHost(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'panel-contextmap';
  document.body.appendChild(el);
  return el;
}

function makeLsp(): ContextMapPanelLsp & { contextMap: ReturnType<typeof vi.fn> } {
  return {
    contextMap: vi.fn(async (): Promise<ContextMapResult> => ({ contexts: ['Billing'], relations: [] })),
  };
}

function makeOnNavigate() {
  return { setActiveContext: vi.fn(), gotoSourceSpan: vi.fn() };
}

/** Let queued microtask-chained loader promises settle (mirrors inspectorController.test.ts's flush). */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

const graphTab = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('[data-ctxmap-view="graph"]')!;
const tableTab = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('[data-ctxmap-view="table"]')!;

beforeEach(() => {
  // The default view is Graph regardless of a prior test/run leaving a persisted choice.
  localStorage.removeItem('koine.studio.contextMapView');
  // Every test that reaches the graph branch mocks renderContextMapGraph itself (real maxGraph doesn't
  // run under happy-dom); default to an instantly-resolved handle so tests that don't care about the
  // graph mount (only the toggle/fetch contract) aren't left with a dangling in-flight promise.
  vi.spyOn(maxgraphRenderer, 'renderContextMapGraph').mockResolvedValue({ dispose: vi.fn() });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('createContextMapPanel — load()', () => {
  test('fetches once and paints the graph mode (default)', async () => {
    const lsp = makeLsp();
    const host = makeHost();
    const panel = createContextMapPanel({ store: createAppStore(), host, lsp, onNavigate: makeOnNavigate() });

    await panel.load();
    await flush();

    expect(lsp.contextMap).toHaveBeenCalledTimes(1);
    const tabs = host.querySelectorAll('.ctxmap-tab');
    expect(tabs).toHaveLength(2);
    expect(graphTab(host).getAttribute('aria-pressed')).toBe('true');
    expect(tableTab(host).getAttribute('aria-pressed')).toBe('false');

    panel.dispose();
  });

  test('marks the docViews "contextmap" key loaded — the staleness gate a caller (the facade) checks before re-invoking load()', async () => {
    const store = createAppStore();
    const lsp = makeLsp();
    const host = makeHost();
    const panel = createContextMapPanel({ store, host, lsp, onNavigate: makeOnNavigate() });

    expect(store.getState().isStale('contextmap')).toBe(true); // nothing fetched yet
    await panel.load();
    await flush();
    expect(store.getState().isStale('contextmap')).toBe(false); // guardedLoad's markLoaded took

    panel.dispose();
  });
});

describe('createContextMapPanel — Graph ⟷ Table toggle', () => {
  test('toggling to Table repaints from the stored ContextMapResult with no second lsp.contextMap call, and back to Graph', async () => {
    const lsp = makeLsp();
    const host = makeHost();
    const panel = createContextMapPanel({ store: createAppStore(), host, lsp, onNavigate: makeOnNavigate() });

    await panel.load();
    await flush();

    tableTab(host).click();
    await flush();
    expect(host.innerHTML).toContain('koi-md');
    expect(tableTab(host).getAttribute('aria-pressed')).toBe('true');
    expect(graphTab(host).getAttribute('aria-pressed')).toBe('false');

    graphTab(host).click();
    await flush();
    expect(graphTab(host).getAttribute('aria-pressed')).toBe('true');
    expect(tableTab(host).getAttribute('aria-pressed')).toBe('false');

    // The toggle never refetches — both switches repaint the SAME fetched result.
    expect(lsp.contextMap).toHaveBeenCalledTimes(1);
    panel.dispose();
  });
});

describe('createContextMapPanel — superseded paint bails via the render seq', () => {
  test('two rapid toggles: the stale in-flight graph render observes isCurrent() = false once superseded', async () => {
    const lsp = makeLsp();
    const host = makeHost();

    const captured: Array<{ isCurrent: () => boolean; resolve: (h: maxgraphRenderer.ContextMapGraphHandle | null) => void }> = [];
    vi.mocked(maxgraphRenderer.renderContextMapGraph).mockRestore();
    vi.spyOn(maxgraphRenderer, 'renderContextMapGraph').mockImplementation(
      async (_stage, _graph, isCurrent) =>
        new Promise((resolve) => {
          captured.push({ isCurrent, resolve });
        }),
    );

    const panel = createContextMapPanel({ store: createAppStore(), host, lsp, onNavigate: makeOnNavigate() });

    void panel.load(); // fetch -> paintContextMap (seq 1) -> renderContextMapGraph call #1, left pending
    await flush();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.isCurrent()).toBe(true); // sanity: current before any toggle

    tableTab(host).click(); // paintContextMap (seq 2): table branch, no new renderContextMapGraph call
    await flush();
    expect(captured[0]!.isCurrent()).toBe(false); // call #1 is now superseded — the render-seq gate bailed it

    graphTab(host).click(); // paintContextMap (seq 3): graph branch again — renderContextMapGraph call #2
    await flush();
    expect(captured).toHaveLength(2);
    expect(captured[1]!.isCurrent()).toBe(true); // the latest toggle is current
    expect(captured[0]!.isCurrent()).toBe(false); // the stale call #1 stays bailed, even after a later toggle

    // Resolve both (mirroring what the real renderContextMapGraph does: a superseded caller gets null,
    // the current one gets a real handle) so no promise is left dangling past the test.
    captured[0]!.resolve(null);
    captured[1]!.resolve({ dispose: vi.fn() });
    await flush();

    panel.dispose();
  });
});

describe('createContextMapPanel — dispose()', () => {
  test('disposes the mounted maxGraph handle', async () => {
    const disposeHandle = vi.fn();
    vi.mocked(maxgraphRenderer.renderContextMapGraph).mockResolvedValue({ dispose: disposeHandle });

    const lsp = makeLsp();
    const host = makeHost();
    const panel = createContextMapPanel({ store: createAppStore(), host, lsp, onNavigate: makeOnNavigate() });

    await panel.load();
    await flush();
    expect(disposeHandle).not.toHaveBeenCalled();

    panel.dispose();
    expect(disposeHandle).toHaveBeenCalledTimes(1);
  });

  test('is safe to call before any load()', () => {
    const panel = createContextMapPanel({ store: createAppStore(), host: makeHost(), lsp: makeLsp(), onNavigate: makeOnNavigate() });
    expect(() => panel.dispose()).not.toThrow();
  });
});

describe('createContextMapPanel — mode persistence (#983)', () => {
  test('seeds Graph as the default when nothing is persisted', () => {
    const store = createAppStore();
    const panel = createContextMapPanel({ store, host: makeHost(), lsp: makeLsp(), onNavigate: makeOnNavigate() });
    expect(store.getState().contextMapView).toBe('graph');
    panel.dispose();
  });

  test('a live toggle writes through to koine.studio.contextMapView', async () => {
    const store = createAppStore();
    const host = makeHost();
    const panel = createContextMapPanel({ store, host, lsp: makeLsp(), onNavigate: makeOnNavigate() });

    // The toggle buttons only exist once the skeleton has been painted at least once (a real session
    // only shows this panel after its first load()).
    await panel.load();
    await flush();

    tableTab(host).click();
    await flush();

    expect(store.getState().contextMapView).toBe('table');
    expect(localStorage.getItem('koine.studio.contextMapView')).toBe('table');
    panel.dispose();
  });

  test('a fresh session (new store) restores the persisted mode from koine.studio.contextMapView', () => {
    const store1 = createAppStore();
    const panel1 = createContextMapPanel({ store: store1, host: makeHost(), lsp: makeLsp(), onNavigate: makeOnNavigate() });
    store1.getState().setContextMapView('table');
    panel1.dispose();

    const store2 = createAppStore();
    const panel2 = createContextMapPanel({ store: store2, host: makeHost(), lsp: makeLsp(), onNavigate: makeOnNavigate() });
    expect(store2.getState().contextMapView).toBe('table');
    panel2.dispose();
  });
});

describe('createContextMapPanel — scope focus (ADR 0009 / #1188)', () => {
  test('a live activeContext change focuses the matching node without refetching or blanking others', async () => {
    const store = createAppStore();
    const host = makeHost();
    const panel = createContextMapPanel({ store, host, lsp: makeLsp(), onNavigate: makeOnNavigate() });

    // Simulate a painted context-map graph (the real maxGraph render is mocked away above): two context
    // nodes carrying their bare name on data-qname — the hook the scope fan-out drives.
    host.innerHTML =
      '<div class="koi-ctxmap-graph">' +
      '<div class="koi-node koi-svg-node" data-qname="Billing">Billing</div>' +
      '<div class="koi-node koi-svg-node" data-qname="Ordering">Ordering</div>' +
      '</div>';
    const node = (q: string) => host.querySelector<HTMLElement>(`.koi-svg-node[data-qname="${q}"]`)!;

    store.getState().setActiveContext('Billing');
    expect(node('Billing').classList.contains('is-scoped')).toBe(true);
    expect(node('Billing').getAttribute('aria-current')).toBe('true');
    expect(node('Ordering').classList.contains('is-scoped')).toBe(false); // a focus, never a filter

    store.getState().setActiveContext('all'); // ALL_CONTEXTS sentinel → nothing focused
    expect(node('Billing').classList.contains('is-scoped')).toBe(false);
    expect(node('Billing').hasAttribute('aria-current')).toBe(false);

    panel.dispose();
  });
});

describe('createContextMapPanel — context-node click navigation (#290)', () => {
  test('a click filters AND jumps to the declaration span when the node has one; a span-less node still filters but never navigates', async () => {
    let hooks: maxgraphRenderer.ContextMapGraphHooks | undefined;
    vi.mocked(maxgraphRenderer.renderContextMapGraph).mockRestore();
    vi.spyOn(maxgraphRenderer, 'renderContextMapGraph').mockImplementation(async (_stage, _graph, _isCurrent, h) => {
      hooks = h;
      return { dispose: vi.fn() };
    });

    const store = createAppStore();
    store.getState().setContexts(['Billing']);
    const onNavigate = makeOnNavigate();
    const host = makeHost();
    const lsp = makeLsp();
    const panel = createContextMapPanel({ store, host, lsp, onNavigate });

    await panel.load();
    await flush();
    expect(hooks).toBeDefined();

    const span = { file: 'file:///billing.koi', line: 1, column: 9, endLine: 1, endColumn: 16, offset: 8, length: 7 };
    const spanned = {
      id: 'Billing', label: 'Billing', kind: 'context', qualifiedName: 'Billing', sourceSpan: span, stereotype: null, members: [],
    };

    hooks!.onContextClick!(spanned);
    expect(onNavigate.setActiveContext).toHaveBeenCalledWith('Billing');
    expect(onNavigate.gotoSourceSpan).toHaveBeenCalledWith(span);

    onNavigate.gotoSourceSpan.mockClear();
    hooks!.onContextClick!({ ...spanned, sourceSpan: null });
    expect(onNavigate.gotoSourceSpan).not.toHaveBeenCalled();

    panel.dispose();
  });
});
