// Tests for the inspectorController — the mode / center-tab / view subsystem extracted from ide.ts's
// init() (Task 4 of the ide.ts decomposition). This file is the PRIMARY behavioral net for this
// subsystem: ide.test.ts does not exercise view switching / lazy-loading / debounce, so the
// stale-token + lazy-load-once + debounce contracts are pinned here.
//
// We drive the real controller with a small seeded DOM (the same id surface init() builds, lifted from
// ide.test.ts's APP_HTML so a drift throws via domById()) and a spied `lsp` content stub. happy-dom renders
// the real panel DOM; fake timers cover the 350ms edit/bottom debounce.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { waitFor } from '@testing-library/preact';
import {
  createInspectorController,
  type InspectorAssistant,
  type InspectorControllerDeps,
  type InspectorControllerLsp,
} from '@/shell/inspectorController';
import { createElement, render } from 'preact';
import { LeftRail, RightStrip } from '@atypical/koine-ui';
import { loadLayout, saveLayout } from '@/shell/layoutStore';
import { createAppStore } from '@/store/index';
import { createCountingStore } from '@/store/testing';
import { ALL_CONTEXTS } from '@/model/activeContext';
import { domById } from '@/shared/domById';
import * as maxgraphRenderer from '@/diagrams/diagrams-maxgraph';
import type { ContextMapGraphHooks } from '@/diagrams/diagrams-maxgraph';
import * as diagramsModule from '@/diagrams/diagrams';
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
  SyntaxTreeNode,
} from '@/lsp/lsp';

// --- DOM seed ----------------------------------------------------------------
// The center / docs / bottom-strip / right-rail / left-rail / context-switcher subset of index.html the
// controller looks up via domById(...). Kept equivalent to ide.test.ts's APP_HTML.
const APP_HTML = `
  <div id="app">
    <main id="split">
      <aside id="leftrail" class="pane"></aside>
      <section id="center" class="pane">
        <div id="deck-bar"></div>
        <div id="center-body">
          <section id="center-visual" class="center-host">
            <div id="canvas-palette-host"></div>
            <div id="diagram-host"></div>
          </section>
          <section id="center-technical" class="center-host" hidden>
            <div id="tech-body">
              <section id="editor-pane" class="tech-view"></section>
              <div id="view-scenarios" class="tech-view" hidden></div>
            </div>
          </section>
          <section id="center-output" class="center-host" hidden>
            <div id="output-body">
              <div id="view-preview" class="tech-view"></div>
              <div id="view-check" class="tech-view doc-view" hidden></div>
              <div id="panel-contextmap" class="tech-view doc-view" hidden></div>
            </div>
          </section>
          <section id="center-docs" class="center-host" hidden>
            <div id="docs-body">
              <div id="view-glossary" class="tech-view doc-view"></div>
              <div id="view-docs" class="tech-view doc-view" hidden></div>
              <div id="view-notes" class="tech-view doc-view" hidden></div>
            </div>
          </section>
        </div>
        <section id="center-panel-settings" class="settings-page" role="dialog" aria-modal="true" aria-label="Settings" hidden>
          <header id="settings-page-header"><h2 class="settings-page-title">Settings</h2><div class="settings-page-header-controls"><div id="settings-scope-toggle"></div><div id="settings-mode-toggle"></div></div></header>
          <div id="settings-page-body"></div>
        </section>
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
          <div id="rview-source-control" class="rview doc-view" role="tabpanel" hidden></div>
          <div id="rview-syntax-tree" class="rview doc-view" role="tabpanel" hidden></div>
        </div>
      </aside>
      <div id="right-strip" class="pane" role="toolbar" aria-label="Tool windows" aria-orientation="vertical"></div>
    </main>
    <footer id="statusbar"><button type="button" class="sb-seg sb-ctx" id="sb-context" aria-haspopup="menu" aria-expanded="false">Context: —</button></footer>
  </div>`;

