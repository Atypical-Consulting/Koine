// Tests for the inspectorController — the mode / center-tab / view subsystem extracted from ide.ts's
// init() (Task 4 of the ide.ts decomposition). This file is the PRIMARY behavioral net for this
// subsystem: ide.test.ts does not exercise view switching / lazy-loading / debounce, so the
// stale-token + lazy-load-once + debounce contracts are pinned here.
//
// We drive the real controller with a small seeded DOM (the same id surface init() builds, lifted from
// ide.test.ts's APP_HTML so a drift throws via el()) and a spied `lsp` content stub. happy-dom renders
// the real panel DOM; fake timers cover the 350ms edit/bottom debounce.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createInspectorController,
  type InspectorAssistant,
  type InspectorControllerDeps,
  type InspectorControllerLsp,
} from '@/shell/inspectorController';
import { createAppStore } from '@/store/index';
import * as maxgraphRenderer from '@/diagrams/diagrams-maxgraph';
import type { ContextMapGraphHooks } from '@/diagrams/diagrams-maxgraph';
import type {
  CheckResult,
  ContextMapResult,
  DiagramNode,
  DocsResult,
  DocumentSymbol,
  EmitPreviewResult,
  GlossaryEntry,
  GlossaryModel,
  SetDocResult,
  SourceSpan,
} from '@/lsp/lsp';

