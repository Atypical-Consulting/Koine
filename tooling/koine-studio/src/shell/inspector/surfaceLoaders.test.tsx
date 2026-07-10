// Tests for the lazily-loaded surface loaders — extracted from inspectorController (Task 3 of #985's
// decomposition). Behavior is pinned two ways: HERE (this module's own contract, in isolation, with
// spied hooks/deps standing in for the facade) and in inspectorController.test.ts's pre-existing "lazy
// view loading" / "invalidation forces a refetch" / "bottom strip lazy loading" / "Source Control live
// refresh-on-save (#470)" / "deck 2-up SECONDARY panes refresh on scope / theme / emit-target changes" /
// "loading states clear on success" describe blocks (the facade's delegation to this module, unmodified
// by this extraction).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createSurfaceLoaders, type SurfaceLoadersDeps, type SurfaceLoadersHooks, type SurfaceLoadersHosts } from '@/shell/inspector/surfaceLoaders';
import { createAppStore } from '@/store/index';
import type { AppState } from '@/store/index';
import type { StoreApi } from 'zustand/vanilla';
import type { Platform } from '@/host';
import type { CheckResult, DocsResult, EmitPreviewResult, GlossaryModel } from '@/lsp/lsp';
import type { ModelIndex } from '@/model/modelIndex';
import * as SourceControlPanelModule from '@/model/SourceControlPanel';

// --- fixtures ----------------------------------------------------------------
function makeHosts(): SurfaceLoadersHosts {
  const mk = (id: string): HTMLElement => {
    const el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
    return el;
  };
  return {
    preview: mk('view-preview'),
    diagrams: mk('diagram-host'),
    glossary: mk('view-glossary'),
    adr: mk('view-docs'),
    notes: mk('view-notes'),
    sourceControl: mk('rview-source-control'),
    events: mk('panel-events'),
    relationships: mk('panel-relationships'),
    check: mk('view-check'),
  };
}

function makeLsp() {
  return {
    glossaryModel: vi.fn(async (): Promise<GlossaryModel> => ({ entries: [] })),
    livingDocs: vi.fn(async (): Promise<DocsResult> => ({ files: [] })),
    emitPreview: vi.fn(
      async (target: string): Promise<EmitPreviewResult> => ({
        target,
        files: [{ path: 'Money.cs', contents: '// ' + target }],
        diagnostics: [],
        error: null,
      }),
    ),
    check: vi.fn(async (): Promise<CheckResult> => ({ hasBreakingChanges: false, changes: [] })),
  };
}

function fakePlatform(over: Partial<Record<string, unknown>> = {}): Platform {
  return {
    kind: 'browser',
    canOpenFolders: true,
    canUseGit: false, // no git calls at all — the panel short-circuits to its empty state
    pickFolder: vi.fn(async () => null),
    readFolderSources: vi.fn(async () => []),
    listKoiFiles: vi.fn(async () => []),
    listEntries: vi.fn(async () => []),
    readTextFile: vi.fn(async () => ''),
    ...over,
  } as unknown as Platform;
}

function fakeOutput() {
  return { setContent: vi.fn(), setLineWrap: vi.fn(), destroy: vi.fn() };
}

function makeDeps(over: Partial<SurfaceLoadersDeps> = {}): SurfaceLoadersDeps {
  return {
    folderRootToken: () => '',
    setStatus: vi.fn(),
    onSaveGlossaryDescription: vi.fn(async () => {}),
    saveAllDirty: vi.fn(async () => {}),
    gotoSourceSpan: vi.fn(),
    gotoRange: vi.fn(),
    ...over,
  };
}

function makeHooks(over: Partial<SurfaceLoadersHooks> = {}): SurfaceLoadersHooks {
  return {
    ensureModelIndex: vi.fn(async () => ({}) as ModelIndex),
    onModelIndexRebuilt: vi.fn(),
    ensureDomainNavigator: vi.fn(),
    invalidateModelDerivedCaches: vi.fn(),
    ensureTechLoaded: vi.fn(),
    ensureOutputLoaded: vi.fn(),
    ensureBottomLoaded: vi.fn(),
    loadSyntaxTree: vi.fn(),
    refreshContextList: vi.fn(async () => {}),
    ...over,
  };
}

