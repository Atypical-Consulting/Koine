// inspectorController: the mode / center-tab / view subsystem lifted out of ide.ts's init()
// (Task 4 of the ide.ts decomposition, issue #180). It owns:
//   • the workspace MODE switcher (Domain / Code / Docs) and its chrome (#143),
//   • the CENTER view machinery — Visual (the diagram canvas), Code (editor / Generated preview /
//     Compatibility check / Assistant sub-tabs) and Documentation (Glossary / ADR-&-Notes sub-tabs) —
//     plus the right-rail Properties/Rules/Notes tab chrome,
//   • the BOTTOM strip (Problems / Events / Relationships / Context Map) with its lazy loaders,
//     collapse toggle and resizer,
//   • the per-view LAZY LOADERS and their stale-token / debounce lifecycle (the Generated preview,
//     the diagrams, the left-rail Domain navigator, the glossary, the ADR docs, and the bottom tables),
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
import type { KoineEditor, OutputLang, OutputView } from '@/editor/editor';
import type {
  CheckResult,
  ContextMapResult,
  DiagramEdge,
  DiagramNode,
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
import { renderContextMapGraph, type ContextMapGraphHandle } from '@/diagrams/diagrams-maxgraph';
import { buildContextMapGraph, type ContextMapEdge } from '@/diagrams/contextMapGraph';
import { NODE_NAVIGATE_EVENT, setDiagramLayoutStore, setDiagramPersistScope } from '@/diagrams/diagramContract';
import type {
  AddNodeKind,
  CanvasAnnotationKind,
  AggregateMemberKind,
  DiagramNodeNavigateDetail,
} from '@/diagrams/diagramContract';
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
  type ContextScope,
} from '@/model/activeContext';
import type { SelectedElement } from '@/model/selection';
import { type ModelOutlineHandlers } from '@/model/modelOutline';
import { mountDomainNavigator, type DomainNavigatorHandle, type TacticalHandlers } from '@/model/domainNavigator';
import { buildInspectorElement, renderRules, type InspectorElement, type InspectorHandlers } from '@/model/inspector';
import { buildModelIndex, lookupElement, resolveInspectableQn, type ModelIndex } from '@/model/modelIndex';
import { PropertiesPanel } from '@/model/PropertiesPanel';
import { SourceControlPanel } from '@/model/SourceControlPanel';
import { ContextBreadcrumb } from '@/model/ContextBreadcrumb';
import { EventsPanel } from '@/model/EventsPanel';
import { RelationshipsPanel } from '@/model/RelationshipsPanel';
import { GlossaryPanel } from '@/model/GlossaryPanel';
import { DocsPanelHost } from '@/docs/DocsPanelHost';
import { CanvasPalette } from '@/diagrams/CanvasPalette';
import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import { guardedLoad } from '@/shell/guardedLoad';
import { createInspectorSheet, type InspectorSheet } from '@/shell/inspectorSheet';
import { isNarrowViewport } from '@/shared/breakpoint';
import { loadLayout, saveLayout } from '@/shell/layoutStore';
import { DEFAULT_CENTER, DEFAULT_DECK_STATE, isValidCenter, type DeckState, type RightView } from '@/store/slices/uiChrome';
import type { DomainIndex } from '@/ai/aiPanel';
import { currentTheme } from '@/settings/theme';
import { escapeHtml, fileUriToPath, formatAclMapping, renderCheckMarkdown, renderContextMapHtml } from '@/shell/ideUtils';
import { DeckBarConnected } from '@/shell/deck/DeckBar';
import { DeckStage } from '@/shell/deck/DeckStage';

// LSP SymbolKind for a namespace — the kind the language service tags each top-level `context`
// document symbol with. Used by followActiveFileContext to read a file's bounded context(s).
const SYMBOL_KIND_NAMESPACE = 3;

