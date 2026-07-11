// The lazily-loaded, model-/folder-derived SURFACE LOADERS — extracted from inspectorController (Task 3
// of #985's decomposition). Owns every panel that fetches on first show and re-fetches on staleness: the
// Generated preview (+ its Copy affordance and Output rail), the diagram, the glossary, the left-rail
// model index build, the ADR + Notes docs pages, the Source Control panel (+ its live dirty-count and
// refresh-on-save repaint), the bottom-strip Events/Relationships tables, and the on-demand Compatibility
// check. It also owns the two invalidation disciplines that keep them all in sync with the model: the
// docViews slice's per-key stale-token (glossary/model/preview/diagrams/events/relationships/contextmap)
// and the debounced doc-edit repaint (`onDocEdited`, now riding the docViews slice's OWN `scheduleRefresh`
// — see `store/slices/docViews.ts:31` — rather than a local timer).
//
// guardedLoad-vs-seq (see `shell/guardedLoad.ts`'s doc comment): the glossary, model, ADR/Notes, Source
// Control, and Events/Relationships loaders gate on the docViews slice's per-key stale TOKEN (guardedLoad,
// or an equivalent hand-rolled check for the ones with a bespoke shape). The diagram and preview loaders
// deliberately do NOT — each keeps its OWN local monotonic sequence (diagramsGen / previewGen), because a
// theme flip or a destination-language switch must re-render WITHOUT bumping the docViews token (bumping
// it would also force every SIBLING doc — the other of the preview/diagram pair — to invalidate, which a
// theme flip or a language switch must not do). Preserve this split; do not collapse it into one mechanism.
//
// Deliberately standalone, like Task 1's contextMapPanel.tsx and Task 2's activeContextController.ts: this
// module never imports `@/shell/inspectorController` (the facade wires it in, never the reverse) and never
// imports the sibling task modules (contextMapPanel.tsx / activeContextController.ts) — sub-modules don't
// import each other; only the facade wires cross-module effects, here via the injected `hooks`. Three
// pieces of state are deliberately NOT owned here even though a naive read of "the loaders" might expect
// them: `ensureModelIndex`/`modelIndex`/`indexPromise` stay in the facade (a SELECTION concern — the
// joined model index the diagram click / outline / Properties inspector resolve names against — not a
// loader concern), reached here only through the injected `hooks.ensureModelIndex()`. The folder-derived
// `adrLoaded`/`notesLoaded`/`sourceControlLoaded` flags below are the mirror image: they stay MODULE-LOCAL
// to this file and are never added to the docViews slice's all-keys `invalidate()` sweep — a `.koi` model
// edit must not stale the ADR/Notes/Source-Control pages, which only reload on their own folder-derived
// triggers (`invalidateDocsPanel`, a folder switch, or their own in-panel create/save).
import { render, type VNode } from 'preact';
import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import type { OutputView } from '@/editor/editor';
import { renderMarkdown } from '@/editor/editor';
import type { Platform } from '@/host';
import type { PreviewTarget } from '@/settings/persistence';
import { currentTheme } from '@/settings/theme';
import { renderDiagrams, renderEventFlowGraph, type EventFlowGraphHandle } from '@/diagrams/diagrams';
import { setDiagramLayoutStore, setDiagramPersistScope } from '@/diagrams/diagramContract';
import { createLayoutStore } from '@/diagrams/layoutStore';
import { extractEventFlow, mergeDiagramGraphs, type TableHandlers } from '@/model/modelTables';
import { isAllContexts, scopeDocsFiles, scopeGraph } from '@/model/activeContext';
import { SourceControlPanel, type SourceControlFocus } from '@/model/SourceControlPanel';
import type { ModelIndex } from '@/model/modelIndex';
import { createDocsStore } from '@/docs/docsStore';
import { AdrPanel, NotesPanel, type DocsPanelHandlers } from '@/docs/DocsPanels';
import {
  DocsPanelHost,
  EventsPanel,
  GlossaryPanel,
  RelationshipsPanel,
  type FlowRenderer,
  type GlossaryHandlers,
} from '@atypical/koine-ui';
import {
  createDocsPanelHostStore,
  createEventsPanelStore,
  createGlossaryPanelStore,
  createRelationshipsPanelStore,
} from '@/store/readableStores';
import { guardedLoad } from '@/shell/guardedLoad';
import { makeCopyButton } from '@/shell/copyFeedback';
import { renderCheckMarkdown } from '@/shell/ideUtils';
import { createLifecycleGuard } from '@/shared/lifecycleGuard';
import { contextWorkspaceKey, docMessage, visibleCenters as deckVisibleCenters } from '@/shell/inspector/shared';
import { ensureOutputScaffold, renderOutputCrumb, renderOutputRailHead, type OutputScaffold } from '@/shell/outputRail';
import { createGeneratedFileTree } from '@/shell/output/generatedFileTree';
import type { EmitFile } from '@/lsp/protocol';
import type { BottomTab, CenterView } from '@/store/slices/uiChrome';
import type {
  CheckResult,
  DiagramGraph,
  DocsResult,
  EmitPreviewResult,
  GlossaryEntry,
  GlossaryModel,
  SourceSpan,
} from '@/lsp/lsp';

/** The narrow LSP surface this module needs — the content fetches its loaders call. A structural subset
 *  of `InspectorControllerLsp`, defined locally (not imported) so this module never depends on the
 *  facade; any object with matching methods (including the real `InspectorControllerLsp`) satisfies it. */
export interface SurfaceLoadersLsp {
  glossaryModel(): Promise<GlossaryModel>;
  livingDocs(): Promise<DocsResult>;
  emitPreview(target: PreviewTarget): Promise<EmitPreviewResult>;
  check(baseline: string, baselineSources?: { uri: string; text: string }[]): Promise<CheckResult>;
}

