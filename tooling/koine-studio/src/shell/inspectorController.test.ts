// Tests for the inspectorController — the mode / center-tab / view subsystem extracted from ide.ts's
// init() (Task 4 of the ide.ts decomposition). This file is the PRIMARY behavioral net for this
// subsystem: ide.test.ts does not exercise view switching / lazy-loading / debounce, so the
// stale-token + lazy-load-once + debounce contracts are pinned here.
//
// We drive the real controller with a small seeded DOM (the same id surface init() builds, lifted from
// ide.test.ts's APP_HTML so a drift throws via el()) and a spied `lsp` content stub. happy-dom renders
// the real panel DOM; fake timers cover the 350ms edit/bottom debounce.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { waitFor } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import {
  createInspectorController,
  type InspectorAssistant,
  type InspectorControllerDeps,
  type InspectorControllerLsp,
} from '@/shell/inspectorController';
import { leftRailMarkup } from '@/shell/leftRail';
import { rightStripMarkup } from '@/shell/rightStrip';
import { loadLayout, saveLayout } from '@/shell/layoutStore';
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
  ModelNode,
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
      <aside id="leftrail" class="pane">${leftRailMarkup()}</aside>
      <section id="center" class="pane">
        <div id="center-tabs" role="tablist">
          <button type="button" class="center-tab" id="center-tab-visual" role="tab" data-center="visual" aria-selected="true">Canvas</button>
          <button type="button" class="center-tab" id="center-tab-technical" role="tab" data-center="technical" aria-selected="false">Code</button>
          <button type="button" class="center-tab" id="center-tab-output" role="tab" data-center="output" aria-selected="false">Output</button>
          <button type="button" class="center-tab" id="center-tab-docs" role="tab" data-center="docs" aria-selected="false">Docs</button>
        </div>
        <div id="center-body">
          <section id="center-visual" class="center-host" role="tabpanel">
            <div id="canvas-palette-host"></div>
            <div id="diagram-host"></div>
          </section>
          <section id="center-technical" class="center-host" role="tabpanel" hidden>
            <div id="tech-tabs" role="tablist">
              <button type="button" class="tech-tab" id="tech-tab-editor" role="tab" data-tech="editor" aria-selected="true">Editor</button>
              <button type="button" class="tech-tab" id="tech-tab-scenarios" role="tab" data-tech="scenarios" aria-selected="false">Scenarios</button>
            </div>
            <div id="tech-body">
              <section id="editor-pane" class="tech-view"></section>
              <div id="view-scenarios" class="tech-view" role="tabpanel" hidden></div>
            </div>
          </section>
          <section id="center-output" class="center-host" role="tabpanel" hidden>
            <div id="output-tabs" role="tablist">
              <button type="button" class="output-tab" id="output-tab-generated" role="tab" data-output="generated" aria-selected="true">Generated</button>
              <button type="button" class="output-tab" id="output-tab-compatibility" role="tab" data-output="compatibility" aria-selected="false">Compatibility</button>
              <button type="button" class="output-tab" id="output-tab-contextmap" role="tab" data-output="contextmap" aria-selected="false">Context Map</button>
            </div>
            <div id="output-body">
              <div id="view-preview" class="tech-view" role="tabpanel"></div>
              <div id="view-check" class="tech-view doc-view" role="tabpanel" hidden></div>
              <div id="panel-contextmap" class="tech-view doc-view" role="tabpanel" hidden></div>
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
        </div>
        <footer id="diagnostics">
          <div class="koi-resizer koi-resizer-y" id="diag-resizer"></div>
          <div id="diag-header">
            <button type="button" id="diag-collapse" class="diag-collapse" aria-expanded="true">collapse</button>
            <div class="diag-tabs" role="tablist">
              <button type="button" class="diag-tab" id="tab-problems" role="tab" data-panel="problems" aria-selected="true">Problems</button>
              <button type="button" class="diag-tab" id="tab-events" role="tab" data-panel="events" aria-selected="false">Events</button>
              <button type="button" class="diag-tab" id="tab-relationships" role="tab" data-panel="relationships" aria-selected="false">Relationships</button>
              <button type="button" class="diag-tab" id="tab-terminal" role="tab" data-panel="terminal" aria-selected="false">Terminal</button>
            </div>
            <span id="diag-count" class="diag-count"></span>
          </div>
          <div id="diag-body" class="diag-panel" role="tabpanel"></div>
          <div id="panel-events" class="diag-panel" role="tabpanel" hidden></div>
          <div id="panel-relationships" class="diag-panel" role="tabpanel" hidden></div>
          <div id="panel-terminal" class="diag-panel diag-panel-terminal" role="tabpanel" hidden></div>
          <div id="panel-review" class="diag-panel" role="tabpanel" hidden></div>
        </footer>
      </section>
      <aside id="right" class="pane">
        <header id="right-header"><h2 id="right-title">Properties</h2></header>
        <div id="right-body">
          <div id="inspector-host" class="rview" role="tabpanel"></div>
          <section id="view-assistant" class="rview" role="tabpanel" hidden></section>
          <div id="rview-rules" class="rview doc-view" role="tabpanel" hidden></div>
          <div id="rview-notes" class="rview doc-view" role="tabpanel" hidden></div>
          <div id="rview-source-control" class="rview doc-view" role="tabpanel" hidden></div>
        </div>
      </aside>
      <div id="right-strip" class="pane" role="toolbar" aria-label="Tool windows" aria-orientation="vertical">${rightStripMarkup()}</div>
    </main>
    <footer id="statusbar"><span class="sb-item" id="sb-context">Context: —</span></footer>
  </div>`;

function seedDom(): void {
  document.body.innerHTML = APP_HTML;
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

// The right-view switcher is the icon stripe (#right-strip), one button per RightView (#500). Tests drive
// view changes by clicking these, the way a user does.
const stripBtn = (view: string) =>
  document.querySelector<HTMLButtonElement>(`#right-strip [data-rview="${view}"]`)!;

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
    model: vi.fn(async (): Promise<ModelNode> => ({ kind: 'model', qualifiedName: '', title: '', members: [], children: [] })),
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
    saveAllDirty: vi.fn(async () => {}),
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
    revealInFiles: vi.fn(),
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

    ctl.selectOutput('generated');
    await flush();
    expect(lsp.emitPreview).toHaveBeenCalledTimes(1);

    // Switch away and back — the cached preview is still fresh, so no refetch.
    ctl.selectTech('editor');
    ctl.selectOutput('generated');
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

  test('opening the AI Chat right view nudges ensureAssistant().syncWorkspace + focusInput, every show', () => {
    const assistant = makeAssistant();
    const ensureAssistant = vi.fn(() => assistant);
    const ctl = createInspectorController(makeDeps(makeLsp(), { ensureAssistant }));
    ctl.init();

    ctl.selectRight('assistant');
    expect(assistant.syncWorkspace).toHaveBeenCalledTimes(1);
    expect(assistant.focusInput).toHaveBeenCalledTimes(1);
    expect(el('view-assistant').hidden).toBe(false);
    expect(el('rtab-assistant').getAttribute('aria-selected')).toBe('true');
  });
});