// The center column's top-level views and the Code/Documentation sub-tabs (kept local — they're a UI
// concern, not part of the target-agnostic model). They mirror the uiChrome slice's CenterView /
// TechView / DocsView literals, which the chrome now drives through.
type CenterView = 'visual' | 'technical' | 'output' | 'docs';
type TechView = 'editor' | 'scenarios';
type OutputTab = 'generated' | 'compatibility' | 'contextmap';
type DocsView = 'glossary' | 'adr' | 'notes';
type BottomTab = 'problems' | 'events' | 'relationships' | 'terminal' | 'review';

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
  /** Persist/restore the Deck v2 center layout. Optional so callers that only wire the legacy
   *  center-pane pair don't need to be updated. */
  saveWorkspaceDeck?: (deck: DeckState) => void;
  loadWorkspaceDeck?: () => DeckState;
  saveActiveContext(workspaceKey: string, scope: string): void;
  loadActiveContext(workspaceKey: string): string | null;

  /**
   * Persist every dirty editor buffer (#109's Save-all), passed to the Source Control panel's
   * save-all-before-commit prompt (#470). ide.ts wires this to `workspace.saveAllDirty`.
   */
  saveAllDirty(): Promise<void>;

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
  /** Insert an aggregate-scoped construct (repository / rule, #254) into the selected aggregate. */
  onAddAggregateMember(kind: AggregateMemberKind, aggregateQualifiedName: string): void;
  /** Export the current Visual canvas as SVG / PNG / PlantUML (#271). */
  onExportDiagram(format: 'svg' | 'png' | 'plantuml'): void;
  /** Copy the current diagram's Mermaid source to the clipboard (#271). */
  onCopyDiagramMermaid(): void;
  /** Jump to a RAW 1-based source span (opens the owning file if needed) — the bottom tables' row click. */
  gotoSourceSpan(span: Pick<SourceSpan, 'file' | 'line' | 'column' | 'endLine' | 'endColumn'>): void;
  /**
   * Reveal a bounded context's `.koi` in the Files axis (the tactical "Reveal in Files" target, #453).
   * ide.ts owns the explorer instance, so it forwards to `explorer.revealByContext`; the tactical leaf
   * has already switched the rail to the Files axis (setAxis) before this fires.
   */
  revealInFiles(context: string): void;

  /** The assistant panel, created lazily by ide.ts the first time its tab is shown. */
  ensureAssistant(): InspectorAssistant;

  /** The scenario-runner panel (#149), created lazily by ide.ts the first time its tab is shown. */
  ensureScenarios?(): { refresh(): void };

  /**
   * The integrated terminal panel (#256), created lazily by ide.ts the first time its tab is shown.
   * `fit()` reflows xterm to the (now-visible) panel. Desktop-only — the browser host omits it, and
   * the panel renders a placeholder instead.
   */
  ensureTerminal?(): { fit(): void };

  /** The Review panel (#259), created lazily by ide.ts the first time its bottom-panel tab is shown. */
  ensureReview?(): void;

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
  /**
   * Switch the left rail's active navigator axis (#453): show the Domain pane (the strategic/tactical DDD
   * navigator) or the Files pane (the workspace `.koi` tree), hiding the other, and persist the choice.
   * ide.ts's ⌘B drives this so the file tree and the Domain view never both claim the rail.
   */
  setAxis(axis: 'domain' | 'files'): void;
  selectTech(view: TechView): void;
  selectOutput(view: OutputTab): void;
  selectDocsTab(view: DocsView): void;
  selectBottomTab(tab: BottomTab): void;
  /** Reveal a right-rail view (Properties / AI Chat / Rules / Notes / Source Control), expanding the rail
   *  if collapsed. Palette commands (Show AI Chat, Explain this construct) route through here. */
  selectRight(view: RightView): void;
  /** Apply the blessed Code ⟷ Canvas split preset (the .koi text and the live diagram side by side). */
  splitCodeCanvas(): void;

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
  /**
   * Live refresh-on-save (#470): re-fetch git status in the Source Control panel when it's the active
   * right view (reusing the `sourceControlRefresh` nonce, so the commit-message draft survives the
   * in-place refresh). A no-op when the SC tab isn't open or the panel hasn't mounted. ide.ts calls
   * this from the editor's save-completion path so a save while the tab is open repaints the changed
   * files without a manual Refresh.
   */
  refreshSourceControl(): void;
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

  // Left-rail host: the Domain axis's strategic/tactical navigator (#453). mountDomainNavigator owns this
  // node — it self-fetches its strategic data and reads the store for altitude + scope — so loadModel
  // mounts it once and thereafter just reloads it. (The former Overview counts surface was removed with
  // the section stack.)
  const domainPane = el('rail-domain-pane');
  // The mounted Domain navigator (#453), created lazily on the first loadModel and reused thereafter — so
  // a model reload re-fetches its strategic data rather than re-mounting (which would drop its store
  // subscription + breadcrumb state). Disposed on tear-down to drop that subscription.
  let domainNavigator: DomainNavigatorHandle | null = null;
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
  // Below $bp-narrow the inspector lives in a bottom sheet instead of the fixed #right rail (#221). The
  // sheet host is OPTIONAL: it's absent from the desktop-only test fixtures, and without it the
  // controller keeps the original right-rail behaviour untouched (no sheet, no resize listener). When it
  // exists the sheet is built once here; renderSelectedInspector mounts Properties into its body on a
  // narrow viewport, and a selection raises it to half.
  const sheetHostEl = document.getElementById('inspector-sheet-host');
  const inspectorSheet: InspectorSheet | null = sheetHostEl ? createInspectorSheet(sheetHostEl) : null;
  // The host the Properties panel is currently rendered into (sheet body on a narrow viewport, else the
  // fixed #inspector-host). Tracked so renderSelectedInspector can unmount the PRIOR host's Preact tree
  // when the active host changes across the breakpoint (#221) — Preact's render() leaves it otherwise.
  let inspectorMountHost: HTMLElement | null = null;
  // Widening past the breakpoint dismisses the sheet and hands Properties back to the fixed right rail;
  // narrowing re-mounts it into the sheet body on the next render. Registered only when the sheet exists.
  // Track the last narrow-ness so a resize TICK that does NOT cross the breakpoint is a no-op: on mobile
  // the soft keyboard / address bar fire `resize` constantly, and re-mounting Properties on every one
  // would thrash the panel. Only an actual narrow↔wide CROSS re-renders/re-mounts (a widen still dismisses
  // the sheet first) — mirroring ide.tsx's diagram-resize cross guard.
  let wasNarrow = isNarrowViewport();
  function onViewportResize(): void {
    const narrow = isNarrowViewport();
    if (narrow === wasNarrow) return; // not a cross — ignore the keyboard/address-bar resize churn
    wasNarrow = narrow;
    // A narrow↔wide cross (rotate/resize) re-evaluates the bottom strip's viewport-aware default (#475) —
    // Documentation/Assistant collapse the strip below BP_NARROW — without clobbering an explicit user
    // preference (applyDefaultDiagCollapsed is itself gated on that). Runs whether or not the inspector
    // sheet exists, so the reading views reclaim their height on a portrait rotate.
    applyDefaultDiagCollapsed();
    if (!inspectorSheet) return; // the remainder is the bottom-sheet's #221 narrow↔wide handling
    if (!narrow && inspectorSheet.isOpen()) inspectorSheet.setDetent('peek');
    renderSelectedInspector(); // re-mount into the now-correct host (sheet body vs #inspector-host)
  }
  window.addEventListener('resize', onViewportResize);
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
  const terminalPanel = el('panel-terminal');
  const reviewPanel = el('panel-review');

  // --- center pane restore ---------------------------------------------------
  // Restore the persisted center pane, defaulting to Visual when absent/invalid.
  const restoredCenter = deps.loadWorkspaceCenter();
  const initialCenter: CenterView =
    restoredCenter && isValidCenter(restoredCenter) ? restoredCenter : DEFAULT_CENTER;
  // The Deck v2 layout (mode / primary / secondary / ratio / flipped) is restored if a dep wires it
  // (it migrates a pre-Deck split layout + the legacy single-view value); otherwise derive a 1-up on the
  // restored center. `center` mirrors the deck's primary.
  const restoredDeck = deps.loadWorkspaceDeck?.();
  const initialDeck: DeckState = restoredDeck ?? { ...DEFAULT_DECK_STATE, primary: initialCenter };
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
    deck: initialDeck,
    center: initialDeck.primary,
    tech: 'editor',
    output: 'generated',
    docs: 'glossary',
    bottom: 'problems',
    right: 'props',
    // The Domain navigator starts at the strategic altitude (#453) for a fresh workspace session — reset
    // here for the same reason the tabs above are: the injected store is, in production, the app-wide
    // singleton reused across reopens, so a prior session left on tactical mustn't leak into a fresh boot.
    navAltitude: 'strategic',
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
    // The status-bar readout + the scoped-surface re-filter are NOT driven here — the `activeContext`
    // subscription below (in createInspectorController) owns them, firing on the slice write this performs.
    // That's what keeps EVERY writer of the slice in lockstep: this dropdown path AND the Domain
    // navigator's drill (#453), which calls setActiveContext directly and so used to skip those two
    // imperative side-effects entirely (#531). Persisting stays here — only a deliberate switcher choice
    // persists; non-deliberate changes (following a selection, or falling back off a vanished context)
    // are view-only so they never overwrite the user's last explicit choice in storage.
    activeContext.set(scope);
    if (persist) deps.saveActiveContext(contextWorkspaceKey(), scope);
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

  // The store's `activeContext` slice is the single source of truth for the active scope: ANY writer —
  // the toolbar dropdown (via applyScope) OR the Domain navigator's drill (#453), which calls
  // setActiveContext directly — must drive the status-bar readout AND the scoped-surface re-filter.
  // Subscribing here (rather than running those two only inside applyScope) is what keeps the navigator
  // drill and the dropdown in lockstep (#531): before, the drill wrote the slice but skipped applyScope's
  // two imperative side-effects, so the status bar read "All contexts" and the canvas stayed unfiltered
  // while the dropdown already showed the drilled context. Guarded on a real value change so an unrelated
  // slice write (setCenter / setSelection / …) is ignored; captured + unsubscribed on dispose (like the
  // dirty-count subscription) so a deferred change can't repaint a torn-down host.
  const unsubscribeActiveContext = appStore.subscribe((s, prev) => {
    if (s.activeContext === prev.activeContext) return;
    syncContextStatusBar();
    rerenderScopedSurfaces();
  });

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

  // --- Source Control (git) right-rail panel (#272) -------------------------
  // Folder-derived like the docs pages: lazily mounted on the first Source-Control tab open, re-fetched
  // on every re-open (a `refreshNonce` bump — Preact reuses the mounted instance, so the commit-message
  // draft survives the in-place refresh), and re-mounted against the new folder on a workspace switch.
  // The panel self-gates on `platform.canUseGit` and catches a non-repo `gitStatus` reject, so the
  // controller can mount it unconditionally and let it paint the right empty state.
  const sourceControlRightView = el('rview-source-control');
  let sourceControlLoaded = false;
  let sourceControlRefresh = 0;
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
        dirtyCount={appStore.getState().dirtyCount()}
        onSaveAll={() => deps.saveAllDirty()}
      />,
      sourceControlRightView,
    );
  }
  function loadSourceControl(): void {
    if (sourceControlLoaded) sourceControlRefresh += 1; // a re-open re-fetches; first mount loads on its own
    sourceControlLoaded = true;
    renderSourceControl();
  }
  // #470: re-fetch git status when a save lands while the SC tab is open — reuses the nonce bump so the
  // in-place refresh preserves the commit-message draft. A no-op when the panel isn't mounted or isn't
  // the active right view (the next open re-fetches anyway).
  function refreshSourceControl(): void {
    if (!sourceControlLoaded) return;
    if (appStore.getState().right !== 'source-control') return;
    loadSourceControl();
  }
  // #470: keep the panel's `dirtyCount` prop live so the commit guard sees buffers dirtied AFTER it last
  // mounted. A dirty-count change re-paints the panel in place (no nonce bump → no git re-fetch), only
  // while the SC tab is the active right view; closed/unmounted → nothing to repaint. The unsubscribe is
  // captured and called on dispose() so a deferred dirty-count change can't repaint a torn-down host.
  let lastDirtyCount = appStore.getState().dirtyCount();
  const unsubscribeDirtyCount = appStore.subscribe((s) => {
    const dc = s.dirtyCount();
    if (dc === lastDirtyCount) return;
    lastDirtyCount = dc;
    if (sourceControlLoaded && s.right === 'source-control') renderSourceControl();
  });
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

  // The Domain navigator's wiring (#453), passed to mountDomainNavigator: its strategic doorways route to
  // focusContextMap() / focusDocs() (the bottom strip is global since #451, so focusContextMap just opens
  // the Context Map tab in place), and its onSelect/goto drive the inspector + jump-to-source for the
  // tactical leaves (wired through renderTactical in Task 4).
  const modelOutlineHandlers: ModelOutlineHandlers = {
    onSelect: (entry) => selection.set({ qualifiedName: entry.qualifiedName, context: entry.context }),
    goto: (line, col) => editor.goto(line, col),
    onOpenContextMap: () => focusContextMap(),
    onOpenGlossary: () => focusDocs(),
  };

  // --- rail axis switch: Domain vs Files (#453) ------------------------------
  // The left rail shows ONE of two top-level navigators: the Domain pane (#rail-domain-pane — the
  // strategic/tactical DDD navigator) or the Files pane (#rail-files — the workspace `.koi` tree). The
  // axis is persisted so a reload restores the last-used navigator; Domain is the default. ide.ts's ⌘B
  // and the tactical "Reveal in Files" affordance both drive setAxis (the file tree and the Domain view
  // never both claim the rail). The segmented control's two buttons live in #rail-axis-switch.
  const RAIL_AXIS_KEY = 'koine.studio.railAxis';
  type RailAxis = 'domain' | 'files';
  const filesPane = document.getElementById('rail-files');
  const axisButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#rail-axis-switch [data-axis]'));

  // Paint the active axis: surface its pane, hide the other, and reflect the segmented control. Showing
  // Files also force-expands its section (its own collapse is ide.ts's #rail-sect chrome) so a reveal
  // always lands on a visible row.
  function applyAxis(axis: RailAxis): void {
    domainPane.hidden = axis !== 'domain';
    if (filesPane) {
      filesPane.hidden = axis !== 'files';
      if (axis === 'files') {
        filesPane.dataset.open = 'true';
        filesPane.querySelector('.rail-sect-head')?.setAttribute('aria-expanded', 'true');
      }
    }
    for (const b of axisButtons) b.setAttribute('aria-selected', String(b.dataset.axis === axis));
  }

  function setAxis(axis: RailAxis): void {
    applyAxis(axis);
    try {
      localStorage.setItem(RAIL_AXIS_KEY, axis);
    } catch {
      // no persistence available — the in-session choice still applies
    }
  }

  for (const b of axisButtons) {
    b.addEventListener('click', () => setAxis((b.dataset.axis as RailAxis) ?? 'domain'));
  }

  // The Domain navigator's TACTICAL leaf wiring (#453): a leaf click selects-and-jumps; its ⋯ overflow's
  // "Reveal in Files" switches the rail to the Files axis then reveals the node's `.koi`. Selection +
  // jump-to-source reuse the same seams the Model outline / diagram use, so the surfaces stay consistent.
  const tacticalHandlers: TacticalHandlers = {
    // Select the node — derive its bounded context from the qualified-name prefix (the model graph
    // carries no separate context field), falling back to the active scope when the name is unqualified.
    onSelect: (node) => selection.set({ qualifiedName: node.qualifiedName, context: nodeContext(node) }),
    // Resolve the node to the nearest inspectable element and jump to its declaration (the editor's
    // 1-based goto contract; the glossary nameRange is 0-based, hence the +1). Unresolvable → no-op.
    goto: (node) => {
      if (!modelIndex) return;
      const qn = resolveInspectableQn(modelIndex, node.qualifiedName);
      const entry = qn ? lookupElement(modelIndex, qn)?.element.entry : undefined;
      if (!entry) return;
      modelOutlineHandlers.goto(entry.nameRange.start.line + 1, entry.nameRange.start.character + 1);
    },
    reveal: (node) => deps.revealInFiles(nodeContext(node)),
    setAxis: (axis) => setAxis(axis),
  };

  // A model node's bounded context: the segment before the first dot of its qualified name (the model
  // graph names a context child `Context.X`), or the active scope when the name is unqualified.
  function nodeContext(node: ModelNode): string {
    const dot = node.qualifiedName.indexOf('.');
    if (dot > 0) return node.qualifiedName.slice(0, dot);
    const scope = activeContext.get();
    return isAllContexts(scope) ? '' : scope;
  }
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
    // Per-element git change history (#150): the commits that touched the element's declaration. The
    // desktop host shells out to `git log -L`; the browser host returns null (section hidden).
    loadHistory: (element) => {
      // Prefer the element's own source span — its correct file AND full line range — so history is
      // scoped to the right declaration even when it lives in a file other than the active editor (a
      // multi-file workspace). Fall back to the active file + name range for elements with no diagram
      // node / span (e.g. an undrawn value object).
      const span = element.sourceSpan;
      const useSpan = span != null && span.file != null;
      const path = fileUriToPath(useSpan ? span.file! : deps.activeUri());
      if (!path) return Promise.resolve(null);
      // git `-L` is 1-based inclusive. A SourceSpan is 1-based with an end-EXCLUSIVE endLine (so the last
      // content line is endLine - 1); the name range is 0-based LSP positions, so shift those by one.
      const startLine = useSpan ? span.line : element.nameRange.start.line + 1;
      const endLine = useSpan ? Math.max(span.line, span.endLine - 1) : element.nameRange.end.line + 1;
      return deps.platform.gitLogForRange(path, startLine, endLine);
    },
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
    // Mobile: mount Properties into the bottom-sheet body; desktop (or no sheet host): the fixed
    // right-rail host. The PropertiesPanel itself is unchanged — only its mount target differs (#221).
    const host = inspectorSheet && isNarrowViewport() ? inspectorSheet.contentNode() : inspectorHost;
    // Preact's render(vnode, newHost) does NOT unmount the tree in the PREVIOUS container, so crossing the
    // breakpoint (sheet body ↔ #inspector-host) would otherwise leave a live, store-subscribed
    // PropertiesPanel mounted in the now-hidden host. Unmount the prior host before rendering into the new
    // one so exactly one panel is ever live (#221).
    if (inspectorMountHost && inspectorMountHost !== host) render(null, inspectorMountHost);
    inspectorMountHost = host;
    render(
      <PropertiesPanel store={appStore} index={modelIndex} handlers={inspectorHandlers} />,
      host,
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

  // Repaint the Domain axis's strategic/tactical navigator (#453) and the model-index-derived chrome
  // (breadcrumb, palette, inspector). The navigator OWNS #rail-domain-pane: it self-fetches its strategic
  // data and reads the store for altitude + scope, so loadModel mounts it once and thereafter just reloads
  // it. The inspector resolves any selection against the whole model, so it tracks the model index here.
  async function loadModel(): Promise<void> {
    // Capture the 'model' stale-token before the await; markLoaded only takes if it's still current
    // after, so an edit mid-fetch leaves the surface stale for the next show (the slice discipline).
    const token = appStore.getState().currentToken('model');
    // The navigator's strategic data is scope-INDEPENDENT and it repaints from its own cache on
    // activeContext/outlineFilter store changes — so only re-fetch when the MODEL actually changed, not on
    // a pure scope/filter re-render (rerenderScopedSurfaces keeps the model index, so a null index is the
    // reliable "the model was (re)loaded" signal — an edit nulls it via invalidateDocViews). Captured
    // BEFORE ensureModelIndex() rebuilds it.
    const hadIndex = modelIndex != null;
    // Mount the navigator once (it paints a loading placeholder + its own empty state, and surfaces a
    // fetch failure in the pane itself); a reload re-fetches its strategic data. Kicking this off before
    // the await runs its fetch in parallel with the model index build, so the rail paints promptly. Its
    // Context Map / Ubiquitous Language doorways route to the same focuses the docs footer used.
    if (!domainNavigator) {
      domainNavigator = mountDomainNavigator(domainPane, appStore, lsp, modelOutlineHandlers, tacticalHandlers);
    } else if (!hadIndex) {
      domainNavigator.reload();
    }
    try {
      await ensureModelIndex();
      // The model index just (re)built — re-pass it to the breadcrumb so the selected element's type icon
      // resolves (the panel tracks selection itself, but reads the construct off the index prop). The
      // palette likewise reads the index to gate its aggregate-scoped buttons (#254), so re-pass it too.
      renderBreadcrumb();
      renderCanvasPalette();
      renderSelectedInspector();
      applySelectionHighlight();
      appStore.getState().markLoaded('model', token);
    } catch (e) {
      // The navigator owns #rail-domain-pane and surfaces its own fetch failure there; a failing model
      // index (the inspector/breadcrumb source) is reported on the status pill instead.
      deps.setStatus('Model request failed: ' + String(e), 'error');
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
    // Mobile: a fresh selection raises the inspector sheet into view (#221) so the just-selected
    // element's Properties are visible without hunting for the Props tab. Only when a sheet exists, the
    // viewport is narrow, and something is actually selected (clearing the selection leaves it be). Raise
    // through the OWNED instance (not the module-global openInspectorSheet) so this controller drives only
    // its own sheet — symmetric with the resize-path's instance setDetent('peek'), and split-brain-proof
    // if more than one sheet ever exists (#221).
    if (inspectorSheet && isNarrowViewport() && sel) inspectorSheet.setDetent('half');
    // Desktop equivalent of the mobile sheet-raise above (#533): a fresh selection auto-activates the
    // right rail's Properties tab so the just-selected element's inspector is visible without a second
    // click — even when the user had Source Control / Rules / Notes open. Only on a NEW, non-null
    // selection (a deselect leaves the user's current tab as-is, mirroring the `&& sel` guard above), and
    // only when not already on Properties so an in-scope selection doesn't trigger a redundant repaint.
    if (sel && appStore.getState().right !== 'props') selectRightView('props');
    // Re-pass the current model index to the palette so its aggregate-scoped buttons (#254) re-gate against
    // the freshly-selected element — a diagram click rebuilds the index before setting the selection, so
    // resolving the selection's kind here uses the up-to-date index rather than a stale captured prop.
    renderCanvasPalette();
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
    // Source Control is folder-derived too — drop its loaded gate so the next open re-mounts it against
    // the new folder, and re-mount immediately when it's the open right-rail view (its `gitStatus` is for
    // the new workspace's repository). This runs on a folder open / root-set change; a `.koi` save's
    // refresh is covered by the refresh-on-reopen (selectRightView) plus the panel's own Refresh button.
    sourceControlLoaded = false;
    if (appStore.getState().right === 'source-control') loadSourceControl();
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
  const activeOutput = (): OutputTab => appStore.getState().output as OutputTab;

  const centerVisualEl = el('center-visual');

  // The construct palette mounts once here; it re-renders itself on the store slices it subscribes to
  // (active context, selection). It also reads the model `index` to resolve whether the selection is an
  // aggregate (gating the rule/repository buttons, #254), so renderCanvasPalette re-passes a fresh index
  // whenever the model rebuilds OR the selection changes — mirroring how the Properties panel is
  // re-rendered. Context-scoped clicks route through onAddConstruct; aggregate-scoped through
  // onAddAggregateMember with the target qname; canvas-only annotations (#255) through onAddAnnotation.
  function renderCanvasPalette(): void {
    render(
      <CanvasPalette
        store={appStore}
        index={modelIndex}
        onAdd={(kind) => deps.onAddConstruct(kind)}
        onAddAggregateMember={(kind, aggregateQn) => deps.onAddAggregateMember(kind, aggregateQn)}
        onAddAnnotation={(kind) => deps.onAddAnnotation(kind)}
        onExport={(format) => deps.onExportDiagram(format)}
        onCopyMermaid={() => deps.onCopyDiagramMermaid()}
      />,
      el('canvas-palette-host'),
    );
  }
  renderCanvasPalette();

  const centerBodyEl = el('center-body');
  const deckBarEl = el('deck-bar');
  const centerTechnicalEl = el('center-technical');
  const centerOutputEl = el('center-output');
  const centerDocsEl = el('center-docs');
  const editorPaneEl = el('editor-pane');
  const previewEl = el('view-preview');
  // The four center surfaces, handed to the DeckStage which hosts each in its card body (the deck owns
  // their layout now — no per-pane re-parenting; the FLIP positions the cards instead).
  const centerHosts: Record<CenterView, HTMLElement> = {
    visual: centerVisualEl,
    technical: centerTechnicalEl,
    output: centerOutputEl,
    docs: centerDocsEl,
  };

  // The center surfaces visible under the current deck state: all four in overview, else the primary
  // (plus the secondary in a 2-up). Lazy-loaders + sub-view chrome key off this, not just `center`, so
  // the SECONDARY pane of a 2-up loads and shows correctly.
  function visibleCenters(): CenterView[] {
    const { deck } = appStore.getState();
    if (deck.mode === 'overview') return ['visual', 'technical', 'output', 'docs'];
    return deck.secondary ? [deck.primary, deck.secondary] : [deck.primary];
  }

  // Pure chrome: surface the active center panel + its technical sub-view and mark the tabs, all read
  // from the uiChrome slice (#193) — the single source of truth the mode buttons and tab clicks write,
  // so the highlighted tab and the shown view can never diverge. No data fetch, so the boot frame can
  // land before the workspace document is open.
  function applyCenterChrome(): void {
    const tech = activeTech();
    const output = activeOutput();
    const docs = activeDocs();
    const vis = visibleCenters();

    // The bottom strip (Problems/Events/Relationships/Terminal/Review) is GLOBAL: it serves every center
    // view and is hidden only by its own collapse toggle (#diag-collapse), never by the active view.
    diagEl.hidden = false;
    // …but on a NARROW viewport the reading-heavy Documentation view DEFAULTS the strip collapsed so the
    // reading pane keeps full height on a phone (#475). Re-evaluated on every center switch and gated so an
    // explicit user collapse preference always wins; desktop + the working views keep the expanded default.
    applyDefaultDiagCollapsed();

    // Each surface keeps its body sub-views; a sub-view is shown when its surface is visible (primary,
    // secondary, or any in overview) AND it is that surface's active facet. The facet sub-strip itself
    // now lives in the DeckCard header (the in-host tab rows were removed), so there are no tab buttons
    // to mark here — the header reflects the active facet via Preact.
    const techVisible = vis.includes('technical');
    editorPaneEl.hidden = !(techVisible && tech === 'editor');
    scenariosView.hidden = !(techVisible && tech === 'scenarios');
    const outputVisible = vis.includes('output');
    previewEl.hidden = !(outputVisible && output === 'generated');
    checkView.hidden = !(outputVisible && output === 'compatibility');
    contextMapView.hidden = !(outputVisible && output === 'contextmap');
    const docsVisible = vis.includes('docs');
    glossaryView.hidden = !(docsVisible && docs === 'glossary');
    adrView.hidden = !(docsVisible && docs === 'adr');
    notesView.hidden = !(docsVisible && docs === 'notes');
    // CodeMirror measures lazily; revealing it from display:none leaves stale geometry until the next
    // layout tick, so force a re-measure whenever the editor becomes visible.
    if (!editorPaneEl.hidden) editor.view.requestMeasure();
  }

  // Lazy-load every surface currently visible under the deck state (covers the secondary pane of a 2-up
  // and all four in overview), plus the model-derived facet of each. Self-gating loaders make repeat
  // calls cheap. Triggered by the deck/facet subscription on any center change.
  function ensureVisibleLoaded(): void {
    if (visibleCenters().includes('visual') && appStore.getState().isStale('diagrams')) void loadDiagrams();
    ensureTechLoaded();
    ensureOutputLoaded();
    ensureDocsLoaded();
  }

  // Apply the center chrome AND load whatever is now visible — the single sync point the deck/facet
  // subscription drives.
  function syncCenterChrome(): void {
    applyCenterChrome();
    ensureVisibleLoaded();
  }

  function selectCenter(view: CenterView): void {
    // Plain "show this surface" = focus it 1-up; the deck subscription applies the chrome + lazy-loads.
    appStore.getState().focusPrimary(view);
  }

  // The assistant is interactive (not a cached, model-derived surface): every show re-points it at the
  // current folder's conversation and focuses the input — the single choke point for that swap. Created
  // lazily by ide.ts the first time this runs (the Anthropic SDK only loads on send). It now lives in the
  // right rail, so the guard checks the active RightView rather than the center.
  function ensureAssistantShown(): void {
    if (appStore.getState().right !== 'assistant') return;
    const a = deps.ensureAssistant();
    a.syncWorkspace();
    a.focusInput();
  }

  // Lazy-load the visible Documentation sub-view: the glossary is model-derived; the Decisions and Notes
  // pages are folder-derived and load independently on their first open. Gated on visibility (primary,
  // secondary, or overview) so the Docs surface loads even as the SECONDARY pane of a 2-up.
  function ensureDocsLoaded(): void {
    if (!visibleCenters().includes('docs')) return;
    const docs = activeDocs();
    if (docs === 'glossary' && appStore.getState().isStale('glossary')) void loadGlossary();
    else if (docs === 'adr' && !adrLoaded) void loadAdr();
    else if (docs === 'notes' && !notesLoaded) void loadNotes();
  }

  function selectDocsTab(view: DocsView): void {
    // setDocs sets the facet and brings Docs up if it isn't shown; the deck subscription applies the
    // chrome + lazy-loads.
    appStore.getState().setDocs(view);
  }

  function selectTech(view: TechView): void {
    appStore.getState().setTech(view);
  }

  // Lazy-load the visible Code sub-view. The editor is live (CodeMirror, always mounted); only the
  // scenario runner needs a refresh on show. The compiler-produced surfaces (Generated / Compatibility /
  // Context Map) moved to the Output view — see ensureOutputLoaded.
  function ensureTechLoaded(): void {
    if (!visibleCenters().includes('technical')) return;
    if (activeTech() === 'scenarios') deps.ensureScenarios?.().refresh();
  }

  function selectOutput(view: OutputTab): void {
    appStore.getState().setOutput(view);
  }

  // Lazy-load the visible Output sub-view: the emitted preview is model-derived (stale-gated), the
  // compatibility check is on-demand (idle state until a baseline is picked), and the context map is the
  // model-derived graph/table (stale-gated) relocated here from the bottom panel.
  function ensureOutputLoaded(): void {
    if (!visibleCenters().includes('output')) return;
    const output = activeOutput();
    if (output === 'generated' && appStore.getState().isStale('preview')) void loadPreview();
    else if (output === 'compatibility') renderCheckIdleIfEmpty();
    else if (output === 'contextmap' && appStore.getState().isStale('contextmap')) void loadContextMapPanel();
  }

  // Surface the Documentation center tab (the "Docs" mode focus and the rail's "Ubiquitous Language"
  // shortcut both route here).
  function focusDocs(): void {
    selectDocsTab('glossary');
  }

  // The Context Map is the contextmap sub-view of the Output center pane now — opening it is a center
  // switch (selectOutput forces center='output' and lazy-loads the graph if stale).
  function focusContextMap(): void {
    selectOutput('contextmap');
  }

  // Repaint the always-visible left rail (Explorer + Overview + the right-rail Properties inspector) +
  // every center surface currently showing (both panes of a 2-up, all four in overview).
  function refreshActiveSurfaces(): void {
    void loadModel();
    const vis = visibleCenters();
    if (vis.includes('visual')) void loadDiagrams();
    // The glossary is model-derived (refresh on edit); the ADR/Notes Docs panel is folder-derived, so an
    // edit never invalidates it — it reloads on folder change / its own create/save.
    if (vis.includes('docs') && activeDocs() === 'glossary') void loadGlossary();
    if (vis.includes('technical')) ensureTechLoaded();
    if (vis.includes('output')) ensureOutputLoaded();
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

  // The center surface switcher + facet sub-strips are now the DeckBar / DeckCard Preact components
  // (mounted in init()); they call focusPrimary / openBeside / setTech|Output|Docs on the store directly,
  // and the deck/facet subscription applies the chrome — so there are no imperative tab click handlers
  // to wire here anymore.

  // The left rail's documentation footer: shortcuts into the model's prose surfaces. ADR + Notes each
  // open their own Documentation page; the contextmap/glossary actions are retained (the footer no
  // longer renders those buttons — they moved into the Domain axis, #453 — so they simply bind to
  // nothing, and a later task can re-wire them from the strategic view). querySelectorAll keeps this
  // resilient to fixtures that omit the rail, and selectBottomTab (declared below) is hoisted, so
  // referencing it here is fine.
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
  // The right-edge icon stripe (#right-strip) is the sole right-view switcher (#500 follow-up); the panel
  // carries only a title header naming the active tool window. selectRightView keeps #right-title in sync
  // and shows the matching view — there's no tab row to mark. (Guarded lookup so DOM fixtures that omit
  // the header don't crash the controller.)
  const rightTitleEl = document.getElementById('right-title');
  const rightViewLabels: Record<RightView, string> = {
    props: 'Properties',
    assistant: 'AI Chat',
    rules: 'Rules',
    notes: 'Notes',
    'source-control': 'Source Control',
  };
  const rightViews: Record<RightView, HTMLElement> = {
    props: inspectorHost,
    assistant: assistantView,
    rules: el('rview-rules'),
    notes: el('rview-notes'),
    'source-control': sourceControlRightView,
  };
  function selectRightView(view: RightView): void {
    appStore.getState().setRight(view);
    if (rightTitleEl) rightTitleEl.textContent = rightViewLabels[view];
    for (const [key, node] of Object.entries(rightViews)) node.hidden = key !== view;
    // Source Control is lazily mounted + folder-derived (#272): paint it on first open and re-fetch git
    // status on every re-open (so a save / external `git` since the last view is reflected — the panel
    // itself owns the in-place refresh). The canUseGit gate + the non-repo empty state live in the panel.
    if (view === 'source-control') loadSourceControl();
    // The AI assistant is lazily created + interactive (#235): mount it on first open and re-sync the
    // conversation to the current folder + focus the input on every re-open.
    else if (view === 'assistant') ensureAssistantShown();
  }
  // Reveal a right-rail view, expanding the rail first if it was collapsed — the entry point palette
  // commands (Show AI Chat, Explain this construct) route through so the panel is always actually visible.
  function selectRight(view: RightView): void {
    if (appStore.getState().rightCollapsed) appStore.getState().setRightCollapsed(false);
    selectRightView(view);
  }

  // Right-edge tool-window stripe (#500): Rider-style toggles that open/close (and switch) the #right
  // Properties panel from a persistent vertical bar. The collapsed flag is owned by the uiChrome slice
  // (runtime, #193) and mirrored to layoutStore (persistence) — the same split the diagnostics strip uses
  // (applyDiagCollapsed). The active view stays owned by uiChrome.right / selectRightView; collapse is a
  // SEPARATE, independent flag, so re-expanding always restores the last view rather than a blank panel.
  const rstripSplitEl = el('split');
  const rstripButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#right-strip .rstrip-btn'));
  function applyRightCollapsed(collapsed: boolean): void {
    // DOM/ARIA only — persistence happens once per actual collapse transition (in the subscription
    // below), not on every right-view switch that also runs this repaint. The collapsed grid (hide
    // #right + #split-resizer, #center reclaims the column, #right-strip stays) is CSS, keyed off this
    // class on #split — mirroring how `applyDiagCollapsed` keys the bottom strip.
    rstripSplitEl.classList.toggle('right-collapsed', collapsed);
    const active = appStore.getState().right;
    // A stripe button reads "pressed" only while the panel is OPEN and showing that view; collapsed → none
    // pressed (the last active view is still remembered in uiChrome.right for the next expand).
    for (const b of rstripButtons) {
      b.setAttribute('aria-pressed', String(!collapsed && b.dataset.rview === active));
    }
  }
  // Seed the runtime flag from persistence before any subscription is wired (so this seed doesn't echo),
  // then paint the DOM/ARIA once for the restored state.
  appStore.getState().setRightCollapsed(loadLayout().rightCollapsed);
  applyRightCollapsed(appStore.getState().rightCollapsed);
  for (const b of rstripButtons) {
    b.addEventListener('click', () => {
      const view = b.dataset.rview as RightView;
      const st = appStore.getState();
      if (st.rightCollapsed) {
        // Collapsed → expand straight to the clicked view (Rider's "click Git to jump to Source Control").
        st.setRightCollapsed(false);
        selectRightView(view);
      } else if (view === st.right) {
        // Open on this view → collapse, reclaiming the column.
        st.setRightCollapsed(true);
      } else {
        // Open on another view → switch, staying open.
        selectRightView(view);
      }
    });
  }
  // Keep the stripe's pressed state + the collapsed grid in sync however the state changes — a stripe
  // click, the palette command, or a selection auto-activating Properties all route
  // through the slice, so re-running applyRightCollapsed here is the single reconciliation point. Persist
  // only on an actual collapse transition (not on every view switch that also repaints). Captured +
  // disposed (like unsubscribeActiveContext / unsubscribeDirtyCount) so a deferred slice change can't
  // fire applyRightCollapsed into a torn-down host's captured DOM after dispose().
  const unsubscribeRightCollapsed = appStore.subscribe((s, prev) => {
    if (s.right !== prev.right || s.rightCollapsed !== prev.rightCollapsed) {
      applyRightCollapsed(s.rightCollapsed);
    }
    if (s.rightCollapsed !== prev.rightCollapsed) {
      saveLayout({ rightCollapsed: s.rightCollapsed });
    }
  });

  // The blessed Code ⟷ Canvas preset: the .koi text beside the live domain diagram — the one layout that
  // shows Koine's round-trip. In the deck this is a 2-up with Code selected on the left and Canvas on the
  // right. Shared by the palette command (it's exposed on the controller).
  function splitCodeCanvas(): void {
    appStore.getState().focusPrimary('technical');
    appStore.getState().openBeside('visual');
    // The subscription applied the chrome (synchronous on set); make sure the canvas pane has rendered
    // nodes (the editor pane is the always-live CodeMirror).
    if (appStore.getState().isStale('diagrams')) void loadDiagrams();
  }

  // Subscribe to deck + facet changes so any mutation — from the DeckBar / DeckCard, a palette command,
  // or a keyboard shortcut — re-applies the center chrome, lazy-loads the now-visible surfaces, and
  // persists the deck. Disposed in dispose() so a deferred callback can't fire into a torn-down DOM.
  const unsubscribeDeck = appStore.subscribe(
    (s: import('@/store/index').AppState, prev: import('@/store/index').AppState) => {
      const centerChanged =
        s.deck !== prev.deck || s.tech !== prev.tech || s.output !== prev.output || s.docs !== prev.docs;
      if (!centerChanged) return;
      syncCenterChrome();
      if (s.deck !== prev.deck) deps.saveWorkspaceDeck?.(s.deck);
    },
  );

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
      selectOutput('compatibility');
      return;
    }
    let folder: string | null;
    try {
      folder = await platform.pickFolder('Select baseline model folder');
    } catch (e) {
      docMessage(checkView, 'Could not open the folder picker: ' + String(e), 'error');
      selectOutput('compatibility');
      return;
    }
    if (!folder) return; // cancelled — abort silently
    selectOutput('compatibility');
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
  let currentTarget: PreviewTarget = deps.initialTarget;

  function setTarget(target: PreviewTarget): void {
    // The Output surface's "Generated" facet now lives in the DeckCard header (a static label); the
    // active emit target is owned by the preview loader below rather than surfaced as a tab caption.
    currentTarget = target;
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
      let lang: OutputLang;
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
    if (activeCenter() === 'output' && activeOutput() === 'generated') void loadPreview();
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
  // Whether the user has an EXPLICIT, persisted collapse choice (written by the #diag-collapse chevron
  // below). `null` = unset, so the viewport-aware default may apply; a stored '0'/'1' is the user's own
  // choice and always wins. localStorage can throw in locked-down hosts — treat a throw as "no preference".
  function hasExplicitDiagCollapsePref(): boolean {
    try {
      return localStorage.getItem(DIAG_COLLAPSED_KEY) !== null;
    } catch {
      return false;
    }
  }
  // The bottom strip's *default* collapsed state is viewport-aware (#475): below BP_NARROW the
  // reading-heavy Documentation center view defaults the strip COLLAPSED so the reading pane gets full
  // height on a phone; Visual/Code and every desktop width keep the expanded default. This sets only a
  // DEFAULT — an explicit user preference always wins, so it's gated on the absence of one.
  // Re-evaluated whenever the center chrome is applied (a center switch / boot) and on a narrow↔wide cross.
  function applyDefaultDiagCollapsed(): void {
    if (hasExplicitDiagCollapsePref()) return; // the user's persisted choice wins
    const center = activeCenter();
    applyDiagCollapsed(isNarrowViewport() && center === 'docs');
  }
  applyDiagCollapsed((localStorage.getItem(DIAG_COLLAPSED_KEY) ?? '0') === '1');
  applyDefaultDiagCollapsed(); // override the expanded default with the narrow Docs default (#475)
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
    terminalPanel.hidden = tab !== 'terminal';
    reviewPanel.hidden = tab !== 'review';
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

  // The Events panel's Flow canvas (#270) bubbles the canvas's own NODE_NAVIGATE_EVENT up to this host when
  // a card is clicked (the bottom strip isn't under the diagrams container ide.tsx listens on, so the event
  // is routed here, like the context-map graph). Route it to the SAME select-and-goto path the Events table
  // uses: jump to the declaration AND select it so the Properties inspector loads it. Attached once on the
  // stable host, so it survives the panel's re-mounts on every scope/view change. The card's context is its
  // qualified-name prefix (the canvas detail carries no separate context field).
  eventsPanel.addEventListener(NODE_NAVIGATE_EVENT, (e) => {
    const d = (e as CustomEvent<DiagramNodeNavigateDetail>).detail;
    if (!d) return;
    deps.gotoSourceSpan({ file: d.file, line: d.line, column: d.column, endLine: d.endLine, endColumn: d.endColumn });
    const dot = d.qualifiedName.indexOf('.');
    selection.set({ qualifiedName: d.qualifiedName, context: dot < 0 ? '' : d.qualifiedName.slice(0, dot) });
  });

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
    // The terminal panel is created lazily by ide.ts the first time its tab is shown (mirrors the
    // assistant/scenarios panels); fit() reflows xterm now that the panel has layout. Desktop-only —
    // the browser host omits ensureTerminal and the panel shows its placeholder.
    if (tab === 'terminal') deps.ensureTerminal?.().fit();
    // The Review panel is created lazily by ide.ts the first time its tab is shown (mirrors terminal).
    if (tab === 'review') deps.ensureReview?.();
  }

  // --- the "Context Map" tab: the strategic context map, as an interactive GRAPH or the dense TABLE ----
  // The graph reuses the maxGraph engine (buildContextMapGraph → renderContextMapGraph) and is the default;
  // the table (renderContextMapHtml) stays one click away for the full per-relation detail. Both read the
  // SAME ContextMapResult, so the toggle never refetches — it repaints the stored result.
  const CONTEXT_MAP_VIEW_KEY = 'koine.studio.contextMapView';
  type ContextMapMode = 'graph' | 'table';
  let contextMapMode: ContextMapMode = ((): ContextMapMode => {
    try {
      return localStorage.getItem(CONTEXT_MAP_VIEW_KEY) === 'table' ? 'table' : 'graph';
    } catch {
      return 'graph';
    }
  })();
  let lastContextMap: ContextMapResult | null = null;
  let contextMapGraphHandle: ContextMapGraphHandle | null = null;
  let contextMapRenderSeq = 0;

  function disposeContextMapGraph(): void {
    contextMapGraphHandle?.dispose();
    contextMapGraphHandle = null;
  }

  // The hover tooltip for a relation edge (a context node's name is already on its box, so → null there).
  // maxGraph renders the string as innerHTML with `\n`→`<br>`, so every fragment is escaped first.
  function contextMapTooltip(value: DiagramNode | DiagramEdge): string | null {
    if (!('from' in value && 'to' in value)) return null;
    const e = value as ContextMapEdge;
    const arrow = e.bidirectional ? '↔' : '→';
    const lines = [`${e.label ?? 'relation'}: ${e.from} ${arrow} ${e.to}`];
    if (e.sharedTypes.length) lines.push(`Shared: ${e.sharedTypes.join(', ')}`);
    for (const a of e.acl) lines.push(`ACL: ${formatAclMapping(a)}`);
    return lines.map(escapeHtml).join('\n');
  }

  // Fill the details strip with a selected relation's kind, direction, shared types and ACL — so nothing
  // from the table view is lost on the graph. `null` hides it (empty-canvas click / fresh render).
  function showRelationDetails(host: HTMLElement, edge: ContextMapEdge | null): void {
    if (!edge) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }
    const arrow = edge.bidirectional ? '↔' : '→';
    const dir = `${escapeHtml(edge.from)} ${arrow} ${escapeHtml(edge.to)}`;
    const shared = edge.sharedTypes.length ? edge.sharedTypes.map(escapeHtml).join(', ') : '—';
    const acl = edge.acl.length ? edge.acl.map((a) => escapeHtml(formatAclMapping(a))).join('<br>') : '—';
    host.innerHTML =
      `<div class="ctxmap-details-head"><span class="ctxmap-details-kind">${escapeHtml(edge.label ?? 'Relation')}</span>` +
      `<span class="ctxmap-details-dir">${dir}</span></div>` +
      `<dl class="ctxmap-details-grid"><dt>Shared types</dt><dd>${shared}</dd><dt>ACL</dt><dd>${acl}</dd></dl>`;
    host.hidden = false;
  }

  // Build the panel skeleton (Graph|Table toggle + stage + details strip) once into #panel-contextmap; a
  // prior `docMessage` (the 'Loading…' line) wiped it, so this rebuilds when absent and returns its parts.
  function ensureContextMapSkeleton(): { stage: HTMLElement; details: HTMLElement } {
    const existing = contextMapView.querySelector<HTMLElement>('.ctxmap');
    if (existing) {
      return {
        stage: existing.querySelector<HTMLElement>('.ctxmap-stage')!,
        details: existing.querySelector<HTMLElement>('.ctxmap-details')!,
      };
    }
    contextMapView.innerHTML = '';
    const shell = document.createElement('div');
    shell.className = 'ctxmap';

    const toolbar = document.createElement('div');
    toolbar.className = 'ctxmap-toolbar';
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', 'Context map view');
    const makeTab = (mode: ContextMapMode, label: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctxmap-tab';
      b.dataset.ctxmapView = mode;
      b.textContent = label;
      b.setAttribute('aria-pressed', String(contextMapMode === mode));
      b.addEventListener('click', () => setContextMapMode(mode));
      return b;
    };
    toolbar.append(makeTab('graph', 'Graph'), makeTab('table', 'Table'));

    const stage = document.createElement('div');
    stage.className = 'ctxmap-stage';
    const details = document.createElement('div');
    details.className = 'ctxmap-details';
    details.hidden = true;

    shell.append(toolbar, stage, details);
    contextMapView.appendChild(shell);
    return { stage, details };
  }

  function setContextMapMode(mode: ContextMapMode): void {
    if (mode === contextMapMode) return;
    contextMapMode = mode;
    try {
      localStorage.setItem(CONTEXT_MAP_VIEW_KEY, mode);
    } catch {
      // no persistence available — the in-session choice still applies
    }
    void paintContextMap();
  }

  // Paint the active view from the stored ContextMapResult. A monotonic seq makes a superseded async graph
  // render (a later toggle/refresh) bail before it touches the DOM; the prior graph handle is disposed first.
  async function paintContextMap(): Promise<void> {
    const seq = ++contextMapRenderSeq;
    disposeContextMapGraph();
    const { stage, details } = ensureContextMapSkeleton();
    for (const b of contextMapView.querySelectorAll<HTMLButtonElement>('.ctxmap-tab')) {
      b.setAttribute('aria-pressed', String(b.dataset.ctxmapView === contextMapMode));
    }
    showRelationDetails(details, null);

    const res = lastContextMap;
    if (!res || (res.contexts.length === 0 && res.relations.length === 0)) {
      stage.innerHTML = '<p class="muted">No context map declared.</p>';
      return;
    }

    if (contextMapMode === 'table') {
      stage.innerHTML = `<div class="koi-md ctxmap-table">${renderContextMapHtml(res)}</div>`;
      return;
    }

    try {
      const graph = buildContextMapGraph(res);
      contextMapGraphHandle = await renderContextMapGraph(stage, graph, () => seq === contextMapRenderSeq, {
        // A context-node click both FILTERS the workspace to that bounded context (only when it's a
        // real, known context — a synthetic dangling endpoint isn't a valid scope) AND JUMPS to its
        // `.koi` declaration (#290). The graph node carries the declaration span, so we reuse the same
        // jump-to-source path the bottom tables use (deps.gotoSourceSpan); a span-less node (a dangling
        // endpoint or a recovered parse) stays inert to navigation but still filters. This is the
        // reachable navigate channel for the map: the canvas's own NODE_NAVIGATE_EVENT bubbles within
        // the bottom strip, which is not under the diagrams container ide.tsx listens on.
        onContextClick: (n) => {
          if (contexts.includes(n.qualifiedName)) setActiveContext(n.qualifiedName);
          if (n.sourceSpan) deps.gotoSourceSpan(n.sourceSpan);
        },
        onRelationSelect: (edge) => showRelationDetails(details, edge as ContextMapEdge | null),
        tooltip: (value) => contextMapTooltip(value),
      });
    } catch (e) {
      if (seq === contextMapRenderSeq) docMessage(stage, 'Could not render the context-map graph: ' + String(e), 'error');
    }
  }

  // The docViews slice's 'contextmap' token guards the fetch — a token captured before the await is
  // compared after, so a superseded fetch (an edit bumped the token) can't clobber a newer render;
  // markLoaded only takes for the token it fetched. The view (graph/table) is repainted from the result.
  async function loadContextMapPanel(): Promise<void> {
    await guardedLoad({
      store: appStore,
      key: 'contextmap',
      loading: () => {
        disposeContextMapGraph();
        docMessage(contextMapView, 'Loading context map…');
      },
      fetch: () => lsp.contextMap(),
      render: (res) => {
        lastContextMap = res;
        void paintContextMap();
      },
      onError: (e) => {
        disposeContextMapGraph();
        docMessage(contextMapView, 'Context map request failed: ' + String(e), 'error');
      },
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
    // Restore the persisted rail axis (Domain default), painting the matching navigator pane (#453).
    let storedAxis: RailAxis = 'domain';
    try {
      if (localStorage.getItem(RAIL_AXIS_KEY) === 'files') storedAxis = 'files';
    } catch {
      // no persistence available — fall back to the Domain default
    }
    applyAxis(storedAxis);
    // Mount the top-bar scope path once at boot (hidden until refreshContextList finds a context). It
    // tracks scope/selection via the store thereafter; setContextOptions + loadModel re-render it when
    // the contexts list or model index changes.
    renderBreadcrumb();
    // Mount the Deck: detach the four center-host sections first so rendering the stage into #center-body
    // doesn't destroy them, then let the DeckStage re-parent each into its card body (via a ref). The
    // DeckBar (Overview + filmstrip) renders into #deck-bar. Both are store-bound — the deck/facet
    // subscription above applies the chrome thereafter.
    for (const h of Object.values(centerHosts)) h.remove();
    render(
      <DeckStage
        store={appStore}
        surfaces={centerHosts}
        onVisibleSurfacesChange={(views) => {
          // The FLIP resized the cards; re-measure the editor once its final geometry is set.
          if (views.includes('technical')) editor.view.requestMeasure();
        }}
      />,
      centerBodyEl,
    );
    render(<DeckBarConnected store={appStore} />, deckBarEl);
    // Paint the initial chrome from the restored deck (no fetch at boot — ide.ts's boot ladder runs
    // refreshActiveSurfaces once the workspace document is open; the deck/facet subscription lazy-loads on
    // every subsequent change).
    applyCenterChrome();
  }

  // Cancel any pending debounce/reset timers. The IDE runs for the page lifetime in production (so this
  // is a no-op there), but the test suite boots many controllers into one shared happy-dom; disposing
  // between boots stops a deferred refresh (onDocEdited's 350ms debounce) from firing into a torn-down
  // environment, where `render` would throw "document is not defined".
  function dispose(): void {
    clearTimeout(copyResetTimer);
    clearTimeout(editDebounce);
    clearTimeout(bottomPanelDebounce);
    // Drop the Domain navigator's store subscription so a deferred store change can't repaint a torn-down
    // host (the same hazard the debounce clears, for the navigator's #453 subscription).
    domainNavigator?.unmount();
    // Drop the Source Control dirty-count subscription (#470) for the same reason.
    unsubscribeDirtyCount();
    // Drop the activeContext subscription (#531) too — its callback re-renders scoped surfaces, which
    // would throw into a torn-down host if a deferred slice change fired after dispose.
    unsubscribeActiveContext();
    // Drop the right-strip collapse subscription (#500) — its callback mutates the captured #split /
    // .rstrip-btn nodes and persists, which must not fire into a torn-down host after dispose.
    unsubscribeRightCollapsed();
    // Drop the deck/facet subscription — its callback re-applies the center chrome + lazy-loads, which
    // must not fire into a torn-down host after dispose. Unmount the deck Preact trees too so their
    // window listeners (the DeckStage keyboard handler) detach.
    unsubscribeDeck();
    render(null, centerBodyEl);
    render(null, deckBarEl);
    // The viewport-resize listener is registered unconditionally now (#475 re-evaluates the strip default
    // on a narrow↔wide cross even without the inspector sheet), so always detach it; the sheet teardown is
    // still sheet-gated.
    window.removeEventListener('resize', onViewportResize);
    inspectorSheet?.destroy();
  }

  return {
    selection,
    activeContext,
    selectCenter,
    setAxis,
    selectTech,
    selectOutput,
    selectDocsTab,
    selectBottomTab,
    selectRight,
    splitCodeCanvas,
    loadPreview,
    loadDiagrams,
    setTarget,
    onPreviewTargetChanged,
    runCheck,
    onDocEdited,
    invalidateDocViews,
    invalidateDocsPanel,
    refreshSourceControl,
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