// --- DOM seed ----------------------------------------------------------------
// The center / docs / bottom-strip / right-rail / left-rail / context-switcher subset of index.html the
// controller looks up via el(...). Kept equivalent to ide.test.ts's APP_HTML.
const APP_HTML = `
  <div id="app">
    <div id="breadcrumb-host" class="topbar-breadcrumb" hidden></div>
    <main id="split">
      <aside id="leftrail" class="pane">
        <div class="rail-sect-body" id="rail-explorer-body"></div>
        <div class="rail-sect-body" id="rail-overview-body"></div>
        <nav class="rail-sect-body" id="rail-docs-body" aria-label="Documentation">
          <ul class="koi-doclinks">
            <li><button type="button" class="koi-doclink" data-doclink="contextmap"><span class="koi-doclink-label">Context Map</span></button></li>
            <li><button type="button" class="koi-doclink" data-doclink="glossary"><span class="koi-doclink-label">Ubiquitous Language</span></button></li>
            <li><button type="button" class="koi-doclink" data-doclink="adr"><span class="koi-doclink-label">ADR</span></button></li>
            <li><button type="button" class="koi-doclink" data-doclink="notes"><span class="koi-doclink-label">Notes</span></button></li>
          </ul>
        </nav>
      </aside>
      <section id="center" class="pane">
        <div id="center-tabs" role="tablist">
          <button type="button" class="center-tab" id="center-tab-visual" role="tab" data-center="visual" aria-selected="true">Visual</button>
          <button type="button" class="center-tab" id="center-tab-technical" role="tab" data-center="technical" aria-selected="false">Code</button>
          <button type="button" class="center-tab" id="center-tab-docs" role="tab" data-center="docs" aria-selected="false">Documentation</button>
          <button type="button" class="center-tab center-tab-ai" id="center-tab-assistant" role="tab" data-center="assistant" aria-selected="false">Assistant</button>
        </div>
        <div id="center-body">
          <section id="center-visual" class="center-host" role="tabpanel">
            <div id="canvas-palette-host"></div>
            <div id="diagram-host"></div>
          </section>
          <section id="center-technical" class="center-host" role="tabpanel" hidden>
            <div id="tech-tabs" role="tablist">
              <button type="button" class="tech-tab" id="tech-tab-editor" role="tab" data-tech="editor" aria-selected="true">Editor</button>
              <button type="button" class="tech-tab" id="tech-tab-preview" role="tab" data-tech="preview" aria-selected="false">Generated</button>
              <button type="button" class="tech-tab" id="tech-tab-check" role="tab" data-tech="check" aria-selected="false">Compatibility</button>
              <button type="button" class="tech-tab" id="tech-tab-scenarios" role="tab" data-tech="scenarios" aria-selected="false">Scenarios</button>
            </div>
            <div id="tech-body">
              <section id="editor-pane" class="tech-view"></section>
              <div id="view-preview" class="tech-view" role="tabpanel" hidden></div>
              <div id="view-check" class="tech-view doc-view" role="tabpanel" hidden></div>
              <div id="view-scenarios" class="tech-view" role="tabpanel" hidden></div>
            </div>
          </section>
          <section id="center-docs" class="center-host" role="tabpanel" hidden>
            <div id="docs-tabs" role="tablist">
              <button type="button" class="docs-tab" id="docs-tab-glossary" role="tab" data-docs="glossary" aria-selected="true">Glossary</button>
              <button type="button" class="docs-tab" id="docs-tab-adr" role="tab" data-docs="adr" aria-selected="false">Decisions</button>
              <button type="button" class="docs-tab" id="docs-tab-notes" role="tab" data-docs="notes" aria-selected="false">Notes</button>
            </div>
            <div id="docs-body">
              <div id="view-glossary" class="tech-view doc-view" role="tabpanel"></div>
              <div id="view-docs" class="tech-view doc-view" role="tabpanel" hidden></div>
              <div id="view-notes" class="tech-view doc-view" role="tabpanel" hidden></div>
            </div>
          </section>
          <section id="view-assistant" class="center-host" role="tabpanel" hidden></section>
        </div>
        <footer id="diagnostics">
          <div class="koi-resizer koi-resizer-y" id="diag-resizer"></div>
          <div id="diag-header">
            <button type="button" id="diag-collapse" class="diag-collapse" aria-expanded="true">collapse</button>
            <div class="diag-tabs" role="tablist">
              <button type="button" class="diag-tab" id="tab-problems" role="tab" data-panel="problems" aria-selected="true">Problems</button>
              <button type="button" class="diag-tab" id="tab-events" role="tab" data-panel="events" aria-selected="false">Events</button>
              <button type="button" class="diag-tab" id="tab-relationships" role="tab" data-panel="relationships" aria-selected="false">Relationships</button>
              <button type="button" class="diag-tab" id="tab-contextmap" role="tab" data-panel="contextmap" aria-selected="false">Context Map</button>
              <button type="button" class="diag-tab" id="tab-terminal" role="tab" data-panel="terminal" aria-selected="false">Terminal</button>
            </div>
            <span id="diag-count" class="diag-count"></span>
          </div>
          <div id="diag-body" class="diag-panel" role="tabpanel"></div>
          <div id="panel-events" class="diag-panel" role="tabpanel" hidden></div>
          <div id="panel-relationships" class="diag-panel" role="tabpanel" hidden></div>
          <div id="panel-contextmap" class="diag-panel doc-view" role="tabpanel" hidden></div>
          <div id="panel-terminal" class="diag-panel diag-panel-terminal" role="tabpanel" hidden></div>
          <div id="panel-review" class="diag-panel" role="tabpanel" hidden></div>
        </footer>
      </section>
      <aside id="right" class="pane">
        <div id="right-tabs" role="tablist">
          <button type="button" class="rtab" id="rtab-props" role="tab" data-rview="props" aria-selected="true">Properties</button>
          <button type="button" class="rtab" id="rtab-rules" role="tab" data-rview="rules" aria-selected="false">Rules</button>
          <button type="button" class="rtab" id="rtab-notes" role="tab" data-rview="notes" aria-selected="false">Notes</button>
          <button type="button" class="rtab" id="rtab-source-control" role="tab" data-rview="source-control" aria-selected="false">Source Control</button>
        </div>
        <div id="right-body">
          <div id="inspector-host" class="rview" role="tabpanel"></div>
          <div id="rview-rules" class="rview doc-view" role="tabpanel" hidden></div>
          <div id="rview-notes" class="rview doc-view" role="tabpanel" hidden></div>
          <div id="rview-source-control" class="rview doc-view" role="tabpanel" hidden></div>
        </div>
      </aside>
    </main>
    <footer id="statusbar"><span class="sb-item" id="sb-context">Context: —</span></footer>
  </div>`;

