// inspectorController: the mode / center-tab / view subsystem lifted out of ide.ts's init()
// (Task 4 of the ide.ts decomposition, issue #180). It owns:
//   • the workspace MODE switcher (Domain / Code / Docs) and its chrome (#143),
//   • the CENTER view machinery — Visual (the diagram canvas), Code (editor / Generated preview /
//     Compatibility check / Assistant sub-tabs) and Documentation (Glossary / ADR-&-Notes sub-tabs) —
//     plus the right-rail Properties/Rules/Notes tab chrome,
//   • the BOTTOM strip (Problems / Events / Relationships / Context Map) with its lazy loaders,
//     collapse toggle and resizer,
//   • the per-view LAZY LOADERS and their stale-token / debounce lifecycle (the Generated preview,
//     the diagrams, the always-visible left-rail Explorer + Overview model, the glossary, the ADR
//     docs, and the bottom tables),
//   • the bounded-context SCOPE switcher (#146) and the selection-driven Properties inspector +
//     cross-highlight cluster (#142), and the joined model index it reads.
//
// Everything model-derived is invalidated together on an edit (onDocEdited / invalidateDocViews) and
// the live surfaces repaint debounced, so the preview + diagram + tables track the model without a
// manual refresh.
//
// Deliberately agnostic of the workspace/buffer layer to avoid an import cycle: it does NOT import
// editorSession or the workspace; the editor↔LSP/buffer/diagnostics concerns are injected as `deps`
// (an `editor` handle, read-only workspace accessors, and the write-path callbacks it triggers but
// does not own — rename / structured-edit / save-description / span navigation / the assistant
// lifecycle). ide.ts wires those and calls the `select*` / `invalidate*` / `load*` methods + `init()`
// from the palette, the toolbar buttons, and the boot ladder.
import { render, type VNode } from 'preact';
import { renderMarkdown } from '@/editor/editor';
import type { KoineEditor, OutputView } from '@/editor/editor';
import type {
  CheckResult,
  ContextMapResult,
  DocsResult,
  EmitPreviewResult,
  GlossaryEntry,
  GlossaryModel,
  ModelNode,
  DocumentSymbol,
  SetDocResult,
  SourceSpan,
  StructuredEdit,
} from '@/lsp/lsp';
import type { Platform } from '@/host';
import type { PreviewTarget } from '@/settings/persistence';
import { renderDiagrams } from '@/diagrams/diagrams';
import { setDiagramLayoutStore, setDiagramPersistScope } from '@/diagrams/diagramContract';
import type { AddNodeKind, CanvasAnnotationKind } from '@/diagrams/diagramContract';
import { createLayoutStore } from '@/diagrams/layoutStore';
import { mergeDiagramGraphs } from '@/model/modelTables';
import { type GlossaryHandlers } from '@/model/glossary';
import { createDocsStore } from '@/docs/docsStore';
import { renderAdrPanel, renderNotesPanel, type DocsPanelHandlers } from '@/docs/docsPanel';
import {
  ALL_CONTEXTS,
  fileContextFollow,
  isAllContexts,
  listContexts,
  scopeDocsFiles,
  scopeGlossaryModel,
  type ContextScope,
} from '@/model/activeContext';
import type { SelectedElement } from '@/model/selection';
import { renderOverviewCounts, type ModelOutlineHandlers } from '@/model/modelOutline';
import { buildInspectorElement, renderRules, type InspectorElement, type InspectorHandlers } from '@/model/inspector';
import { buildModelIndex, lookupElement, type ModelIndex } from '@/model/modelIndex';
import { PropertiesPanel } from '@/model/PropertiesPanel';
import { ContextBreadcrumb } from '@/model/ContextBreadcrumb';
import { ModelOutlinePanel } from '@/model/ModelOutlinePanel';
import { EventsPanel } from '@/model/EventsPanel';
import { RelationshipsPanel } from '@/model/RelationshipsPanel';
import { GlossaryPanel } from '@/model/GlossaryPanel';
import { DocsPanelHost } from '@/docs/DocsPanelHost';
import { CanvasPalette } from '@/diagrams/CanvasPalette';
import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import { guardedLoad } from '@/shell/guardedLoad';
import { DEFAULT_CENTER, isValidCenter, type RightView } from '@/store/slices/uiChrome';
import type { DomainIndex } from '@/ai/aiPanel';
import { currentTheme } from '@/settings/theme';
import { renderCheckMarkdown, renderContextMapHtml } from '@/shell/ideUtils';

// LSP SymbolKind for a namespace — the kind the language service tags each top-level `context`
// document symbol with. Used by followActiveFileContext to read a file's bounded context(s).
const SYMBOL_KIND_NAMESPACE = 3;

// The center column's top-level views and the Code/Documentation sub-tabs (kept local — they're a UI
// concern, not part of the target-agnostic model). They mirror the uiChrome slice's CenterView /
// TechView / DocsView literals, which the chrome now drives through.
type CenterView = 'visual' | 'technical' | 'docs' | 'assistant';
type TechView = 'editor' | 'preview' | 'check' | 'scenarios';
type DocsView = 'glossary' | 'adr' | 'notes';
type BottomTab = 'problems' | 'events' | 'relationships' | 'contextmap';

/**
 * The slice of {@link import('@/lsp/lsp').KoineLsp} the loaders call (content requests only). A
 * structural interface (not the class) so tests can pass a spy; methods mirror KoineLsp 1:1.
 */
export interface InspectorControllerLsp {
  glossaryModel(): Promise<GlossaryModel>;
  livingDocs(): Promise<DocsResult>;
  model(qualifiedName?: string): Promise<ModelNode>;
  contextMap(): Promise<ContextMapResult>;
  emitPreview(target: PreviewTarget): Promise<EmitPreviewResult>;
  check(baseline: string, baselineSources?: { uri: string; text: string }[]): Promise<CheckResult>;
  setDoc(id: string, text: string): Promise<SetDocResult>;
  documentSymbols(): Promise<DocumentSymbol[]>;
}

/** A minimal assistant handle (ide.ts owns the panel's lifecycle; the controller only nudges its tab). */
export interface InspectorAssistant {
  syncWorkspace(): void;
  focusInput(): void;
}

export interface InspectorControllerDeps {
  /** The LSP client (content requests only — the editor↔LSP wall lives in editorSession). */
  lsp: InspectorControllerLsp;
  /** The live editor handle (read-only here: jump-to-source + a re-measure on reveal). */
  editor: Pick<KoineEditor, 'view' | 'goto' | 'gotoRange'>;
  /** The read-only output viewer in #view-preview (owned by ide.ts; the Generated preview writes here). */
  output: OutputView;
  /** The host platform (baseline picker for the check, the docs store fs, browser/desktop kind). */
  platform: Platform;
  /**
   * The app state store, injected rather than reached as a module singleton — so the controller owns no
   * global state, can be driven against a fresh store per instance (the test suite does exactly this),
   * and two controllers with separate stores can coexist. Production passes the app-wide `appStore`.
   */
  store: StoreApi<AppState>;

  /** The uri the editor currently shows (read live from ide.ts). */
  activeUri(): string;
  /** The opened-folder token (or '' in no-folder mode) — keys the per-workspace scope + diagram layout. */
  folderRootToken(): string;

  /** The destination language for the Generated preview on boot (Settings → Output). */
  initialTarget: PreviewTarget;

  // --- store seams (persist/restore the per-workspace center pane + scope) ---
  saveWorkspaceCenter(id: string): void;
  loadWorkspaceCenter(): string | null;
  saveActiveContext(workspaceKey: string, scope: string): void;
  loadActiveContext(workspaceKey: string): string | null;

  // --- write-path callbacks ide.ts owns (the controller triggers, never owns, these) ---
  /** Write the status pill (errors route here from the loaders that surface their own failures). */
  setStatus(text: string, kind: 'connecting' | 'green' | 'error'): void;
  /** Rename the selected element (LSP rename refactor, applied across ide.ts's buffers). */
  onRenameElement(element: InspectorElement, newName: string): void;
  /** Persist the selected element's `///` description (setDoc → apply across buffers). */
  onSaveElementDescription(element: InspectorElement, text: string): void;
  /**
   * Persist a glossary concept's `///` description (setDoc → apply across buffers). Returns a promise
   * so the controller can surface a failure in the glossary pane (the original error home).
   */
  onSaveGlossaryDescription(entry: GlossaryEntry, text: string): Promise<void>;
  /** Apply a structured model edit (the #91 round-trip) for a Properties-panel field change. */
  onApplyStructuredEdit(edit: StructuredEdit, successMsg: string): void;
  /** Insert a new DDD construct of the given kind into the active context (the palette's add path). */
  onAddConstruct(kind: AddNodeKind): void;
  /** Create a canvas-only annotation (note/group) — a view concern persisted in koine.layout.json (#255). */
  onAddAnnotation(kind: CanvasAnnotationKind): void;
  /** Jump to a RAW 1-based source span (opens the owning file if needed) — the bottom tables' row click. */
  gotoSourceSpan(span: Pick<SourceSpan, 'file' | 'line' | 'column' | 'endLine' | 'endColumn'>): void;

  /** The assistant panel, created lazily by ide.ts the first time its tab is shown. */
  ensureAssistant(): InspectorAssistant;