function build(
  over: {
    store?: StoreApi<AppState>;
    lsp?: ReturnType<typeof makeLsp>;
    hosts?: SurfaceLoadersHosts;
    deps?: SurfaceLoadersDeps;
    hooks?: SurfaceLoadersHooks;
    platform?: Platform;
    output?: ReturnType<typeof fakeOutput>;
  } = {},
) {
  const store = over.store ?? createAppStore();
  const lsp = over.lsp ?? makeLsp();
  const hosts = over.hosts ?? makeHosts();
  const deps = over.deps ?? makeDeps();
  const hooks = over.hooks ?? makeHooks();
  const platform = over.platform ?? fakePlatform();
  const output = over.output ?? fakeOutput();
  const loaders = createSurfaceLoaders({ store, lsp, output, platform, hosts, deps, hooks });
  return { store, lsp, hosts, deps, hooks, platform, output, loaders };
}

/** Let queued microtask-chained loader promises settle (mirrors inspectorController.test.ts's flush). */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

// --- (a) onDocEdited debounces through the docViews slice's scheduleRefresh ---
describe('createSurfaceLoaders — onDocEdited rides docViews.scheduleRefresh (first production caller)', () => {
  test('every onDocEdited() call goes through store.getState().scheduleRefresh; a burst collapses to ONE refresh 350ms after the LAST edit', async () => {
    vi.useFakeTimers();
    const { store, hooks, loaders } = build();
    const scheduleRefreshSpy = vi.spyOn(store.getState(), 'scheduleRefresh');

    loaders.onDocEdited();
    loaders.onDocEdited();
    loaders.onDocEdited();

    expect(scheduleRefreshSpy).toHaveBeenCalledTimes(3); // each edit re-schedules through the slice
    expect(hooks.refreshContextList).not.toHaveBeenCalled(); // nothing has fired yet — still debounced

    await vi.advanceTimersByTimeAsync(349);
    expect(hooks.refreshContextList).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(hooks.refreshContextList).toHaveBeenCalledTimes(1); // only the LAST scheduled callback fired
  });

  test('dispose() before the 350ms debounce expires cancels the pending refresh — it never fires', async () => {
    vi.useFakeTimers();
    const { hooks, loaders } = build();

    loaders.onDocEdited();
    loaders.dispose();
    await vi.advanceTimersByTimeAsync(350);

    expect(hooks.refreshContextList).not.toHaveBeenCalled();
    expect(hooks.ensureModelIndex).not.toHaveBeenCalled(); // refreshActiveSurfaces (→ loadModel) never ran either
  });

  test('onDocEdited invalidates the model-derived docViews surfaces synchronously (not debounced)', () => {
    const { hooks, loaders } = build();

    loaders.onDocEdited();

    // invalidateDocViews() (synchronous) drops the facade's model-derived caches immediately, before the
    // debounced refresh even schedules.
    expect(hooks.invalidateModelDerivedCaches).toHaveBeenCalledTimes(1);
  });
});

// --- (b) Source Control dirty-count repaint — the prev.dirtyCount() trap -----
describe('createSurfaceLoaders — Source Control dirty-count repaint (the prev.dirtyCount() trap)', () => {
  test('repaints when the dirty count derived from buffers snapshots actually changes', async () => {
    const { store, loaders } = build();
    loaders.loadSourceControl();
    store.getState().setRight('source-control');
    await flush();

    // Spying on the (project-local, so live-binding-friendly under Vite) SourceControlPanel export lets
    // us observe a repaint attempt without depending on any VISIBLE dirtyCount rendering — the prop only
    // affects a later Commit click, so DOM diffing alone can't detect it.
    const panelSpy = vi.spyOn(SourceControlPanelModule, 'SourceControlPanel');
    panelSpy.mockClear();

    // A buffer becomes dirty: 0 -> 1 dirty. This is exactly the scenario a `prev.dirtyCount()`-based
    // comparison would MISS (it would read the store's CURRENT — i.e. post-write — state for BOTH sides
    // of the comparison, so `dc === prevDc` would always be true and this repaint would never fire).
    store.getState().upsertBuffer({
      uri: 'file:///a.koi', path: '/a.koi', relPath: 'a.koi', name: 'a.koi', text: 'x', dirty: true, rootToken: '',
    });
    await flush();

    expect(panelSpy).toHaveBeenCalled();
    expect(panelSpy.mock.calls.at(-1)?.[0]).toMatchObject({ dirtyCount: 1 });
    panelSpy.mockRestore();
  });

  test('does NOT repaint on an unrelated store write that leaves buffers untouched', async () => {
    const { store, loaders } = build();
    loaders.loadSourceControl();
    store.getState().setRight('source-control');
    await flush();

    const panelSpy = vi.spyOn(SourceControlPanelModule, 'SourceControlPanel');
    panelSpy.mockClear();

    store.getState().setSelection({ qualifiedName: 'Billing.Money', context: 'Billing' }); // unrelated slice
    await flush();

    expect(panelSpy).not.toHaveBeenCalled();
    panelSpy.mockRestore();
  });

  test('does NOT repaint when Source Control is not the active right view, even if buffers change', async () => {
    const { store, loaders } = build();
    loaders.loadSourceControl();
    store.getState().setRight('props'); // SC tab is not open
    await flush();

    const panelSpy = vi.spyOn(SourceControlPanelModule, 'SourceControlPanel');
    panelSpy.mockClear();

    store.getState().upsertBuffer({
      uri: 'file:///a.koi', path: '/a.koi', relPath: 'a.koi', name: 'a.koi', text: 'x', dirty: true, rootToken: '',
    });
    await flush();

    expect(panelSpy).not.toHaveBeenCalled();
    panelSpy.mockRestore();
  });
});