function seedDom(): void {
  document.body.innerHTML = APP_HTML;
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

// --- fixtures ----------------------------------------------------------------
// A two-element glossary model (one aggregate + one value) under one context, so loadModel renders a
// non-empty outline + counts and the inspector can resolve a selection.
function glossaryFixture(): GlossaryModel {
  const entries: GlossaryEntry[] = [
    {
      id: 'Billing',
      name: 'Billing',
      kind: 'context',
      context: 'Billing',
      qualifiedName: 'Billing',
      doc: null,
      nameRange: { start: { line: 0, character: 8 }, end: { line: 0, character: 15 } },
    },
    {
      id: 'Billing.Money',
      name: 'Money',
      kind: 'value',
      context: 'Billing',
      qualifiedName: 'Billing.Money',
      doc: 'A monetary amount.',
      nameRange: { start: { line: 1, character: 8 }, end: { line: 1, character: 13 } },
    },
  ];
  return { entries };
}

// --- LSP stub ----------------------------------------------------------------
// The content surface the loaders call, every method a vi.fn so a test can assert call counts (the
// lazy-load-once / refetch-after-invalidate contracts) and swap return values per test.
function makeLsp() {
  return {
    glossaryModel: vi.fn(async (): Promise<GlossaryModel> => glossaryFixture()),
    livingDocs: vi.fn(async (): Promise<DocsResult> => ({ files: [] })),
    model: vi.fn(async () => ({ kind: 'model', qualifiedName: '', title: '', members: [], children: [] })),
    contextMap: vi.fn(async (): Promise<ContextMapResult> => ({ contexts: ['Billing'], relations: [] })),
    emitPreview: vi.fn(
      async (target: string): Promise<EmitPreviewResult> => ({
        target,
        files: [{ path: 'Money.cs', contents: '// money' }],
        diagnostics: [],
        error: null,
      }),
    ),
    check: vi.fn(async (): Promise<CheckResult> => ({ hasBreakingChanges: false, changes: [] })),
    setDoc: vi.fn(async (): Promise<SetDocResult> => ({ uri: null, edits: [] })),
    documentSymbols: vi.fn(async (): Promise<DocumentSymbol[]> => []),
  };
}
type Lsp = ReturnType<typeof makeLsp>;

// A no-op editor handle: the loaders only read editor.view.requestMeasure + jump-to-source (goto/
// gotoRange), none of which need a live CodeMirror in these assertions.
function fakeEditor(): InspectorControllerDeps['editor'] {
  return {
    view: { requestMeasure: vi.fn() } as unknown as InspectorControllerDeps['editor']['view'],
    goto: vi.fn(),
    gotoRange: vi.fn(),
  };
}

// A spied output viewer (the Generated preview writes content + lang here).
function fakeOutput(): InspectorControllerDeps['output'] {
  return { setContent: vi.fn(), setLineWrap: vi.fn(), destroy: vi.fn() };
}

// A browser-like platform stub: only the bits runCheck / loadAdr / loadNotes touch (kind, canOpenFolders,
// pickFolder, readFolderSources, and the docsStore fs reads — which return empty here).
function fakePlatform(over: Partial<Record<string, unknown>> = {}): InspectorControllerDeps['platform'] {
  return {
    kind: 'browser',
    canOpenFolders: true,
    pickFolder: vi.fn(async () => null),
    readFolderSources: vi.fn(async () => []),
    listKoiFiles: vi.fn(async () => []),
    listEntries: vi.fn(async () => []),
    readTextFile: vi.fn(async () => ''),
    gitLogForRange: vi.fn(async () => null),
    ...over,
  } as unknown as InspectorControllerDeps['platform'];
}

function makeAssistant(): InspectorAssistant & { syncWorkspace: ReturnType<typeof vi.fn>; focusInput: ReturnType<typeof vi.fn> } {
  return { syncWorkspace: vi.fn<() => void>(), focusInput: vi.fn<() => void>() };
}

function makeDeps(lsp: Lsp, over: Partial<InspectorControllerDeps> = {}): InspectorControllerDeps {
  return {
    lsp: lsp as unknown as InspectorControllerLsp,
    editor: fakeEditor(),
    output: fakeOutput(),
    platform: fakePlatform(),
    // A fresh store per controller — the injection's payoff: tests no longer share (and leak through) the
    // app-wide singleton, so the per-instance boot reset is exercised on isolated state.
    store: createAppStore(),
    activeUri: () => 'file:///work/model.koi',
    folderRootToken: () => '',
    initialTarget: 'csharp',
    saveWorkspaceCenter: vi.fn(),
    loadWorkspaceCenter: vi.fn(() => null),
    saveActiveContext: vi.fn(),
    loadActiveContext: vi.fn(() => null),
    setStatus: vi.fn(),
    onRenameElement: vi.fn(),
    onSaveElementDescription: vi.fn(),
    onSaveGlossaryDescription: vi.fn(),
    onApplyStructuredEdit: vi.fn(),
    onAddConstruct: vi.fn(),
    onAddAnnotation: vi.fn(),
    onAddAggregateMember: vi.fn(),
    onExportDiagram: vi.fn(),
    onCopyDiagramMermaid: vi.fn(),
    gotoSourceSpan: vi.fn(),
    ensureAssistant: vi.fn(() => makeAssistant()),
    initEdgeResizer: vi.fn(),
    ...over,
  };
}

/** Let queued microtask-chained loader promises settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeEach(() => {
  seedDom();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('createInspectorController — center switching', () => {
  test('init() boots Visual (default) → the visual center is shown, the others hidden', () => {
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();

    expect(el('center-visual').hidden).toBe(false);
    expect(el('center-technical').hidden).toBe(true);
    expect(el('center-docs').hidden).toBe(true);
    expect(el('center-tab-visual').getAttribute('aria-selected')).toBe('true');
  });

  test('the bottom panel is visible in every center view (#451)', () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init(); // boots Visual

    expect(el('diagnostics').hidden).toBe(false); // Visual
    ctl.selectCenter('technical');
    expect(el('diagnostics').hidden).toBe(false); // Code
    ctl.selectDocsTab('glossary'); // forces center = docs
    expect(el('diagnostics').hidden).toBe(false); // Documentation
    ctl.selectCenter('assistant');
    expect(el('diagnostics').hidden).toBe(false); // Assistant
  });

  test('selectCenter("technical") surfaces the technical center + editor sub-view and marks the Code tab', () => {
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();

    ctl.selectCenter('technical');

    expect(el('center-technical').hidden).toBe(false);
    expect(el('center-visual').hidden).toBe(true);
    expect(el('editor-pane').hidden).toBe(false); // the technical center lands on the editor sub-tab
    expect(el('center-tab-technical').getAttribute('aria-selected')).toBe('true');
    expect(el('center-tab-visual').getAttribute('aria-selected')).toBe('false');
  });

  test('selectCenter("docs") surfaces the Documentation center on the Glossary sub-view', () => {
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();

    ctl.selectCenter('docs');

    expect(el('center-docs').hidden).toBe(false);
    expect(el('view-glossary').hidden).toBe(false);
    expect(el('view-docs').hidden).toBe(true);
    expect(el('center-tab-docs').getAttribute('aria-selected')).toBe('true');
  });

  test('a real center change persists via saveWorkspaceCenter; re-selecting the same center does not', () => {
    const saveWorkspaceCenter = vi.fn();
    const ctl = createInspectorController(makeDeps(makeLsp(), { saveWorkspaceCenter }));
    ctl.init();

    ctl.selectCenter('technical');
    expect(saveWorkspaceCenter).toHaveBeenCalledWith('technical');
    saveWorkspaceCenter.mockClear();
    ctl.selectCenter('technical'); // same center — no churn
    expect(saveWorkspaceCenter).not.toHaveBeenCalled();
  });

  test('a persisted center restores it on boot (technical)', () => {
    const ctl = createInspectorController(makeDeps(makeLsp(), { loadWorkspaceCenter: () => 'technical' }));
    ctl.init();
    expect(el('center-technical').hidden).toBe(false);
    expect(el('center-visual').hidden).toBe(true);
  });
});

describe('createInspectorController — lazy view loading (load exactly once)', () => {
  test('the Generated preview emits once on first show, not again on a re-show', async () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();

    ctl.selectTech('preview');
    await flush();
    expect(lsp.emitPreview).toHaveBeenCalledTimes(1);

    // Switch away and back — the cached preview is still fresh, so no refetch.
    ctl.selectTech('editor');
    ctl.selectTech('preview');
    await flush();
    expect(lsp.emitPreview).toHaveBeenCalledTimes(1);
  });

  test('the glossary loads once on first Documentation show, not again on a re-show', async () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();

    ctl.selectDocsTab('glossary');
    await flush();
    const afterFirst = lsp.glossaryModel.mock.calls.length;
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    // Re-show the glossary: it's cached (docViewsLoaded.glossary), so no extra glossaryModel fetch.
    ctl.selectDocsTab('adr');
    ctl.selectDocsTab('glossary');
    await flush();
    expect(lsp.glossaryModel.mock.calls.length).toBe(afterFirst);
  });

  test('the Assistant center tab nudges ensureAssistant().syncWorkspace + focusInput, every show', () => {
    const assistant = makeAssistant();
    const ensureAssistant = vi.fn(() => assistant);
    const ctl = createInspectorController(makeDeps(makeLsp(), { ensureAssistant }));
    ctl.init();

    ctl.selectCenter('assistant');
    expect(assistant.syncWorkspace).toHaveBeenCalledTimes(1);
    expect(assistant.focusInput).toHaveBeenCalledTimes(1);
  });
});

describe('createInspectorController — invalidation forces a refetch', () => {
  test('invalidateDocViews() then re-show refetches the preview (stale → reload)', async () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();

    ctl.selectTech('preview');
    await flush();
    expect(lsp.emitPreview).toHaveBeenCalledTimes(1);

    ctl.invalidateDocViews(); // an edit happened (model-derived views are stale)
    ctl.selectTech('editor');
    ctl.selectTech('preview'); // re-show → must refetch
    await flush();
    expect(lsp.emitPreview).toHaveBeenCalledTimes(2);
  });

  test('onDocEdited() debounces a refresh of the live surfaces (350ms) and refreshes the context list', async () => {
    vi.useFakeTimers();
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();
    // Land on the technical center so the only live model-derived surface is the left rail (loadModel),
    // keeping the assertion about the debounced refreshContextList clean.
    ctl.selectCenter('technical');
    lsp.glossaryModel.mockClear();

    ctl.onDocEdited();
    ctl.onDocEdited();
    ctl.onDocEdited();
    // Nothing fired yet — the refresh is debounced.
    expect(lsp.glossaryModel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(350);
    // refreshContextList (glossaryModel) + refreshActiveSurfaces (loadModel → ensureModelIndex →
    // glossaryModel) both ran once after the single debounce window — not three times.
    expect(lsp.glossaryModel.mock.calls.length).toBeGreaterThanOrEqual(1);
    const settled = lsp.glossaryModel.mock.calls.length;
    await vi.advanceTimersByTimeAsync(350);
    expect(lsp.glossaryModel.mock.calls.length).toBe(settled); // no further timer fired
  });

  test('dispose() cancels the pending edit-debounce so the refresh never fires', async () => {
    vi.useFakeTimers();
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();
    ctl.selectCenter('technical');
    lsp.glossaryModel.mockClear();

    ctl.onDocEdited(); // schedules the 350ms refresh debounce
    ctl.dispose(); // must cancel it — otherwise the timer fires after the test's DOM is gone
    await vi.advanceTimersByTimeAsync(350);
    // The debounced refresh never ran: disposing cleared the timer (no post-teardown "document is not defined").
    expect(lsp.glossaryModel).not.toHaveBeenCalled();
  });
});

describe('createInspectorController — bottom strip lazy loading', () => {
  test('Events loads once per first selectBottomTab; Problems never fetches', async () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();

    // Problems is the default; switching to it fetches nothing.
    ctl.selectBottomTab('problems');
    await flush();
    expect(lsp.livingDocs).not.toHaveBeenCalled();

    ctl.selectBottomTab('events');
    await flush();
    const afterEvents = lsp.livingDocs.mock.calls.length;
    expect(afterEvents).toBeGreaterThanOrEqual(1);
    expect(el('panel-events').hidden).toBe(false);

    // Re-show Events without an edit — cached, so no extra livingDocs fetch.
    ctl.selectBottomTab('problems');
    ctl.selectBottomTab('events');
    await flush();
    expect(lsp.livingDocs.mock.calls.length).toBe(afterEvents);
  });

  test('the Context Map tab lazy-loads the context map once and renders it with a Graph | Table toggle (graph default)', async () => {
    localStorage.removeItem('koine.studio.contextMapView'); // the default view is Graph regardless of prior runs
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();

    ctl.selectBottomTab('contextmap');
    await flush();

    expect(lsp.contextMap).toHaveBeenCalledTimes(1);
    const panel = el('panel-contextmap');
    expect(panel.hidden).toBe(false);
    // the interactive view: a Graph | Table toggle, with Graph the default selected view
    const tabs = panel.querySelectorAll<HTMLButtonElement>('.ctxmap-tab');
    expect(tabs).toHaveLength(2);
    expect(panel.querySelector('[data-ctxmap-view="graph"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(panel.querySelector('[data-ctxmap-view="table"]')?.getAttribute('aria-pressed')).toBe('false');
  });

  test('toggling the Context Map to Table renders the dense table (and back to Graph) without refetching', async () => {
    localStorage.removeItem('koine.studio.contextMapView');
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();

    ctl.selectBottomTab('contextmap');
    await flush();
    const panel = el('panel-contextmap');

    // Switch to the Table view — synchronous, renders renderContextMapHtml's `koi-md` markup.
    panel.querySelector<HTMLButtonElement>('[data-ctxmap-view="table"]')!.click();
    await flush();
    expect(panel.innerHTML).toContain('koi-md');
    expect(panel.querySelector('[data-ctxmap-view="table"]')?.getAttribute('aria-pressed')).toBe('true');

    // Back to Graph — the toggle never refetches the context map (one fetch total).
    panel.querySelector<HTMLButtonElement>('[data-ctxmap-view="graph"]')!.click();
    await flush();
    expect(panel.querySelector('[data-ctxmap-view="graph"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(lsp.contextMap).toHaveBeenCalledTimes(1);
  });

  test('clicking a context node filters AND jumps to its .koi declaration when the node has a span (#290)', async () => {
    localStorage.removeItem('koine.studio.contextMapView'); // Graph is the default view
    const lsp = makeLsp();
    const deps = makeDeps(lsp);
    const ctl = createInspectorController(deps);
    ctl.init();
    await ctl.refreshContextList(); // populate the known-context list (Billing) from the glossary model
    await flush();

    // Capture the hooks the inspector wires into the context-map graph (so we exercise onContextClick
    // directly, without driving the maxGraph engine). The real renderer is restored by afterEach.
    let hooks: ContextMapGraphHooks | undefined;
    vi.spyOn(maxgraphRenderer, 'renderContextMapGraph').mockImplementation(async (_stage, _graph, _isCurrent, h) => {
      hooks = h;
      return { dispose: () => {} };
    });

    ctl.selectBottomTab('contextmap');
    await flush();
    expect(hooks).toBeDefined();

    const span: SourceSpan = { file: 'file:///billing.koi', line: 1, column: 9, endLine: 1, endColumn: 16, offset: 8, length: 7 };
    const spanned: DiagramNode = {
      id: 'Billing', label: 'Billing', kind: 'context', qualifiedName: 'Billing', sourceSpan: span, stereotype: null, members: [],
    };

    hooks!.onContextClick!(spanned);
    // filters to the clicked context...
    expect(deps.store.getState().activeContext).toBe('Billing');
    // ...AND jumps to its declaration via the shared jump-to-source path.
    expect(deps.gotoSourceSpan).toHaveBeenCalledWith(span);

    // A span-less context node (a dangling endpoint / recovered parse) still filters but never navigates.
    vi.mocked(deps.gotoSourceSpan).mockClear();
    hooks!.onContextClick!({ ...spanned, sourceSpan: null });
    expect(deps.gotoSourceSpan).not.toHaveBeenCalled();
  });

  test('the rail Context Map link opens the map in the now-global strip without leaving the view (#451)', async () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();

    // Land on Documentation — the bottom strip is now visible here (it's global).
    ctl.selectDocsTab('adr');
    expect(el('diagnostics').hidden).toBe(false);

    // The rail's Context Map link just opens the Context Map bottom tab, in place.
    document.querySelector<HTMLButtonElement>('.koi-doclink[data-doclink="contextmap"]')!.click();
    await flush();

    expect(el('center-docs').hidden).toBe(false); // still on Documentation…
    expect(el('diagnostics').hidden).toBe(false); // …strip visible…
    expect(el('panel-contextmap').hidden).toBe(false); // …showing the Context Map.
  });
});

describe('createInspectorController — loading states clear on success', () => {
  // Regression: docMessage writes a raw <p>Loading…</p> the Preact reconciler can't see, so a
  // bare render(<Panel/>, host) used to APPEND the panel beside the loading line — both showed at
  // once. Every Preact-panel host must replace its loading line, not stack on top of it.
  test('loadModel replaces the "Loading model…" line — it does not stack beside the outline', async () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();

    ctl.refreshActiveSurfaces(); // → loadModel paints the left-rail Explorer outline
    await flush();

    const explorer = el('rail-explorer-body');
    expect(explorer.textContent).toContain('Money'); // the outline rendered
    expect(explorer.textContent).not.toContain('Loading model'); // …without the loading line left behind
  });

  test('the glossary replaces its "Loading glossary…" line on success', async () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();

    ctl.selectDocsTab('glossary');
    await flush();

    const glossary = el('view-glossary');
    expect(glossary.textContent).toContain('Money'); // the glossary rendered
    expect(glossary.textContent).not.toContain('Loading glossary');
  });

  test('the Events panel replaces its "Loading events…" line on success', async () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();

    ctl.selectBottomTab('events');
    await flush();

    expect(el('panel-events').textContent).not.toContain('Loading events');
  });

  test('the Relationships panel replaces its "Loading relationships…" line on success', async () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();

    ctl.selectBottomTab('relationships');
    await flush();

    expect(el('panel-relationships').textContent).not.toContain('Loading relationships');
  });
});

describe('createInspectorController — Properties inspector tracks the selection bus', () => {
  test('selecting an element renders its Properties; the inspector host is non-empty', async () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();
    // Prime the model index (the inspector resolves a selection against it) by loading the model once.
    ctl.refreshActiveSurfaces();
    await flush();

    ctl.selection.set({ qualifiedName: 'Billing.Money', context: 'Billing' });

    // The Properties host renders the resolved element (its name appears in the panel).
    const host = el('inspector-host');
    expect(host.textContent).toContain('Money');
  });

  test('clearing the selection renders the inspector empty state without throwing', async () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();
    ctl.refreshActiveSurfaces();
    await flush();

    ctl.selection.set({ qualifiedName: 'Billing.Money', context: 'Billing' });
    expect(() => ctl.selection.set(null)).not.toThrow();
  });
});

describe('createInspectorController — bounded-context scope', () => {
  test('refreshContextList populates the scope-path selector and reveals it', async () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();

    await ctl.refreshContextList();

    const select = document.querySelector<HTMLSelectElement>('#breadcrumb-host select')!;
    // "All contexts" sentinel + the one model context.
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['all', 'Billing']);
    expect(el('breadcrumb-host').hidden).toBe(false);
  });

  test('getCachedDomainIndex builds once then reuses until invalidateDocViews clears it', async () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();

    const idx1 = await ctl.getCachedDomainIndex();
    expect(idx1?.contexts).toEqual(['Billing']);
    const callsAfterBuild = lsp.contextMap.mock.calls.length;

    // A second read reuses the cache — no extra contextMap recompile.
    await ctl.getCachedDomainIndex();
    expect(lsp.contextMap.mock.calls.length).toBe(callsAfterBuild);

    // An edit clears it → the next read rebuilds.
    ctl.invalidateDocViews();
    await ctl.getCachedDomainIndex();
    expect(lsp.contextMap.mock.calls.length).toBeGreaterThan(callsAfterBuild);
  });
});

describe('createInspectorController — construct palette', () => {
  test('clicking an enabled palette button calls onAddConstruct with its kind', () => {
    const onAddConstruct = vi.fn();
    const deps = makeDeps(makeLsp(), { onAddConstruct });
    // Set a single active context BEFORE mounting so the palette's first render is already enabled
    // (no async re-render to await — the initial useStore read sees 'Ordering').
    deps.store.getState().setActiveContext('Ordering');
    createInspectorController(deps);
    const btn = el('canvas-palette-host').querySelector<HTMLButtonElement>('[data-kind="entity"]')!;
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(onAddConstruct).toHaveBeenCalledWith('entity');
  });

  test('palette construct buttons are disabled under "All contexts"', () => {
    const deps = makeDeps(makeLsp()); // createAppStore() defaults to ALL_CONTEXTS
    createInspectorController(deps);
    const btn = el('canvas-palette-host').querySelector<HTMLButtonElement>('[data-kind="entity"]')!;
    expect(btn.disabled).toBe(true);
  });
});