  /** The scenario-runner panel (#149), created lazily by ide.ts the first time its tab is shown. */
  ensureScenarios?(): { refresh(): void };

  /** Bind a fixed-height resizer to a panel (ide.ts's resize.ts, injected to keep this DOM-infra-free). */
  initEdgeResizer(opts: {
    target: HTMLElement;
    handle: HTMLElement;
    container?: HTMLElement;
    cssVar: string;
    anchor: 'left' | 'right' | 'top' | 'bottom';
    storageKey: string;
    min: number;
    max: (size: number) => number;
  }): void;
}

/** A thin read/write shim over the app store's `selection` slice (#142) — ide.ts's diagram write-path
 *  uses it to set the selection. The store is the single source of truth; this is just a typed handle. */
export interface SelectionHandle {
  get(): SelectedElement | null;
  set(element: SelectedElement | null): void;
}

/** A thin read/write shim over the app store's `activeContext` slice (#146) — ide.ts reads the active
 *  scope through it for the diagram add-type path. The store is the single source of truth. */
export interface ActiveContextHandle {
  get(): ContextScope;
  set(scope: ContextScope): void;
}

export interface InspectorController {
  /** The shared "selected element" handle (#142) — ide.ts's diagram write-path sets it; the inspector reads it. */
  readonly selection: SelectionHandle;
  /** The active bounded-context handle (#146) — read at paint time by every scoped surface. */
  readonly activeContext: ActiveContextHandle;

  // View selection (palette commands + toolbar/tab clicks route here).
  selectCenter(view: CenterView): void;
  selectTech(view: TechView): void;
  selectDocsTab(view: DocsView): void;
  selectBottomTab(tab: BottomTab): void;

  // Loaders + lifecycle ide.ts still triggers (theme flip, prefs target change, boot, server restart).
  loadPreview(): Promise<void>;
  loadDiagrams(): Promise<void>;
  setTarget(target: PreviewTarget): void;
  /**
   * Adopt a destination-language change from Settings → Output: relabel the Generated tab, mark the
   * preview stale, and re-emit it when the Generated sub-view is the one showing (else it reloads on
   * next open). A no-op when the target is unchanged.
   */
  onPreviewTargetChanged(target: PreviewTarget): void;
  runCheck(): Promise<void>;
  onDocEdited(): void;
  invalidateDocViews(): void;
  /**
   * Mark the folder-derived ADR/Notes Docs panel stale (a workspace folder switch). Unlike the
   * model-derived views, an edit never invalidates it — only a folder change does, so this is
   * separate from invalidateDocViews().
   */
  invalidateDocsPanel(): void;
  /** A theme flip: the Mermaid palette changed, so mark the diagram stale + re-render it if it's showing. */
  onThemeChanged(): void;
  refreshActiveSurfaces(): void;
  refreshContextList(): Promise<void>;
  restoreActiveContext(): void;
  followActiveFileContext(): Promise<void>;

  /** Build (or reuse) the joined model index — ide.ts's diagram-click selection resolves names through it. */
  ensureModelIndex(): Promise<ModelIndex>;
  /** The assistant's domain index, built lazily from the compiled model and cached until the next edit. */
  getCachedDomainIndex(): Promise<DomainIndex | undefined>;

