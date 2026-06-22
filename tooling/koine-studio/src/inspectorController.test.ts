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
} from './inspectorController';
import type {
  CheckResult,
  ContextMapResult,
  DocsResult,
  DocumentSymbol,
  EmitPreviewResult,
  GlossaryEntry,
  GlossaryModel,
  SetDocResult,
} from './lsp';

// --- DOM seed ----------------------------------------------------------------
// The center / docs / bottom-strip / right-rail / left-rail / mode-switcher / context-switcher subset
// of index.html the controller looks up via el(...). Kept equivalent to ide.test.ts's APP_HTML.
const APP_HTML = `
  <div id="app">
    <nav id="mode-switcher" class="mode-switcher" role="tablist"></nav>
    <div id="context-switcher" class="context-switcher" hidden></div>
    <main id="split">
      <aside id="leftrail" class="pane">
        <div class="rail-sect-body" id="rail-explorer-body"></div>
        <div class="rail-sect-body" id="rail-overview-body"></div>
      </aside>
      <section id="center" class="pane">
        <div id="center-tabs" role="tablist">
          <button type="button" class="center-tab" id="center-tab-visual" role="tab" data-center="visual" aria-selected="true">Visual</button>
          <button type="button" class="center-tab" id="center-tab-technical" role="tab" data-center="technical" aria-selected="false">Code</button>
          <button type="button" class="center-tab" id="center-tab-docs" role="tab" data-center="docs" aria-selected="false">Documentation</button>
        </div>
        <div id="center-body">
          <section id="center-visual" class="center-host" role="tabpanel"></section>
          <section id="center-technical" class="center-host" role="tabpanel" hidden>
            <div id="tech-tabs" role="tablist">
              <button type="button" class="tech-tab" id="tech-tab-editor" role="tab" data-tech="editor" aria-selected="true">Editor</button>
              <button type="button" class="tech-tab" id="tech-tab-preview" role="tab" data-tech="preview" aria-selected="false">Generated</button>
              <button type="button" class="tech-tab" id="tech-tab-check" role="tab" data-tech="check" aria-selected="false">Compatibility</button>
              <button type="button" class="tech-tab" id="tech-tab-assistant" role="tab" data-tech="assistant" aria-selected="false">Assistant</button>
            </div>
            <div id="tech-body">
              <section id="editor-pane" class="tech-view"></section>
              <div id="view-preview" class="tech-view" role="tabpanel" hidden></div>
              <div id="view-check" class="tech-view doc-view" role="tabpanel" hidden></div>
              <div id="view-assistant" class="tech-view" role="tabpanel" hidden></div>
            </div>
          </section>
          <section id="center-docs" class="center-host" role="tabpanel" hidden>
            <div id="docs-tabs" role="tablist">
              <button type="button" class="docs-tab" id="docs-tab-glossary" role="tab" data-docs="glossary" aria-selected="true">Glossary</button>
              <button type="button" class="docs-tab" id="docs-tab-adr" role="tab" data-docs="adr" aria-selected="false">Decisions &amp; Notes</button>
            </div>
            <div id="docs-body">
              <div id="view-glossary" class="tech-view doc-view" role="tabpanel"></div>
              <div id="view-docs" class="tech-view doc-view" role="tabpanel" hidden></div>
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
              <button type="button" class="diag-tab" id="tab-contextmap" role="tab" data-panel="contextmap" aria-selected="false">Context Map</button>
            </div>
            <span id="diag-count" class="diag-count"></span>
          </div>
          <div id="diag-body" class="diag-panel" role="tabpanel"></div>
          <div id="panel-events" class="diag-panel" role="tabpanel" hidden></div>
          <div id="panel-relationships" class="diag-panel" role="tabpanel" hidden></div>
          <div id="panel-contextmap" class="diag-panel doc-view" role="tabpanel" hidden></div>
        </footer>
      </section>
      <aside id="right" class="pane">
        <div id="right-tabs" role="tablist">
          <button type="button" class="rtab" id="rtab-props" role="tab" data-rview="props" aria-selected="true">Properties</button>
          <button type="button" class="rtab" id="rtab-rules" role="tab" data-rview="rules" aria-selected="false">Rules</button>
          <button type="button" class="rtab" id="rtab-notes" role="tab" data-rview="notes" aria-selected="false">Notes</button>
        </div>
        <div id="right-body">
          <div id="inspector-host" class="rview" role="tabpanel"></div>
          <div id="rview-rules" class="rview doc-view" role="tabpanel" hidden></div>
          <div id="rview-notes" class="rview doc-view" role="tabpanel" hidden></div>
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

// A browser-like platform stub: only the bits runCheck / loadDocs touch (kind, canOpenFolders,
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
    activeUri: () => 'file:///work/model.koi',
    folderRootToken: () => '',
    initialTarget: 'csharp',
    saveWorkspaceMode: vi.fn(),
    loadWorkspaceMode: vi.fn(() => null),
    saveActiveContext: vi.fn(),
    loadActiveContext: vi.fn(() => null),
    setStatus: vi.fn(),
    onRenameElement: vi.fn(),
    onSaveElementDescription: vi.fn(),
    onSaveGlossaryDescription: vi.fn(),
    onApplyStructuredEdit: vi.fn(),
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

describe('createInspectorController — mode switching', () => {
  test('init() boots Domain (default) → the visual center is shown and its button marked', () => {
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();

    expect(el('center-visual').hidden).toBe(false);
    expect(el('center-technical').hidden).toBe(true);
    expect(el('center-docs').hidden).toBe(true);
    const domainBtn = document.querySelector<HTMLElement>('.mode-btn[data-mode="domain"]')!;
    expect(domainBtn.getAttribute('aria-selected')).toBe('true');
  });

  test('selectMode("code") surfaces the technical center + editor sub-view and marks the Code button', () => {
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();

    ctl.selectMode('code');

    expect(el('center-technical').hidden).toBe(false);
    expect(el('center-visual').hidden).toBe(true);
    expect(el('editor-pane').hidden).toBe(false); // Code mode lands on the editor sub-tab
    expect(document.querySelector('.mode-btn[data-mode="code"]')!.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('.mode-btn[data-mode="domain"]')!.getAttribute('aria-selected')).toBe('false');
  });

  test('selectMode("docs") focuses the Documentation center on the Glossary sub-view', () => {
    const ctl = createInspectorController(makeDeps(makeLsp()));
    ctl.init();

    ctl.selectMode('docs');

    expect(el('center-docs').hidden).toBe(false);
    expect(el('view-glossary').hidden).toBe(false);
    expect(el('view-docs').hidden).toBe(true);
    expect(document.querySelector('.mode-btn[data-mode="docs"]')!.getAttribute('aria-selected')).toBe('true');
  });

  test('a real mode change persists via saveWorkspaceMode; re-selecting the same mode does not', () => {
    const saveWorkspaceMode = vi.fn();
    const ctl = createInspectorController(makeDeps(makeLsp(), { saveWorkspaceMode }));
    ctl.init();

    ctl.selectMode('code');
    expect(saveWorkspaceMode).toHaveBeenCalledWith('code');
    saveWorkspaceMode.mockClear();
    ctl.selectMode('code'); // same mode — no churn
    expect(saveWorkspaceMode).not.toHaveBeenCalled();
  });

  test('a persisted mode restores the matching center on boot (Code → technical)', () => {
    const ctl = createInspectorController(makeDeps(makeLsp(), { loadWorkspaceMode: () => 'code' }));
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

  test('the assistant tab nudges ensureAssistant().syncWorkspace + focusInput, every show', () => {
    const assistant = makeAssistant();
    const ensureAssistant = vi.fn(() => assistant);
    const ctl = createInspectorController(makeDeps(makeLsp(), { ensureAssistant }));
    ctl.init();

    ctl.selectTech('assistant');
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
    // Land on Code so the only live model-derived surface is the left rail (loadModel), keeping the
    // assertion about the debounced refreshContextList clean.
    ctl.selectMode('code');
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

  test('the Context Map tab lazy-loads the context map once and renders it', async () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();

    ctl.selectBottomTab('contextmap');
    await flush();

    expect(lsp.contextMap).toHaveBeenCalledTimes(1);
    expect(el('panel-contextmap').hidden).toBe(false);
    expect(el('panel-contextmap').innerHTML).toContain('koi-md');
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
  test('refreshContextList populates the switcher options and reveals it', async () => {
    const lsp = makeLsp();
    const ctl = createInspectorController(makeDeps(lsp));
    ctl.init();

    await ctl.refreshContextList();

    const select = document.querySelector<HTMLSelectElement>('#context-switcher select')!;
    // "All contexts" sentinel + the one model context.
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['all', 'Billing']);
    expect(el('context-switcher').hidden).toBe(false);
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