// --- (c) emitTarget: setTarget writes through; loadPreview reads live (no closure copy) ---
describe('createSurfaceLoaders — emitTarget: setTarget writes setEmitTarget; loadPreview reads it live', () => {
  test('setTarget writes the shared emitTarget slice; loadPreview subsequently emits that exact target', async () => {
    const { store, lsp, loaders } = build();
    expect(store.getState().emitTarget).toBe('csharp'); // the slice default

    loaders.setTarget('typescript');
    expect(store.getState().emitTarget).toBe('typescript'); // written straight through setEmitTarget — no closure

    await loaders.loadPreview();
    expect(lsp.emitPreview).toHaveBeenCalledWith('typescript');
  });

  test('a DIRECT store write to emitTarget (bypassing loaders.setTarget) is what loadPreview reads — proves there is no closure copy', async () => {
    const { store, lsp, loaders } = build();

    store.getState().setEmitTarget('python'); // written directly, never through loaders.setTarget

    await loaders.loadPreview();
    expect(lsp.emitPreview).toHaveBeenCalledWith('python');
  });

  test('onPreviewTargetChanged is a no-op when the target already matches the current emitTarget slice value', async () => {
    const { store, lsp, loaders } = build();
    expect(store.getState().emitTarget).toBe('csharp');

    loaders.onPreviewTargetChanged('csharp'); // unchanged

    expect(lsp.emitPreview).not.toHaveBeenCalled(); // no invalidate, no reload
  });
});