/** The DOM hosts this module paints into — owned/looked-up by the facade (mirroring Task 1's single
 *  `host: HTMLElement`, pluralised here since this module owns many panels), injected so this module
 *  never does its own `domById` lookups. */
export interface SurfaceLoadersHosts {
  preview: HTMLElement;
  diagrams: HTMLElement;
  glossary: HTMLElement;
  adr: HTMLElement;
  notes: HTMLElement;
  sourceControl: HTMLElement;
  events: HTMLElement;
  relationships: HTMLElement;
  check: HTMLElement;
}

/** The write-path / accessor callbacks this module needs from `InspectorControllerDeps` — a locally
 *  redeclared structural subset (not a literal `Pick<InspectorControllerDeps, …>`, which would import the
 *  facade), mirroring how `ActiveContextControllerDeps` redeclares its own subset of the same fields. */
export interface SurfaceLoadersDeps {
  /** The opened-folder token (or '' in no-folder mode) — keys the docs/git/diagram-layout hosts. */
  folderRootToken(): string;
  /** Write the action-feedback pill (a loader failure that has no better in-panel home routes here). */
  setStatus(text: string, kind: 'error'): void;
  /** Persist a glossary concept's `///` description; the promise lets the glossary pane surface a
   *  failure inline (the original error home). */
  onSaveGlossaryDescription(entry: GlossaryEntry, text: string): Promise<void>;
  /** Persist every dirty editor buffer (#109's Save-all) — the Source Control panel's save-all-before-
   *  commit prompt (#470). */
  saveAllDirty(): Promise<void>;
  /** Jump to a RAW 1-based source span — the bottom tables' row click. */
  gotoSourceSpan(span: Pick<SourceSpan, 'file' | 'line' | 'column' | 'endLine' | 'endColumn'>): void;
  /** Jump the editor to an LSP range (0-based) — the glossary term list's jump-to-source. */
  gotoRange(start: { line: number; character: number }, end: { line: number; character: number }): void;
}

/** The cross-module effects a loader needs but doesn't own — every one of these is either facade-private
 *  state (the joined model index, the Domain navigator, the assistant's domain-index cache) or a call
 *  into a SIBLING task module (Task 1's contextMapPanel, Task 2's activeContextController) that this
 *  module must never import directly. Grouping mirrors the brief's summary; "hasModelIndex" folds into
 *  `ensureDomainNavigator` (the facade decides mount-vs-reload itself, since only it knows whether the
 *  index it holds is fresh) rather than being a separate accessor. */
export interface SurfaceLoadersHooks {
  /** Build (or reuse) the joined model index (`ensureModelIndex`/`modelIndex`/`indexPromise` stay in the
   *  facade — a selection concern, not a loader concern). */
  ensureModelIndex(): Promise<ModelIndex>;
  /** Repaint the model-index-derived chrome once the index has (re)built: the construct palette's
   *  aggregate gating, the Properties inspector, and the diagram/outline cross-highlight — the facade's
   *  `renderCanvasPalette`/`renderSelectedInspector`/`applySelectionHighlight` tail of the old loadModel. */
  onModelIndexRebuilt(): void;
  /** Mount the Domain navigator on first load, or reload its strategic data when the model was rebuilt.
   *  The facade owns the mount node, the mounted handle, and the navigator's selection/goto handlers. */
  ensureDomainNavigator(): void;
  /** Drop the facade's own model-derived caches (the joined model index, its in-flight builder, and the
   *  assistant's domain index) — called once per invalidateDocViews(), alongside this module's token bump. */
  invalidateModelDerivedCaches(): void;
  /** Refresh the Code surface's Scenario runner if it's the active sub-view (chrome-owned; not a
   *  docViews-gated surface, so it's a facade concern like the rest of `ensureVisibleLoaded`). */
  ensureTechLoaded(): void;
  /** Refresh the Output surface's active sub-view: the Generated preview / Compatibility idle state (this
   *  module) or the Context Map (Task 1's contextMapPanel) — a cross-module call only the facade can make. */
  ensureOutputLoaded(): void;
  /** Refresh the given bottom-strip tab if it needs it: Events/Relationships (this module) or the
   *  lazily-created Terminal/Review panels (facade-owned). */
  ensureBottomLoaded(tab: BottomTab): void;
  /** Reload the Syntax Tree right-rail panel (facade-owned mount + revision counter; untouched by Task 3). */
  loadSyntaxTree(): void;
  /** Refresh the bounded-context switcher's option list from the just-edited model (Task 2's
   *  activeContextController) — a cross-module call the facade wires in. */
  refreshContextList(): Promise<void>;
}

export interface SurfaceLoadersOptions {
  store: StoreApi<AppState>;
  lsp: SurfaceLoadersLsp;
  /** The read-only output viewer in #view-preview (owned by the facade; the Generated preview writes here). */
  output: OutputView;
  platform: Platform;
  hosts: SurfaceLoadersHosts;
  deps: SurfaceLoadersDeps;
  hooks: SurfaceLoadersHooks;
}

export interface SurfaceLoaders {
  loadPreview(): Promise<void>;
  loadDiagrams(): Promise<void>;
  loadGlossary(): Promise<void>;
  loadModel(): Promise<void>;
  loadAdr(host?: HTMLElement): Promise<void>;
  loadNotes(host?: HTMLElement): Promise<void>;
  loadSourceControl(): void;
  loadEventsPanel(): Promise<void>;
  loadRelationshipsPanel(): Promise<void>;
  runCheck(): Promise<void>;
  renderCheckIdleIfEmpty(): void;
  refreshSourceControl(): void;
  invalidateDocViews(): void;
  invalidateDocsPanel(): void;
  invalidateBottomPanels(): void;
  onDocEdited(): void;
  onThemeChanged(): void;
  setTarget(target: PreviewTarget): void;
  onPreviewTargetChanged(target: PreviewTarget): void;
  refreshActiveSurfaces(): void;
  /** Whether the ADR page has painted for the current folder — the facade's `ensureDocsLoaded` gate
   *  (the flag itself is module-local, per the folder-derived-flags constraint). */
  isAdrLoaded(): boolean;
  isNotesLoaded(): boolean;
  /** Stash a launcher focus (#1165) for the Source Control panel's NEXT paint — the facade's `selectRight`
   *  calls this before switching to the source-control right view. */
  focusSourceControl(focus: SourceControlFocus): void;
  /** Stash + apply a launcher scroll-to-term (#1165) for the glossary — the facade's `selectDocsTab` calls
   *  this when a term accompanies the tab switch. */
  scrollGlossaryToTerm(term: string): void;
  /** Repaint the Output rail's scope EMPHASIS (ADR 0009) from the already-fetched preview, without a
   *  re-emit — the facade's `rerenderScopedSurfaces` calls this after a scope change. */
  refreshOutputRailScope(): void;
  /** Cancel pending debounce timers and drop this module's own store subscription. */
  dispose(): void;
}