describe('createInspectorController — invalidation forces a refetch', () => {
  test('invalidateDocViews() then re-show refetches the preview (stale → reload)', async () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();

    ctl.selectOutput('generated');
    await flush();
    expect(lsp.emitPreview).toHaveBeenCalledTimes(1);

    ctl.invalidateDocViews(); // an edit happened (model-derived views are stale)
    ctl.selectTech('editor');
    ctl.selectOutput('generated'); // re-show → must refetch
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

    ctl.selectOutput('contextmap');
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

    ctl.selectOutput('contextmap');
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

    ctl.selectOutput('contextmap');
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

  // NOTE: the rail's Context Map / Ubiquitous Language doclinks moved out of the docs footer into the
  // Domain axis (#453); the footer now carries only ADR + Notes. The Context Map doorway is rebuilt in
  // the strategic Domain view (below). Per #451 the bottom strip is global, so the doorway opens the
  // Context Map in place without leaving the current center.
});

describe('createInspectorController — rail axis switch (#453)', () => {
  test('the Files axis button surfaces #rail-files and hides the Domain pane; Domain switches back', () => {
    localStorage.removeItem('koine.studio.railAxis');
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();

    const domainPane = el('rail-domain-pane');
    const filesPane = el('rail-files');
    // Domain is the default axis.
    expect(domainPane.hidden).toBe(false);
    expect(filesPane.hidden).toBe(true);

    // Clicking the Files axis tab shows the file tree and hides the Domain navigator.
    (document.querySelector('#rail-axis-switch [data-axis="files"]') as HTMLButtonElement).click();
    expect(domainPane.hidden).toBe(true);
    expect(filesPane.hidden).toBe(false);
    expect(document.querySelector('#rail-axis-switch [data-axis="files"]')!.getAttribute('aria-selected')).toBe('true');

    // setAxis('domain') (ide.ts's ⌘B path) hands the rail back to the Domain navigator.
    ctl.setAxis('domain');
    expect(domainPane.hidden).toBe(false);
    expect(filesPane.hidden).toBe(true);
  });
});

describe('createInspectorController — Domain navigator doorways + cross-axis glue (#453)', () => {
  test('the strategic Context Map doorway opens the Context Map in the Output center pane', async () => {
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();
    ctl.refreshActiveSurfaces(); // mounts the Domain navigator, which self-fetches + paints the doorways
    await flush();

    // Land on Documentation first, so we can prove the doorway navigates AWAY to Output.
    ctl.selectDocsTab('adr');
    expect(el('center-docs').hidden).toBe(false);

    // Drive the REAL strategic Context Map doorway → modelOutlineHandlers.onOpenContextMap →
    // focusContextMap() → selectOutput('contextmap'): the Context Map is the contextmap sub-view of the
    // Output center pane now, so the doorway switches the center to Output and shows the map.
    const doorway = el('rail-domain-pane').querySelector<HTMLButtonElement>('[data-door="contextmap"]')!;
    doorway.click();
    await flush();

    expect(el('center-output').hidden).toBe(false); // switched to the Output pane…
    expect(el('center-docs').hidden).toBe(true); // …left Documentation…
    expect(el('panel-contextmap').hidden).toBe(false); // …showing the Context Map.
  });

  test('a tactical leaf: selecting jumps via goto; "Reveal in Files" calls revealInFiles with the leaf context', async () => {
    const lsp = makeLsp();
    // Give the model graph a real aggregate-owned leaf so the tactical view has a row to act on (the
    // shared makeLsp().model is an empty graph). The aggregate carries the `<Ctx>.<Agg>` qualified name.
    lsp.model = vi.fn(async (): Promise<ModelNode> => ({
      kind: 'model',
      qualifiedName: '',
      title: '',
      members: [],
      children: [
        {
          kind: 'context',
          qualifiedName: 'Billing',
          title: 'Billing',
          members: [],
          children: [
            {
              kind: 'aggregate',
              qualifiedName: 'Billing.Invoice',
              title: 'Invoice',
              members: [],
              children: [{ kind: 'value', qualifiedName: 'Billing.Money', title: 'Money', members: [], children: [] }],
            },
          ],
        },
      ],
    }));
    const deps = makeDeps(lsp);
    const ctl = createInspectorController(deps);
    ctl.init();
    ctl.refreshActiveSurfaces(); // mount + fetch the navigator (strategic rows + the tactical tree) and the model index
    await flush();

    // Drill into Billing → tactical, exposing its aggregate's leaf rows.
    (el('rail-domain-pane').querySelector('[data-ctx="Billing"]') as HTMLButtonElement).click();
    await flush();

    // Selecting the Money leaf resolves through nodeContext/resolveInspectableQn and jumps to source.
    const leaf = el('rail-domain-pane').querySelector<HTMLButtonElement>('.koi-tactical-leaf[data-name="Money"]')!;
    leaf.click();
    expect(deps.editor.goto).toHaveBeenCalled();
    expect(deps.store.getState().selection?.qualifiedName).toBe('Billing.Money');

    // Its ⋯ overflow → "Reveal in Files" reveals the leaf's bounded context in the Files axis.
    leaf.closest('.koi-tactical-leaf-row')!.querySelector<HTMLButtonElement>('.koi-tactical-more')!.click();
    const item = Array.from(document.querySelectorAll<HTMLButtonElement>('.koi-tactical-menu-item')).find(
      (b) => b.textContent === 'Reveal in Files',
    )!;
    item.click();
    expect(deps.revealInFiles).toHaveBeenCalledWith('Billing');
  });
});

describe('createInspectorController — loading states clear on success', () => {
  // Regression: docMessage writes a raw <p>Loading…</p> the Preact reconciler can't see, so a
  // bare render(<Panel/>, host) used to APPEND the panel beside the loading line — both showed at
  // once. Every Preact-panel host must replace its loading line, not stack on top of it.
  test('loadModel paints the strategic Domain navigator — its loading placeholder is replaced', async () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();

    ctl.refreshActiveSurfaces(); // → loadModel mounts the Domain navigator, which self-fetches + paints
    await flush();

    // The Domain pane now shows the STRATEGIC context list (a row per bounded context, #453), not the old
    // per-construct outline — so the glossaryFixture's 'Billing' context appears…
    const domainPane = el('rail-domain-pane');
    expect(domainPane.querySelector('[data-ctx="Billing"]')).not.toBeNull();
    expect(domainPane.textContent).toContain('Billing');
    // …and neither the navigator's loading placeholder nor any stale loading line is left behind.
    expect(domainPane.textContent).not.toContain('Loading');
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

describe('createInspectorController — selecting an element focuses the Properties tab (#533)', () => {
  // Regression: when the right rail is on a non-Properties tab (Source Control / Rules / Notes), a new
  // element selection used to leave the rail on that tab — the user had to click Properties to see the
  // element they just selected. Selecting now auto-activates the Properties tab (desktop mirror of the
  // existing mobile inspector-sheet raise on the same selection path).
  test('a new selection while on Source Control activates the Properties right view', async () => {
    const lsp = makeLsp();
    const deps = makeDeps(lsp);
    const ctl = createInspectorController(deps);
    ctl.init();
    ctl.refreshActiveSurfaces();
    await flush();

    // Put the right rail on a non-Properties view, exactly as a user clicking the Source Control stripe icon would.
    stripBtn('source-control').click();
    expect(deps.store.getState().right).toBe('source-control');
    expect(stripBtn('source-control').getAttribute('aria-pressed')).toBe('true');
    expect(stripBtn('props').getAttribute('aria-pressed')).toBe('false');
    expect(el('right-title').textContent).toBe('Source Control');

    // Selecting an element (canvas / Domain navigator) must bring the user back to Properties.
    ctl.selection.set({ qualifiedName: 'Billing.Money', context: 'Billing' });

    expect(deps.store.getState().right).toBe('props');
    expect(stripBtn('props').getAttribute('aria-pressed')).toBe('true');
    expect(stripBtn('source-control').getAttribute('aria-pressed')).toBe('false');
    expect(el('right-title').textContent).toBe('Properties');
  });

  test('clearing the selection leaves the current right view untouched (no auto-switch on deselect)', async () => {
    const lsp = makeLsp();
    const deps = makeDeps(lsp);
    const ctl = createInspectorController(deps);
    ctl.init();
    ctl.refreshActiveSurfaces();
    await flush();

    // Select something (which focuses Properties), then deliberately switch back to Source Control.
    ctl.selection.set({ qualifiedName: 'Billing.Money', context: 'Billing' });
    stripBtn('source-control').click();
    expect(deps.store.getState().right).toBe('source-control');

    // A deselect must NOT yank the user onto the (now-empty) Properties pane.
    ctl.selection.set(null);

    expect(deps.store.getState().right).toBe('source-control');
    expect(stripBtn('source-control').getAttribute('aria-pressed')).toBe('true');
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

describe('createInspectorController — Domain-navigator drill syncs the status bar + canvas (#531)', () => {
  // Regression: drilling into a context from the Domain navigator (#453) writes the `activeContext`
  // slice DIRECTLY (setActiveContext), NOT through the dropdown's applyScope choke point. The
  // store-subscribing surfaces (the dropdown, the construct palette) react, but the status-bar readout
  // (#sb-context) and the Visual canvas re-filter are driven imperatively — so they used to stay stale
  // ("Context: All contexts" + an unfiltered canvas) while the dropdown showed the drilled context. The
  // fix subscribes those two surfaces to the slice, so ANY writer keeps them in lockstep.
  test('a direct setActiveContext write (the navigator drill) updates #sb-context AND re-filters the canvas', async () => {
    const lsp = makeLsp();
    const deps = makeDeps(lsp);
    const ctl = createInspectorController(deps);
    ctl.init(); // boots Visual — so the diagram (loadDiagrams → lsp.livingDocs) is the live scoped surface
    await ctl.refreshContextList(); // learn 'Billing' is a real context + sync the status bar to "All contexts"
    await flush();

    // Baseline: nothing drilled yet — the status bar reads the unscoped label.
    expect(el('sb-context').textContent).toBe('Context: All contexts');
    const diagramsBefore = lsp.livingDocs.mock.calls.length;

    // Simulate the Domain-navigator drill: write the slice DIRECTLY (NOT via the dropdown / applyScope),
    // exactly as domainNavigator.ts's onOpenContext does.
    deps.store.getState().setActiveContext('Billing');
    await flush();

    // (a) the status bar mirrors the drilled context…
    expect(el('sb-context').textContent).toBe('Context: Billing');
    // (b) …and the scoped-surface re-filter ran — the Visual canvas re-fetched its (now-scoped) diagrams.
    expect(lsp.livingDocs.mock.calls.length).toBeGreaterThan(diagramsBefore);
  });
});

describe('createInspectorController — Source Control live refresh-on-save (#470)', () => {
  // A git-capable platform: canUseGit true + the git surface as spies, so the mounted SourceControlPanel
  // actually fetches (gitStatus) and we can assert a re-fetch. The panel's fetch runs in its own
  // useEffect (a rAF/macrotask under happy-dom), so assertions poll via waitFor rather than a microtask flush.
  function gitPlatform() {
    const gitStatus = vi.fn(async () => ({ branch: 'main', files: [] }));
    const platform = fakePlatform({
      canUseGit: true,
      gitStatus,
      gitDiff: vi.fn(async () => ''),
      gitStage: vi.fn(async () => {}),
      gitUnstage: vi.fn(async () => {}),
      gitCommit: vi.fn(async () => {}),
      gitBranches: vi.fn(async () => ['main']),
      gitCheckout: vi.fn(async () => {}),
      gitLog: vi.fn(async () => []),
    });
    return { platform, gitStatus };
  }

  test('refreshSourceControl() re-fetches git status while the SC tab is open, and is a no-op otherwise', async () => {
    const { platform, gitStatus } = gitPlatform();
    const ctl = createInspectorController(makeDeps(makeLsp(), { platform }));
    ctl.init();

    // Open the Source Control right view (stripe click → selectRightView → loadSourceControl → mount).
    stripBtn('source-control').click();
    await waitFor(() => expect(gitStatus.mock.calls.length).toBeGreaterThanOrEqual(1));
    const afterOpen = gitStatus.mock.calls.length;

    // A save fires refreshSourceControl(): the view is open, so it re-fetches git status in place.
    ctl.refreshSourceControl();
    await waitFor(() => expect(gitStatus.mock.calls.length).toBeGreaterThan(afterOpen));

    // Switch to another right view: refreshSourceControl() is now a no-op (Source Control isn't active).
    stripBtn('props').click();
    const beforeNoop = gitStatus.mock.calls.length;
    ctl.refreshSourceControl();
    await new Promise((r) => setTimeout(r, 60)); // give any (erroneous) re-fetch time to fire
    expect(gitStatus.mock.calls.length).toBe(beforeNoop);
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

// #475 — On a NARROW viewport the global bottom strip (#458) DEFAULTS to collapsed on the two
// reading-heavy center views (Documentation, Assistant) so the reading/chat pane gets full height on a
// phone; the strip stays present (only its `.collapsed` default flips, never `.hidden`). An explicit
// persisted collapse preference (koine.studio.diagCollapsed) always wins, and desktop + narrow
// Visual/Code keep the expanded default. The strip is `.collapsed` ⇔ the class is on #diagnostics.
describe('createInspectorController — narrow-viewport bottom-strip default (#475)', () => {
  const DIAG_KEY = 'koine.studio.diagCollapsed';
  const origWidth = window.innerWidth;
  const setWidth = (value: number) =>
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value });
  const collapsed = () => el('diagnostics').classList.contains('collapsed');

  afterEach(() => {
    setWidth(origWidth);
    localStorage.removeItem(DIAG_KEY);
  });

  test('narrow + Documentation (Glossary) ⇒ strip collapsed by default, still visible', () => {
    setWidth(500);
    localStorage.removeItem(DIAG_KEY); // no explicit preference
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init(); // boots Visual — a working view, so expanded
    expect(collapsed()).toBe(false);

    ctl.selectDocsTab('glossary'); // → Documentation
    expect(collapsed()).toBe(true);
    expect(el('diagnostics').hidden).toBe(false); // GLOBAL per #458 — only collapsed, never hidden
    ctl.dispose();
  });

  test('narrow + Visual/Code (the working views) ⇒ strip stays expanded', () => {
    setWidth(500);
    localStorage.removeItem(DIAG_KEY);
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();
    expect(collapsed()).toBe(false); // Visual
    ctl.selectCenter('technical');
    expect(collapsed()).toBe(false); // Code
    ctl.dispose();
  });

  test('an explicit expanded preference wins over the narrow Documentation default', () => {
    setWidth(500);
    localStorage.setItem(DIAG_KEY, '0'); // user deliberately chose expanded (chevron wrote '0')
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();
    ctl.selectDocsTab('glossary');
    expect(collapsed()).toBe(false); // the user's choice wins, not the narrow default
    ctl.dispose();
  });

  test('an explicit collapsed preference still applies on narrow Visual (user wins both ways)', () => {
    setWidth(500);
    localStorage.setItem(DIAG_KEY, '1'); // user deliberately collapsed everywhere
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init(); // Visual — would be expanded by default, but the preference collapses it
    expect(collapsed()).toBe(true);
    ctl.dispose();
  });

  test('desktop + Documentation ⇒ strip keeps the expanded default (unchanged)', () => {
    setWidth(1280);
    localStorage.removeItem(DIAG_KEY);
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();
    ctl.selectDocsTab('glossary');
    expect(collapsed()).toBe(false);
    ctl.dispose();
  });

  test('crossing BP_NARROW live (rotate to portrait) re-evaluates the Documentation default', () => {
    setWidth(1280);
    localStorage.removeItem(DIAG_KEY);
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();
    ctl.selectDocsTab('glossary');
    expect(collapsed()).toBe(false); // wide → expanded

    setWidth(500);
    window.dispatchEvent(new Event('resize'));
    expect(collapsed()).toBe(true); // crossed to narrow on Documentation → collapsed
    ctl.dispose();
  });
});

describe('createInspectorController — right-edge tool-window stripe (#500)', () => {
  const LAYOUT_KEY = 'koine.studio.layout';
  const splitEl = () => el('split');

  beforeEach(() => localStorage.removeItem(LAYOUT_KEY));

  test('boots collapsed from persisted layout: #split has right-collapsed, no button pressed', () => {
    saveLayout({ rightCollapsed: true });
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();
    expect(splitEl().classList.contains('right-collapsed')).toBe(true);
    for (const v of ['props', 'rules', 'notes', 'source-control']) {
      expect(stripBtn(v).getAttribute('aria-pressed')).toBe('false');
    }
    ctl.dispose();
  });

  test('clicking a stripe icon while collapsed expands to that view and presses its button', () => {
    saveLayout({ rightCollapsed: true });
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();
    expect(splitEl().classList.contains('right-collapsed')).toBe(true);

    stripBtn('props').click();
    expect(splitEl().classList.contains('right-collapsed')).toBe(false);
    expect(deps.store.getState().rightCollapsed).toBe(false);
    expect(deps.store.getState().right).toBe('props');
    expect(stripBtn('props').getAttribute('aria-pressed')).toBe('true');
    ctl.dispose();
  });

  test("clicking the active view's icon again collapses and persists the flag", () => {
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();
    // Open on Properties (default) — clicking Properties collapses.
    expect(deps.store.getState().right).toBe('props');
    stripBtn('props').click();
    expect(splitEl().classList.contains('right-collapsed')).toBe(true);
    expect(deps.store.getState().rightCollapsed).toBe(true);
    expect(loadLayout().rightCollapsed).toBe(true);
    ctl.dispose();
  });

  test('clicking a different view while open switches the view without collapsing', () => {
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();
    expect(deps.store.getState().right).toBe('props');

    stripBtn('notes').click();
    expect(splitEl().classList.contains('right-collapsed')).toBe(false);
    expect(deps.store.getState().right).toBe('notes');
    expect(stripBtn('notes').getAttribute('aria-pressed')).toBe('true');
    expect(stripBtn('props').getAttribute('aria-pressed')).toBe('false');
    ctl.dispose();
  });
});

describe('createInspectorController — split center layout', () => {
  test('a 2-pane layout renders two .center-split-pane elements in #center-body', async () => {
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();

    deps.store.getState().splitCenter('row');
    await waitFor(() => {
      const panes = document.querySelectorAll('.center-split-pane');
      expect(panes.length).toBe(2);
    });

    ctl.dispose();
  });

  test('each pane has a .center-pane-header with view selector buttons', async () => {
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();

    deps.store.getState().splitCenter('row');
    await waitFor(() => {
      const panes = document.querySelectorAll('.center-split-pane');
      expect(panes.length).toBe(2);
    });

    const headers = document.querySelectorAll('.center-pane-header');
    expect(headers.length).toBe(2);
    // Each header should have view selector tabs
    for (const header of Array.from(headers)) {
      const tabs = header.querySelectorAll('.center-pane-tab');
      expect(tabs.length).toBe(4); // visual, technical, output, docs (AI is in the right rail)
    }

    ctl.dispose();
  });

  test('clicking a view-selector button in pane B calls setPaneView (check via store state)', async () => {
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();

    deps.store.getState().splitCenter('row');
    await waitFor(() => {
      const panes = document.querySelectorAll('.center-split-pane');
      expect(panes.length).toBe(2);
    });

    // Get pane B (second pane)
    const panes = document.querySelectorAll<HTMLElement>('.center-split-pane');
    const paneB = panes[1];
    const paneBId = paneB.dataset.paneId!;

    // Click the "Code" tab button in pane B
    const codeTabs = paneB.querySelectorAll<HTMLButtonElement>('.center-pane-tab');
    const codeTab = Array.from(codeTabs).find((b) => b.textContent === 'Code')!;
    codeTab.click();
    await waitFor(() => {
      const layout = deps.store.getState().centerLayout;
      const pane = layout.panes.find((p) => p.id === paneBId)!;
      expect(pane.view).toBe('technical');
    });

    ctl.dispose();
  });

  test('clicking pane B makes pane B focused (sets focusedPaneId, adds is-focused class)', async () => {
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();

    deps.store.getState().splitCenter('row');
    await waitFor(() => {
      const panes = document.querySelectorAll('.center-split-pane');
      expect(panes.length).toBe(2);
    });

    const panes = document.querySelectorAll<HTMLElement>('.center-split-pane');
    const paneB = panes[1];
    const paneBId = paneB.dataset.paneId!;

    // Click the pane B element itself (not a button within it)
    paneB.click();
    await waitFor(() => {
      expect(deps.store.getState().centerLayout.focusedPaneId).toBe(paneBId);
    });

    // The is-focused class should be on pane B
    expect(paneB.classList.contains('is-focused')).toBe(true);
    // Pane A should not have the class
    expect(panes[0].classList.contains('is-focused')).toBe(false);

    ctl.dispose();
  });

  test('reverting to single-pane removes the pane slots', async () => {
    const { DEFAULT_CENTER_LAYOUT } = await import('@/store/slices/uiChrome');
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();

    // Go to split
    deps.store.getState().splitCenter('row');
    await waitFor(() => {
      const panes = document.querySelectorAll('.center-split-pane');
      expect(panes.length).toBe(2);
    });

    // Revert to single pane
    deps.store.getState().setCenterLayout(DEFAULT_CENTER_LAYOUT);
    await waitFor(() => {
      const panes = document.querySelectorAll('.center-split-pane');
      expect(panes.length).toBe(0);
    });

    ctl.dispose();
  });

  test('a 2-pane layout renders a .center-splitter between the pane slots', async () => {
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();

    deps.store.getState().splitCenter('row');
    await waitFor(() => {
      const panes = document.querySelectorAll('.center-split-pane');
      expect(panes.length).toBe(2);
    });

    const splitters = document.querySelectorAll('.center-splitter');
    expect(splitters.length).toBe(1);

    // Splitter must be between the pane slots in DOM order
    const children = Array.from(el('center-body').children);
    const panes = children.filter((c) => c.classList.contains('center-split-pane'));
    const splitterEls = children.filter((c) => c.classList.contains('center-splitter-host'));
    expect(splitterEls.length).toBe(1);
    // The splitter host must appear between pane[0] and pane[1]
    const idx0 = children.indexOf(panes[0]);
    const idxS = children.indexOf(splitterEls[0]);
    const idx1 = children.indexOf(panes[1]);
    expect(idxS).toBeGreaterThan(idx0);
    expect(idxS).toBeLessThan(idx1);

    ctl.dispose();
  });

  test('arrow key on the splitter calls resizeCenter (store sizes change)', async () => {
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();

    deps.store.getState().splitCenter('row');
    await waitFor(() => {
      const panes = document.querySelectorAll('.center-split-pane');
      expect(panes.length).toBe(2);
    });

    const splitterEl = document.querySelector<HTMLElement>('[role="separator"]')!;
    expect(splitterEl).not.toBeNull();

    const sizesBefore = [...deps.store.getState().centerLayout.sizes];

    // Fire ArrowRight on the splitter (row orientation → nudge pane[0] wider)
    splitterEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    await waitFor(() => {
      const sizesAfter = deps.store.getState().centerLayout.sizes;
      expect(sizesAfter[0]).not.toBe(sizesBefore[0]);
    });

    ctl.dispose();
  });

  test('the splitter has required aria attributes (role, aria-orientation, aria-valuenow, aria-valuemin, aria-valuemax)', async () => {
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();

    deps.store.getState().splitCenter('row');
    await waitFor(() => {
      const panes = document.querySelectorAll('.center-split-pane');
      expect(panes.length).toBe(2);
    });

    const splitterEl = document.querySelector<HTMLElement>('[role="separator"]')!;
    expect(splitterEl).not.toBeNull();
    expect(splitterEl.getAttribute('aria-orientation')).toBe('vertical'); // row layout → vertical separator
    expect(splitterEl.getAttribute('aria-valuenow')).not.toBeNull();
    expect(splitterEl.getAttribute('aria-valuemin')).not.toBeNull();
    expect(splitterEl.getAttribute('aria-valuemax')).not.toBeNull();
    expect(splitterEl.tabIndex).toBe(0);

    ctl.dispose();
  });

  test('vitest-axe: a 2-pane center layout has no accessibility violations', async () => {
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();

    deps.store.getState().splitCenter('row');
    await waitFor(() => {
      const panes = document.querySelectorAll('.center-split-pane');
      expect(panes.length).toBe(2);
    });

    const centerBody = el('center-body');
    expect(await axe(centerBody)).toHaveNoViolations();

    ctl.dispose();
  });

  // --- Task 5: split/reset controls in the center tab bar ---

  test('init() creates #center-split-controls inside #center-tabs', () => {
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();

    const host = document.getElementById('center-split-controls');
    expect(host).not.toBeNull();
    expect(el('center-tabs').contains(host)).toBe(true);

    ctl.dispose();
  });

  test('"Code ⟷ Canvas" preset button lays out a 2-pane Code|Canvas row', async () => {
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();

    const btn = document.querySelector<HTMLButtonElement>(
      '[aria-label="Split center into Code and Canvas side by side"]',
    );
    expect(btn).not.toBeNull();

    btn!.click();
    await waitFor(() => {
      const { centerLayout } = deps.store.getState();
      expect(centerLayout.panes.map((p) => p.view)).toEqual(['technical', 'visual']);
      expect(centerLayout.orientation).toBe('row');
    });

    ctl.dispose();
  });

  test('controller.splitCodeCanvas() applies the same preset (palette entry point)', async () => {
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();

    ctl.splitCodeCanvas();
    await waitFor(() => {
      expect(deps.store.getState().centerLayout.panes.map((p) => p.view)).toEqual(['technical', 'visual']);
    });

    ctl.dispose();
  });

  test('"Split →" button has aria-label "Split center pane right" and clicking it calls splitCenter("row")', async () => {
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();

    const btn = document.querySelector<HTMLButtonElement>('[aria-label="Split center pane right"]');
    expect(btn).not.toBeNull();

    btn!.click();
    await waitFor(() => {
      expect(deps.store.getState().centerLayout.panes.length).toBe(2);
      expect(deps.store.getState().centerLayout.orientation).toBe('row');
    });

    ctl.dispose();
  });

  test('"Split ↓" button has aria-label "Split center pane down" and clicking it calls splitCenter("column")', async () => {
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();

    const btn = document.querySelector<HTMLButtonElement>('[aria-label="Split center pane down"]');
    expect(btn).not.toBeNull();

    btn!.click();
    await waitFor(() => {
      expect(deps.store.getState().centerLayout.panes.length).toBe(2);
      expect(deps.store.getState().centerLayout.orientation).toBe('column');
    });

    ctl.dispose();
  });

  test('Reset button is absent in single-pane mode', () => {
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();

    const btn = document.querySelector<HTMLButtonElement>('[aria-label="Reset center to single pane"]');
    expect(btn).toBeNull();

    ctl.dispose();
  });

  test('Reset button appears when 2+ panes; clicking it resets to DEFAULT_CENTER_LAYOUT', async () => {
    const { DEFAULT_CENTER_LAYOUT } = await import('@/store/slices/uiChrome');
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();

    // Split first so the Reset button appears.
    deps.store.getState().splitCenter('row');
    await waitFor(() => {
      const btn = document.querySelector<HTMLButtonElement>('[aria-label="Reset center to single pane"]');
      expect(btn).not.toBeNull();
    });

    const resetBtn = document.querySelector<HTMLButtonElement>('[aria-label="Reset center to single pane"]')!;
    resetBtn.click();

    await waitFor(() => {
      expect(deps.store.getState().centerLayout.panes.length).toBe(1);
      expect(deps.store.getState().centerLayout).toEqual(DEFAULT_CENTER_LAYOUT);
    });

    // Reset button must disappear again.
    await waitFor(() => {
      expect(document.querySelector('[aria-label="Reset center to single pane"]')).toBeNull();
    });

    ctl.dispose();
  });
});