// --- (d) preview/diagrams keep their OWN seq discipline (do not bump the docViews token) ---
describe('createSurfaceLoaders — preview/diagrams keep their own seq discipline, distinct from the docViews token', () => {
  test('onPreviewTargetChanged invalidates ONLY the "preview" key — sibling docViews tokens are untouched', () => {
    const { store, loaders } = build();
    const modelToken = store.getState().currentToken('model');
    const diagramsToken = store.getState().currentToken('diagrams');
    const glossaryToken = store.getState().currentToken('glossary');
    const previewToken = store.getState().currentToken('preview');

    loaders.onPreviewTargetChanged('typescript');

    // The preview key's OWN token bumps (a single-key invalidate)...
    expect(store.getState().currentToken('preview')).toBe(previewToken + 1);
    // ...but sibling surfaces are NOT force-invalidated — a language switch must not stale docs that
    // don't need it.
    expect(store.getState().currentToken('model')).toBe(modelToken);
    expect(store.getState().currentToken('diagrams')).toBe(diagramsToken);
    expect(store.getState().currentToken('glossary')).toBe(glossaryToken);
  });

  test('onThemeChanged invalidates ONLY the "diagrams" key — sibling docViews tokens are untouched', () => {
    const { store, loaders } = build();
    const modelToken = store.getState().currentToken('model');
    const previewToken = store.getState().currentToken('preview');
    const diagramsToken = store.getState().currentToken('diagrams');

    loaders.onThemeChanged();

    expect(store.getState().currentToken('diagrams')).toBe(diagramsToken + 1);
    expect(store.getState().currentToken('model')).toBe(modelToken);
    expect(store.getState().currentToken('preview')).toBe(previewToken);
  });

  test('a stale in-flight preview load is DROPPED when superseded by a newer target switch, even if it resolves LAST (seq, not token, orders them)', async () => {
    const { store, lsp, output, loaders } = build();
    // Make the Output/Generated surface "visible" (mirrors the facade's boot seeding) so
    // onPreviewTargetChanged's visibility check actually re-triggers a second loadPreview().
    store.getState().focusPrimary('output');
    store.getState().setOutput('generated');
    const pending: Array<(r: EmitPreviewResult) => void> = [];
    lsp.emitPreview.mockImplementation(
      () =>
        new Promise<EmitPreviewResult>((resolve) => {
          pending.push(resolve);
        }),
    );

    const firstLoad = loaders.loadPreview(); // call #1: the default target (csharp)
    loaders.onPreviewTargetChanged('typescript'); // call #2: supersedes #1 before it resolves
    await flush();
    expect(pending).toHaveLength(2);

    // Resolve the NEWER call (#2) first, then the now-STALE call (#1) last.
    pending[1]({ target: 'typescript', files: [{ path: 'Money.ts', contents: '// ts' }], diagnostics: [], error: null });
    await flush();
    expect(output.setContent).toHaveBeenLastCalledWith('// ts', 'typescript');

    pending[0]({ target: 'csharp', files: [{ path: 'Money.cs', contents: '// stale cs' }], diagnostics: [], error: null });
    await flush();
    await firstLoad;

    // The stale call's content must never have painted, even though it resolved last.
    expect(output.setContent).not.toHaveBeenCalledWith('// stale cs', expect.anything());
    expect(output.setContent).toHaveBeenLastCalledWith('// ts', 'typescript');
  });
});

// --- (e) the Generated facet browses output file-by-file via the tree, not the old flat rail (#871 Task 3) ---
describe('createSurfaceLoaders — the Generated file tree replaces the flat rail (#871 Task 3)', () => {
  test('loadPreview() mounts every emitted file into the tree and shows the FIRST file in the viewer (not a concatenated blob)', async () => {
    const { hosts, lsp, output, loaders } = build();
    lsp.emitPreview.mockResolvedValueOnce({
      target: 'csharp',
      files: [
        { path: 'Billing/Money.cs', contents: '// money' },
        { path: 'Billing/Invoice.cs', contents: '// invoice' },
      ],
      diagnostics: [],
      error: null,
    });

    await loaders.loadPreview();

    // hosts.preview is a REAL <div id="view-preview"> (makeHosts()) that ensureOutputScaffold/the tree
    // mount into for real — query it directly rather than the mocked LSP call.
    const items = hosts.preview.querySelectorAll('[role="treeitem"]');
    expect(items).toHaveLength(3); // the "Billing" folder row + its two file rows
    const fileRows = Array.from(items).filter((el) => (el as HTMLElement).dataset.kind === 'file');
    // The tree sorts files alphabetically within a folder — Invoice.cs before Money.cs — independent of
    // the emitted array's order.
    expect(fileRows.map((el) => (el as HTMLElement).dataset.path)).toEqual(['Billing/Invoice.cs', 'Billing/Money.cs']);

    // The viewer shows the FIRST file in the EMITTED array (Money.cs), not the tree's sorted order, and
    // not a concatenated blob of both.
    expect(output.setContent).toHaveBeenLastCalledWith('// money', 'csharp');
  });

  test('a re-emit that still contains the previously-selected path keeps it selected', async () => {
    const { hosts, lsp, output, loaders } = build();
    lsp.emitPreview.mockResolvedValueOnce({
      target: 'csharp',
      files: [
        { path: 'Billing/Money.cs', contents: '// money v1' },
        { path: 'Billing/Invoice.cs', contents: '// invoice v1' },
      ],
      diagnostics: [],
      error: null,
    });
    await loaders.loadPreview();

    // Select Money.cs via a real click on its treeitem — mirrors a user click routing through the
    // tree's onSelect (wired to showOutputFile), not a reach into module-private state.
    const moneyRow = Array.from(hosts.preview.querySelectorAll<HTMLElement>('[role="treeitem"][data-kind="file"]')).find(
      (el) => el.dataset.path === 'Billing/Money.cs',
    )!;
    moneyRow.click();
    expect(output.setContent).toHaveBeenLastCalledWith('// money v1', 'csharp');

    // Re-emit with the SAME path still present (contents changed) — the selection survives the reload.
    lsp.emitPreview.mockResolvedValueOnce({
      target: 'csharp',
      files: [
        { path: 'Billing/Money.cs', contents: '// money v2' },
        { path: 'Billing/Invoice.cs', contents: '// invoice v2' },
      ],
      diagnostics: [],
      error: null,
    });
    await loaders.loadPreview();

    expect(output.setContent).toHaveBeenLastCalledWith('// money v2', 'csharp');
  });

  test('a re-emit where the previously-selected path is gone falls back to the first file', async () => {
    const { hosts, lsp, output, loaders } = build();
    lsp.emitPreview.mockResolvedValueOnce({
      target: 'csharp',
      files: [
        { path: 'Billing/Money.cs', contents: '// money v1' },
        { path: 'Billing/Invoice.cs', contents: '// invoice v1' },
      ],
      diagnostics: [],
      error: null,
    });
    await loaders.loadPreview();

    const moneyRow = Array.from(hosts.preview.querySelectorAll<HTMLElement>('[role="treeitem"][data-kind="file"]')).find(
      (el) => el.dataset.path === 'Billing/Money.cs',
    )!;
    moneyRow.click();
    expect(output.setContent).toHaveBeenLastCalledWith('// money v1', 'csharp');

    // Re-emit WITHOUT Money.cs — the previously-selected path no longer exists, so the viewer falls
    // back to the (new) first file.
    lsp.emitPreview.mockResolvedValueOnce({
      target: 'csharp',
      files: [{ path: 'Billing/Invoice.cs', contents: '// invoice v2' }],
      diagnostics: [],
      error: null,
    });
    await loaders.loadPreview();

    expect(output.setContent).toHaveBeenLastCalledWith('// invoice v2', 'csharp');
  });
});