  /** Boot the chrome into the restored mode (no fetch) + label the Generated tab. Called from ide.ts's boot. */
  init(): void;
  /** Cancel pending debounce/reset timers so a deferred repaint can't fire after the host is torn down. */
  dispose(): void;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

export function createInspectorController(deps: InspectorControllerDeps): InspectorController {
  const { lsp, editor, output, platform, store: appStore } = deps;

  // --- DOM hosts (looked up once; the same id surface init() builds, so a drift throws via el()) ---
  // A copy affordance overlaid on the emitted-preview pane (auto-hidden with the pane). Tracks the
  // most recent generated output; disabled until there is some.
  let lastPreview = '';
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined;
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'koi-copy';
  copyBtn.textContent = 'Copy';
  copyBtn.title = 'Copy generated code';
  copyBtn.disabled = true;
  copyBtn.addEventListener('click', () => {
    if (!lastPreview) return;
    void navigator.clipboard
      .writeText(lastPreview)
      .then(() => (copyBtn.textContent = 'Copied ✓'))
      .catch(() => (copyBtn.textContent = 'Copy failed'))
      .finally(() => {
        clearTimeout(copyResetTimer);
        copyResetTimer = setTimeout(() => (copyBtn.textContent = 'Copy'), 1600);
      });
  });
  el('view-preview').appendChild(copyBtn);

  // Left-rail hosts (always visible, repainted together from the model): the Explorer construct
  // tree and the Overview per-context counts.
  const explorerBody = el('rail-explorer-body');
  const overviewBody = el('rail-overview-body');
  // The Documentation center tab's three sub-views: Glossary (the ubiquitous language), Decisions (the
  // ADR list) and Notes — the latter two split from the former combined "Decisions & Notes" surface.
  const glossaryView = el('view-glossary');
  const adrView = el('view-docs');
  const notesView = el('view-notes');
  // Center hosts: the diagram canvas (Visual) and the code editor's companion sub-views.
  const diagramsView = el('diagram-host');
  const assistantView = el('view-assistant');
  const checkView = el('view-check');
  const scenariosView = el('view-scenarios');
  // Right-rail host: the element inspector (Properties). Fixed — never torn down on a model reload.
  const inspectorHost = el('inspector-host');
  // Top-bar "scope path" host (the ContextBreadcrumb Preact panel — the scope selector + selected
  // element) and its status-bar context mirror.
  const breadcrumbHost = el('breadcrumb-host');
  const sbContextEl = el('sb-context');

  // Bottom-panel refs.
  const diagEl = el('diagnostics');
  const diagBodyEl = el('diag-body');
  const diagCountEl = el('diag-count');
  const eventsPanel = el('panel-events');
  const relationshipsPanel = el('panel-relationships');
  const contextMapView = el('panel-contextmap');

  // --- center pane restore ---------------------------------------------------
  // Restore the persisted center pane, defaulting to Visual when absent/invalid.
  const restoredCenter = deps.loadWorkspaceCenter();
  const initialCenter: CenterView =
    restoredCenter && isValidCenter(restoredCenter) ? restoredCenter : DEFAULT_CENTER;
  // The chrome (center / tech / docs tab states) is owned by the uiChrome slice — the ONE source of
  // truth for both the highlighted tab AND the shown view, so they can never diverge (#193). Reset it to
  // this controller's defaults: the restored center, with the tech/docs sub-views back at their landing
  // tabs. setState lands the reset atomically in one notification, before any subscriber runs.
  // `bottom`/`right` are reset to their landing tabs alongside the others: the store is INJECTED (deps.store)
  // and, in production, is the app-wide singleton reused across workspace reopens — so without this reset a
  // prior session that left `bottom`/`right` on a non-default tab would leak into a freshly-booted controller
  // (the same reason the docViews invalidate() below resets surface-staleness). Tests pass a fresh store per
  // controller, for which this is a harmless no-op. This restores the per-instance defaults the old
  // module-local `activeBottomTab = 'problems'` / right-rail `'props'` start gave for free.
  appStore.setState({
    center: initialCenter,
    tech: 'editor',
    docs: 'glossary',
    bottom: 'problems',
    right: 'props',
  });
  // The docViews slice (#193) is the single source of truth for which lazily-loaded, model-derived
  // surfaces — the Generated preview, the left-rail model, the diagram, the glossary, and the bottom
  // Events/Relationships/Context Map tables — are loaded vs stale; there are no longer any controller-
  // local `loaded` flags duplicating it. Reset it to fully-stale for this fresh workspace session so the
  // first show of each fetches: invalidate() flips every view to not-loaded and bumps its token.
  // This reset is load-bearing because the injected store is, in production, the app-wide singleton reused
  // across workspace reopens (and the test suite builds many controllers): without it, a prior session that
  // left a view `loaded` would make a freshly-booted controller skip its first fetch. It resets the store's
  // surface-staleness for this controller's session.
  appStore.getState().invalidate();

  // Persist the active center pane across reloads: on a real center change, write it through, with a
  // no-churn guard so re-selecting the same pane doesn't touch storage. The center tabs (Visual / Code /
  // Documentation) are the only switcher now, so what they land on is what a reload restores.
  let persistedCenter: CenterView = initialCenter;
  appStore.subscribe((s, prev) => {
    if (s.center === prev.center) return;
    if (s.center !== persistedCenter) {
      persistedCenter = s.center;
      deps.saveWorkspaceCenter(s.center);
    }
  });

  // --- bounded-context switcher (#146) ---------------------------------------
  // A thin handle over the app store's `activeContext` slice — the store is the single source of truth,
  // so the switcher writes it here and every scoped surface (and the ModelOutlinePanel, which subscribes
  // to the slice) reads the same value.
  const activeContext: ActiveContextHandle = {
    get: () => appStore.getState().activeContext,
    set: (scope) => appStore.getState().setActiveContext(scope),
  };
  // The model's bounded contexts (the scope selector's options after "All contexts"), kept here so the
  // breadcrumb can be re-rendered whenever they change. Empty in a cold/scratch model → the host hides.
  let contexts: string[] = [];

  // Render (or re-render) the top-bar "scope path": the ContextBreadcrumb Preact panel. It subscribes to
  // the activeContext + selection slices itself (so a scope/selection change repaints it without a call
  // here), and takes the contexts list + model index as props — so a re-render is needed only when those
  // change (setContextOptions / a model-index rebuild). Hidden while the model has no contexts. Picking a
  // context routes through setActiveContext — the same persist-and-repaint choke point the old <select>
  // used — so the scoped surfaces stay consistent.
  function renderBreadcrumb(): void {
    breadcrumbHost.hidden = contexts.length === 0;
    render(
      <ContextBreadcrumb
        store={appStore}
        contexts={contexts}
        index={modelIndex}
        onScopeChange={setActiveContext}
      />,
      breadcrumbHost,
    );
  }

  /** The per-workspace storage key for the active scope (folder identity, or 'scratch'). */
  function contextWorkspaceKey(): string {
    return deps.folderRootToken() || 'scratch';
  }

  /** The human label for a scope: the context name, or "All contexts" for the unscoped sentinel. */
  function scopeLabel(scope: ContextScope): string {
    return isAllContexts(scope) ? 'All contexts' : scope;
  }

  /** Mirror the active scope onto the status-bar readout. The top-bar selector reflects the scope on its
   *  own (the breadcrumb subscribes to the activeContext slice), so this only feeds the persistent
   *  status-bar "Context: X" — the readout that used to sit (redundantly) in the toolbar. */
  function syncContextStatusBar(): void {
    sbContextEl.textContent = `Context: ${scopeLabel(activeContext.get())}`;
  }

  // The single choke point for every scope change (the <select>, a restored value's validation, and
  // the select-outside-scope path all route through here): update the store's `activeContext` slice,
  // optionally persist it for this workspace, sync the control, and re-render the scoped surfaces.
  // `persist` is the user's
  // intent flag — only a deliberate switcher choice persists; non-deliberate changes (following a
  // selection, or falling back off a vanished context) are view-only so they never overwrite the
  // user's last explicit choice in storage.
  function applyScope(scope: ContextScope, persist: boolean): void {
    // Write the app store's `activeContext` slice (the single source of truth): the ModelOutlinePanel
    // subscribes to it and re-renders the scoped tree, and every other scoped render path reads it back.
    activeContext.set(scope);
    if (persist) deps.saveActiveContext(contextWorkspaceKey(), scope);
    syncContextStatusBar();
    rerenderScopedSurfaces();
  }

  /** A deliberate scope change from the switcher — persisted so a reload restores it. */
  function setActiveContext(scope: ContextScope): void {
    applyScope(scope, true);
  }

  // Adopt the current model's contexts as the scope selector's options ("All contexts" is always first,
  // rendered by the breadcrumb itself). Re-renders the breadcrumb (which hides itself when the list is
  // empty — an empty/scratch model).
  function setContextOptions(list: string[]): void {
    contexts = list;
    appStore.getState().setContexts(list); // mirror into the store so the construct palette can react
    renderBreadcrumb();
    // Fall back to "All contexts" ONLY when we positively know the model's contexts (a non-empty list)
    // and the active scope isn't among them — a genuine rename/removal. An EMPTY list is a transient or
    // cold state (the LSP still warming up right after open, or a momentarily-unparseable model mid-edit),
    // so preserve the scope rather than clobber it. The fallback is view-only (not persisted), so the
    // user's last explicit choice survives in storage and a reload restores it once the context is back.
    const scope = activeContext.get();
    if (list.length > 0 && !isAllContexts(scope) && !list.includes(scope)) {
      applyScope(ALL_CONTEXTS, false);
    } else {
      syncContextStatusBar();
    }
  }

  // Refresh the switcher's context list from the workspace model (best-effort; empties on failure).
  // The glossary model lists every declared type with its owning context, so it's the most complete
  // source for "every context that has anything in it".
  async function refreshContextList(): Promise<void> {
    try {
      const model = await lsp.glossaryModel();
      setContextOptions(listContexts(model));
    } catch (e) {
      // Best-effort: empty the picker, but log so a failing glossary model isn't a silent dead end.
      console.warn('Context list refresh failed; clearing the context picker.', e);
      setContextOptions([]);
    }
  }

  // Restore the persisted scope for the just-opened workspace, before the first scoped render. The
  // control catches up when refreshContextList rebuilds the options (the slice value is what the render
  // paths read, so the initial render is already scoped regardless of the dropdown's paint timing).
  function restoreActiveContext(): void {
    const stored = deps.loadActiveContext(contextWorkspaceKey());
    const scope = stored && stored.length > 0 ? stored : ALL_CONTEXTS;
    // Set the store's scope so the ModelOutlinePanel's first paint is already scoped.
    activeContext.set(scope);
    syncContextStatusBar();
  }

  // When the active .koi file changes, follow the bounded-context switcher to that file's context so
  // the top bar — and every scoped surface — reflects the file you're now editing. The file's primary
  // context is its first top-level document symbol. View-only (applyScope persist=false): navigating
  // between files shouldn't overwrite the user's deliberately chosen, persisted scope. A response for a
  // file the user has already switched away from is dropped; a file with no determinable context leaves
  // the scope untouched.
  async function followActiveFileContext(): Promise<void> {
    const uri = deps.activeUri();
    let contexts: string[];
    try {
      const symbols = await lsp.documentSymbols();
      // Top-level document symbols are the file's `context` declarations (SymbolKind 3 = Namespace).
      contexts = symbols.filter((s) => s.kind === SYMBOL_KIND_NAMESPACE).map((s) => s.name);
    } catch {
      return;
    }
    if (deps.activeUri() !== uri) return; // the user switched files while the symbols were in flight
    const next = fileContextFollow(contexts, activeContext.get());
    if (next !== undefined) applyScope(next, false);
  }

  // Re-render the scoped, model-derived surfaces after a scope change. Scope is applied at paint time
  // from the `activeContext` slice and the model itself is unchanged (scope is a pure filter), so the
  // cached model index is kept — only the visible surfaces repaint. The model/diagram doc caches are marked stale so a
  // not-currently-visible one re-renders scoped on its next visit.
  function rerenderScopedSurfaces(): void {
    // A scope change is a pure re-filter, not a model edit: mark the SCOPE-derived surfaces stale so the
    // not-currently-visible ones re-render scoped on their next visit, then repaint the live ones now.
    // The Generated preview isn't scope-derived (it's target-derived), so it's deliberately left fresh —
    // matching the old `docViewsLoaded.model/diagrams = false` + bottom-token bump that never touched it.
    const inv = appStore.getState().invalidate;
    inv('model');
    inv('diagrams');
    inv('glossary');
    // The left-rail Explorer + Overview are always visible, so re-scope them immediately.
    void loadModel();
    // The diagram only re-scopes when the visual center is showing it.
    if (activeCenter() === 'visual') void loadDiagrams();
    invalidateBottomPanels(); // the Events/Relationships/Context Map tables are graph-derived too
  }

  // --- doc-view cache + assistant domain index -------------------------------

  // Which lazily-loaded, model-derived surfaces need a (re)fetch is owned ENTIRELY by the docViews
  // slice (#193) — there is no controller-local `loaded` record any more. Every such surface (the
  // Generated preview, the left-rail model, the diagram, the glossary, and the bottom
  // Events/Relationships/Context Map tables) reads the slice's per-key {loaded, token}: a loader
  // captures currentToken(key) before its await, compares after, and markLoaded(key, capturedToken)
  // only takes when the token is still current. An edit's invalidate() bumps every key together, so a
  // single call makes all surfaces stale at once. The check view (on-demand) and the assistant
  // (interactive) are not model-derived, so they're excluded; the Explorer/Overview ('model') is always
  // visible, so it repaints on every edit.

  // The assistant's domain index is another model-derived view (built from the same context-map +
  // glossary the views above use), so it's cached the same way: `null` = stale/unbuilt, `{ value }` =
  // built (value undefined for a scratch/empty model). invalidateDocViews() clears it on any model
  // change, so a chat about an unedited model reuses it instead of re-running the LSP recompiles.
  let cachedDomainIndex: { value: DomainIndex | undefined } | null = null;

  // Build the assistant's domain index from the COMPILED workspace (contexts/aggregates/relations +
  // glossary coverage), best-effort: any failing LSP endpoint just drops the index — this never
  // throws. Returns undefined for a scratch/empty model so the system prompt stays clean.
  async function buildDomainIndex(): Promise<DomainIndex | undefined> {
    try {
      const [contextMap, glossaryModel] = await Promise.all([
        lsp.contextMap().catch(() => null),
        lsp.glossaryModel().catch(() => null),
      ]);
      const contexts = contextMap?.contexts ?? [];
      if (!contexts.length) return undefined;

      const entries = glossaryModel?.entries ?? [];
      // The aggregate root isn't exposed directly: derive it from the nested entities. Koine's
      // `aggregate X root X` convention means the root entity usually shares the aggregate's name;
      // else, if there's exactly one nested entity, use it; otherwise leave it blank.
      const aggregates = entries
        .filter((e) => e.kind === 'aggregate')
        .map((agg) => {
          const nested = entries.filter(
            (e) => e.kind === 'entity' && e.qualifiedName.startsWith(agg.qualifiedName + '.'),
          );
          const root =
            nested.find((e) => e.name === agg.name)?.name ?? (nested.length === 1 ? nested[0].name : '');
          return { name: agg.name, root };
        });

      return {
        contexts,
        aggregates,
        relations: (contextMap?.relations ?? []).map((r) => ({
          upstream: r.upstream,
          downstream: r.downstream,
          kind: r.kind,
        })),
        glossaryCoverage: {
          documented: entries.filter((e) => e.doc != null).length,
          total: entries.length,
        },
      };
    } catch {
      return undefined;
    }
  }

  // Lazily build + cache the assistant's domain index (the expensive part — two LSP recompiles), reused
  // until the next edit clears it (invalidateDocViews). ide.ts's assistant getContext awaits this.
  async function getCachedDomainIndex(): Promise<DomainIndex | undefined> {
    if (cachedDomainIndex === null) {
      cachedDomainIndex = { value: await buildDomainIndex() };
    }
    return cachedDomainIndex.value;
  }

  // Write a status/empty/error message imperatively into a host that may currently hold a Preact tree
  // (the model / glossary / Events / Relationships panels mount via render()). Unmounting any prior tree
  // FIRST (render(null, view)) is load-bearing: a Preact-rendered host and a raw innerHTML write
  // otherwise fight over the same node — so folding the unmount in here makes every docMessage call site
  // safe by construction, and the explicit render(null, host) dance disappears from the loaders. It's a
  // harmless no-op for hosts that never held a Preact tree (checkView / contextMapView / the docs host).
  function docMessage(view: HTMLElement, text: string, kind: 'muted' | 'error' = 'muted'): void {
    render(null, view);
    // Build the node with textContent rather than interpolating into innerHTML — `text` often carries
    // an error string (String(e)) that can embed host paths or user-influenced file/folder names, so
    // raw interpolation would be an HTML-injection sink.
    view.innerHTML = '';
    const p = document.createElement('p');
    p.className = kind === 'error' ? 'doc-error' : 'muted';
    p.textContent = text;
    view.appendChild(p);
  }

  // The Preact counterpart to docMessage: paint a panel into a host that may currently hold the raw
  // docMessage <p> (the 'Loading…' line is written via innerHTML, which the reconciler can't see). A
  // bare render(vnode, host) would diff against Preact's OWN tree — already emptied by docMessage's
  // render(null) — so it has no record of the raw <p> and APPENDS the panel beside it (the bug: the
  // loading line and the loaded panel both showed at once). Dropping any prior Preact tree (render(null))
  // AND any raw write (innerHTML = '') FIRST makes the fresh render replace the loading line, not stack
  // on it — the symmetric inverse of docMessage's own render(null)+innerHTML dance.
  function renderPanel(view: HTMLElement, vnode: VNode): void {
    render(null, view);
    view.innerHTML = '';
    render(vnode, view);
  }

  // --- glossary (the ubiquitous-language editor, #67) ------------------------
  // Now a Preact panel (#193): the GlossaryPanel subscribes to the store's `activeContext` slice and
  // re-scopes the model on its own, so a scope change re-renders the glossary without a refetch. The
  // controller still owns the LSP fetch, under the docViews slice's stale-token discipline ('glossary'
  // is the matching key — this is the glossary view): a token captured before the await is compared to
  // the slice's current one after, so an edit mid-fetch discards the superseded result and the panel is
  // marked loaded only for the token it fetched. The status/empty/error states write the host
  // imperatively via docMessage, which unmounts any prior Preact tree first — so the reconciler and the
  // imperative write never fight over the same node (the prior-tasks hazard).
  async function loadGlossary(): Promise<void> {
    await guardedLoad({
      store: appStore,
      key: 'glossary',
      loading: () => docMessage(glossaryView, 'Loading glossary…'),
      fetch: () => lsp.glossaryModel(),
      render: (model) => {
        if (!model.entries.length) {
          docMessage(glossaryView, 'No concepts yet — declare some types, or fix syntax errors to populate the glossary.');
        } else {
          renderPanel(glossaryView, <GlossaryPanel store={appStore} model={model} handlers={glossaryHandlers} />);
        }
      },
      onError: (e) => docMessage(glossaryView, 'Glossary request failed: ' + String(e), 'error'),
    });
  }

  // Wires the pure (testable) glossary view to the editor + LSP: jump-to-source (here) and
  // persist-a-description (ide.ts's write path, injected).
  const glossaryHandlers: GlossaryHandlers = {
    onGoto: (range) => editor.gotoRange(range.start, range.end),
    // Persisting is ide.ts's write path; a failure is surfaced HERE, in the glossary pane (its
    // original error home), so the boundary stays clean without losing the message.
    onSave: (entry, text) =>
      void deps
        .onSaveGlossaryDescription(entry, text)
        .catch((e) => docMessage(glossaryView, 'Saving description failed: ' + String(e), 'error')),
  };

  // --- Decisions (ADR) & Notes documentation surfaces (#174, #193) ----------
  // Two independent folder-derived pages (split from the former combined "Decisions & Notes" panel):
  // each is NOT invalidated by `.koi` edits, lazily loads on its first tab open, and reloads only on a
  // workspace folder change (the <DocsPanelHost> contract). The mount nodes are captured here so the
  // lazy first-load and in-panel create/save reloads paint into the same node without re-fetching.
  let adrMount: HTMLElement | null = null;
  let notesMount: HTMLElement | null = null;
  let adrLoaded = false;
  let notesLoaded = false;
  const docsFail = (verb: string) => (e: unknown) => deps.setStatus(`Could not ${verb}: ${String(e)}`, 'error');

  // One handlers object the two pages share: each create resets only its OWN page's loaded flag and
  // repaints just that page (saves are in-place and need no reload). renderAdrPanel uses only the ADR
  // handlers and renderNotesPanel only the note ones, so the unused half is never invoked.
  function docsHandlers(store: ReturnType<typeof createDocsStore>): DocsPanelHandlers {
    return {
      onCreateAdr: (title) =>
        void store.createAdr(title).then(() => { adrLoaded = false; void loadAdr(); }).catch(docsFail('create the ADR')),
      onSaveAdr: (file, adr) => void store.saveAdr(file.token, adr).catch(docsFail('save the ADR')),
      onCreateNote: (title) =>
        void store.createNote(title).then(() => { notesLoaded = false; void loadNotes(); }).catch(docsFail('create the note')),
      onReadNote: (file) => store.readNote(file.token),
      onSaveNote: (file, md) => void store.saveNote(file.token, md).catch(docsFail('save the note')),
    };
  }

  async function loadAdr(host?: HTMLElement): Promise<void> {
    const target = host ?? adrMount;
    if (!target) return; // the host hasn't mounted yet
    const store = createDocsStore(platform, deps.folderRootToken());
    docMessage(target, 'Loading decisions…');
    try {
      const adrs = await store.listAdrs();
      target.replaceChildren(renderAdrPanel({ canWrite: store.canWrite, adrs, notes: [], renderMarkdown }, docsHandlers(store)));
      adrLoaded = true;
    } catch (e) {
      docMessage(target, 'Decisions request failed: ' + String(e), 'error');
    }
  }

  async function loadNotes(host?: HTMLElement): Promise<void> {
    const target = host ?? notesMount;
    if (!target) return; // the host hasn't mounted yet
    const store = createDocsStore(platform, deps.folderRootToken());
    docMessage(target, 'Loading notes…');
    try {
      const notes = await store.listNotes();
      target.replaceChildren(renderNotesPanel({ canWrite: store.canWrite, adrs: [], notes, renderMarkdown }, docsHandlers(store)));
      notesLoaded = true;
    } catch (e) {
      docMessage(target, 'Notes request failed: ' + String(e), 'error');
    }
  }

  // Mount each folder-derived page into its view. On mount the host hands us the node (captured for the
  // lazy first-load + in-panel reloads) WITHOUT fetching — the lazy tab-open path owns that first paint,
  // keeping the fetch off the construction frame. A real folder-token change re-runs the fetch in place.
  render(
    <DocsPanelHost
      store={appStore}
      onMount={(host) => {
        adrMount = host;
      }}
      load={(host) => {
        adrMount = host;
        adrLoaded = false;
        void loadAdr(host);
      }}
    />,
    adrView,
  );
  render(
    <DocsPanelHost
      store={appStore}
      onMount={(host) => {
        notesMount = host;
      }}
      load={(host) => {
        notesMount = host;
        notesLoaded = false;
        void loadNotes(host);
      }}
    />,
    notesView,
  );

  // --- the DDD workspace (#142): outline / inspector / cross-highlight -------
  // A thin handle over the app store's `selection` slice (the single source of truth): the outline,
  // the diagram (via ide.ts's write-path), and the Properties panel all read/write the same selection.
  const selection: SelectionHandle = {
    get: () => appStore.getState().selection,
    set: (element) => appStore.getState().setSelection(element),
  };

  const modelOutlineHandlers: ModelOutlineHandlers = {
    onSelect: (entry) => selection.set({ qualifiedName: entry.qualifiedName, context: entry.context }),
    goto: (line, col) => editor.goto(line, col),
    onOpenContextMap: () => selectBottomTab('contextmap'),
    onOpenGlossary: () => focusDocs(),
  };
  const inspectorHandlers: InspectorHandlers = {
    onGoto: (range) => editor.gotoRange(range.start, range.end),
    onRename: (element, newName) => deps.onRenameElement(element, newName),
    onSaveDescription: (element, text) => deps.onSaveElementDescription(element, text),
    // Property editing rides the same #91 round-trip the canvas uses (applyStructuredEdit), so editing a
    // field here rewrites the `.koi` AND re-renders the diagram + this panel in step.
    onAddProperty: (element, name, type) =>
      deps.onApplyStructuredEdit(
        { kind: 'addField', target: element.qualifiedName, name, type },
        `Added ${name}: ${type} to ${element.name}`,
      ),
    onRemoveProperty: (element, propName) =>
      deps.onApplyStructuredEdit(
        { kind: 'removeMember', target: `${element.qualifiedName}.${propName}` },
        `Removed ${propName} from ${element.name}`,
      ),
    onRenameProperty: (element, oldName, newName) =>
      deps.onApplyStructuredEdit(
        { kind: 'renameMember', target: `${element.qualifiedName}.${oldName}`, name: newName },
        `Renamed ${oldName} → ${newName}`,
      ),
    onChangeType: (element, propName, newType) =>
      deps.onApplyStructuredEdit(
        { kind: 'changeFieldType', target: `${element.qualifiedName}.${propName}`, type: newType },
        `Changed ${propName} to ${newType}`,
      ),
  };

  // The joined model index (#142): the workspace-merged glossary joined with the richest matching
  // `DiagramNode`. Cached and invalidated on edit; `indexPromise` de-dups concurrent builders (a model
  // reload AND a diagram click can both request it before the fetch resolves).
  let modelIndex: ModelIndex | null = null;
  let indexPromise: Promise<ModelIndex> | null = null;

  /**
   * Build (or reuse) the joined model index. `livingDocs` (diagram nodes) and the structured `model`
   * (the #91 field source for elements with no class node) are both best-effort — a glossary-only
   * index still works, just without members for undrawn elements.
   */
  function ensureModelIndex(): Promise<ModelIndex> {
    if (modelIndex) return Promise.resolve(modelIndex);
    indexPromise ??= Promise.all([
      lsp.glossaryModel(),
      lsp.livingDocs().catch(() => ({ files: [] }) as DocsResult),
      lsp.model().catch(() => undefined),
    ])
      .then(([glossary, docs, model]) => (modelIndex = buildModelIndex(glossary, docs, model)))
      .finally(() => {
        indexPromise = null;
      });
    return indexPromise;
  }

  // Cross-highlight (#142): mark the outline leaf — and the diagram node, best-effort — that matches
  // the current selection, so selecting in one surface lights up the other. `lookupElement` resolves
  // either key form to the canonical glossary qualified name (the outline leaves' key); the SVG nodes
  // key on `context.simpleName`, derived from the resolved element.
  function applySelectionHighlight(): void {
    const sel = selection.get();
    const hit = sel && modelIndex ? lookupElement(modelIndex, sel.qualifiedName) : null;
    // The outline leaves' `is-selected` cross-highlight is now owned by the Preact ModelOutlinePanel
    // (it subscribes to the store's `selection` slice); this function only drives the SVG-node side.
    const ctxName = hit ? `${hit.element.entry.context}.${hit.element.entry.name}` : null;
    // Scope to the primary diagram SVG — the minimap (#145) clones the node layer as a decorative
    // thumbnail, so an unscoped query would also (wrongly) highlight the clone.
    for (const node of Array.from(diagramsView.querySelectorAll<HTMLElement>('.koi-svg-diagram .koi-svg-node'))) {
      node.classList.toggle('is-selected', ctxName != null && node.dataset.qname === ctxName);
    }
  }

  // Mount (and re-render) the Properties inspector as a Preact panel into the right-rail host (#193,
  // the first migrated panel). The panel subscribes to the `selection` slice of the app store and
  // resolves it through the current model index, so it tracks selection on its own; the explicit
  // render(...) here repaints it synchronously when the index resolves (loadModel) or a selection lands
  // (the store subscriber below calls this when the `selection` slice changes). Preact's top-level
  // render() reconciles into the same host node, so the host keeps its identity across repaints.
  function renderSelectedInspector(): void {
    render(
      <PropertiesPanel store={appStore} index={modelIndex} handlers={inspectorHandlers} />,
      inspectorHost,
    );
    renderSelectedRules();
  }

  // The right-rail "Rules" tab: the selected element's invariants (business rules), resolved through the
  // same selection → model-index → InspectorElement path as the Properties inspector, so the two tabs
  // track selection in lockstep. Rendered imperatively into its host (it's a read-only projection).
  function renderSelectedRules(): void {
    const sel = appStore.getState().selection;
    const hit = sel && modelIndex ? lookupElement(modelIndex, sel.qualifiedName) : null;
    const element: InspectorElement | null = hit
      ? buildInspectorElement(hit.element.entry, hit.element.node, hit.element.modelMembers)
      : null;
    el('rview-rules').replaceChildren(renderRules(element));
  }

  // Repaint the always-visible left rail: the Explorer construct tree + the Overview counts, both
  // scoped to the active bounded context (#146). The inspector resolves any selection against the whole
  // model, so only the navigator + counts are narrowed.
  async function loadModel(): Promise<void> {
    // Capture the 'model' stale-token before the await; markLoaded only takes if it's still current
    // after, so an edit mid-fetch leaves the surface stale for the next show (the slice discipline).
    const token = appStore.getState().currentToken('model');
    // The status/empty/error states write the explorer host imperatively via docMessage; the tree itself
    // is a Preact panel painted via renderPanel, which drops the loading line first so the outline
    // replaces it rather than stacking beside it.
    docMessage(explorerBody, 'Loading model…');
    try {
      const index = await ensureModelIndex();
      // The model index just (re)built — re-pass it to the breadcrumb so the selected element's type icon
      // resolves (the panel tracks selection itself, but reads the construct off the index prop).
      renderBreadcrumb();
      const scopedGlossary = scopeGlossaryModel(index.glossary, activeContext.get());
      if (!scopedGlossary.entries.length) {
        docMessage(
          explorerBody,
          index.glossary.entries.length
            ? 'No elements in this context — switch to “All contexts” to see the whole model.'
            : 'No elements yet — declare some types, or fix syntax errors to populate the model.',
        );
        overviewBody.replaceChildren();
        renderSelectedInspector();
        appStore.getState().markLoaded('model', token);
        return;
      }
      // Explorer = the construct tree as a Preact panel scoped from the store's activeContext slice, with
      // its inline counts suppressed; the dedicated Overview section owns the tallies (renderOverviewCounts),
      // so the two never double up. The panel owns the leaf `is-selected` cross-highlight on its own.
      renderPanel(
        explorerBody,
        <ModelOutlinePanel
          store={appStore}
          model={index.glossary}
          handlers={modelOutlineHandlers}
          index={index}
        />,
      );
      overviewBody.replaceChildren(renderOverviewCounts(scopedGlossary));
      renderSelectedInspector();
      applySelectionHighlight();
      appStore.getState().markLoaded('model', token);
    } catch (e) {
      docMessage(explorerBody, 'Model request failed: ' + String(e), 'error');
    }
  }

  // The inspector + cross-highlight track the app store's `selection` slice for the app's lifetime (a
  // diagram click can select an element while the Model tab is closed; opening it then shows the right
  // inspector). Subscribe to the whole store but act only when the `selection` field actually changes
  // reference — so an unrelated slice write (a setBottom / setActiveContext) doesn't trigger this.
  appStore.subscribe((state, prev) => {
    if (state.selection === prev.selection) return;
    const sel = state.selection;
    // Jump-to-source works across scope, but a selection landing OUTSIDE the active context would
    // otherwise leave the scoped surfaces showing a different context than the inspector. Follow it:
    // switch the scope to the selected element's context (#146). View-only (persist=false) — a
    // read-only inspect shouldn't overwrite the user's deliberately chosen, persisted scope. In-scope
    // selections and the unscoped ("All contexts") view leave the scope untouched. applyScope re-renders
    // the scoped surfaces, which also refreshes the inspector/cross-highlight for the Model tab — the
    // explicit calls below cover the cross-highlight when another view is active.
    if (sel && !isAllContexts(activeContext.get()) && sel.context !== activeContext.get()) {
      applyScope(sel.context, false);
    }
    // The Properties panel subscribes to the store's `selection` slice and re-renders on its own; the
    // explicit repaint keeps the right-rail update synchronous for callers that read it immediately
    // after a set.
    renderSelectedInspector();
    applySelectionHighlight();
  });

  // --- live diagrams ---------------------------------------------------------
  // Fetch the DocsEmitter output (Mermaid-in-Markdown) and render it. The loaded/stale GATE is the
  // docViews slice's 'diagrams' key — markLoaded only takes if the captured token is still current. A
  // local monotonic `diagramsSeq` is kept ALONGSIDE it because a theme flip / refresh re-renders the
  // diagram WITHOUT bumping the slice token (those aren't model edits): the seq drops the result of a
  // render a newer call superseded, and is the live cancellation predicate threaded into renderDiagrams.
  let diagramsSeq = 0;
  async function loadDiagrams(): Promise<void> {
    const seq = ++diagramsSeq;
    const token = appStore.getState().currentToken('diagrams');
    docMessage(diagramsView, 'Rendering diagrams…');
    try {
      const res = await lsp.livingDocs();
      if (seq !== diagramsSeq) return;
      // Scope the diagrams to the active bounded context (#146): each diagram's graph is narrowed and
      // emptied diagrams/files drop out, so a context shows only its own diagrams. "All" is the identity.
      const files = scopeDocsFiles(res.files, activeContext.get());
      // Scope persisted node positions to this workspace so a folder restores its own manual layout, and
      // inject the matching layout store: a committable koine.layout.json at the folder root when one is
      // open, else browser storage (web/scratch mode).
      setDiagramPersistScope(contextWorkspaceKey());
      setDiagramLayoutStore(createLayoutStore(platform, deps.folderRootToken()));
      await renderDiagrams(diagramsView, files, currentTheme(), () => seq === diagramsSeq);
      if (seq === diagramsSeq) appStore.getState().markLoaded('diagrams', token);
    } catch (e) {
      if (seq === diagramsSeq) docMessage(diagramsView, 'Diagrams request failed: ' + String(e), 'error');
    }
  }

  // Mark the folder-derived Decisions + Notes pages stale on a workspace folder switch (the model-derived
  // views are dropped by invalidateDocViews; these two only change with the folder).
  function invalidateDocsPanel(): void {
    adrLoaded = false;
    notesLoaded = false;
  }

  // Diagrams are rendered with a theme-matched Mermaid palette; re-render on a theme flip. Mark the
  // cached diagram stale (so a not-visible one re-renders themed on its next visit) and re-render
  // immediately when the visual center is showing.
  function onThemeChanged(): void {
    // A theme flip re-themes ONLY the diagram (not a model edit), so mark just the 'diagrams' key stale —
    // a single-key invalidate that leaves every other surface fresh.
    appStore.getState().invalidate('diagrams');
    if (activeCenter() === 'visual') void loadDiagrams();
  }

  // --- center (Visual / Code / Documentation) + right rail + region focus ----
  // The active center / tech / docs view now lives in the uiChrome slice (#193) — there are no
  // module-local activeCenter / activeTech / activeDocs vars, so the highlighted tab (derived from the
  // slice) and the shown view (also derived from the slice in applyCenterChrome) can never drift apart.
  // These accessors read the slice at paint time.
  const activeCenter = (): CenterView => appStore.getState().center as CenterView;
  const activeTech = (): TechView => appStore.getState().tech as TechView;
  const activeDocs = (): DocsView => appStore.getState().docs as DocsView;

  const centerVisualEl = el('center-visual');

  // The construct palette is store-driven (active-context gating) and model-independent, so it mounts
  // once here rather than per diagram reload. Clicks route through the injected onAddConstruct callback.
  render(
    <CanvasPalette
      store={appStore}
      onAdd={(kind) => deps.onAddConstruct(kind)}
      onAddAnnotation={(kind) => deps.onAddAnnotation(kind)}
    />,
    el('canvas-palette-host'),
  );

  const centerTechnicalEl = el('center-technical');
  const centerDocsEl = el('center-docs');
  const editorPaneEl = el('editor-pane');
  const previewEl = el('view-preview');
  const centerTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.center-tab'));
  const techTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.tech-tab'));
  const docsTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.docs-tab'));

  // Pure chrome: surface the active center panel + its technical sub-view and mark the tabs, all read
  // from the uiChrome slice (#193) — the single source of truth the mode buttons and tab clicks write,
  // so the highlighted tab and the shown view can never diverge. No data fetch, so the boot frame can
  // land before the workspace document is open.
  function applyCenterChrome(): void {
    const center = activeCenter();
    const tech = activeTech();
    const docs = activeDocs();
    centerVisualEl.hidden = center !== 'visual';
    centerTechnicalEl.hidden = center !== 'technical';
    centerDocsEl.hidden = center !== 'docs';
    // The assistant is its own top-level center pane now (#235) — a peer of Visual/Code/Documentation,
    // reachable in one click from any view, not a Code sub-tab. Its host (#view-assistant) is the
    // center-host itself, so it's shown/hidden purely by the active center.
    assistantView.hidden = center !== 'assistant';
    // The bottom strip (Problems/Events/Relationships/Context Map) sits under the canvas/editor — it
    // serves Visual and Code, but not Documentation or the full-height Assistant conversation.
    diagEl.hidden = center === 'docs' || center === 'assistant';
    for (const t of centerTabs) t.setAttribute('aria-selected', String(t.dataset.center === center));
    const techVisible = center === 'technical';
    editorPaneEl.hidden = !(techVisible && tech === 'editor');
    previewEl.hidden = !(techVisible && tech === 'preview');
    checkView.hidden = !(techVisible && tech === 'check');
    scenariosView.hidden = !(techVisible && tech === 'scenarios');
    for (const t of techTabs) t.setAttribute('aria-selected', String(t.dataset.tech === tech));
    // Documentation sub-views: Glossary (the ubiquitous language), Decisions (the ADR list) and Notes.
    const docsVisible = center === 'docs';
    glossaryView.hidden = !(docsVisible && docs === 'glossary');
    adrView.hidden = !(docsVisible && docs === 'adr');
    notesView.hidden = !(docsVisible && docs === 'notes');
    for (const t of docsTabs) t.setAttribute('aria-selected', String(t.dataset.docs === docs));
    // CodeMirror measures lazily; revealing it from display:none leaves stale geometry until the next
    // layout tick, so force a re-measure whenever the editor becomes visible.
    if (!editorPaneEl.hidden) editor.view.requestMeasure();
  }

  function selectCenter(view: CenterView): void {
    appStore.getState().setCenter(view);
    applyCenterChrome();
    if (view === 'visual' && appStore.getState().isStale('diagrams')) void loadDiagrams();
    else if (view === 'technical') ensureTechLoaded();
    else if (view === 'docs') ensureDocsLoaded();
    else if (view === 'assistant') ensureAssistantShown();
  }

  // The assistant is interactive (not a cached, model-derived surface): every show re-points it at the
  // current folder's conversation and focuses the input — the single choke point for that swap. Created
  // lazily by ide.ts the first time this runs (the Anthropic SDK only loads on send).
  function ensureAssistantShown(): void {
    if (activeCenter() !== 'assistant') return;
    const a = deps.ensureAssistant();
    a.syncWorkspace();
    a.focusInput();
  }

  // Lazy-load the active Documentation sub-view: the glossary is model-derived; the Decisions and Notes
  // pages are folder-derived and load independently on their first open.
  function ensureDocsLoaded(): void {
    if (activeCenter() !== 'docs') return;
    const docs = activeDocs();
    if (docs === 'glossary' && appStore.getState().isStale('glossary')) void loadGlossary();
    else if (docs === 'adr' && !adrLoaded) void loadAdr();
    else if (docs === 'notes' && !notesLoaded) void loadNotes();
  }

  function selectDocsTab(view: DocsView): void {
    // setDocs sets docs AND forces center='docs' in one transition, so the docs tab + the center pane
    // never disagree.
    appStore.getState().setDocs(view);
    applyCenterChrome();
    ensureDocsLoaded();
  }

  function selectTech(view: TechView): void {
    // setTech sets tech AND forces center='technical' in one transition.
    appStore.getState().setTech(view);
    applyCenterChrome();
    ensureTechLoaded();
  }

  // Lazy-load the active technical sub-view: the emitted preview is the only model-derived one; the
  // editor is live and the check is on-demand. (The assistant is its own center pane now — see
  // ensureAssistantShown.)
  function ensureTechLoaded(): void {
    if (activeCenter() !== 'technical') return;
    if (activeTech() === 'preview' && appStore.getState().isStale('preview')) void loadPreview();
    else if (activeTech() === 'scenarios') deps.ensureScenarios?.().refresh();
    else if (activeTech() === 'check') renderCheckIdleIfEmpty();
  }

  // Surface the Documentation center tab (the "Docs" mode focus and the rail's "Ubiquitous Language"
  // shortcut both route here).
  function focusDocs(): void {
    selectDocsTab('glossary');
  }

  // The Context Map lives in the bottom strip, which applyCenterChrome HIDES while Documentation is the
  // active center. So the rail's Context Map link must first leave Documentation for a center that shows
  // the strip (Visual — the map's natural home) before opening its Context Map tab; otherwise the click
  // would set the bottom tab on a strip that stays hidden, and nothing would appear.
  function focusContextMap(): void {
    if (activeCenter() === 'docs') selectCenter('visual');
    selectBottomTab('contextmap');
  }

  // Repaint the always-visible left rail (Explorer + Overview + the right-rail Properties inspector) +
  // whatever the center is currently showing.
  function refreshActiveSurfaces(): void {
    void loadModel();
    if (activeCenter() === 'visual') void loadDiagrams();
    // The glossary is model-derived (refresh on edit); the ADR/Notes Docs panel is folder-derived, so an
    // edit never invalidates it — it reloads on folder change / its own create/save.
    else if (activeCenter() === 'docs' && activeDocs() === 'glossary') void loadGlossary();
    else if (activeCenter() === 'technical') ensureTechLoaded();
  }

  // Mark the cached, model-derived surfaces stale (e.g. after an edit or a file switch). A model edit
  // touches EVERY model-derived surface, so a single all-keys invalidate() bumps the preview / model /
  // diagram / glossary tokens at once (the docViews slice is the single source of truth — #193);
  // invalidateBottomPanels() then bumps the three bottom-table keys and live-refreshes the visible one.
  function invalidateDocViews(): void {
    appStore.getState().invalidate();
    // The joined glossary+diagram index (#142) and its in-flight builder are stale — drop both so the
    // next model load rebuilds against the current model.
    modelIndex = null;
    indexPromise = null;
    cachedDomainIndex = null; // the assistant's domain index is derived from the same model
    invalidateBottomPanels(); // the Events/Relationships/Context Map tables are model-derived too
  }

  // An edit makes the model-derived surfaces stale. Mark them dirty and (debounced) repaint the live
  // ones — the always-visible left rail plus the active center view — so they track the model without a
  // manual refresh. This is what makes the emitted preview + the diagram live.
  let editDebounce: ReturnType<typeof setTimeout> | undefined;
  function onDocEdited(): void {
    invalidateDocViews();
    // The set of contexts can change as the model is edited (a context added / renamed / removed), so
    // keep the switcher's options in step — debounced, and regardless of which view is active.
    clearTimeout(editDebounce);
    editDebounce = setTimeout(() => {
      void refreshContextList();
      refreshActiveSurfaces();
    }, 350);
  }

  for (const t of centerTabs) {
    t.addEventListener('click', () => selectCenter(t.dataset.center as CenterView));
  }
  for (const t of techTabs) {
    t.addEventListener('click', () => selectTech(t.dataset.tech as TechView));
  }
  for (const t of docsTabs) {
    t.addEventListener('click', () => selectDocsTab(t.dataset.docs as DocsView));
  }

  // The left rail's "Documentation" section: four shortcuts into the model's prose surfaces. Context
  // Map opens the bottom strip's map; the other three each open their own Documentation page (Glossary,
  // Decisions, Notes). querySelectorAll keeps this resilient to fixtures that omit the rail, and
  // selectBottomTab (declared below) is hoisted, so referencing it here is fine.
  const docLinkActions: Record<string, () => void> = {
    contextmap: () => focusContextMap(),
    glossary: () => focusDocs(),
    adr: () => selectDocsTab('adr'),
    notes: () => selectDocsTab('notes'),
  };
  for (const link of Array.from(document.querySelectorAll<HTMLButtonElement>('.koi-doclink'))) {
    const action = docLinkActions[link.dataset.doclink ?? ''];
    if (action) link.addEventListener('click', action);
  }

  // Right rail: Properties (the inspector) / Rules / Notes. Rules/Notes are placeholder panels for now —
  // the tab chrome matches the mockup while the inspector stays read-only. The active right view lives in
  // the uiChrome slice (#193), like center/tech/docs: selectRightView writes it via setRight, so the slice
  // owns that state rather than it being implicit in the DOM.
  const rightTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.rtab'));
  const rightViews: Record<RightView, HTMLElement> = {
    props: inspectorHost,
    rules: el('rview-rules'),
    notes: el('rview-notes'),
  };
  function selectRightView(view: RightView): void {
    appStore.getState().setRight(view);
    for (const t of rightTabs) t.setAttribute('aria-selected', String(t.dataset.rview === view));
    for (const [key, node] of Object.entries(rightViews)) node.hidden = key !== view;
  }
  for (const t of rightTabs) {
    t.addEventListener('click', () => selectRightView(t.dataset.rview as RightView));
  }

  // --- compatibility check (on-demand) ---------------------------------------
  // The check only runs when the user picks a baseline, so the panel would otherwise be an empty void
  // when its tab is first opened. Paint an explanatory idle state (with the trigger) so the surface
  // always reads as a feature, never a blank pane. Skipped once a check has produced output.
  function renderCheckIdleIfEmpty(): void {
    if (checkView.childElementCount > 0) return; // a prior result / loading / error line already shows
    render(null, checkView);
    checkView.innerHTML = '';
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
    checkView.appendChild(wrap);
  }

  async function runCheck(): Promise<void> {
    if (!platform.canOpenFolders) {
      docMessage(checkView, 'Selecting a baseline folder needs a Chromium-based browser.', 'error');
      selectTech('check');
      return;
    }
    let folder: string | null;
    try {
      folder = await platform.pickFolder('Select baseline model folder');
    } catch (e) {
      docMessage(checkView, 'Could not open the folder picker: ' + String(e), 'error');
      selectTech('check');
      return;
    }
    if (!folder) return; // cancelled — abort silently
    selectTech('check');
    docMessage(checkView, 'Checking against baseline…');
    try {
      // The browser has no server-side filesystem: read the baseline sources here and pass them to the
      // in-process compiler. The desktop server reads the folder path itself.
      const baselineSources = platform.kind === 'browser' ? await platform.readFolderSources(folder) : undefined;
      const res = await lsp.check(folder, baselineSources);
      if (res.error) {
        docMessage(checkView, 'Compatibility check failed: ' + res.error, 'error');
        return;
      }
      checkView.innerHTML = `<div class="koi-md">${renderMarkdown(renderCheckMarkdown(res))}</div>`;
    } catch (e) {
      docMessage(checkView, 'Check request failed: ' + String(e), 'error');
    }
  }

  // --- emitted-code preview --------------------------------------------------
  const LANGS: { id: PreviewTarget; name: string }[] = [
    { id: 'csharp', name: 'C#' },
    { id: 'typescript', name: 'TypeScript' },
    { id: 'python', name: 'Python' },
    { id: 'php', name: 'PHP' },
  ];
  let currentTarget: PreviewTarget = deps.initialTarget;
  const previewTabEl = el<HTMLButtonElement>('tech-tab-preview');

  function setTarget(target: PreviewTarget): void {
    currentTarget = target;
    const meta = LANGS.find((l) => l.id === target)!;
    previewTabEl.textContent = `Generated · ${meta.name}`;
  }

  // Emit the current target into the preview pane. Folded into the doc-view lifecycle (like the
  // glossary/diagrams tabs) so it loads on open and tracks edits live — no button press required. The
  // loaded/stale GATE is the docViews slice's 'preview' key (markLoaded only takes if the captured token
  // is still current). A local monotonic `previewSeq` is kept ALONGSIDE it because a destination-language
  // switch re-emits WITHOUT bumping the slice token: the seq drops a stale emit a newer call (edit or
  // target switch) superseded. The prior output stays on screen across a refresh (only the very first
  // load shows a placeholder) so live typing never flashes the pane empty.
  let previewSeq = 0;
  async function loadPreview(): Promise<void> {
    const seq = ++previewSeq;
    const token = appStore.getState().currentToken('preview');
    if (!lastPreview) output.setContent('// generating preview…', 'plain');
    try {
      const res = await lsp.emitPreview(currentTarget);
      if (seq !== previewSeq) return;
      let content: string;
      let lang: 'csharp' | 'typescript' | 'python' | 'php' | 'plain';
      let copyable = false;
      if (res.error) {
        content = '// emit error\n' + res.error;
        lang = 'plain';
      } else if (!res.files.length) {
        content = '// no files emitted (fix diagnostics first)';
        lang = 'plain';
      } else {
        content = res.files.map((f) => `// ==== ${f.path} ====\n${f.contents}`).join('\n\n');
        lang = currentTarget;
        copyable = true;
      }
      output.setContent(content, lang);
      lastPreview = content;
      copyBtn.disabled = !copyable;
      appStore.getState().markLoaded('preview', token);
    } catch (e) {
      if (seq !== previewSeq) return;
      output.setContent('// preview request failed\n' + String(e), 'plain');
      lastPreview = '';
      copyBtn.disabled = true;
    }
  }

  // Adopt a destination-language change from Settings → Output: relabel the tab, mark the preview
  // stale, and re-emit it when the Generated sub-view is the one showing (else it reloads next open).
  function onPreviewTargetChanged(target: PreviewTarget): void {
    if (target === currentTarget) return;
    setTarget(target);
    // A destination-language switch re-emits ONLY the preview (not a model edit), so mark just the
    // 'preview' key stale — a single-key invalidate that leaves every other surface fresh.
    appStore.getState().invalidate('preview');
    if (activeCenter() === 'technical' && activeTech() === 'preview') void loadPreview();
  }

  // --- bottom panel (Problems / Events / Relationships / Context Map, #144) --
  // The Events/Relationships tables + the Context Map are model-derived bottom-strip views; their lazy
  // fetch is owned by the docViews slice's stale-token discipline, each under its OWN key — 'events',
  // 'relationships', 'contextmap' (#193). A loader captures appStore.getState().currentToken(tab) before
  // its await and compares after, discarding a result an edit superseded, and markLoaded(tab, token)
  // only takes for the token it fetched. An edit's all-keys invalidate() bumps these three (along with
  // every other surface), so the whole strip goes stale together on an edit — exactly the old shared-key
  // behaviour, now without the controller-local `bottomLoadedToken` map distinguishing tabs. Events +
  // Relationships are Preact panels that subscribe to `activeContext` and scope themselves, so a scope
  // change re-renders them without a refetch; the loaders pass the UNSCOPED graph/context-map.
  // The active bottom tab lives in the uiChrome slice (#193) — read it through this accessor at use
  // sites, matching how center/tech/docs already flow through the slice; selectBottomTab writes it via
  // setBottom, so the slice genuinely owns that state.
  const activeBottomTab = (): BottomTab => appStore.getState().bottom;
  let bottomPanelDebounce: ReturnType<typeof setTimeout> | undefined;

  deps.initEdgeResizer({
    target: diagEl,
    handle: el('diag-resizer'),
    container: el('center'),
    cssVar: '--koi-diag-h',
    anchor: 'bottom',
    storageKey: 'koine.studio.diagHeight',
    min: 80,
    max: (h) => h * 0.5,
  });
  const diagCollapse = el('diag-collapse');
  const DIAG_COLLAPSED_KEY = 'koine.studio.diagCollapsed';
  function applyDiagCollapsed(collapsed: boolean): void {
    diagEl.classList.toggle('collapsed', collapsed);
    diagCollapse.setAttribute('aria-expanded', String(!collapsed));
  }
  applyDiagCollapsed((localStorage.getItem(DIAG_COLLAPSED_KEY) ?? '0') === '1');
  diagCollapse.addEventListener('click', () => {
    const collapsed = !diagEl.classList.contains('collapsed');
    applyDiagCollapsed(collapsed);
    try {
      localStorage.setItem(DIAG_COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      // ignore — no persistence available
    }
    if (!collapsed) ensureBottomLoaded(activeBottomTab()); // expanding → fill the active table if stale
  });

  // Tab switching: only the active panel body is shown; the count pill belongs to Problems. The first
  // time Events/Relationships is shown it loads lazily; clicking a tab also expands a collapsed panel.
  const bottomTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.diag-tab'));
  function selectBottomTab(tab: BottomTab): void {
    appStore.getState().setBottom(tab);
    for (const t of bottomTabs) t.setAttribute('aria-selected', String(t.dataset.panel === tab));
    diagBodyEl.hidden = tab !== 'problems';
    eventsPanel.hidden = tab !== 'events';
    relationshipsPanel.hidden = tab !== 'relationships';
    contextMapView.hidden = tab !== 'contextmap';
    diagCountEl.hidden = tab !== 'problems';
    if (diagEl.classList.contains('collapsed')) applyDiagCollapsed(false);
    ensureBottomLoaded(tab);
  }
  for (const t of bottomTabs) {
    t.addEventListener('click', () => selectBottomTab(t.dataset.panel as BottomTab));
  }

  // Row click → jump to the construct's `.koi` declaration (the same span navigation the diagram uses)
  // AND select it, so the Properties inspector loads the event — clicking an Events-table row inspects
  // it just like clicking its diagram node. The inspector resolves the diagram qualified name itself.
  const bottomTableHandlers = {
    goto: (span: SourceSpan) => deps.gotoSourceSpan(span),
    onSelect: (qualifiedName: string, context: string) => selection.set({ qualifiedName, context }),
  };

  // The merged DiagramGraph projection behind both tables: every per-diagram graph from livingDocs fused
  // into one (node ids disambiguated) so the extractors see all aggregates + the integration-event flow
  // at once. It's the SAME source the diagram renders from, so the tables and the diagram never drift.
  // Returned UNSCOPED — the Events/Relationships Preact panels narrow it to the active bounded context
  // themselves (#146, subscribing to the activeContext slice), so a scope change re-frames the mounted
  // table without a refetch.
  async function bottomGraph() {
    const docs = await lsp.livingDocs();
    return mergeDiagramGraphs(docs.files.flatMap((f) => f.diagrams.map((d) => d.graph)));
  }

  // Per-tab lazy-load gate, read straight off the docViews slice: each table has its own key, so
  // isStale(tab) is the gate (true until a load marks that key loaded at the current token). An edit's
  // all-keys invalidate() clears every key, so a re-show after an edit refetches; a re-show without one
  // reuses the render.
  function ensureBottomLoaded(tab: BottomTab): void {
    if (tab === 'events' && appStore.getState().isStale('events')) void loadEventsPanel();
    if (tab === 'relationships' && appStore.getState().isStale('relationships')) void loadRelationshipsPanel();
    if (tab === 'contextmap' && appStore.getState().isStale('contextmap')) void loadContextMapPanel();
  }

  // The "Context Map" tab: the strategic context map. The docViews slice's 'contextmap' token guards the
  // fetch — a token captured before the await is compared after, so a superseded fetch (an edit bumped
  // the token) can't clobber a newer render; markLoaded only takes for the token it fetched.
  async function loadContextMapPanel(): Promise<void> {
    await guardedLoad({
      store: appStore,
      key: 'contextmap',
      loading: () => docMessage(contextMapView, 'Loading context map…'),
      fetch: () => lsp.contextMap(),
      render: (res) => {
        contextMapView.innerHTML = `<div class="koi-md">${renderContextMapHtml(res)}</div>`;
      },
      onError: (e) => docMessage(contextMapView, 'Context map request failed: ' + String(e), 'error'),
    });
  }

  // Events + Relationships are Preact panels mounted into their hosts; each subscribes to the store's
  // `activeContext` slice and scopes itself, so the loaders pass the UNSCOPED merged graph / context map
  // and a scope change re-renders the table without a refetch. The fetch rides the docViews slice's own
  // per-tab token ('events' / 'relationships'): captured before the await, compared after (so an edit
  // mid-fetch discards the superseded result), and the panel is marked loaded only for the token it
  // fetched. The loading/error states write the host imperatively via docMessage, which unmounts the
  // prior Preact tree first — so the reconciler and the imperative write never fight over the node.
  async function loadEventsPanel(): Promise<void> {
    await guardedLoad({
      store: appStore,
      key: 'events',
      loading: () => docMessage(eventsPanel, 'Loading events…'),
      fetch: () => bottomGraph(),
      render: (graph) =>
        renderPanel(eventsPanel, <EventsPanel store={appStore} graph={graph} handlers={bottomTableHandlers} />),
      onError: (e) => docMessage(eventsPanel, 'Events request failed: ' + String(e), 'error'),
    });
  }

  async function loadRelationshipsPanel(): Promise<void> {
    await guardedLoad({
      store: appStore,
      key: 'relationships',
      loading: () => docMessage(relationshipsPanel, 'Loading relationships…'),
      fetch: () =>
        Promise.all([
          bottomGraph(),
          lsp.contextMap().catch(() => ({ contexts: [], relations: [] }) as ContextMapResult),
        ]),
      render: ([graph, ctxMap]) =>
        renderPanel(
          relationshipsPanel,
          <RelationshipsPanel store={appStore} graph={graph} contextMap={ctxMap} handlers={bottomTableHandlers} />,
        ),
      onError: (e) => docMessage(relationshipsPanel, 'Relationships request failed: ' + String(e), 'error'),
    });
  }

  // Mark the Events/Relationships/Context Map tables stale (called from invalidateDocViews on any model
  // change, and from a scope change). Each has its own docViews key now (#193): bumping a key's token
  // both invalidates any in-flight load of that tab (its captured token no longer matches) and makes the
  // tab stale for its next show (isStale reads the cleared `loaded`). If one is on screen and expanded,
  // live-refresh it (debounced) so it tracks edits like the inspector; Problems is refreshed by the
  // diagnostics push, and a collapsed panel reloads when next expanded.
  function invalidateBottomPanels(): void {
    const inv = appStore.getState().invalidate;
    inv('events');
    inv('relationships');
    inv('contextmap');
    if (activeBottomTab() === 'problems' || diagEl.classList.contains('collapsed')) return;
    clearTimeout(bottomPanelDebounce);
    bottomPanelDebounce = setTimeout(() => ensureBottomLoaded(activeBottomTab()), 350);
  }

  // --- boot ------------------------------------------------------------------
  // Boot the center chrome into the restored center pane (no fetch — ide.ts's boot ladder's
  // refreshActiveSurfaces loads everything once the workspace document is open) + label the Generated
  // sub-tab with the persisted target. The center is already seeded in the slice at construction
  // (setState above) and the center tabs derive their highlight from it, so boot only paints the center
  // chrome from that slice state.
  function init(): void {
    applyCenterChrome();
    setTarget(currentTarget);
    // Mount the top-bar scope path once at boot (hidden until refreshContextList finds a context). It
    // tracks scope/selection via the store thereafter; setContextOptions + loadModel re-render it when
    // the contexts list or model index changes.
    renderBreadcrumb();
  }

  // Cancel any pending debounce/reset timers. The IDE runs for the page lifetime in production (so this
  // is a no-op there), but the test suite boots many controllers into one shared happy-dom; disposing
  // between boots stops a deferred refresh (onDocEdited's 350ms debounce) from firing into a torn-down
  // environment, where `render` would throw "document is not defined".
  function dispose(): void {
    clearTimeout(copyResetTimer);
    clearTimeout(editDebounce);
    clearTimeout(bottomPanelDebounce);
  }

  return {
    selection,
    activeContext,
    selectCenter,
    selectTech,
    selectDocsTab,
    selectBottomTab,
    loadPreview,
    loadDiagrams,
    setTarget,
    onPreviewTargetChanged,
    runCheck,
    onDocEdited,
    invalidateDocViews,
    invalidateDocsPanel,
    onThemeChanged,
    refreshActiveSurfaces,
    refreshContextList,
    restoreActiveContext,
    followActiveFileContext,
    ensureModelIndex,
    getCachedDomainIndex,
    init,
    dispose,
  };
}