export function createSurfaceLoaders(options: SurfaceLoadersOptions): SurfaceLoaders {
  const { store, lsp, output, platform, hosts, deps, hooks } = options;

  // Mirrors the facade's own lifecycle guard (#1002): lifecycle.dispose() is called as dispose()'s first
  // statement, so a loader continuation racing teardown (or a debounced repaint) observes it before
  // touching a dead host.
  const lifecycle = createLifecycleGuard();

  // The center surfaces visible under the current deck state — the shared pure `deck` read (#1262,
  // formerly this module's own copy, mirroring centerDeckController's), bound to this module's store here
  // so the loaders' zero-arg call sites are unchanged.
  function visibleCenters(): CenterView[] {
    return deckVisibleCenters(store.getState().deck);
  }

  // The Preact counterpart to docMessage: paint a panel into a host that may currently hold the raw
  // docMessage <p>. Dropping any prior Preact tree AND any raw write FIRST makes the fresh render replace
  // the loading line, not stack on it.
  function renderPanel(view: HTMLElement, vnode: VNode): void {
    render(null, view);
    view.innerHTML = '';
    render(vnode, view);
  }

  // --- emitted-code preview (+ the Output rail / Copy affordance) ------------
  const TARGET_LABEL: Record<string, string> = {
    csharp: 'C#',
    typescript: 'TypeScript',
    python: 'Python',
    php: 'PHP',
    rust: 'Rust',
  };
  const targetLabel = (t: string): string => TARGET_LABEL[t] ?? t.toUpperCase();

  // The Output surface's "Generated" facet: a nested folder tree (#871) beside a single-file viewer
  // (concept-7 "Flush"). The scaffold is idempotent (ensureOutputScaffold), so this and the facade's own
  // OutputView mount can both build it, in either order. The tree is built once and mounted into the rail
  // right after the scaffold — mirrors how `copyBtn` below is appended into `outputScaffold.crumb`.
  const outputScaffold: OutputScaffold = ensureOutputScaffold(hosts.preview);
  const outputTree = createGeneratedFileTree({ onSelect: showOutputFile });
  outputScaffold.rail.appendChild(outputTree.element);
  let lastFiles: EmitFile[] = [];
  let selectedOutputPath: string | null = null;

  // The shared write-clipboard / flash-label / reset-after-1600ms sequence Copy file and Copy all both
  // need is the `@/shell/copyFeedback` module's `makeCopyButton` (#1362 — extracted from here, since
  // `mcp.ts` reinvented the same idiom twice more with no shared helper anywhere in the package).
  // Derived fresh from lastFiles at click time, like copyAll's getText below — replaces the redundant
  // `lastPreview` mirror this used to read (code-review fix).
  const copyFile = makeCopyButton('out-copy out-copy-file', 'Copy file', 'Copy this file', () =>
    lastFiles.find((f) => f.path === selectedOutputPath)?.contents ?? '',
  );
  const copyBtn = copyFile.el;
  // Copies every emitted file, `// ==== path ====`-delimited — the format the facet's pre-tree "copy
  // everything" flow used to produce (the issue's problem statement), still what a "copy all" click means.
  const copyAll = makeCopyButton('out-copy out-copy-all', 'Copy all', 'Copy every generated file', () =>
    lastFiles.map((f) => `// ==== ${f.path} ====\n${f.contents}`).join('\n\n'),
  );
  const copyAllBtn = copyAll.el;
  outputScaffold.crumb.append(copyBtn, copyAllBtn);

  // The effective emit target now lives ONLY in the shared store's `emitTarget` slice (#923's top-bar
  // mirror) — there is no more closure-local `currentTarget` shadowing it. `setTarget` writes through
  // `setEmitTarget` and every reader below (`loadPreview`, `showOutputFile`, `onPreviewTargetChanged`)
  // reads `store.getState().emitTarget` fresh, so the preview loader and the top-bar selector /
  // status-bar echo can never drift apart.
  function setTarget(target: PreviewTarget): void {
    store.getState().setEmitTarget(target);
  }

  // Show one generated file in the viewer and reflect it in the tree + crumb + Copy button.
  function showOutputFile(path: string): void {
    const f = lastFiles.find((x) => x.path === path);
    if (!f) return;
    selectedOutputPath = path;
    output.setContent(f.contents, store.getState().emitTarget);
    copyBtn.disabled = false;
    renderOutputCrumb(outputScaffold, path, targetLabel(store.getState().emitTarget));
    outputTree.selectPath(path);
  }

  // Clear the tree/crumb/viewer to a message (error / empty / failure states).
  function clearOutput(message: string): void {
    lastFiles = [];
    selectedOutputPath = null;
    copyBtn.disabled = true;
    copyAllBtn.disabled = true;
    outputTree.setFiles([]); // hides the tree entirely (Task 2's empty-input behavior)
    renderOutputRailHead(outputScaffold, 0);
    renderOutputCrumb(outputScaffold, null, '');
    output.setContent(message, 'plain');
  }

  // Fetch the DocsEmitter output (Mermaid-in-Markdown) and render it. The loaded/stale GATE is the
  // docViews slice's 'preview' key (markLoaded only takes if the captured token is still current). A local
  // monotonic sequence (`previewGen`) is kept ALONGSIDE it because a destination-language switch re-emits
  // WITHOUT bumping the slice token (see the module doc's guardedLoad-vs-seq split): the seq drops a stale
  // emit a newer call (edit or target switch) superseded. The prior output stays on screen across a
  // refresh (only the very first load shows a placeholder) so live typing never flashes the pane empty.
  const previewGen = lifecycle.createSequence();
  async function loadPreview(): Promise<void> {
    const seq = previewGen.next();
    const token = store.getState().currentToken('preview');
    if (!lastFiles.length) output.setContent('// generating preview…', 'plain');
    try {
      const res = await lsp.emitPreview(store.getState().emitTarget);
      // isCurrent() already folds in disposed — torn down mid-fetch (#1002) or superseded by a newer
      // call, either way no repaint on behalf of a dead/stale controller.
      if (!previewGen.isCurrent(seq)) return;
      if (res.error) {
        clearOutput('// emit error\n' + res.error);
      } else if (!res.files.length) {
        clearOutput('// no files emitted (fix diagnostics first)');
      } else {
        lastFiles = res.files;
        copyAllBtn.disabled = false;
        renderOutputRailHead(outputScaffold, lastFiles.length);
        outputTree.setFiles(lastFiles); // BEFORE showOutputFile, so selectPath has nodes to find
        const keep = selectedOutputPath && lastFiles.some((f) => f.path === selectedOutputPath);
        showOutputFile(keep ? selectedOutputPath! : lastFiles[0].path);
      }
      store.getState().markLoaded('preview', token);
    } catch (e) {
      if (!previewGen.isCurrent(seq)) return;
      clearOutput('// preview request failed\n' + String(e));
    }
  }

  // Adopt a destination-language change from Settings → Output: relabel the tab, mark the preview stale,
  // and re-emit it when the Generated sub-view is the one showing (else it reloads next open). A
  // destination-language switch re-emits ONLY the preview (not a model edit), so this marks just the
  // 'preview' key stale — the docViews token is deliberately left UNCHANGED for every other surface, and
  // the seq (not the token) is what drops a superseded emit — see the module doc.
  function onPreviewTargetChanged(target: PreviewTarget): void {
    if (target === store.getState().emitTarget) return;
    setTarget(target);
    store.getState().invalidate('preview');
    if (visibleCenters().includes('output') && store.getState().output === 'generated') void loadPreview();
  }

  // --- live diagrams ---------------------------------------------------------
  // The loaded/stale GATE is the docViews slice's 'diagrams' key. A local monotonic sequence (`diagramsGen`)
  // is kept ALONGSIDE it because a theme flip / refresh re-renders the diagram WITHOUT bumping the slice
  // token (those aren't model edits) — see the module doc's guardedLoad-vs-seq split.
  const diagramsGen = lifecycle.createSequence();
  async function loadDiagrams(): Promise<void> {
    const seq = diagramsGen.next();
    const token = store.getState().currentToken('diagrams');
    docMessage(hosts.diagrams, 'Rendering diagrams…');
    try {
      const res = await lsp.livingDocs();
      // isCurrent() already folds in disposed — torn down mid-fetch (#1002) or superseded by a newer
      // call, either way no repaint on behalf of a dead/stale controller.
      if (!diagramsGen.isCurrent(seq)) return;
      // Scope the diagrams to the active bounded context (#146): each diagram's graph is narrowed and
      // emptied diagrams/files drop out, so a context shows only its own diagrams. "All" is the identity.
      const files = scopeDocsFiles(res.files, store.getState().activeContext);
      // Scope persisted node positions to this workspace so a folder restores its own manual layout, and
      // inject the matching layout store: a committable koine.layout.json at the folder root when one is
      // open, else browser storage (web/scratch mode).
      setDiagramPersistScope(contextWorkspaceKey(deps.folderRootToken()));
      setDiagramLayoutStore(createLayoutStore(platform, deps.folderRootToken()));
      // renderDiagrams itself suspends again internally (a dynamic import, a layout-store load) before it
      // mounts into diagramsView — its own `isCurrent` gate must also see the lifecycle guard's disposed
      // state, not just the local seq, or a resolving mount still lands in the torn-down host (#1002).
      await renderDiagrams(hosts.diagrams, files, currentTheme(), () => diagramsGen.isCurrent(seq));
      // The render above can itself suspend — re-check before marking loaded (isCurrent() covers both
      // disposed-mid-render and superseded-mid-render).
      if (diagramsGen.isCurrent(seq)) store.getState().markLoaded('diagrams', token);
    } catch (e) {
      if (diagramsGen.isCurrent(seq)) docMessage(hosts.diagrams, 'Diagrams request failed: ' + String(e), 'error');
    }
  }

  // Diagrams are rendered with a theme-matched Mermaid palette; re-render on a theme flip. Mark the cached
  // diagram stale (so a not-visible one re-renders themed on its next visit) and re-render immediately when
  // the visual center is showing — a visible SECONDARY canvas (2-up / overview) must re-theme too, so
  // visibleCenters, not just the primary.
  function onThemeChanged(): void {
    store.getState().invalidate('diagrams');
    if (visibleCenters().includes('visual')) void loadDiagrams();
  }

  // --- glossary (the ubiquitous-language editor, #67) ------------------------
  // The last-rendered glossary model + the pending scroll-to-term (#1165), so a launcher "Open glossary"
  // can re-scroll an ALREADY-loaded glossary (no refetch) as well as a freshly-loaded one.
  let lastGlossaryModel: GlossaryModel | null = null;
  let glossaryScrollTerm: string | undefined;
  let glossaryScrollNonce = 0;
  function renderGlossaryPanel(model: GlossaryModel): void {
    renderPanel(
      hosts.glossary,
      <GlossaryPanel
        store={createGlossaryPanelStore(store, model)}
        handlers={glossaryHandlers}
        scrollToTerm={glossaryScrollTerm}
        scrollNonce={glossaryScrollNonce}
      />,
    );
    // One-shot: renderPanel REMOUNTS GlossaryPanel (its per-instance nonce guard resets), so a term left
    // set here would re-scroll on EVERY later reload (a model edit, a scope change). Clear it now that this
    // render has consumed it — only a fresh scrollGlossaryToTerm sets it again.
    glossaryScrollTerm = undefined;
  }
  async function loadGlossary(): Promise<void> {
    await guardedLoad({
      store,
      key: 'glossary',
      isDisposed: lifecycle.isDisposed,
      loading: () => docMessage(hosts.glossary, 'Loading glossary…'),
      fetch: () => lsp.glossaryModel(),
      render: (model) => {
        lastGlossaryModel = model;
        if (!model.entries.length) {
          docMessage(hosts.glossary, 'No concepts yet — declare some types, or fix syntax errors to populate the glossary.');
        } else {
          renderGlossaryPanel(model);
        }
      },
      onError: (e) => docMessage(hosts.glossary, 'Glossary request failed: ' + String(e), 'error'),
    });
  }
  // Wires the pure (testable) glossary view to the editor + LSP: jump-to-source (here) and persist-a-
  // description (the facade's write path, injected).
  const glossaryHandlers: GlossaryHandlers = {
    onGoto: (range) => deps.gotoRange(range.start, range.end),
    onSave: (entry, text) =>
      void deps
        .onSaveGlossaryDescription(entry, text)
        .catch((e) => docMessage(hosts.glossary, 'Saving description failed: ' + String(e), 'error')),
  };
  // A launcher scroll-to-term (#1165): stash it (bump the nonce so the panel applies it once). If the
  // glossary is already loaded + fresh, re-render it now with the new target (no refetch); otherwise the
  // lazy load renders it with the target.
  function scrollGlossaryToTerm(term: string): void {
    glossaryScrollTerm = term;
    glossaryScrollNonce += 1;
    if (lastGlossaryModel?.entries.length && !store.getState().isStale('glossary')) {
      renderGlossaryPanel(lastGlossaryModel);
    }
  }

  // --- the left-rail model index build (Domain navigator + selection chrome) -
  // Repaints the Domain axis's strategic/tactical navigator + the model-index-derived chrome (palette,
  // inspector, cross-highlight) via the injected hooks — `ensureModelIndex`/the index itself stay a
  // facade/selection concern (see the module doc).
  async function loadModel(): Promise<void> {
    // Capture the 'model' stale-token before the await; markLoaded only takes if it's still current after,
    // so an edit mid-fetch leaves the surface stale for the next show (the slice discipline).
    const token = store.getState().currentToken('model');
    hooks.ensureDomainNavigator();
    try {
      await hooks.ensureModelIndex();
      if (lifecycle.isDisposed()) return; // torn down mid-fetch (#1002) — no repaint on behalf of a dead controller
      hooks.onModelIndexRebuilt();
      store.getState().markLoaded('model', token);
    } catch (e) {
      if (lifecycle.isDisposed()) return;
      deps.setStatus('Model request failed: ' + String(e), 'error');
    }
  }

  // --- Decisions (ADR) & Notes documentation surfaces (#174, #193) ----------
  // Two independent folder-derived pages: each is NOT invalidated by `.koi` edits, lazily loads on its
  // first tab open, and reloads only on a workspace folder change (the <DocsPanelHost> contract). The
  // mount nodes are captured here so the lazy first-load + in-panel create/save reloads paint into the
  // same node without re-fetching. `adrLoaded`/`notesLoaded` are folder-derived flags — MODULE-LOCAL,
  // never joining the docViews slice's all-keys invalidate() sweep (see the module doc).
  let adrMount: HTMLElement | null = null;
  let notesMount: HTMLElement | null = null;
  let adrLoaded = false;
  let notesLoaded = false;
  const docsFail = (verb: string) => (e: unknown) => deps.setStatus(`Could not ${verb}: ${String(e)}`, 'error');

  // One handlers object the two pages share: each create resets only its OWN page's loaded flag and
  // repaints just that page (saves are in-place and need no reload).
  function docsHandlers(docsStore: ReturnType<typeof createDocsStore>): DocsPanelHandlers {
    return {
      onCreateAdr: (title) =>
        void docsStore.createAdr(title).then(() => { adrLoaded = false; void loadAdr(); }).catch(docsFail('create the ADR')),
      onSaveAdr: (file, adr) => void docsStore.saveAdr(file.token, adr).catch(docsFail('save the ADR')),
      onCreateNote: (title) =>
        void docsStore.createNote(title).then(() => { notesLoaded = false; void loadNotes(); }).catch(docsFail('create the note')),
      onReadNote: (file) => docsStore.readNote(file.token),
      onSaveNote: (file, md) => void docsStore.saveNote(file.token, md).catch(docsFail('save the note')),
    };
  }

  async function loadAdr(host?: HTMLElement): Promise<void> {
    const target = host ?? adrMount;
    if (!target) return; // the host hasn't mounted yet
    const docsStore = createDocsStore(platform, deps.folderRootToken());
    docMessage(target, 'Loading decisions…');
    try {
      const adrs = await docsStore.listAdrs();
      if (lifecycle.isDisposed()) return; // torn down mid-fetch (#1002) — no write into the dead host
      renderPanel(
        target,
        <AdrPanel data={{ canWrite: docsStore.canWrite, adrs, notes: [], renderMarkdown }} handlers={docsHandlers(docsStore)} />,
      );
      adrLoaded = true;
    } catch (e) {
      if (lifecycle.isDisposed()) return;
      docMessage(target, 'Decisions request failed: ' + String(e), 'error');
    }
  }

  async function loadNotes(host?: HTMLElement): Promise<void> {
    const target = host ?? notesMount;
    if (!target) return; // the host hasn't mounted yet
    const docsStore = createDocsStore(platform, deps.folderRootToken());
    docMessage(target, 'Loading notes…');
    try {
      const notes = await docsStore.listNotes();
      if (lifecycle.isDisposed()) return; // torn down mid-fetch (#1002) — no write into the dead host
      renderPanel(
        target,
        <NotesPanel data={{ canWrite: docsStore.canWrite, adrs: [], notes, renderMarkdown }} handlers={docsHandlers(docsStore)} />,
      );
      notesLoaded = true;
    } catch (e) {
      if (lifecycle.isDisposed()) return;
      docMessage(target, 'Notes request failed: ' + String(e), 'error');
    }
  }

  // Mount each folder-derived page into its host. On mount the host hands us the node (captured for the
  // lazy first-load + in-panel reloads) WITHOUT fetching — the lazy tab-open path owns that first paint. A
  // real folder-token change re-runs the fetch in place. The host panel lives in @atypical/koine-ui since
  // #1244, so it reads the folder token through the generic ReadableStore adapter (one shared instance).
  const docsHostStore = createDocsPanelHostStore(store);
  render(
    <DocsPanelHost
      store={docsHostStore}
      onMount={(host) => { adrMount = host; }}
      load={(host) => { adrMount = host; adrLoaded = false; void loadAdr(host); }}
    />,
    hosts.adr,
  );
  render(
    <DocsPanelHost
      store={docsHostStore}
      onMount={(host) => { notesMount = host; }}
      load={(host) => { notesMount = host; notesLoaded = false; void loadNotes(host); }}
    />,
    hosts.notes,
  );
  const isAdrLoaded = (): boolean => adrLoaded;
  const isNotesLoaded = (): boolean => notesLoaded;

  // --- Source Control (git) right-rail panel (#272) -------------------------
  // Folder-derived like the docs pages: lazily mounted on the first Source-Control tab open, re-fetched on
  // every re-open (a `refreshNonce` bump — Preact reuses the mounted instance, so the commit-message draft
  // survives the in-place refresh), and re-mounted against the new folder on a workspace switch. The panel
  // self-gates on `platform.canUseGit` and catches a non-repo `gitStatus` reject, so this can mount it
  // unconditionally and let it paint the right empty state.
  let sourceControlLoaded = false;
  let sourceControlRefresh = 0;
  // A pending launcher focus (#1165): the specific file diff / commit to reveal on the next Source-Control
  // open. `sourceControlFocusNonce` bumps only when a NEW focus is requested, so the panel applies it once.
  let sourceControlFocus: SourceControlFocus | undefined;
  let sourceControlFocusNonce = 0;
  // Paint the panel with the live commit-guard inputs (#470): the current unsaved-buffer count and a
  // Save-all action, both read fresh at paint time. Splitting this out lets a dirty-count change re-paint
  // the panel WITHOUT bumping the refresh nonce (just the prop update — no git re-fetch), while
  // loadSourceControl bumps the nonce for a genuine re-fetch.
  function renderSourceControl(): void {
    render(
      <SourceControlPanel
        git={platform}
        folderToken={deps.folderRootToken()}
        refreshNonce={sourceControlRefresh}
        dirtyCount={store.getState().dirtyCount()}
        onSaveAll={() => deps.saveAllDirty()}
        focus={sourceControlFocus}
        focusNonce={sourceControlFocusNonce}
      />,
      hosts.sourceControl,
    );
  }
  function loadSourceControl(): void {
    if (sourceControlLoaded) sourceControlRefresh += 1; // a re-open re-fetches; first mount loads on its own
    sourceControlLoaded = true;
    renderSourceControl();
  }
  // #470: re-fetch git status when a save lands while the SC tab is open — reuses the nonce bump so the
  // in-place refresh preserves the commit-message draft. A no-op when the panel isn't mounted or isn't the
  // active right view (the next open re-fetches anyway).
  function refreshSourceControl(): void {
    if (!sourceControlLoaded) return;
    if (store.getState().right !== 'source-control') return;
    loadSourceControl();
  }
  function focusSourceControl(focus: SourceControlFocus): void {
    sourceControlFocus = focus;
    sourceControlFocusNonce += 1;
  }
  // Count dirty buffers straight from a `buffers` SNAPSHOT (never `dirtyCount()`, and never a mirrored
  // closure variable): `workspace.ts`'s `dirtyCount()` method closes over the store's live `get()`, so
  // calling it on a `prev` snapshot silently reads the CURRENT state, not the state as of that snapshot —
  // it would make the `dc === prevDc` comparison below always true (comparing "current" to "current"), so
  // a genuine dirty-count change would never repaint the panel. Deriving both counts from the `buffers` Map
  // each snapshot actually carries is what makes the comparison correct.
  function dirtyCountOf(buffers: AppState['buffers']): number {
    let n = 0;
    for (const b of buffers.values()) if (b.dirty) n++;
    return n;
  }
  // #470: keep the panel's `dirtyCount` prop live so the commit guard sees buffers dirtied AFTER it last
  // mounted. A dirty-count change re-paints the panel in place (no nonce bump → no git re-fetch), only
  // while the SC tab is the active right view. The `s.buffers === prev.buffers` fast-bail skips the O(n)
  // recount on every unrelated store write (selection, deck, docViews, …) without changing the outcome: a
  // workspace action always swaps in a NEW Map when anything actually changed (or returns the SAME
  // reference on a true no-op), so a reference-equal `buffers` can never carry a changed dirty count.
  const unsubscribeDirtyCount = store.subscribe((s, prev) => {
    if (s.buffers === prev.buffers) return;
    if (dirtyCountOf(s.buffers) === dirtyCountOf(prev.buffers)) return;
    if (sourceControlLoaded && s.right === 'source-control') renderSourceControl();
  });

  // --- bottom panel: Events / Relationships (#144) ---------------------------
  // The merged DiagramGraph projection behind both tables: every per-diagram graph from livingDocs fused
  // into one (node ids disambiguated) so the extractors see all aggregates + the integration-event flow at
  // once. Returned UNSCOPED — the Events/Relationships Preact panels narrow it to the active bounded
  // context themselves (#146, subscribing to the activeContext slice), so a scope change re-renders the
  // mounted table without a refetch.
  async function bottomGraph() {
    const docs = await lsp.livingDocs();
    return mergeDiagramGraphs(docs.files.flatMap((f) => f.diagrams.map((d) => d.graph)));
  }
  // Row click → jump to the construct's `.koi` declaration AND select it, so the Properties inspector
  // loads it — clicking a table row inspects it just like clicking its diagram node.
  const bottomTableHandlers: TableHandlers = {
    goto: (span: SourceSpan) => deps.gotoSourceSpan(span),
    onSelect: (qualifiedName: string, context: string) => store.getState().setSelection({ qualifiedName, context }),
  };
  // The koine-ui EventsPanel owns the mount + the SR-only legend; the maxGraph flow CANVAS stays host-side
  // (issue #1408). This thin wrapper over `renderEventFlowGraph` re-derives the flow for the given scope and
  // manages the async render's in-flight/disposed lifecycle behind the synchronous `{ dispose }` handle the
  // panel's effect expects — mirroring the retired EventFlowView's own effect.
  function makeEventsFlowRenderer(graph: DiagramGraph): FlowRenderer {
    return (host, scopeKey) => {
      let current = true;
      let handle: EventFlowGraphHandle | null = null;
      const flow = extractEventFlow(scopeGraph(graph, scopeKey));
      void renderEventFlowGraph(host, flow, () => current).then((h) => {
        if (current) handle = h;
        else h?.dispose();
      });
      return {
        dispose() {
          current = false;
          handle?.dispose();
        },
      };
    };
  }
  async function loadEventsPanel(): Promise<void> {
    await guardedLoad({
      store,
      key: 'events',
      isDisposed: lifecycle.isDisposed,
      loading: () => docMessage(hosts.events, 'Loading events…'),
      fetch: () => bottomGraph(),
      render: (graph) =>
        renderPanel(
          hosts.events,
          <EventsPanel
            store={createEventsPanelStore(store, graph)}
            handlers={bottomTableHandlers}
            renderFlow={makeEventsFlowRenderer(graph)}
          />,
        ),
      onError: (e) => docMessage(hosts.events, 'Events request failed: ' + String(e), 'error'),
    });
  }
  async function loadRelationshipsPanel(): Promise<void> {
    await guardedLoad({
      store,
      key: 'relationships',
      isDisposed: lifecycle.isDisposed,
      loading: () => docMessage(hosts.relationships, 'Loading relationships…'),
      fetch: () => bottomGraph(),
      render: (graph) =>
        renderPanel(
          hosts.relationships,
          <RelationshipsPanel store={createRelationshipsPanelStore(store, graph)} handlers={bottomTableHandlers} />,
        ),
      onError: (e) => docMessage(hosts.relationships, 'Relationships request failed: ' + String(e), 'error'),
    });
  }

  // --- compatibility check (on-demand) ---------------------------------------
  // The check only runs when the user picks a baseline, so the panel would otherwise be an empty void when
  // its tab is first opened. Paint an explanatory idle state (with the trigger) so the surface always reads
  // as a feature, never a blank pane. Skipped once a check has produced output.
  function renderCheckIdleIfEmpty(): void {
    if (hosts.check.childElementCount > 0) return; // a prior result / loading / error line already shows
    render(null, hosts.check);
    hosts.check.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'koi-check-idle';

    const title = document.createElement('h3');
    title.className = 'koi-check-idle-title';
    title.textContent = 'Model compatibility';

    const body = document.createElement('p');
    body.className = 'koi-docs-empty';
    body.textContent =
      'Compare this model against an earlier baseline to catch breaking changes before you ship — renamed or removed types, changed fields, or tightened invariants.';
    wrap.append(title, body);

    if (platform.canOpenFolders) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'koi-docs-new-btn koi-check-idle-action';
      btn.textContent = 'Check against baseline…';
      btn.addEventListener('click', () => void runCheck());
      wrap.appendChild(btn);
    } else {
      const note = document.createElement('p');
      note.className = 'koi-docs-empty';
      note.textContent = 'Selecting a baseline folder needs a Chromium-based browser.';
      wrap.appendChild(note);
    }
    hosts.check.appendChild(wrap);
  }

  async function runCheck(): Promise<void> {
    if (!platform.canOpenFolders) {
      docMessage(hosts.check, 'Selecting a baseline folder needs a Chromium-based browser.', 'error');
      store.getState().setOutput('compatibility');
      return;
    }
    let folder: string | null;
    try {
      folder = await platform.pickFolder('Select baseline model folder');
    } catch (e) {
      if (lifecycle.isDisposed()) return; // torn down mid-fetch (#1002) — no write into the dead host
      docMessage(hosts.check, 'Could not open the folder picker: ' + String(e), 'error');
      store.getState().setOutput('compatibility');
      return;
    }
    if (lifecycle.isDisposed()) return;
    if (!folder) return; // cancelled — abort silently
    store.getState().setOutput('compatibility');
    docMessage(hosts.check, 'Checking against baseline…');
    try {
      // Hosts whose compat check runs in-process must be handed the baseline sources; others read the path.
      const baselineSources = platform.compatNeedsInProcessSources
        ? await platform.readFolderSources(folder)
        : undefined;
      if (lifecycle.isDisposed()) return;
      const res = await lsp.check(folder, baselineSources);
      if (lifecycle.isDisposed()) return;
      if (res.error) {
        docMessage(hosts.check, 'Compatibility check failed: ' + res.error, 'error');
        return;
      }
      hosts.check.innerHTML = `<div class="koi-md">${renderMarkdown(renderCheckMarkdown(res))}</div>`;
    } catch (e) {
      if (lifecycle.isDisposed()) return;
      docMessage(hosts.check, 'Check request failed: ' + String(e), 'error');
    }
  }

  // --- invalidation + the debounced doc-edit repaint -------------------------
  let bottomPanelDebounce: ReturnType<typeof setTimeout> | undefined;
  // Mark the Events/Relationships/Context Map tables stale (called from invalidateDocViews on any model
  // change, and from a scope change via the facade). Each has its own docViews key (#193): bumping a key's
  // token both invalidates any in-flight load of that tab and makes the tab stale for its next show. If one
  // is on screen and expanded, live-refresh it (debounced) so it tracks edits like the inspector.
  function invalidateBottomPanels(): void {
    const inv = store.getState().invalidate;
    inv('events');
    inv('relationships');
    inv('contextmap');
    if (store.getState().bottom === 'problems' || store.getState().diagCollapsed) return;
    clearTimeout(bottomPanelDebounce);
    bottomPanelDebounce = setTimeout(() => hooks.ensureBottomLoaded(store.getState().bottom), 350);
  }

  // Mark the cached, model-derived surfaces stale (e.g. after an edit or a file switch). A model edit
  // touches EVERY model-derived surface, so a single all-keys invalidate() bumps the preview/model/
  // diagram/glossary tokens at once; invalidateBottomPanels() then bumps the three bottom-table keys.
  function invalidateDocViews(): void {
    store.getState().invalidate();
    // The joined glossary+diagram index (#142), its in-flight builder, and the assistant's domain index
    // are all facade-private and stale — drop them via the injected hook so the next model load rebuilds.
    hooks.invalidateModelDerivedCaches();
    invalidateBottomPanels();
  }

  // Mark the folder-derived ADR/Notes/Source-Control pages stale on a workspace folder switch (the
  // model-derived views are dropped by invalidateDocViews; these three only change with the folder).
  function invalidateDocsPanel(): void {
    adrLoaded = false;
    notesLoaded = false;
    sourceControlLoaded = false;
    if (store.getState().right === 'source-control') loadSourceControl();
  }

  // An edit makes the model-derived surfaces stale. Mark them dirty and (debounced) repaint the live ones
  // — the always-visible left rail plus the active center view — so they track the model without a manual
  // refresh. Rides the docViews slice's OWN 350ms debounce (`scheduleRefresh`, `store/slices/docViews.ts`)
  // rather than a local timer — this is that mechanism's first production caller. The `lifecycle.isDisposed()`
  // guard inside the scheduled callback is what makes dispose() "cancel" the pending refresh: scheduleRefresh's
  // timer is store-owned (no separate cancel handle), so a torn-down module leaves its own callback inert
  // instead, exactly like `guardedLoad`'s `isDisposed` checks.
  function onDocEdited(): void {
    invalidateDocViews();
    store.getState().scheduleRefresh(() => {
      if (lifecycle.isDisposed()) return;
      void hooks.refreshContextList();
      refreshActiveSurfaces();
    });
  }

  // Repaint the always-visible left rail (Explorer + Overview + the right-rail Properties inspector) +
  // every center surface currently showing (both panes of a 2-up, all four in overview).
  function refreshActiveSurfaces(): void {
    void loadModel();
    const vis = visibleCenters();
    if (vis.includes('visual')) void loadDiagrams();
    // The glossary is model-derived (refresh on edit); the ADR/Notes Docs panel is folder-derived, so an
    // edit never invalidates it.
    if (vis.includes('docs') && store.getState().docs === 'glossary') void loadGlossary();
    if (vis.includes('technical')) hooks.ensureTechLoaded();
    if (vis.includes('output')) hooks.ensureOutputLoaded();
    // The Syntax Tree is a RIGHT-rail model-derived surface (#890, facade-owned): reload it here when it's
    // the active right view and an edit re-staled its docViews key.
    if (store.getState().right === 'syntax-tree' && store.getState().isStale('syntax-tree')) hooks.loadSyntaxTree();
  }

  // Repaint the Output tree's scope EMPHASIS (ADR 0009) from the already-fetched preview, without a
  // re-emit — the facade's `rerenderScopedSurfaces` calls this after a scope change (a pure re-filter, not
  // a model edit, so the preview's CONTENT is deliberately not re-emitted).
  function refreshOutputRailScope(): void {
    if (!lastFiles.length) return;
    const scope = store.getState().activeContext;
    outputTree.emphasizeTopLevel(isAllContexts(scope) ? null : scope);
  }

  // Cancel any pending debounce timers and drop this module's own store subscription. The IDE runs for the
  // page lifetime in production (so this is mostly a no-op there), but the test suite boots many
  // controllers into one shared happy-dom; disposing between boots stops a deferred repaint from firing
  // into a torn-down environment.
  function dispose(): void {
    lifecycle.dispose();
    copyFile.cancelReset();
    copyAll.cancelReset();
    clearTimeout(bottomPanelDebounce);
    unsubscribeDirtyCount();
  }

  return {
    loadPreview,
    loadDiagrams,
    loadGlossary,
    loadModel,
    loadAdr,
    loadNotes,
    loadSourceControl,
    loadEventsPanel,
    loadRelationshipsPanel,
    runCheck,
    renderCheckIdleIfEmpty,
    refreshSourceControl,
    invalidateDocViews,
    invalidateDocsPanel,
    invalidateBottomPanels,
    onDocEdited,
    onThemeChanged,
    setTarget,
    onPreviewTargetChanged,
    refreshActiveSurfaces,
    isAdrLoaded,
    isNotesLoaded,
    focusSourceControl,
    scrollGlossaryToTerm,
    refreshOutputRailScope,
    dispose,
  };
}