// --- (f) Copy file / Copy all (#871 Task 4) --------------------------------
describe('createSurfaceLoaders — Copy file / Copy all (#871 Task 4)', () => {
  beforeEach(() => {
    // The suite's existing clipboard-mocking convention (see exportShare.test.ts).
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => undefined) } });
  });

  test('Copy file is disabled until a file is selected, then writes only the SELECTED file\'s contents', async () => {
    const { hosts, lsp, loaders } = build();
    const copyFileBtn = hosts.preview.querySelector<HTMLButtonElement>('.out-copy-file')!;
    expect(copyFileBtn.textContent).toBe('Copy file');
    expect(copyFileBtn.disabled).toBe(true);

    lsp.emitPreview.mockResolvedValueOnce({
      target: 'csharp',
      files: [
        { path: 'Billing/Money.cs', contents: '// money' },
        { path: 'Billing/Invoice.cs', contents: '// invoice' },
      ],
      diagnostics: [],
      error: null,
    });
    await loaders.loadPreview();
    expect(copyFileBtn.disabled).toBe(false);

    copyFileBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('// money'); // the first/selected file only
    expect(navigator.clipboard.writeText).not.toHaveBeenCalledWith(expect.stringContaining('invoice'));
  });

  test('Copy file proceeds (writeText("")) for a genuinely empty-content file — code-review fix: the old ' +
    'guard read getText() truthiness, so an empty file (e.g. the Python emitter\'s always-empty py.typed ' +
    'marker) silently no-op\'d a click even though the button was enabled', async () => {
    const { hosts, lsp, loaders } = build();
    lsp.emitPreview.mockResolvedValueOnce({
      target: 'python',
      files: [{ path: 'py.typed', contents: '' }],
      diagnostics: [],
      error: null,
    });
    await loaders.loadPreview();
    const copyFileBtn = hosts.preview.querySelector<HTMLButtonElement>('.out-copy-file')!;
    expect(copyFileBtn.disabled).toBe(false); // the file IS selected — the button's gate is disabled state

    copyFileBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('');
    expect(copyFileBtn.textContent).toBe('Copied ✓');
  });

  test('Copy all is disabled with no files, then writes every file\'s content joined as "// ==== path ===="', async () => {
    const { hosts, lsp, loaders } = build();
    const copyAllBtn = hosts.preview.querySelector<HTMLButtonElement>('.out-copy-all')!;
    expect(copyAllBtn.textContent).toBe('Copy all');
    expect(copyAllBtn.disabled).toBe(true);

    lsp.emitPreview.mockResolvedValueOnce({
      target: 'csharp',
      files: [
        { path: 'Billing/Money.cs', contents: '// money' },
        { path: 'Billing/Invoice.cs', contents: '// invoice' },
      ],
      diagnostics: [],
      error: null,
    });
    await loaders.loadPreview();
    expect(copyAllBtn.disabled).toBe(false);

    copyAllBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      '// ==== Billing/Money.cs ====\n// money\n\n// ==== Billing/Invoice.cs ====\n// invoice',
    );
  });

  test('Copy all becomes disabled again once an emit error empties lastFiles', async () => {
    const { hosts, lsp, loaders } = build();
    lsp.emitPreview.mockResolvedValueOnce({
      target: 'csharp',
      files: [{ path: 'Billing/Money.cs', contents: '// money' }],
      diagnostics: [],
      error: null,
    });
    await loaders.loadPreview();
    const copyAllBtn = hosts.preview.querySelector<HTMLButtonElement>('.out-copy-all')!;
    expect(copyAllBtn.disabled).toBe(false);

    lsp.emitPreview.mockResolvedValueOnce({ target: 'csharp', files: [], diagnostics: [], error: 'emit exploded' });
    await loaders.loadPreview();
    expect(copyAllBtn.disabled).toBe(true);
  });

  test('Copy file flashes "Copied ✓" then resets to "Copy file" after 1600ms', async () => {
    vi.useFakeTimers();
    const { hosts, lsp, loaders } = build();
    lsp.emitPreview.mockResolvedValueOnce({
      target: 'csharp',
      files: [{ path: 'Billing/Money.cs', contents: '// money' }],
      diagnostics: [],
      error: null,
    });
    await loaders.loadPreview();
    const copyFileBtn = hosts.preview.querySelector<HTMLButtonElement>('.out-copy-file')!;

    copyFileBtn.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(copyFileBtn.textContent).toBe('Copied ✓');

    await vi.advanceTimersByTimeAsync(1600);
    expect(copyFileBtn.textContent).toBe('Copy file');
  });
});