function seedDom(): void {
  document.body.innerHTML = APP_HTML;
  // The left rail + right-strip buttons are Preact components now (#759, were leftRailMarkup /
  // rightStripMarkup): render them into their thin shells so the controller's rail/`.rstrip-btn` lookups +
  // wiring resolve, as the boot does.
  render(createElement(LeftRail, null), document.getElementById('leftrail')!);
  render(createElement(RightStrip, null), document.getElementById('right-strip')!);
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

// A minimal two-level syntax tree (root + one context child), so the SyntaxTreePanel renders a non-empty
// tree rather than its empty state, and the panel's fetch is observable via the spy's call count.
function syntaxTreeFixture(): SyntaxTreeNode {
  const zeroSpan = { line: 0, column: 0, endLine: 0, endColumn: 0, offset: 0, length: 0, file: null };
  return {
    kind: 'KoineModel',
    name: null,
    span: zeroSpan,
    isMissing: false,
    isError: false,
    leaf: null,
    children: [
      {
        kind: 'ContextNode',
        name: 'Billing',
        span: { line: 1, column: 1, endLine: 3, endColumn: 1, offset: 0, length: 20, file: 'file:///work/model.koi' },
        isMissing: false,
        isError: false,
        leaf: null,
        children: [],
      },
    ],
  };
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
    syntaxTree: vi.fn(async (): Promise<SyntaxTreeNode | null> => syntaxTreeFixture()),
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
    scopeFiles: vi.fn(),
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

// In the deck, the visibility unit is the card (the .ghost class), not the host's `hidden` attribute
// (every host is un-hidden once it's re-parented into its card). A surface is "shown" when its card is
// mounted and not a ghost.
function shownCenter(id: string): boolean {
  const card = document.querySelector<HTMLElement>(`#center-body [data-surface="${id}"]`);
  return !!card && !card.classList.contains('ghost');
}

describe('createInspectorController — center switching', () => {
  test('init() boots Visual (default) → the visual surface is shown, the others ghosted', async () => {
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();

    await waitFor(() => expect(shownCenter('visual')).toBe(true));
    expect(shownCenter('technical')).toBe(false);
    expect(shownCenter('docs')).toBe(false);
    ctl.dispose();
  });

  test('the bottom panel is visible in every center view (#451)', () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init(); // boots Visual

    expect(domById('diagnostics').hidden).toBe(false); // Visual
    ctl.selectCenter('technical');
    expect(domById('diagnostics').hidden).toBe(false); // Code
    ctl.selectDocsTab('glossary'); // brings up Docs
    expect(domById('diagnostics').hidden).toBe(false); // Documentation
    ctl.dispose();
  });

  test('selectCenter("technical") focuses the Code surface on the editor sub-view', async () => {
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();

    ctl.selectCenter('technical');

    expect(deps.store.getState().deck.primary).toBe('technical');
    await waitFor(() => expect(shownCenter('technical')).toBe(true));
    expect(shownCenter('visual')).toBe(false);
    expect(domById('editor-pane').hidden).toBe(false); // the technical surface lands on the editor facet
    ctl.dispose();
  });

  test('selectCenter("docs") focuses the Documentation surface on the Glossary sub-view', async () => {
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();

    ctl.selectCenter('docs');

    expect(deps.store.getState().deck.primary).toBe('docs');
    await waitFor(() => expect(shownCenter('docs')).toBe(true));
    expect(domById('view-glossary').hidden).toBe(false);
    expect(domById('view-docs').hidden).toBe(true);
    ctl.dispose();
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
    ctl.dispose();
  });

  test('opening the transient Settings overlay never persists center (it is not a deck surface) (#482)', () => {
    const saveWorkspaceCenter = vi.fn();
    const ctl = createInspectorController(makeDeps(makeLsp(), { saveWorkspaceCenter }));
    ctl.init();

    ctl.selectCenter('technical'); // a real surface IS persisted as the center
    expect(saveWorkspaceCenter).toHaveBeenLastCalledWith('technical');
    saveWorkspaceCenter.mockClear();
    // The gear-launched Settings overlay rides the orthogonal `settingsOpen` flag, NOT `center` — so it
    // must not overwrite the persisted 'technical'; a reload restores Code, not the default.
    ctl.showSettings();
    expect(saveWorkspaceCenter).not.toHaveBeenCalled();
  });

  test('the Settings overlay covers the deck body and reveals the panel; focusing a surface restores it (#482)', () => {
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();
    const body = domById('center-body');
    const panel = domById('center-panel-settings');
    // Resting: deck body shown, Settings overlay hidden.
    expect(panel.hidden).toBe(true);
    expect(body.hidden).toBe(false);
    // Gear → showSettings: the overlay covers the deck body.
    ctl.showSettings();
    expect(panel.hidden).toBe(false);
    expect(body.hidden).toBe(true);
    // Focusing any deck surface (the deck-bar) leaves Settings and restores the deck.
    ctl.selectCenter('docs');
    expect(panel.hidden).toBe(true);
    expect(body.hidden).toBe(false);
  });

  test('opening Settings does not touch the persisted deck (Settings is orthogonal to the deck) (#482)', () => {
    const saveWorkspaceDeck = vi.fn();
    const deps = makeDeps(makeLsp(), { saveWorkspaceDeck });
    const ctl = createInspectorController(deps);
    ctl.init();

    ctl.selectCenter('technical'); // a real deck change IS persisted
    expect(saveWorkspaceDeck).toHaveBeenCalled();
    saveWorkspaceDeck.mockClear();
    // The overlay leaves the deck untouched, so nothing new is persisted and the deck keeps its surface —
    // the transient view can never leak into the saved deck (no wholesale-rejection-on-restore landmine).
    ctl.showSettings();
    expect(saveWorkspaceDeck).not.toHaveBeenCalled();
    expect(deps.store.getState().deck.primary).toBe('technical');
    expect(deps.store.getState().settingsOpen).toBe(true);
  });

  test('showSettings(category) opens the overlay AND records the landing category (#731)', () => {
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();

    // A deep-linked open (e.g. the About command) lands the overlay on a specific category: the overlay
    // opens AND the requested category is recorded on the store so the pane (mountPreferencesPane) opens
    // on that tab.
    ctl.showSettings('about');
    expect(deps.store.getState().settingsOpen).toBe(true);
    expect(deps.store.getState().settingsCategory).toBe('about');
  });

  test('showSettings() opens the overlay with no forced category (uses the last-used tab) (#731)', () => {
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();

    // First deep-link to a tab, then a plain open: a no-arg open must NOT keep forcing the prior category —
    // it clears the forced category (null) so the pane falls back to its last-used / default tab.
    ctl.showSettings('about');
    ctl.showSettings();
    expect(deps.store.getState().settingsOpen).toBe(true);
    expect(deps.store.getState().settingsCategory).toBeNull();
  });

  test('showSettings(unknown-id) still opens the overlay without throwing (#731)', () => {
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();

    // The controller/store don't validate the id — an unknown category is recorded verbatim and the
    // overlay opens; the pane (prefs.ts refresh) ignores an unmatched id and stays on the default tab, so
    // an unknown deep-link can never throw or wedge the open.
    expect(() => ctl.showSettings('does-not-exist')).not.toThrow();
    expect(deps.store.getState().settingsOpen).toBe(true);
  });

  test('a persisted center restores it on boot (technical)', async () => {
    const deps = makeDeps(makeLsp(), { loadWorkspaceCenter: () => 'technical' });
    const ctl = createInspectorController(deps);
    ctl.init();
    expect(deps.store.getState().deck.primary).toBe('technical');
    await waitFor(() => expect(shownCenter('technical')).toBe(true));
    expect(shownCenter('visual')).toBe(false);
    ctl.dispose();
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
    expect(domById('view-assistant').hidden).toBe(false);
    // The stripe is the sole right-view switcher (#726): the title header names the active tool window.
    expect(domById('right-title').textContent).toBe('AI Chat');
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
    expect(domById('panel-events').hidden).toBe(false);

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
    const panel = domById('panel-contextmap');
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
    const panel = domById('panel-contextmap');

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

    const domainPane = domById('rail-domain-pane');
    const filesPane = domById('rail-files');
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

  // #979: #rail-files is a REQUIRED contract element — ide.tsx renders LeftRail synchronously before any
  // controller exists, so its absence is always a programmer error. Construction must throw loudly (via
  // domById) rather than silently degrade, resolving the former optional/required split-brain with layout.ts.
  test('construction throws `missing #rail-files` when the Files pane is absent', () => {
    document.getElementById('rail-files')!.remove();
    expect(() => createInspectorController(makeDeps(makeLsp()))).toThrow('missing #rail-files');
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
    await waitFor(() => expect(shownCenter('docs')).toBe(true));

    // Drive the REAL strategic Context Map doorway → modelOutlineHandlers.onOpenContextMap →
    // focusContextMap() → selectOutput('contextmap'): the Context Map is the contextmap sub-view of the
    // Output center pane now, so the doorway switches the center to Output and shows the map.
    const doorway = domById('rail-domain-pane').querySelector<HTMLButtonElement>('[data-door="contextmap"]')!;
    doorway.click();
    await flush();

    await waitFor(() => expect(shownCenter('output')).toBe(true)); // switched to the Output surface…
    expect(shownCenter('docs')).toBe(false); // …left Documentation…
    expect(domById('panel-contextmap').hidden).toBe(false); // …showing the Context Map.
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
    (domById('rail-domain-pane').querySelector('[data-ctx="Billing"]') as HTMLButtonElement).click();
    await flush();

    // Selecting the Money leaf resolves through nodeContext/resolveInspectableQn and jumps to source.
    const leaf = domById('rail-domain-pane').querySelector<HTMLButtonElement>('.koi-tactical-leaf[data-name="Money"]')!;
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
    const domainPane = domById('rail-domain-pane');
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

    const glossary = domById('view-glossary');
    expect(glossary.textContent).toContain('Money'); // the glossary rendered
    expect(glossary.textContent).not.toContain('Loading glossary');
  });

  test('the Events panel replaces its "Loading events…" line on success', async () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();

    ctl.selectBottomTab('events');
    await flush();

    expect(domById('panel-events').textContent).not.toContain('Loading events');
  });

  test('the Relationships panel replaces its "Loading relationships…" line on success', async () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();

    ctl.selectBottomTab('relationships');
    await flush();

    expect(domById('panel-relationships').textContent).not.toContain('Loading relationships');
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
    const host = domById('inspector-host');
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
    expect(domById('right-title').textContent).toBe('Source Control');

    // Selecting an element (canvas / Domain navigator) must bring the user back to Properties.
    ctl.selection.set({ qualifiedName: 'Billing.Money', context: 'Billing' });

    expect(deps.store.getState().right).toBe('props');
    expect(stripBtn('props').getAttribute('aria-pressed')).toBe('true');
    expect(stripBtn('source-control').getAttribute('aria-pressed')).toBe('false');
    expect(domById('right-title').textContent).toBe('Properties');
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
  test('refreshContextList mirrors the model contexts into the store (scope options)', async () => {
    const lsp = makeLsp();
    const deps = makeDeps(lsp);
    const ctl = createInspectorController(deps);
    ctl.init();

    await ctl.refreshContextList();

    // Chrome v2 (#923) removed the top-bar breadcrumb <select>; the scope options now live in the store
    // (read by the left Domain navigator + the construct palette). "All contexts" is the implicit
    // unscoped sentinel, so only the real model context is listed.
    expect(deps.store.getState().contexts).toEqual(['Billing']);
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

  test('a scope change fans out to the Files tree via scopeFiles (context, then null for All) — ADR 0009', async () => {
    const lsp = makeLsp();
    const deps = makeDeps(lsp);
    const ctl = createInspectorController(deps);
    ctl.init();
    await ctl.refreshContextList();

    // Picking a context emphasises its `.koi` in the Files tree; the fan-out passes the bare name.
    vi.mocked(deps.scopeFiles).mockClear();
    deps.store.getState().setActiveContext('Billing');
    expect(deps.scopeFiles).toHaveBeenLastCalledWith('Billing');

    // Returning to "All contexts" clears the emphasis (null), never hiding anything.
    deps.store.getState().setActiveContext(ALL_CONTEXTS);
    expect(deps.scopeFiles).toHaveBeenLastCalledWith(null);
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
    expect(domById('sb-context').textContent).toBe('Context: All contexts');
    const diagramsBefore = lsp.livingDocs.mock.calls.length;

    // Simulate the Domain-navigator drill: write the slice DIRECTLY (NOT via the dropdown / applyScope),
    // exactly as domainNavigator.ts's onOpenContext does.
    deps.store.getState().setActiveContext('Billing');
    await flush();

    // (a) the status bar mirrors the drilled context…
    expect(domById('sb-context').textContent).toBe('Context: Billing');
    // (b) …and the scoped-surface re-filter ran — the Visual canvas re-fetched its (now-scoped) diagrams.
    expect(lsp.livingDocs.mock.calls.length).toBeGreaterThan(diagramsBefore);
  });
});

describe('createInspectorController — the status-bar Context segment is a scope picker (#146)', () => {
  // The #sb-context segment is the CANONICAL scope control (PR #1180 removed the top-bar breadcrumb
  // <select>; #923 left only this readout). Clicking it opens a createFloatingMenu (mounted on
  // document.body) listing the model's contexts + "All contexts"; picking one routes through the SAME
  // persist=true choke point (setActiveContext) the Domain-navigator drill uses, so an explicit pick
  // scopes every surface AND survives a reload.
  const scopeMenu = () => document.querySelector<HTMLElement>('.koi-scope-menu');
  const menuItems = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('.koi-scope-menu [role="menuitem"]'));
  const clickContextSegment = () =>
    domById('sb-context').dispatchEvent(new MouseEvent('click', { bubbles: true }));

  // A two-context glossary model (Billing + Shipping), so the picker lists more than one real context.
  function twoContextGlossary(): GlossaryModel {
    return {
      entries: [
        glossaryFixture().entries[0], // the Billing context header
        {
          id: 'Shipping',
          name: 'Shipping',
          kind: 'context',
          context: 'Shipping',
          qualifiedName: 'Shipping',
          doc: null,
          nameRange: { start: { line: 0, character: 8 }, end: { line: 0, character: 16 } },
        },
      ],
    };
  }

  test('clicking the segment opens a menu listing the contexts + "All contexts", marking the active one', async () => {
    const lsp = makeLsp();
    lsp.glossaryModel.mockResolvedValue(twoContextGlossary());
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();
    await ctl.refreshContextList(); // learn the model's contexts (Billing, Shipping)
    await flush();

    expect(scopeMenu()).toBeNull(); // closed until clicked
    clickContextSegment();

    expect(scopeMenu()).not.toBeNull();
    // "All contexts" heads the list (the boot default scope, so it carries the ✓ marker), then each
    // model context in order.
    expect(menuItems().map((i) => i.textContent)).toEqual(['✓ All contexts', 'Billing', 'Shipping']);
    // The engine flips the trigger's aria-expanded while the menu is open.
    expect(domById('sb-context').getAttribute('aria-expanded')).toBe('true');
    ctl.dispose();
  });

  test('the ✓ marker follows the active scope (a drilled context, not "All contexts")', async () => {
    const lsp = makeLsp();
    const deps = makeDeps(lsp);
    const ctl = createInspectorController(deps);
    ctl.init();
    await ctl.refreshContextList(); // contexts = [Billing]
    deps.store.getState().setActiveContext('Billing'); // drill into Billing (the navigator's write)
    await flush();

    clickContextSegment();
    expect(menuItems().map((i) => i.textContent)).toEqual(['All contexts', '✓ Billing']);
    ctl.dispose();
  });

  test('selecting a context sets the scope through the persist=true choke point, updates the readout, and dismisses', async () => {
    const lsp = makeLsp();
    const deps = makeDeps(lsp);
    const ctl = createInspectorController(deps);
    ctl.init();
    await ctl.refreshContextList();
    await flush();

    clickContextSegment();
    menuItems().find((i) => i.textContent === 'Billing')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    // The store slice now scopes to Billing…
    expect(deps.store.getState().activeContext).toBe('Billing');
    // …and the pick PERSISTED (an explicit user choice), keyed by the workspace ('scratch' with no folder).
    expect(deps.saveActiveContext).toHaveBeenCalledWith('scratch', 'Billing');
    // The status-bar readout mirrors it (via the activeContext subscription) and the menu dismissed.
    expect(domById('sb-context').textContent).toBe('Context: Billing');
    expect(scopeMenu()).toBeNull();
    ctl.dispose();
  });

  test('selecting "All contexts" resets the scope to the unscoped sentinel', async () => {
    const lsp = makeLsp();
    const deps = makeDeps(lsp);
    const ctl = createInspectorController(deps);
    ctl.init();
    await ctl.refreshContextList();
    deps.store.getState().setActiveContext('Billing');
    await flush();

    clickContextSegment();
    menuItems().find((i) => i.textContent === 'All contexts')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();

    expect(deps.store.getState().activeContext).toBe(ALL_CONTEXTS);
    expect(deps.saveActiveContext).toHaveBeenCalledWith('scratch', ALL_CONTEXTS);
    ctl.dispose();
  });

  test('dispose() closes an open scope menu so no orphan survives teardown', async () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();
    await ctl.refreshContextList();
    await flush();

    clickContextSegment();
    expect(scopeMenu()).not.toBeNull();

    ctl.dispose();
    expect(scopeMenu()).toBeNull();
  });
});

describe('createInspectorController — deck 2-up SECONDARY panes refresh on scope / theme / emit-target changes', () => {
  // Regression: three refresh paths gated on the deck PRIMARY only (activeCenter()), so a surface
  // visible as the SECONDARY pane of a 2-up (the blessed Code ⟷ Canvas preset) was marked stale but
  // never reloaded — the visible canvas kept the previous scope/theme, the visible Generated pane the
  // previous language, until an unrelated deck/facet change.
  const codeCanvas2Up = { mode: 'focus', primary: 'technical', secondary: 'visual', ratio: 0.5, flipped: false } as const;

  test('a scope change re-filters a canvas visible as the SECONDARY pane', async () => {
    const lsp = makeLsp();
    const deps = makeDeps(lsp);
    const ctl = createInspectorController(deps);
    ctl.init(); // boots Visual primary — the diagrams load once
    await flush();

    deps.store.getState().setDeck(codeCanvas2Up); // Code primary, Canvas still visible as secondary
    await flush();
    const diagramsBefore = lsp.livingDocs.mock.calls.length;

    deps.store.getState().setActiveContext('Billing'); // the Domain-navigator drill
    await flush();

    expect(lsp.livingDocs.mock.calls.length).toBeGreaterThan(diagramsBefore);
    ctl.dispose();
  });

  test('a theme flip re-renders a canvas visible as the SECONDARY pane', async () => {
    const lsp = makeLsp();
    const deps = makeDeps(lsp);
    const ctl = createInspectorController(deps);
    ctl.init();
    await flush();

    deps.store.getState().setDeck(codeCanvas2Up);
    await flush();
    const diagramsBefore = lsp.livingDocs.mock.calls.length;

    ctl.onThemeChanged();
    await flush();

    expect(lsp.livingDocs.mock.calls.length).toBeGreaterThan(diagramsBefore);
    ctl.dispose();
  });

  test('an emit-target change re-emits a Generated pane visible as the SECONDARY pane', async () => {
    const lsp = makeLsp();
    const deps = makeDeps(lsp);
    const ctl = createInspectorController(deps);
    ctl.init();
    await flush();

    deps.store.getState().setDeck({ ...codeCanvas2Up, secondary: 'output' }); // Code + Generated 2-up
    await flush();
    const previewBefore = lsp.emitPreview.mock.calls.length;
    expect(previewBefore).toBeGreaterThanOrEqual(1); // the newly-visible Output pane loaded on show

    ctl.onPreviewTargetChanged('typescript');
    await flush();

    expect(lsp.emitPreview.mock.calls.length).toBeGreaterThan(previewBefore);
    expect(lsp.emitPreview).toHaveBeenLastCalledWith('typescript');
    ctl.dispose();
  });
});

describe('createInspectorController — locked-down storage', () => {
  // Regression: the DIAG_COLLAPSED boot read was the one unguarded localStorage access in the
  // construction path — in a host where touching storage throws (Chromium with site data blocked) it
  // threw out of the factory and aborted the whole IDE boot, while every sibling read degrades.
  test('construction survives a throwing localStorage and defaults the bottom strip to expanded', () => {
    const spy = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: storage is disabled');
    });
    try {
      let ctl: ReturnType<typeof createInspectorController> | undefined;
      expect(() => {
        ctl = createInspectorController(makeDeps(makeLsp()));
      }).not.toThrow();
      expect(domById('diagnostics').classList.contains('collapsed')).toBe(false); // the '0' default
      ctl?.dispose();
    } finally {
      spy.mockRestore();
    }
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
      gitRevert: vi.fn(async () => {}),
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

// Real timers + waitFor throughout: the SyntaxTreePanel fetches in its own useEffect (a rAF/macrotask
// under happy-dom, like the SourceControl panel), so assertions poll rather than flushing a microtask.
describe('createInspectorController — Syntax Tree right view (#890)', () => {
  test('selecting the Syntax Tree stripe mounts the panel, titles it, and hides the other rviews', async () => {
    const lsp = makeLsp();
    const deps = makeDeps(lsp);
    const ctl = createInspectorController(deps);
    ctl.init();

    // Click the Syntax Tree stripe icon (the user path: stripe click → selectRightView → loadSyntaxTree).
    stripBtn('syntax-tree').click();
    expect(deps.store.getState().right).toBe('syntax-tree');
    expect(stripBtn('syntax-tree').getAttribute('aria-pressed')).toBe('true');
    expect(domById('right-title').textContent).toBe('Syntax Tree');

    // The panel owns its own fetch: it pulls the tree and renders the WAI-ARIA tree into #rview-syntax-tree.
    await waitFor(() => expect(lsp.syntaxTree.mock.calls.length).toBeGreaterThanOrEqual(1));
    const host = domById('rview-syntax-tree');
    await waitFor(() => expect(host.querySelector('[role="tree"]')).not.toBeNull());
    expect(host.hidden).toBe(false);

    // The other right views are hidden while Syntax Tree is active.
    expect(domById('inspector-host').hidden).toBe(true);
    expect(domById('view-assistant').hidden).toBe(true);
    expect(domById('rview-source-control').hidden).toBe(true);
    ctl.dispose();
  });

  test('a doc edit while the Syntax Tree view is active refetches the tree (debounced)', async () => {
    const lsp = makeLsp();
    const deps = makeDeps(lsp);
    const ctl = createInspectorController(deps);
    ctl.init();

    stripBtn('syntax-tree').click();
    await waitFor(() => expect(lsp.syntaxTree.mock.calls.length).toBeGreaterThanOrEqual(1));
    const afterOpen = lsp.syntaxTree.mock.calls.length;

    // An edit invalidates every model-derived surface (incl. the 'syntax-tree' docViews key) and, after the
    // 350ms debounce, refreshActiveSurfaces reloads the active right view — bumping the panel's revision,
    // which drives the panel's own re-fetch.
    ctl.onDocEdited();
    await waitFor(() => expect(lsp.syntaxTree.mock.calls.length).toBeGreaterThan(afterOpen), { timeout: 2000 });
    ctl.dispose();
  });

  test('a doc edit while Syntax Tree is NOT the active view does not refetch it', async () => {
    const lsp = makeLsp();
    const deps = makeDeps(lsp);
    const ctl = createInspectorController(deps);
    ctl.init(); // boots with Properties as the active right view

    ctl.onDocEdited();
    await new Promise((r) => setTimeout(r, 450)); // past the 350ms debounce — give an (erroneous) fetch time to fire
    expect(lsp.syntaxTree).not.toHaveBeenCalled();
    ctl.dispose();
  });

  test('clicking a node jumps the editor to its span; the zero-span root is a no-op (#890)', async () => {
    const lsp = makeLsp();
    const deps = makeDeps(lsp);
    const ctl = createInspectorController(deps);
    ctl.init();

    stripBtn('syntax-tree').click();
    const host = domById('rview-syntax-tree');
    // Wait for the panel to mount its tree, then click the Billing context row (a leaf in this fixture).
    const ctxRow = await waitFor(() => {
      const el = host.querySelector<HTMLElement>('[role="treeitem"][aria-label*="ContextNode Billing"]');
      expect(el).not.toBeNull();
      return el!;
    });
    ctxRow.click();
    // Tree → editor: the node's raw span is handed to the shared jump-to-source path.
    expect(deps.gotoSourceSpan).toHaveBeenCalledWith(
      expect.objectContaining({ file: 'file:///work/model.koi', line: 1, column: 1, endLine: 3, endColumn: 1 }),
    );

    // The KoineModel root carries an all-zero span (line 0): clicking it must never jump to 0:0.
    vi.mocked(deps.gotoSourceSpan).mockClear();
    host.querySelector<HTMLElement>('[role="treeitem"][aria-label*="KoineModel"]')!.click();
    expect(deps.gotoSourceSpan).not.toHaveBeenCalled();
    ctl.dispose();
  });

  test('a caret move while the Syntax Tree view is active highlights the deepest containing node (#890)', async () => {
    const lsp = makeLsp();
    const deps = makeDeps(lsp);
    const ctl = createInspectorController(deps);
    ctl.init();

    stripBtn('syntax-tree').click();
    const host = domById('rview-syntax-tree');
    await waitFor(() => expect(host.querySelector('[role="tree"]')).not.toBeNull());

    // The editor publishes a caret inside Billing's span (lines 1–3) via the store's cursor slice.
    deps.store.getState().setCursor(2, 1);

    // Debounced (~120ms): the controller re-renders the panel with the new caret, which marks the deepest
    // containing node (the Billing context — the root is span-less) as current.
    await waitFor(
      () => {
        const current = host.querySelector('.koi-stree-item--current');
        expect(current?.getAttribute('aria-label')).toMatch(/ContextNode Billing/);
      },
      { timeout: 2000 },
    );
    ctl.dispose();
  });

  test('a caret move while Syntax Tree is NOT the active view is a no-op (#890)', async () => {
    const lsp = makeLsp();
    const deps = makeDeps(lsp);
    const ctl = createInspectorController(deps);
    ctl.init(); // Properties is the active right view; the Syntax Tree panel is never mounted

    deps.store.getState().setCursor(2, 1);
    await new Promise((r) => setTimeout(r, 200)); // past the 120ms caret debounce
    // The panel was never mounted/rendered, so no tree (and no highlight) exists in its host.
    expect(domById('rview-syntax-tree').querySelector('[role="tree"]')).toBeNull();
    expect(lsp.syntaxTree).not.toHaveBeenCalled();
    ctl.dispose();
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
    const btn = domById('canvas-palette-host').querySelector<HTMLButtonElement>('[data-kind="entity"]')!;
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(onAddConstruct).toHaveBeenCalledWith('entity');
  });

  test('palette construct buttons are disabled under "All contexts"', () => {
    const deps = makeDeps(makeLsp()); // createAppStore() defaults to ALL_CONTEXTS
    createInspectorController(deps);
    const btn = domById('canvas-palette-host').querySelector<HTMLButtonElement>('[data-kind="entity"]')!;
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
  const collapsed = () => domById('diagnostics').classList.contains('collapsed');

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
    expect(domById('diagnostics').hidden).toBe(false); // GLOBAL per #458 — only collapsed, never hidden
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
  const splitEl = () => domById('split');

  beforeEach(() => localStorage.removeItem(LAYOUT_KEY));

  test('boots collapsed from persisted layout: #split has right-collapsed, no button pressed', () => {
    saveLayout({ rightCollapsed: true });
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();
    expect(splitEl().classList.contains('right-collapsed')).toBe(true);
    for (const v of ['props', 'assistant', 'source-control', 'syntax-tree']) {
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
    // Start expanded explicitly (the persisted default is now collapsed, #730) so this exercises the
    // open → click-active → collapse transition.
    saveLayout({ rightCollapsed: false });
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
    // Start expanded explicitly (the persisted default is now collapsed, #730) so this exercises a
    // view-to-view switch on an already-open rail rather than an expand-from-collapsed.
    saveLayout({ rightCollapsed: false });
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();
    expect(deps.store.getState().right).toBe('props');

    stripBtn('source-control').click();
    expect(splitEl().classList.contains('right-collapsed')).toBe(false);
    expect(deps.store.getState().right).toBe('source-control');
    expect(stripBtn('source-control').getAttribute('aria-pressed')).toBe('true');
    expect(stripBtn('props').getAttribute('aria-pressed')).toBe('false');
    ctl.dispose();
  });
});

describe('createInspectorController — left navigator morph-collapse (#730)', () => {
  const LAYOUT_KEY = 'koine.studio.layout';
  const RAIL_AXIS_KEY = 'koine.studio.railAxis';
  const splitEl = () => domById('split');
  const railCollapse = () => document.getElementById('rail-collapse')!;
  const lspineBtn = (sel: string) => document.querySelector<HTMLButtonElement>(`#left-strip ${sel}`)!;
  const axisSelected = (axis: string) =>
    document.querySelector(`#rail-axis-switch [data-axis="${axis}"]`)!.getAttribute('aria-selected');

  // Clear both the layout key AND the separately-persisted rail axis so a prior test's setAxis('files')
  // can't leak the active axis into the next boot.
  beforeEach(() => {
    localStorage.removeItem(LAYOUT_KEY);
    localStorage.removeItem(RAIL_AXIS_KEY);
  });

  test('left rail is open by default: no left-collapsed class, collapse button expanded', () => {
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();
    expect(splitEl().classList.contains('left-collapsed')).toBe(false);
    expect(railCollapse().getAttribute('aria-expanded')).toBe('true');
    ctl.dispose();
  });

  test('boots collapsed from persisted layout: #split has left-collapsed, button not expanded', () => {
    saveLayout({ leftCollapsed: true });
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();
    expect(splitEl().classList.contains('left-collapsed')).toBe(true);
    expect(railCollapse().getAttribute('aria-expanded')).toBe('false');
    ctl.dispose();
  });

  test('clicking the collapse button tucks the rail and persists the flag', () => {
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();
    expect(splitEl().classList.contains('left-collapsed')).toBe(false);
    railCollapse().click();
    expect(splitEl().classList.contains('left-collapsed')).toBe(true);
    expect(deps.store.getState().leftCollapsed).toBe(true);
    expect(loadLayout().leftCollapsed).toBe(true);
    ctl.dispose();
  });

  test('a spine axis toggle re-opens the rail and switches to that axis', () => {
    saveLayout({ leftCollapsed: true });
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();
    expect(splitEl().classList.contains('left-collapsed')).toBe(true);
    lspineBtn('[data-laxis="files"]').click();
    expect(splitEl().classList.contains('left-collapsed')).toBe(false);
    expect(deps.store.getState().leftCollapsed).toBe(false);
    expect(axisSelected('files')).toBe('true');
    ctl.dispose();
  });

  test('the spine expand control re-opens the rail, leaving the axis unchanged', () => {
    saveLayout({ leftCollapsed: true });
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();
    expect(splitEl().classList.contains('left-collapsed')).toBe(true);
    lspineBtn('[data-lexpand]').click();
    expect(splitEl().classList.contains('left-collapsed')).toBe(false);
    expect(axisSelected('domain')).toBe('true');
    ctl.dispose();
  });
});

describe('createInspectorController — deck center layout', () => {
  test('init() mounts the deck stage: four surface cards in #center-body', async () => {
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();
    await waitFor(() => {
      const cards = document.querySelectorAll('#center-body .deck-card');
      expect(cards.length).toBe(4);
    });
    // The DeckSpine tab-strip renders into #deck-bar.
    expect(document.querySelector('#deck-bar .fx-strip')).not.toBeNull();
    ctl.dispose();
  });

  test('splitCodeCanvas() opens the Code ⟷ Canvas 2-up (Code primary, Canvas secondary)', async () => {
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();

    ctl.splitCodeCanvas();
    await flush(); // let the Preact re-render settle before waitFor polls (avoids a Windows CI timeout)

    const deck = deps.store.getState().deck;
    expect(deck.primary).toBe('technical');
    expect(deck.secondary).toBe('visual');
    await waitFor(() => {
      expect(shownCenter('technical')).toBe(true);
      expect(shownCenter('visual')).toBe(true);
      expect(shownCenter('output')).toBe(false);
    });
    ctl.dispose();
  });

  test('the deck persists via saveWorkspaceDeck on a center change', () => {
    const saveWorkspaceDeck = vi.fn();
    const ctl = createInspectorController(makeDeps(makeLsp(), { saveWorkspaceDeck }));
    ctl.init();

    ctl.selectCenter('docs');
    expect(saveWorkspaceDeck).toHaveBeenCalled();
    const calls = saveWorkspaceDeck.mock.calls;
    const lastDeck = calls[calls.length - 1][0];
    expect(lastDeck.primary).toBe('docs');
    ctl.dispose();
  });

  test('a persisted deck restores the 2-up on boot', async () => {
    const deck = { mode: 'focus', primary: 'technical', secondary: 'visual', ratio: 0.5, flipped: false } as const;
    const deps = makeDeps(makeLsp(), { loadWorkspaceDeck: () => deck });
    const ctl = createInspectorController(deps);
    ctl.init();
    expect(deps.store.getState().deck).toEqual(deck);
    await waitFor(() => {
      expect(shownCenter('technical')).toBe(true);
      expect(shownCenter('visual')).toBe(true);
    });
    ctl.dispose();
  });

  test('opening the bird\'s-eye overview shows all four surfaces', async () => {
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();

    deps.store.getState().toggleOverview();

    await waitFor(() => {
      for (const id of ['visual', 'technical', 'output', 'docs']) {
        expect(shownCenter(id)).toBe(true);
      }
    });
    ctl.dispose();
  });
});

// #648 — When an element is selected while the desktop Properties panel is collapsed, the panel must
// STAY collapsed (respect the user's explicit collapse) and add a transient attention cue on the
// Properties stripe button (approach b). This is distinct from the expanded case (#533) where
// selecting switches the active right view to Properties.
describe('createInspectorController — collapsed Properties panel + selection feedback (#648)', () => {
  const LAYOUT_KEY = 'koine.studio.layout';

  beforeEach(() => localStorage.removeItem(LAYOUT_KEY));

  test('selecting an element while Properties is collapsed keeps the panel collapsed and flashes the stripe button', async () => {
    // Start with an explicitly collapsed right rail (approach b: respect the explicit collapse).
    saveLayout({ rightCollapsed: true });
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();
    ctl.refreshActiveSurfaces();
    await flush();

    // Pre-condition: panel is collapsed and no button is pressed.
    expect(domById('split').classList.contains('right-collapsed')).toBe(true);
    expect(deps.store.getState().rightCollapsed).toBe(true);
    for (const v of ['props', 'assistant', 'source-control', 'syntax-tree']) {
      expect(stripBtn(v).getAttribute('aria-pressed')).toBe('false');
    }

    // Fire a selection while the panel is collapsed.
    ctl.selection.set({ qualifiedName: 'Billing.Money', context: 'Billing' });

    // Approach (b): the panel must STAY collapsed — the user's explicit collapse is honoured.
    expect(domById('split').classList.contains('right-collapsed')).toBe(true);
    expect(deps.store.getState().rightCollapsed).toBe(true);

    // The Properties stripe button acquires the attention cue (the flash class).
    expect(stripBtn('props').classList.contains('rstrip-notify')).toBe(true);

    // None of the stripe buttons should be pressed (collapsed → all false).
    for (const v of ['props', 'assistant', 'source-control', 'syntax-tree']) {
      expect(stripBtn(v).getAttribute('aria-pressed')).toBe('false');
    }

    ctl.dispose();
  });

  test('the flash cue class is removed after the animation timeout', async () => {
    vi.useFakeTimers();
    saveLayout({ rightCollapsed: true });
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();
    ctl.refreshActiveSurfaces();
    await flush();

    // Select while collapsed → flash the Properties stripe button.
    ctl.selection.set({ qualifiedName: 'Billing.Money', context: 'Billing' });
    expect(stripBtn('props').classList.contains('rstrip-notify')).toBe(true);

    // After the animation window elapses (~800 ms), the class is removed so the cue resets.
    await vi.advanceTimersByTimeAsync(900);
    expect(stripBtn('props').classList.contains('rstrip-notify')).toBe(false);

    ctl.dispose();
  });

  test('a repeated selection re-fires the flash on the Properties stripe button', async () => {
    vi.useFakeTimers();
    saveLayout({ rightCollapsed: true });
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();
    ctl.refreshActiveSurfaces();
    await flush();

    // First selection flashes the button.
    ctl.selection.set({ qualifiedName: 'Billing.Money', context: 'Billing' });
    expect(stripBtn('props').classList.contains('rstrip-notify')).toBe(true);

    // A second selection on a DIFFERENT element while still collapsed re-fires the flash.
    ctl.selection.set({ qualifiedName: 'Billing', context: 'Billing' });
    expect(stripBtn('props').classList.contains('rstrip-notify')).toBe(true);

    ctl.dispose();
  });

  test('expanding the panel by clicking the stripe clears the flash and presses the button', async () => {
    saveLayout({ rightCollapsed: true });
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();
    ctl.refreshActiveSurfaces();
    await flush();

    // Select while collapsed → flash the button.
    ctl.selection.set({ qualifiedName: 'Billing.Money', context: 'Billing' });
    expect(stripBtn('props').classList.contains('rstrip-notify')).toBe(true);
    expect(domById('split').classList.contains('right-collapsed')).toBe(true);

    // User clicks the Properties stripe icon → expands to Properties.
    stripBtn('props').click();
    expect(domById('split').classList.contains('right-collapsed')).toBe(false);
    expect(deps.store.getState().rightCollapsed).toBe(false);
    expect(stripBtn('props').getAttribute('aria-pressed')).toBe('true');

    ctl.dispose();
  });
});

describe('createInspectorController — teardown / disposal (#980)', () => {
  test('dispose() synchronously releases every store subscription init() registered, across repeated boots', () => {
    const { store, active } = createCountingStore();
    const base = active(); // nothing subscribed yet

    // init() registers its store subscriptions synchronously (seven of them); it also kicks off async
    // panel loaders that subscribe only AFTER a macrotask. This test targets the invariant this issue
    // fixes — dispose() releases every subscription that is live at dispose time — so it stays synchronous
    // (no await between init and dispose): the loaders never get to subscribe, and the tally we compare is
    // exactly init()'s own subscriptions in vs dispose()'s out. (The separate matter of in-flight loaders
    // mounting panels after dispose is out of scope here — #985/#989 re-home that code.)
    //
    // Production reuses the app-wide singleton store, so boot onto the SAME store twice: a per-boot leak
    // would accumulate. Before the fix, each dispose leaks 2 (center-persist + selection); after it, the
    // tally returns to baseline each time.
    for (let boot = 0; boot < 2; boot++) {
      seedDom(); // fresh hosts per boot — a prior boot's dispose (render(null, centerBodyEl)) wipes them
      const ctl = createInspectorController(makeDeps(makeLsp(), { store }));
      ctl.init();
      expect(active()).toBeGreaterThan(base); // sanity: init did subscribe
      ctl.dispose();
      expect(active()).toBe(base);
    }
  });

  test('a disposed controller no longer persists the center pane on a store write (:466 leak)', () => {
    const saveWorkspaceCenter = vi.fn();
    const deps = makeDeps(makeLsp(), { saveWorkspaceCenter });
    const ctl = createInspectorController(deps);
    ctl.init();
    ctl.dispose();

    // The center-persist subscription must be gone: a post-dispose center change writes nothing for a
    // torn-down session.
    saveWorkspaceCenter.mockClear();
    deps.store.getState().setCenter('technical');
    expect(saveWorkspaceCenter).not.toHaveBeenCalled();
  });

  test('a disposed controller no longer reveals/repaints on a selection change (:1140 leak)', () => {
    const deps = makeDeps(makeLsp());
    const ctl = createInspectorController(deps);
    ctl.init();
    ctl.dispose();

    // With the rail expanded on a non-Properties tool window, a live selection subscription would flip the
    // right view to 'props' (reveal-on-select, #533) and repaint the inspector. After dispose it must do
    // neither: the write neither throws nor moves the right view.
    deps.store.getState().setRight('assistant');
    expect(() =>
      deps.store.getState().setSelection({ qualifiedName: 'Billing.Money', context: 'Billing' }),
    ).not.toThrow();
    expect(deps.store.getState().right).toBe('assistant');
  });
});

describe('createInspectorController — teardown / disposal, in-flight loader (#1002)', () => {
  // #980 fixed subscriptions that were LIVE at dispose time; this targets the async sibling — a surface
  // loader that is still AWAITING its fetch when dispose() runs. The resolved continuation must not mount
  // a fresh store-subscribing panel (or write to the host at all) on behalf of a torn-down controller.
  // loadEventsPanel (via guardedLoad) is the target: its host (#panel-events) lives in the diagnostics
  // footer, a sibling of #center — unlike a center-pane loader (e.g. loadModel), it survives dispose()'s
  // render(null, centerBodyEl) unmount, so a post-dispose write is cleanly observable rather than masked
  // by an unrelated "host no longer exists" throw.
  test('an in-flight loadEventsPanel() that resolves after dispose() does not re-subscribe or repaint', async () => {
    const { store, active } = createCountingStore();
    const base = active(); // nothing subscribed yet

    const lsp = makeLsp();
    let resolveDocs!: (docs: DocsResult) => void;
    lsp.livingDocs.mockImplementation(
      () =>
        new Promise<DocsResult>((resolve) => {
          resolveDocs = resolve;
        }),
    );

    const ctl = createInspectorController(makeDeps(lsp, { store }));
    ctl.init();
    expect(active()).toBeGreaterThan(base); // sanity: init did subscribe

    ctl.selectBottomTab('events'); // kicks off loadEventsPanel(); it suspends on the deferred livingDocs fetch
    const loadingHtml = domById('panel-events').innerHTML;
    expect(loadingHtml).not.toBe(''); // the loading placeholder painted synchronously, before dispose

    ctl.dispose(); // tear down WHILE that fetch is still in flight — drops every subscription live at dispose

    resolveDocs({ files: [] });
    await flush(); // let the microtask-chained continuation run
    await new Promise((resolve) => setTimeout(resolve, 0)); // + a macrotask — Preact effects subscribe deferred

    expect(active()).toBe(base); // back to zero — the resolved loader must not have mounted a subscribing panel
    expect(domById('panel-events').innerHTML).toBe(loadingHtml); // ...nor repainted the torn-down host
  });

  // A single-await loader could pass the test above by accident (e.g. a bail only at the very top of the
  // continuation). runCheck genuinely suspends TWICE (pickFolder, then lsp.check) with real work between —
  // proving the SECOND suspension is guarded too, not just the first.
  test('an in-flight runCheck() that resolves its second await after dispose() does not repaint the torn-down host', async () => {
    // compatNeedsInProcessSources: true exercises the readFolderSources leg too (the real BrowserPlatform
    // sets it), so this test's own disposed-guard after THAT suspension gets covered as well — not just
    // the pickFolder/lsp.check pair.
    const platform = fakePlatform({
      pickFolder: vi.fn(async () => '/baseline'),
      compatNeedsInProcessSources: true,
      readFolderSources: vi.fn(async () => []),
    });
    const lsp = makeLsp();
    let resolveCheck!: (result: CheckResult) => void;
    lsp.check.mockImplementation(
      () =>
        new Promise<CheckResult>((resolve) => {
          resolveCheck = resolve;
        }),
    );

    const ctl = createInspectorController(makeDeps(lsp, { platform }));
    ctl.init();
    // Captured ONCE, before dispose(): dispose()'s render(null, centerBodyEl) detaches #view-check (it
    // lives inside the center pane) from the document, so a FRESH domById() lookup after dispose would
    // throw "missing #view-check" — the controller's own internal reference stays valid on a detached
    // node (Preact/DOM writes to it don't throw), so this test must hold the same kind of reference.
    const viewCheckEl = domById('view-check');

    void ctl.runCheck(); // suspends on pickFolder first
    await flush(); // let pickFolder resolve and the continuation reach the SECOND await (lsp.check)
    const checkingHtml = viewCheckEl.innerHTML;
    expect(checkingHtml).toContain('Checking against baseline'); // painted synchronously before the 2nd await

    ctl.dispose(); // tear down WHILE lsp.check is still in flight

    resolveCheck({ hasBreakingChanges: false, changes: [] });
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(viewCheckEl.innerHTML).toBe(checkingHtml); // the resolved 2nd await must not repaint it
  });

  // loadDiagrams' own `if (disposed) return;` only guards ITS continuation — the actual DOM mount happens
  // inside renderDiagrams (a maxGraph canvas), which suspends AGAIN internally (a dynamic import, a
  // layout-store load) behind its own `isCurrent` callback. Verify that callback itself observes `disposed`
  // once torn down, not just the local seq — otherwise a resolving nested render still mounts post-dispose.
  test('loadDiagrams threads disposed into renderDiagrams\' own isCurrent gate, not just the local seq', async () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();

    let capturedIsCurrent: (() => boolean) | undefined;
    let resolveRender!: () => void;
    vi.spyOn(diagramsModule, 'renderDiagrams').mockImplementation(async (_container, _files, _theme, isCurrent) => {
      capturedIsCurrent = isCurrent;
      return new Promise<void>((resolve) => {
        resolveRender = resolve;
      });
    });

    void ctl.loadDiagrams(); // suspends on lsp.livingDocs() (resolves immediately), then on renderDiagrams
    await flush();
    expect(capturedIsCurrent).toBeDefined();
    expect(capturedIsCurrent!()).toBe(true); // sanity: still current before dispose

    ctl.dispose(); // tear down WHILE renderDiagrams' own internal await is in flight

    expect(capturedIsCurrent!()).toBe(false); // the fix: isCurrent must observe disposed too

    resolveRender();
    await flush();
  });

  // Same hazard, one level deeper: loadContextMapPanel's guardedLoad `render` callback fires a fire-and-
  // forget `paintContextMap()`, which suspends again inside renderContextMapGraph (again, a maxGraph mount).
  // guardedLoad's isDisposed() never reaches that nested suspension — only threading `disposed` into
  // paintContextMap's own isCurrent callback closes it.
  test('loadContextMapPanel threads disposed into renderContextMapGraph\'s own isCurrent gate, not just the local seq', async () => {
    localStorage.removeItem('koine.studio.contextMapView'); // Graph is the default view
    const lsp = makeLsp();
    lsp.contextMap.mockResolvedValue({ contexts: ['Billing'], relations: [] });
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();

    let capturedIsCurrent: (() => boolean) | undefined;
    let resolveGraph!: (handle: maxgraphRenderer.ContextMapGraphHandle | null) => void;
    vi.spyOn(maxgraphRenderer, 'renderContextMapGraph').mockImplementation(async (_stage, _graph, isCurrent) => {
      capturedIsCurrent = isCurrent;
      return new Promise((resolve) => {
        resolveGraph = resolve;
      });
    });

    ctl.selectOutput('contextmap'); // loadContextMapPanel -> lsp.contextMap() -> render() -> paintContextMap()
    await flush();
    expect(capturedIsCurrent).toBeDefined();
    expect(capturedIsCurrent!()).toBe(true); // sanity: still current before dispose

    ctl.dispose(); // tear down WHILE renderContextMapGraph's own internal await is in flight

    expect(capturedIsCurrent!()).toBe(false); // the fix: isCurrent must observe disposed too

    resolveGraph({ dispose: vi.fn() });
    await flush();
  });

  // #1037: refreshContextList is a public method invoked from ide.tsx on every onFolderOpened /
  // onRootSetChanged — the one loader-shaped sibling #1002's own review pass flagged but left
  // unaudited. Same hazard as loadEventsPanel above: a fetch still in flight when dispose() runs must
  // resolve into a no-op, not a write into the store or the status-bar DOM on behalf of a dead controller.
  test('an in-flight refreshContextList() that resolves after dispose() does not write the store or status bar', async () => {
    const lsp = makeLsp();
    const deps = makeDeps(lsp);
    const ctl = createInspectorController(deps);
    ctl.init();

    const baselineContexts = deps.store.getState().contexts;
    const baselineCoverage = deps.store.getState().docsCoverage;
    const baselineStatusBar = domById('sb-context').textContent;

    let resolveGlossary!: (model: GlossaryModel) => void;
    lsp.glossaryModel.mockImplementation(
      () =>
        new Promise<GlossaryModel>((resolve) => {
          resolveGlossary = resolve;
        }),
    );

    void ctl.refreshContextList(); // suspends on the deferred glossaryModel fetch

    ctl.dispose(); // tear down WHILE that fetch is still in flight

    resolveGlossary(glossaryFixture());
    await flush(); // let the microtask-chained continuation run
    await new Promise((resolve) => setTimeout(resolve, 0)); // + a macrotask, matching the sibling tests above

    expect(deps.store.getState().contexts).toEqual(baselineContexts);
    expect(deps.store.getState().docsCoverage).toEqual(baselineCoverage);
    expect(domById('sb-context').textContent).toBe(baselineStatusBar);
  });
});

// #983 — railAxis / diagCollapsed / contextMapView are moving off bespoke closures + the DOM class into
// the uiChrome slice. These tests PIN the persistence round-trips at their existing localStorage keys +
// byte-identical value formats, so the refactor is proven behaviour-preserving (the keys and formats must
// not drift). localStorage leaks between tests (the global beforeEach only re-seeds the DOM), so each
// key is cleared explicitly around the cases.
describe('createInspectorController — persistence round-trips (#983)', () => {
  const RAIL_AXIS_KEY = 'koine.studio.railAxis';
  const DIAG_KEY = 'koine.studio.diagCollapsed';
  const CTXMAP_KEY = 'koine.studio.contextMapView';
  const clearKeys = () => {
    localStorage.removeItem(RAIL_AXIS_KEY);
    localStorage.removeItem(DIAG_KEY);
    localStorage.removeItem(CTXMAP_KEY);
  };
  beforeEach(clearKeys);
  afterEach(clearKeys);

  test('(a) toggling the rail axis to Files persists koine.studio.railAxis="files"', () => {
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();
    (document.querySelector('#rail-axis-switch [data-axis="files"]') as HTMLButtonElement).click();
    expect(localStorage.getItem(RAIL_AXIS_KEY)).toBe('files');
    ctl.dispose();
  });

  test('(a) boot with railAxis="files" stored surfaces #rail-files (Files axis restored)', () => {
    localStorage.setItem(RAIL_AXIS_KEY, 'files');
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();
    expect(domById('rail-files').hidden).toBe(false);
    expect(domById('rail-domain-pane').hidden).toBe(true);
    ctl.dispose();
  });

  test('(b) the #diag-collapse chevron writes koine.studio.diagCollapsed as "1"/"0"', () => {
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();
    const chevron = domById('diag-collapse');
    // Boots expanded (Visual, wide) → the chevron collapses it and persists '1'.
    chevron.click();
    expect(domById('diagnostics').classList.contains('collapsed')).toBe(true);
    expect(localStorage.getItem(DIAG_KEY)).toBe('1');
    // ...and back: expanding persists '0'.
    chevron.click();
    expect(domById('diagnostics').classList.contains('collapsed')).toBe(false);
    expect(localStorage.getItem(DIAG_KEY)).toBe('0');
    ctl.dispose();
  });

  test('(b) a bottom-tab click that auto-expands the strip writes NOTHING to koine.studio.diagCollapsed', () => {
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();
    // Collapse explicitly via the chevron → the persisted preference is now '1'.
    domById('diag-collapse').click();
    expect(domById('diagnostics').classList.contains('collapsed')).toBe(true);
    expect(localStorage.getItem(DIAG_KEY)).toBe('1');
    // Clicking a bottom tab reveals its panel (a transient runtime expand) but must NOT persist the
    // expand — the saved preference stays '1' so a reload restores the user's collapse.
    domById('tab-events').click();
    expect(domById('diagnostics').classList.contains('collapsed')).toBe(false);
    expect(localStorage.getItem(DIAG_KEY)).toBe('1');
    ctl.dispose();
  });

  test('(c) the Graph/Table toggle persists koine.studio.contextMapView="table"', async () => {
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();
    ctl.selectOutput('contextmap');
    await flush();
    domById('panel-contextmap').querySelector<HTMLButtonElement>('[data-ctxmap-view="table"]')!.click();
    await flush();
    expect(localStorage.getItem(CTXMAP_KEY)).toBe('table');
    ctl.dispose();
  });

  test('(c) boot with contextMapView="table" stored restores the dense table view', async () => {
    localStorage.setItem(CTXMAP_KEY, 'table');
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();
    ctl.selectOutput('contextmap');
    await flush();
    const panel = domById('panel-contextmap');
    expect(panel.querySelector('[data-ctxmap-view="table"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(panel.innerHTML).toContain('koi-md');
    ctl.dispose();
  });
});