// --- (g) the file-count header restores an issue requirement Task 3 dropped (#871 Task 4) ---
describe('createSurfaceLoaders — file-count header restores a dropped issue requirement (#871 Task 4)', () => {
  test('loadPreview paints "N files" above the tree', async () => {
    const { hosts, lsp, loaders } = build();
    lsp.emitPreview.mockResolvedValueOnce({
      target: 'csharp',
      files: [
        { path: 'Billing/Money.cs', contents: '// money' },
        { path: 'Billing/Invoice.cs', contents: '// invoice' },
      ],
      diagnostics: [],
      error: null,
    });

    await loaders.loadPreview();

    expect(hosts.preview.querySelector('.out-railhead')!.textContent).toBe('2 files');
  });

  test('an emit error clears the file-count header', async () => {
    const { hosts, lsp, loaders } = build();
    lsp.emitPreview.mockResolvedValueOnce({
      target: 'csharp',
      files: [{ path: 'Billing/Money.cs', contents: '// money' }],
      diagnostics: [],
      error: null,
    });
    await loaders.loadPreview();
    expect(hosts.preview.querySelector('.out-railhead')!.textContent).toBe('1 file');

    lsp.emitPreview.mockResolvedValueOnce({ target: 'csharp', files: [], diagnostics: [], error: 'boom' });
    await loaders.loadPreview();
    expect(hosts.preview.querySelector('.out-railhead')!.textContent).toBe('');
  });
});

// --- additional coverage: the other moved loaders, in isolation ---
describe('createSurfaceLoaders — loadModel wires the injected hooks (ensureModelIndex/onModelIndexRebuilt/ensureDomainNavigator stay facade-owned)', () => {
  test('mounts/reloads the Domain navigator, awaits the model index, then repaints via onModelIndexRebuilt and marks the token loaded', async () => {
    const { store, hooks, loaders } = build();
    const token = store.getState().currentToken('model');

    await loaders.loadModel();

    expect(hooks.ensureDomainNavigator).toHaveBeenCalledTimes(1);
    expect(hooks.ensureModelIndex).toHaveBeenCalledTimes(1);
    expect(hooks.onModelIndexRebuilt).toHaveBeenCalledTimes(1);
    expect(store.getState().isStale('model')).toBe(false);
    expect(store.getState().currentToken('model')).toBe(token);
  });

  test('a failing ensureModelIndex surfaces via deps.setStatus and never marks the token loaded', async () => {
    const hooks = makeHooks({ ensureModelIndex: vi.fn(async () => { throw new Error('boom'); }) });
    const deps = makeDeps();
    const { store, loaders } = build({ hooks, deps });

    await loaders.loadModel();

    expect(deps.setStatus).toHaveBeenCalledWith(expect.stringContaining('Model request failed'), 'error');
    expect(store.getState().isStale('model')).toBe(true);
  });
});

describe('createSurfaceLoaders — invalidateDocViews', () => {
  test('bumps every docViews key, drops the facade caches via the hook, and stales the bottom tables', () => {
    const { store, hooks, loaders } = build();
    const before = {
      preview: store.getState().currentToken('preview'),
      events: store.getState().currentToken('events'),
    };

    loaders.invalidateDocViews();

    // The all-keys invalidate() bumps preview once; invalidateBottomPanels() ALSO bumps 'events' again
    // on top of that (the same double-bump the original facade code had for the three bottom-table
    // keys) — assert "increased" rather than an exact count, since the precise amount is an incidental
    // implementation detail, not a meaningful contract.
    expect(store.getState().currentToken('preview')).toBeGreaterThan(before.preview);
    expect(store.getState().currentToken('events')).toBeGreaterThan(before.events);
    expect(store.getState().isStale('preview')).toBe(true);
    expect(store.getState().isStale('events')).toBe(true);
    expect(hooks.invalidateModelDerivedCaches).toHaveBeenCalledTimes(1);
  });
});

describe('createSurfaceLoaders — ADR/Notes are folder-derived and module-local (never joining the all-keys invalidate)', () => {
  test('isAdrLoaded/isNotesLoaded flip true once each loader completes, independent of docViews', async () => {
    const { loaders } = build();
    expect(loaders.isAdrLoaded()).toBe(false);
    expect(loaders.isNotesLoaded()).toBe(false);

    await loaders.loadAdr();
    await loaders.loadNotes();

    expect(loaders.isAdrLoaded()).toBe(true);
    expect(loaders.isNotesLoaded()).toBe(true);
  });

  test('invalidateDocViews (a .koi model edit) does NOT reset the ADR/Notes loaded flags', async () => {
    const { loaders } = build();
    await loaders.loadAdr();
    await loaders.loadNotes();

    loaders.invalidateDocViews();

    expect(loaders.isAdrLoaded()).toBe(true);
    expect(loaders.isNotesLoaded()).toBe(true);
  });

  test('invalidateDocsPanel (a folder switch) DOES reset both flags', async () => {
    const { loaders } = build();
    await loaders.loadAdr();
    await loaders.loadNotes();

    loaders.invalidateDocsPanel();

    expect(loaders.isAdrLoaded()).toBe(false);
    expect(loaders.isNotesLoaded()).toBe(false);
  });
});

describe('createSurfaceLoaders — runCheck / renderCheckIdleIfEmpty', () => {
  test('renderCheckIdleIfEmpty paints the idle state once and is a no-op once content exists', () => {
    const { hosts, loaders } = build();
    loaders.renderCheckIdleIfEmpty();
    expect(hosts.check.querySelector('.koi-check-idle')).not.toBeNull();

    hosts.check.innerHTML = '<p>a result</p>';
    loaders.renderCheckIdleIfEmpty(); // must not clobber existing content
    expect(hosts.check.innerHTML).toBe('<p>a result</p>');
  });

  test('a cancelled folder picker aborts silently without switching the Output tab', async () => {
    const platform = fakePlatform({ pickFolder: vi.fn(async () => null) });
    const { store, loaders } = build({ platform });
    store.getState().setOutput('generated');

    await loaders.runCheck();

    expect(store.getState().output).toBe('generated'); // never switched — cancelled
  });

  test('a picked baseline runs the check, switches to Compatibility, and paints the result', async () => {
    const platform = fakePlatform({ pickFolder: vi.fn(async () => '/baseline') });
    const { store, hosts, loaders } = build({ platform });

    await loaders.runCheck();

    expect(store.getState().output).toBe('compatibility');
    expect(hosts.check.innerHTML).toContain('koi-md');
  });
});
