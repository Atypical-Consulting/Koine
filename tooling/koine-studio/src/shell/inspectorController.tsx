// inspectorController: the mode / center-tab / view subsystem lifted out of ide.ts's init()
// (Task 4 of the ide.ts decomposition, issue #180). It owns:
//   • the CENTER "Deck" surfaces — Canvas (the diagram), Code (editor / Scenarios), Output
//     (Generated / Compatibility / Context Map) and Docs (Glossary / ADRs / Notes) — plus the
//     right-rail Properties / AI Chat / Source Control / Syntax Tree view chrome,
//   • the BOTTOM strip (Problems / Events / Relationships, and Terminal / Review) with its lazy
//     loaders, collapse toggle and resizer,
//   • the per-view LAZY LOADERS and their stale-token / debounce lifecycle (the Generated preview,
//     the diagrams, the left-rail Domain navigator, the glossary, the ADR docs, and the bottom tables),
//   • the bounded-context SCOPE (#146, driven by the Domain navigator) and the selection-driven
//     Properties inspector + cross-highlight cluster (#142), and the joined model index it reads.
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
import { render } from 'preact';
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
  SyntaxTreeNode,
} from '@/lsp/lsp';
import type { Platform } from '@/host';
import type { PreviewTarget } from '@/settings/persistence';
import { domById } from '@/shared/domById';
import { LEFT_RAIL_IDS, createFloatingMenu, type FloatingMenuItem } from '@atypical/koine-ui';
import { NODE_NAVIGATE_EVENT } from '@/diagrams/diagramContract';
import type {
  AddNodeKind,
  CanvasAnnotationKind,
  AggregateMemberKind,
  DiagramNodeNavigateDetail,
} from '@/diagrams/diagramContract';
import { ALL_CONTEXTS, contextOf, isAllContexts, type ContextScope } from '@/model/activeContext';
import type { SelectedElement } from '@/model/selection';
import { type ModelOutlineHandlers } from '@/model/modelOutline';
import { mountDomainNavigator, type DomainNavigatorHandle, type TacticalHandlers } from '@/model/domainNavigator';
import { type InspectorElement, type InspectorHandlers } from '@/model/inspector';
import { buildModelIndex, lookupElement, resolveInspectableQn, type ModelIndex } from '@/model/modelIndex';
import { PropertiesPanel } from '@/model/PropertiesPanel';
import type { SourceControlFocus } from '@/model/SourceControlPanel';
import { SyntaxTreePanel } from '@/model/SyntaxTreePanel';
import { CanvasPalette } from '@/diagrams/CanvasPalette';
import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import { createInspectorSheet, type InspectorSheet } from '@/shell/inspectorSheet';
import { isNarrowViewport } from '@/shared/breakpoint';
import { DEFAULT_CENTER, DEFAULT_DECK_STATE, isValidCenter, type DeckState, type RightView } from '@/store/slices/uiChrome';
import type { DomainIndex } from '@/ai/aiPanel';
import { fileUriToPath } from '@/shell/ideUtils';
import { createContextMapPanel } from '@/shell/inspector/contextMapPanel';
import {
  createActiveContextController,
  scopeLabel,
  type ActiveContextController,
  type ActiveContextHandle,
} from '@/shell/inspector/activeContextController';
import { createSurfaceLoaders } from '@/shell/inspector/surfaceLoaders';
import { createCenterDeckController } from '@/shell/inspector/centerDeckController';

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
  /** The active document's raw syntax tree (#890) — pulled by the self-fetching Syntax Tree panel; null on
   *  an unknown/absent active uri. Structurally satisfies the panel's SyntaxTreeSource. */
  syntaxTree(): Promise<SyntaxTreeNode | null>;
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
  /** Write the action-feedback pill (errors route here from the loaders that surface their own failures). */
  setStatus(text: string, kind: 'error'): void;
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
  onApplyStructuredEdit(edit: StructuredEdit): void;
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
  /**
   * Emphasise the active bounded-context scope in the Files tree (ADR 0009 / #1188) — the source-side
   * arm of the scope fan-out (`rerenderScopedSurfaces`), the Files counterpart of the Output rail's
   * emphasis. ide.ts owns the explorer, so it forwards to `explorer.setActiveContext`; `null` (the *All
   * contexts* view) clears the emphasis. Emphasis, never hiding — every file op keeps working.
   */
  scopeFiles(context: string | null): void;

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

// ActiveContextHandle (#146) — the app store's `activeContext` slice's thin read/write shim — is now
// defined in inspector/activeContextController.ts (the module that owns the slice's read/write path);
// re-exported here for API stability (ide.ts reads the active scope through it for the diagram add-type
// path).
export type { ActiveContextHandle };

export interface InspectorController {
  /** The shared "selected element" handle (#142) — ide.ts's diagram write-path sets it; the inspector reads it. */
  readonly selection: SelectionHandle;
  /** The active bounded-context handle (#146) — read at paint time by every scoped surface. */
  readonly activeContext: ActiveContextHandle;

  // View selection (palette commands + toolbar/tab clicks route here).
  selectCenter(view: CenterView): void;
  /** Show the transient, gear-launched Settings overlay (#482) over the deck (not a deck surface). Pass a
   *  category id (#731) to land the overlay on that tab (the About command deep-links to `about`); omit it
   *  to open on the last-used / default tab. */
  showSettings(category?: string): void;
  /**
   * Switch the left rail's active navigator axis (#453): show the Domain pane (the strategic/tactical DDD
   * navigator) or the Files pane (the workspace `.koi` tree), hiding the other, and persist the choice.
   * ide.ts's ⌘B drives this so the file tree and the Domain view never both claim the rail.
   */
  setAxis(axis: 'domain' | 'files'): void;
  selectTech(view: TechView): void;
  selectOutput(view: OutputTab): void;
  selectDocsTab(view: DocsView, term?: string): void;
  selectBottomTab(tab: BottomTab): void;
  /** Reveal a right-rail view (Properties / AI Chat / Rules / Notes / Source Control), expanding the rail
   *  if collapsed. Palette commands (Show AI Chat, Explain this construct) route through here. A
   *  `focus` (issue #1165) reveals a specific target inside Source Control (a file's diff / a commit). */
  selectRight(view: RightView, focus?: SourceControlFocus): void;
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

export function createInspectorController(deps: InspectorControllerDeps): InspectorController {
  const { lsp, editor, output, platform, store: appStore } = deps;

  // Set as dispose()'s first statement, so a loader continuation racing teardown observes it. Unlike the
  // stale-token guard (which only suppresses STALE content on a LIVE controller), this suppresses ALL
  // post-await mount/subscribe/status-write work once the controller is dead — closing the in-flight-
  // loader-after-dispose leak (#1002, the async sibling of #980's live-subscription leaks).
  let disposed = false;

  // --- DOM hosts (looked up once; the same id surface init() builds, so a drift throws via domById()) ---
  // The Generated preview host (#view-preview): a per-file rail beside a single-file viewer (concept-7
  // "Flush"), owned by surfaceLoaders.tsx now (Task 3) — this facade only keeps the lookup it already
  // needed for chrome purposes (see `previewEl` below) and hands the SAME node to the loaders as a host.
  //
  // Left-rail host: the Domain axis's strategic/tactical navigator (#453). mountDomainNavigator owns this
  // node — it self-fetches its strategic data and reads the store for altitude + scope — so loadModel
  // mounts it once and thereafter just reloads it. (The former Overview counts surface was removed with
  // the section stack.)
  const domainPane = domById(LEFT_RAIL_IDS.domainPane);
  // The mounted Domain navigator (#453), created lazily on the first loadModel and reused thereafter — so
  // a model reload re-fetches its strategic data rather than re-mounting (which would drop its store
  // subscription + breadcrumb state). Disposed on tear-down to drop that subscription.
  let domainNavigator: DomainNavigatorHandle | null = null;
  // The Documentation center tab's three sub-views: Glossary (the ubiquitous language), Decisions (the
  // ADR list) and Notes — the latter two split from the former combined "Decisions & Notes" surface.
  const glossaryView = domById('view-glossary');
  const adrView = domById('view-docs');
  const notesView = domById('view-notes');
  // Center hosts: the diagram canvas (Visual) and the code editor's companion sub-views.
  const diagramsView = domById('diagram-host');
  const checkView = domById('view-check');
  // Right-rail host: the element inspector (Properties). Fixed — never torn down on a model reload.
  const inspectorHost = domById('inspector-host');
  // Below $bp-narrow the inspector lives in a bottom sheet instead of the fixed #right rail (#221). The
  // sheet host is OPTIONAL: it's absent from the desktop-only test fixtures, and without it the
  // controller keeps the original right-rail behaviour untouched (no sheet, no resize listener). When it
  // exists the sheet is built once here; renderSelectedInspector mounts Properties into its body on a
  // narrow viewport, and a selection raises it to half.
  const sheetHostEl = document.getElementById('inspector-sheet-host'); // eslint-disable-line no-restricted-properties -- intentionally optional: guarded by `sheetHostEl ? … : null`
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
  // The #475 bottom-strip viewport-aware-default re-evaluation on this SAME cross now lives in
  // centerDeckController's OWN independent `resize` listener (#985 Task 4 — each module tracks its own
  // narrow↔wide crossing rather than sharing this flag, the same duplication precedent `visibleCenters()`
  // already established). This listener only handles the #221 inspector-sheet narrow↔wide handling.
  let wasNarrow = isNarrowViewport();
  function onViewportResize(): void {
    const narrow = isNarrowViewport();
    if (narrow === wasNarrow) return; // not a cross — ignore the keyboard/address-bar resize churn
    wasNarrow = narrow;
    if (!inspectorSheet) return;
    if (!narrow && inspectorSheet.isOpen()) inspectorSheet.setDetent('peek');
    renderSelectedInspector(); // re-mount into the now-correct host (sheet body vs #inspector-host)
  }
  // The `resize` listener is registered at the END of construction (just before `return`), not here: the
  // required DOM-host lookups below (`domById`/`domQueryAll`) THROW on a drifted layout, and registering a
  // global window listener before they run would leak a half-initialized closure into the page on failure.
  // The active bounded-context scope is surfaced in the status-bar "Context" segment (chrome v2, #923
  // removed the redundant top-bar breadcrumb strip; the left Domain navigator drives scope switching).
  const sbContextEl = domById('sb-context');

  // Bottom-panel refs still needed here: `eventsPanel` for the Flow-canvas NODE_NAVIGATE_EVENT listener
  // below AND as surfaceLoaders' own paint target; `relationshipsPanel` likewise as surfaceLoaders' paint
  // target (centerDeckController looks up its own independent copy of both for the tab hidden-toggle
  // chrome — the `previewEl`-style dual-lookup precedent); `contextMapView` as Task 1's contextMapPanel
  // host. The rest of the bottom-strip DOM (diagEl, diag-body/-count, terminal/review) is now
  // centerDeckController's own lookup (#985 Task 4) — this facade no longer needs a copy.
  const eventsPanel = domById('panel-events');
  const relationshipsPanel = domById('panel-relationships');
  const contextMapView = domById('panel-contextmap');

  // --- construction reset (facade-owned pieces only) --------------------------
  // The center/deck restore + the bulk of the uiChrome reset (center/tech/output/docs/bottom/right) now
  // live in centerDeckController (#985 Task 4 — see `restoreWorkspaceDeck` and its own construction-time
  // `setState` below). This facade keeps only the ONE field that's a Domain-navigator/loader concern, not
  // a center/deck-chrome one: the Domain navigator starts at the strategic altitude (#453) for a fresh
  // workspace session — reset here (a separate `setState`, still landing before ANY subscriber exists in
  // either module, so still effectively atomic) for the same reason centerDeckController's own reset
  // exists: the injected store is, in production, the app-wide singleton reused across workspace reopens,
  // so a prior session left on tactical mustn't leak into a fresh boot.
  appStore.setState({ navAltitude: 'strategic' });
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

  // The center-persist subscription (#980) — the closure-mirror `persistedCenter` guard it used to sit
  // alongside — now lives in centerDeckController (#985 Task 4, which also deletes the mirror; see that
  // module's own comment on the replacement guard).

  // --- bounded-context switcher (#146) ---------------------------------------
  // Extracted to its own module (inspector/activeContextController.ts, #985 Task 2): the scope handle,
  // the per-workspace persist/restore, the status-bar readout sync, the model's context-list refresh (+
  // the docs-coverage ring it ships alongside), and the file-follow behaviour all live there now. This
  // facade only wires the injected deps + the `rerenderScopedSurfaces` hook below (its BODY calls into
  // surfaceLoaders.tsx, #985 Task 3, now that the loaders it re-filters live there) and still owns the
  // status-bar scope-PICKER MENU (a UI concern, not the scope-change choke point itself).
  //
  // Forward-declared so `rerenderScopedSurfaces` (passed to the controller as its `hooks` callback) can
  // read the just-changed scope back off the controller's handle: the two are mutually referential by
  // construction — the controller needs the hook to be constructed, the hook needs the controller to read
  // the scope — so the binding exists first and is assigned once the controller is built. `loaders` is
  // forward-declared for the same reason (`rerenderScopedSurfaces` calls into it, but it isn't constructed
  // until every piece IT needs — the Domain navigator handlers, the model index, the chrome functions — is
  // defined, further down); it's only ever CALLED after both are assigned. `centerDeck` (#985 Task 4) joins
  // the same forward-declared trio for the same reason: `rerenderScopedSurfaces` reads its
  // `visibleCenters()`, but it isn't constructed until its own hook-helper functions (further down, which
  // themselves close over `loaders`/`contextMapPanel`) are defined.
  let activeContextCtrl: ActiveContextController;
  let loaders: ReturnType<typeof createSurfaceLoaders>;
  let centerDeck: ReturnType<typeof createCenterDeckController>;

  // Re-render the scoped, model-derived surfaces after a scope change. Scope is applied at paint time
  // from the `activeContext` slice and the model itself is unchanged (scope is a pure filter), so the
  // cached model index is kept — only the visible surfaces repaint. The model/diagram doc caches are marked stale so a
  // not-currently-visible one re-renders scoped on its next visit.
  function rerenderScopedSurfaces(): void {
    // A scope change is a pure re-filter, not a model edit: mark the SCOPE-derived surfaces stale so the
    // not-currently-visible ones re-render scoped on their next visit, then repaint the live ones now.
    // The Generated preview's CONTENT is target-derived (not scope-derived), so it is deliberately NOT
    // re-emitted here. Its rail EMPHASIS, however, obeys the scope (ADR 0009): repaint the rail from the
    // current emit result so the active context's files light up and the rest de-emphasise — no re-emit.
    const inv = appStore.getState().invalidate;
    inv('model');
    inv('diagrams');
    inv('glossary');
    // The left-rail Explorer + Overview are always visible, so re-scope them immediately.
    void loaders.loadModel();
    // The Files tree obeys the scope by EMPHASIS (ADR 0009): mark the active context's `.koi` and
    // de-emphasise the other contexts' files — never hidden, so every file op keeps working. The
    // strategic Domain navigator's own store subscription handles its active-context marker.
    const scope = activeContextCtrl.handle.get();
    deps.scopeFiles(isAllContexts(scope) ? null : scope);
    // The diagram only re-scopes when the visual center is showing it — including as the SECONDARY
    // pane of a 2-up / in overview, so visibleCenters(), not just the deck primary. Reads
    // centerDeckController's own copy now (#985 Task 4) — this facade no longer keeps a local one.
    if (centerDeck.visibleCenters().includes('visual')) void loaders.loadDiagrams();
    loaders.invalidateBottomPanels(); // the Events/Relationships/Context Map tables are graph-derived too
    loaders.refreshOutputRailScope(); // refresh the Output rail's scope emphasis (ADR 0009), no re-emit
    // The Context Map's own ADR 0009 scope-focus repaint is driven by contextMapPanel's OWN `activeContext`
    // subscription now (inspector/contextMapPanel.tsx) — it fires independently off the same store write.
  }

  activeContextCtrl = createActiveContextController({
    store: appStore,
    lsp,
    activeUri: deps.activeUri,
    folderRootToken: deps.folderRootToken,
    saveActiveContext: deps.saveActiveContext,
    loadActiveContext: deps.loadActiveContext,
    statusBarEl: sbContextEl,
    hooks: { rerenderScopedSurfaces },
  });

  // --- status-bar scope picker (#146) ----------------------------------------
  // The status-bar "Context" segment is the CANONICAL scope control: PR #1180 removed the dead top-bar
  // breadcrumb <select> and #923 left only this readout, so clicking the segment is now how you change the
  // global bounded-context scope without drilling the left Domain navigator. Clicking it opens a small menu
  // of the model's contexts (read from the store's `contexts` list refreshContextList keeps current) plus
  // an "All contexts" option, and routes a pick through setActiveContext — the SAME persist=true choke
  // point the navigator drill uses — so an explicit pick behaves identically and survives a reload. Built
  // on the shared createFloatingMenu engine (#547): it inherits the keyboard nav, outside-click/Escape
  // dismissal, focus-return, and aria-expanded toggling every other Studio popup menu has.
  const scopeMenu = createFloatingMenu({
    menuClass: 'koi-scope-menu',
    itemClass: 'koi-scope-menu-item',
    ariaLabel: 'Bounded context scope',
  });
  /** The menu rows: "All contexts" then one per model context (store order), the ACTIVE scope marked with
   *  a leading ✓ — a non-colour indicator, so the current scope reads without relying on hue (WCAG AA). */
  function scopeMenuItems(): FloatingMenuItem[] {
    const active = activeContextCtrl.handle.get();
    const scopes: ContextScope[] = [ALL_CONTEXTS, ...appStore.getState().contexts];
    return scopes.map((scope) => ({
      id: `scope:${scope}`,
      label: `${scope === active ? '✓ ' : ''}${scopeLabel(scope)}`,
      run: () => activeContextCtrl.setActiveContext(scope),
    }));
  }
  /** Toggle the scope menu under the Context segment. The segment lives in the BOTTOM status bar, so the
   *  menu is anchored to open UPWARD: we hand the engine the segment's TOP-left as the anchor point and the
   *  `.koi-scope-menu` CSS lifts it by its own height (a downward menu would fall off-screen). */
  function toggleScopeMenu(): void {
    const rect = sbContextEl.getBoundingClientRect();
    scopeMenu.toggle({ items: scopeMenuItems(), trigger: sbContextEl, at: { x: rect.left, y: rect.top } });
  }
  sbContextEl.addEventListener('click', toggleScopeMenu);

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

  // --- Source Control (git) right-rail panel (#272) -------------------------
  // Folder-derived like the docs pages: lazily mounted on the first Source-Control tab open, re-fetched
  // on every re-open (a `refreshNonce` bump — Preact reuses the mounted instance, so the commit-message
  // draft survives the in-place refresh), and re-mounted against the new folder on a workspace switch.
  // The panel self-gates on `platform.canUseGit` and catches a non-repo `gitStatus` reject, so it can be
  // mounted unconditionally and paint the right empty state. The panel's own lifecycle (loaded flag,
  // refresh nonce, the render + the dirty-count subscription) moved to surfaceLoaders.tsx (#985 Task 3);
  // this facade keeps only the host lookup those loaders need — centerDeckController (#985 Task 4) looks
  // this id up independently for its own right-rail hidden-toggle chrome (the `previewEl`-style dual-lookup
  // precedent, see that module's own doc).
  const sourceControlRightView = domById('rview-source-control');

  // --- Syntax Tree (raw parse tree) right-rail panel (#890) ------------------
  // Model-derived + self-fetching, mirroring Source Control: lazily mounted on first open, re-fetched on
  // every re-open AND on the debounced doc-changed invalidation via a `revision` bump — the SyntaxTreePanel
  // OWNS the LSP `syntaxTree()` fetch (guarding its own async race), so the controller just hands it `lsp`
  // (structurally SyntaxTreeSource) and bumps the revision. Staleness rides the docViews 'syntax-tree' key.
  // `loadSyntaxTree` below is handed to centerDeckController as its own `loadSyntaxTree` hook verbatim —
  // this whole subsystem stays facade-owned, untouched by #985 Task 4.
  const syntaxTreeRightView = domById('rview-syntax-tree');
  let syntaxTreeLoaded = false;
  let syntaxTreeRefresh = 0;
  function renderSyntaxTree(): void {
    render(
      <SyntaxTreePanel
        source={lsp}
        revision={syntaxTreeRefresh}
        // Tree → editor (#890): jump to the clicked node's span, GUARDING the all-zero span the model root
        // and span-less nodes carry (line 0 → a no-op, never a jump to 0:0). `node.span` is now the
        // shared SourceSpan (#1099), so it directly satisfies gotoSourceSpan's Pick<SourceSpan, …>.
        onNodeClick={(node) => {
          if (node.span.line > 0) deps.gotoSourceSpan(node.span);
        }}
        // Editor → tree (#890): the live caret, so the panel highlights the deepest node containing it.
        // Read fresh at render time, so opening the panel (or an edit-driven re-render) already reflects
        // the current caret; the debounced cursor subscription below re-renders on subsequent caret moves.
        caret={appStore.getState().cursor ?? undefined}
      />,
      syntaxTreeRightView,
    );
  }
  function loadSyntaxTree(): void {
    if (syntaxTreeLoaded) syntaxTreeRefresh += 1; // a re-open / edit re-fetches; first mount fetches on its own
    syntaxTreeLoaded = true;
    // markLoaded gates a repeat refreshActiveSurfaces from redundantly re-fetching; an edit re-stales it.
    appStore.getState().markLoaded('syntax-tree', appStore.getState().currentToken('syntax-tree'));
    renderSyntaxTree();
  }
  // Editor → tree caret sync (#890): the editor publishes its caret to the store's `cursor` slice
  // (editorSession.onCursor). When the Syntax Tree is the active right view AND its panel is mounted,
  // mirror a caret move into the panel (a fresh `caret` prop — same `revision`, so NO re-fetch) so it
  // re-highlights the deepest containing node. DEBOUNCED because caret moves are frequent and this is a
  // secondary affordance; when the view isn't active we skip the work (the next open re-renders with the
  // then-current caret). Captured + unsubscribed on dispose (like surfaceLoaders' own dirty-count
  // subscription) so a deferred re-render can't fire into a torn-down host; the timer is likewise cleared
  // on dispose.
  let caretSyncTimer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribeCursor = appStore.subscribe((s, prev) => {
    if (s.cursor === prev.cursor) return; // an unrelated slice write
    if (!syntaxTreeLoaded || s.right !== 'syntax-tree') return;
    clearTimeout(caretSyncTimer);
    caretSyncTimer = setTimeout(() => {
      if (disposed) return;
      if (!syntaxTreeLoaded || appStore.getState().right !== 'syntax-tree') return;
      renderSyntaxTree();
    }, 120);
  });

  // --- the DDD workspace (#142): outline / inspector / cross-highlight -------
  // A thin handle over the app store's `selection` slice (the single source of truth): the outline,
  // the diagram (via ide.ts's write-path), and the Properties panel all read/write the same selection.
  const selection: SelectionHandle = {
    get: () => appStore.getState().selection,
    set: (element) => appStore.getState().setSelection(element),
  };

  // The Domain navigator's wiring (#453), passed to mountDomainNavigator: its strategic doorways route to
  // centerDeck.selectOutput('contextmap') / centerDeck.selectDocsTab('glossary') (the bottom strip is
  // global since #451, so opening the Context Map is just a center switch that lands on its sub-view) —
  // the former facade-local `focusContextMap`/`focusDocs` one-liners moved with the rest of the center
  // chrome (#985 Task 4) and weren't worth re-exporting as named wrappers, so this calls straight through.
  // Its onSelect/goto drive the inspector + jump-to-source for the tactical leaves (wired through
  // renderTactical in Task 4 of the original ide.ts decomposition).
  const modelOutlineHandlers: ModelOutlineHandlers = {
    onSelect: (entry) => selection.set({ qualifiedName: entry.qualifiedName, context: entry.context }),
    goto: (line, col) => editor.goto(line, col),
    onOpenContextMap: () => centerDeck.selectOutput('contextmap'),
    onOpenGlossary: () => centerDeck.selectDocsTab('glossary'),
  };

  // The rail axis switch (Domain vs Files, #453) — the segmented control + collapsed-rail spine chrome,
  // the `koine.studio.railAxis` persistence, and the `setAxis` choke point — now lives in
  // centerDeckController (#985 Task 4). `domainPane` above stays a facade-owned lookup (it's also
  // `ensureDomainNavigator`'s mount target); the tactical handlers below call `centerDeck.setAxis`.

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
    setAxis: (axis) => centerDeck.setAxis(axis),
  };

  // A model node's bounded context: the segment before the first dot of its qualified name (the model
  // graph names a context child `Context.X`), or the active scope when the name is unqualified — the
  // shared `contextOf` helper (@/model/activeContext) owns the split; this just supplies the fallback.
  function nodeContext(node: ModelNode): string {
    const scope = activeContextCtrl.handle.get();
    return contextOf(node.qualifiedName, isAllContexts(scope) ? '' : scope);
  }
  const inspectorHandlers: InspectorHandlers = {
    onGoto: (range) => editor.gotoRange(range.start, range.end),
    onRename: (element, newName) => deps.onRenameElement(element, newName),
    onSaveDescription: (element, text) => deps.onSaveElementDescription(element, text),
    // Property editing rides the same #91 round-trip the canvas uses (applyStructuredEdit), so editing a
    // field here rewrites the `.koi` AND re-renders the diagram + this panel in step.
    onAddProperty: (element, name, type) =>
      deps.onApplyStructuredEdit({ kind: 'addField', target: element.qualifiedName, name, type }),
    onRemoveProperty: (element, propName) =>
      deps.onApplyStructuredEdit({ kind: 'removeMember', target: `${element.qualifiedName}.${propName}` }),
    onRenameProperty: (element, oldName, newName) =>
      deps.onApplyStructuredEdit({ kind: 'renameMember', target: `${element.qualifiedName}.${oldName}`, name: newName }),
    onChangeType: (element, propName, newType) =>
      deps.onApplyStructuredEdit({ kind: 'changeFieldType', target: `${element.qualifiedName}.${propName}`, type: newType }),
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

  // Shared in-flight fetch of `glossaryModel()`/`model()` (#484 follow-up on #460's review): loadModel()
  // below reloads the Domain navigator AND calls ensureModelIndex() in the same tick, and each used to
  // issue its OWN request for these same two endpoints — doubling them on every edit. Memoizing the
  // in-flight promise here means whichever caller asks first kicks off the one lsp call and the other
  // awaits that same promise, so the request count halves WITHOUT delaying either caller — both still
  // kick off their fetch immediately, in parallel with everything else loadModel does.
  let glossaryFetch: Promise<GlossaryModel> | null = null;
  function fetchGlossaryModel(): Promise<GlossaryModel> {
    glossaryFetch ??= lsp.glossaryModel().finally(() => {
      glossaryFetch = null;
    });
    return glossaryFetch;
  }
  let structuredModelFetch: Promise<ModelNode | null> | null = null;
  function fetchStructuredModel(): Promise<ModelNode | null> {
    structuredModelFetch ??= lsp
      .model()
      .then((m): ModelNode | null => m ?? null)
      .catch(() => null)
      .finally(() => {
        structuredModelFetch = null;
      });
    return structuredModelFetch;
  }

  /**
   * Build (or reuse) the joined model index. `livingDocs` (diagram nodes) and the structured `model`
   * (the #91 field source for elements with no class node) are both best-effort — a glossary-only
   * index still works, just without members for undrawn elements.
   */
  function ensureModelIndex(): Promise<ModelIndex> {
    if (modelIndex) return Promise.resolve(modelIndex);
    indexPromise ??= Promise.all([
      fetchGlossaryModel(),
      lsp.livingDocs().catch(() => ({ files: [] }) as DocsResult),
      fetchStructuredModel(),
    ])
      .then(([glossary, docs, model]) => (modelIndex = buildModelIndex(glossary, docs, model ?? undefined)))
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
    // The outline leaves' `is-selected` cross-highlight is owned by the left-rail Domain navigator
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
  }

  // The three hooks surfaceLoaders.tsx's loadModel calls (#985 Task 3) — the model-index FETCH + its
  // docViews token bookkeeping now live there; these three facade-private pieces (the Domain navigator
  // mount, the palette/inspector/cross-highlight repaint, and the caches an edit must drop) stay here,
  // reached only through the injected hook.

  // Mount the Domain navigator once (it paints its own loading placeholder + empty state, and surfaces a
  // fetch failure in the pane itself); a reload re-fetches its strategic data. The navigator's strategic
  // data is scope-INDEPENDENT and it repaints from its own cache on activeContext/outlineFilter store
  // changes — so only re-fetch when the MODEL actually changed, not on a pure scope/filter re-render
  // (rerenderScopedSurfaces keeps the model index, so a null index is the reliable "the model was
  // (re)loaded" signal — an edit nulls it via invalidateModelDerivedCaches below). Kicking the mount off
  // BEFORE loadModel awaits the model index runs the navigator's own fetch in parallel, so the rail paints
  // promptly. Its Context Map / Glossary doorways route to the same focuses the docs footer used.
  function ensureDomainNavigator(): void {
    const hadIndex = modelIndex != null;
    // The reload below is SEEDED with the same shared fetchGlossaryModel()/fetchStructuredModel() promises
    // ensureModelIndex() is about to start (#484) — both calls land on the same in-flight fetch, so the
    // navigator's own doFetch reuses it instead of re-issuing glossaryModel()/model(), halving the
    // per-edit request count with no change to when the rail paints.
    if (!domainNavigator) {
      domainNavigator = mountDomainNavigator(domainPane, appStore, lsp, modelOutlineHandlers, tacticalHandlers);
    } else if (!hadIndex) {
      domainNavigator.reload({ glossaryModel: fetchGlossaryModel(), model: fetchStructuredModel() });
    }
  }

  // The model index just (re)built — the canvas palette reads it to gate its aggregate-scoped buttons
  // (#254), the Properties inspector resolves the selection through it, and the diagram/outline
  // cross-highlight needs the fresh resolution too, so re-render all three.
  function onModelIndexRebuilt(): void {
    renderCanvasPalette();
    renderSelectedInspector();
    applySelectionHighlight();
  }

  // Drop the facade's OWN model-derived caches — the joined model index, its in-flight builder, and the
  // assistant's domain index — so the next model load / getCachedDomainIndex call rebuilds against the
  // current model. Called from surfaceLoaders' invalidateDocViews() on every model edit.
  function invalidateModelDerivedCaches(): void {
    modelIndex = null;
    indexPromise = null;
    // Drop the shared glossary/model in-flight fetch too (#484): without this, a fetch already in flight
    // when THIS edit lands would still be reused by fetchGlossaryModel()/fetchStructuredModel() on the
    // next loadModel() (they only start a new lsp call when the memo is null) — seeding the Domain
    // navigator and model index with the PRIOR edit's data instead of this one's, on a slow LSP /
    // fast-typing overlap. Dropping the reference doesn't cancel the in-flight promise (JS can't cancel
    // promises) — its `.finally()` still runs, harmlessly, on an already-null var — it just forces the
    // next caller to kick off a fresh request for the current model.
    glossaryFetch = null;
    structuredModelFetch = null;
    cachedDomainIndex = null;
  }

  // The inspector + cross-highlight track the app store's `selection` slice for the app's lifetime (a
  // diagram click can select an element while the Model tab is closed; opening it then shows the right
  // inspector). Subscribe to the whole store but act only when the `selection` field actually changes
  // reference — so an unrelated slice write (a setBottom / setActiveContext) doesn't trigger this.
  // Captured + unsubscribed on dispose (like the sibling subscriptions) so a deferred selection change
  // can't repaint the inspector / re-apply scope into a torn-down host after dispose().
  const unsubscribeSelection = appStore.subscribe((state, prev) => {
    if (state.selection === prev.selection) return;
    const sel = state.selection;
    // Jump-to-source works across scope, but a selection landing OUTSIDE the active context would
    // otherwise leave the scoped surfaces showing a different context than the inspector. Follow it:
    // switch the scope to the selected element's context (#146). View-only — a direct handle.set() never
    // persists (activeContextController's own choke point is what persists a DELIBERATE pick) — a
    // read-only inspect shouldn't overwrite the user's deliberately chosen, persisted scope. In-scope
    // selections and the unscoped ("All contexts") view leave the scope untouched. The write re-renders
    // the scoped surfaces (via activeContextController's own store subscription, #531), which also
    // refreshes the inspector/cross-highlight for the Model tab — the explicit calls below cover the
    // cross-highlight when another view is active.
    if (sel && !isAllContexts(activeContextCtrl.handle.get()) && sel.context !== activeContextCtrl.handle.get()) {
      activeContextCtrl.handle.set(sel.context);
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
    // Desktop reveal-on-select (#533): when an element is selected and the right rail is expanded but
    // showing a different tool window (Source Control / AI Chat), switch to Properties so the inspector
    // is visible without a second click. The `&& sel` guard skips deselects — nothing moves unbidden.
    // Collapsed (#648, approach b): if the rail is collapsed, respect the user's explicit collapse
    // rather than forcing it open. Instead, add a transient attention cue on the Properties stripe
    // button so the user sees "something landed here" and can expand with one deliberate click.
    const ui = appStore.getState();
    if (sel && !ui.rightCollapsed && ui.right !== 'props') {
      centerDeck.selectRightView('props');
    } else if (sel && ui.rightCollapsed) {
      centerDeck.notifyRstripProps();
    }
    // Re-pass the current model index to the palette so its aggregate-scoped buttons (#254) re-gate against
    // the freshly-selected element — a diagram click rebuilds the index before setting the selection, so
    // resolving the selection's kind here uses the up-to-date index rather than a stale captured prop.
    renderCanvasPalette();
    applySelectionHighlight();
  });

  // --- center (Visual / Code / Documentation) + right rail + region focus ----
  // The center/deck chrome (applyCenterChrome/syncCenterChrome/visibleCenters), selectCenter/showSettings,
  // and the DOM hosts they touch now live in centerDeckController (#985 Task 4). This facade keeps only
  // the hook-helper functions below: the loader-calling HALVES of ensureVisibleLoaded/ensureOutputLoaded/
  // ensureDocsLoaded/ensureTechLoaded/ensureBottomLoaded that must reach into a SIBLING module (Task 1's
  // contextMapPanel, Task 3's surfaceLoaders) or facade-private state (`deps.ensureAssistant`,
  // `deps.ensureScenarios`) centerDeckController must never import/reach directly — injected into it as
  // `hooks`. Each reads `centerDeck.visibleCenters()` now rather than a facade-local copy.

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
      domById('canvas-palette-host'),
    );
  }
  renderCanvasPalette();

  // The Generated preview host (#view-preview) — surfaceLoaders' own paint target (`hosts.preview`).
  // centerDeckController looks this id up independently for its own hidden-toggle chrome (the same
  // dual-lookup precedent as `sourceControlRightView`/`syntaxTreeRightView` above).
  const previewEl = domById('view-preview');

  // The assistant is interactive (not a cached, model-derived surface): every show re-points it at the
  // current folder's conversation and focuses the input — the single choke point for that swap. Created
  // lazily by ide.ts the first time this runs (the Anthropic SDK only loads on send). It now lives in the
  // right rail, so the guard checks the active RightView rather than the center. `deps.ensureAssistant` is
  // facade-private (not part of centerDeckController's own deps subset), so this whole function is
  // injected into it as the `ensureAssistantShown` hook.
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
    if (!centerDeck.visibleCenters().includes('docs')) return;
    const docs = appStore.getState().docs;
    if (docs === 'glossary' && appStore.getState().isStale('glossary')) void loaders.loadGlossary();
    else if (docs === 'adr' && !loaders.isAdrLoaded()) void loaders.loadAdr();
    else if (docs === 'notes' && !loaders.isNotesLoaded()) void loaders.loadNotes();
  }

  // Lazy-load the visible Code sub-view. The editor is live (CodeMirror, always mounted); only the
  // scenario runner needs a refresh on show. The compiler-produced surfaces (Generated / Compatibility /
  // Context Map) moved to the Output view — see ensureOutputLoaded. `deps.ensureScenarios` is facade-only
  // (not part of centerDeckController's own deps subset), so this stays facade-owned.
  function ensureTechLoaded(): void {
    if (!centerDeck.visibleCenters().includes('technical')) return;
    if (appStore.getState().tech === 'scenarios') deps.ensureScenarios?.().refresh();
  }

  // Lazy-load the visible Output sub-view: the emitted preview is model-derived (stale-gated), the
  // compatibility check is on-demand (idle state until a baseline is picked), and the context map is the
  // model-derived graph/table (stale-gated, Task 1's contextMapPanel).
  function ensureOutputLoaded(): void {
    if (!centerDeck.visibleCenters().includes('output')) return;
    const output = appStore.getState().output;
    if (output === 'generated' && appStore.getState().isStale('preview')) void loaders.loadPreview();
    else if (output === 'compatibility') loaders.renderCheckIdleIfEmpty();
    else if (output === 'contextmap' && appStore.getState().isStale('contextmap')) void contextMapPanel.load();
  }

  // Lazy-load every surface currently visible under the deck state (covers the secondary pane of a 2-up
  // and all four in overview), plus the model-derived facet of each. Self-gating loaders make repeat calls
  // cheap. This whole function is injected into centerDeckController as its `ensureVisibleLoaded` hook —
  // every branch needs Task 3's surfaceLoaders (directly, or via the three helpers above), which
  // centerDeckController must never import.
  function ensureVisibleLoaded(): void {
    if (centerDeck.visibleCenters().includes('visual') && appStore.getState().isStale('diagrams')) void loaders.loadDiagrams();
    ensureTechLoaded();
    ensureOutputLoaded();
    ensureDocsLoaded();
  }

  // A launcher scroll-to-term (#1165) is facade/Task-3 territory (surfaceLoaders' own glossary
  // scroll-nonce state, #985 Task 3) — handled HERE, before delegating the plain view switch to
  // centerDeckController's own `selectDocsTab` (#985 Task 4), which owns no term-scrolling concern.
  function selectDocsTab(view: DocsView, term?: string): void {
    if (view === 'glossary' && term) loaders.scrollGlossaryToTerm(term);
    centerDeck.selectDocsTab(view);
  }

  // Mount/refresh the Source Control right-rail panel — thin wrappers around surfaceLoaders' own methods
  // (#985 Task 3), injected into centerDeckController as its `loadSourceControl`/`focusSourceControl`
  // hooks (it must never import surfaceLoaders directly).
  function loadSourceControlHook(): void {
    loaders.loadSourceControl();
  }
  function focusSourceControlHook(focus: SourceControlFocus): void {
    loaders.focusSourceControl(focus);
  }

  // Refresh the given bottom-strip tab if it needs it: Events/Relationships (Task 3's surfaceLoaders) or
  // the lazily-created Terminal/Review panels (`deps.ensureTerminal`/`deps.ensureReview` — those two ARE
  // part of centerDeckController's own deps subset, but the Events/Relationships half still needs
  // surfaceLoaders, so the whole dispatch is injected as one hook rather than splitting it in two).
  function ensureBottomLoaded(tab: BottomTab): void {
    if (tab === 'events' && appStore.getState().isStale('events')) void loaders.loadEventsPanel();
    if (tab === 'relationships' && appStore.getState().isStale('relationships')) void loaders.loadRelationshipsPanel();
    if (tab === 'terminal') deps.ensureTerminal?.().fit();
    if (tab === 'review') deps.ensureReview?.();
  }

  // centerDeckController's own restore reads ONLY `deps.loadWorkspaceDeck` (Deck v2) — its own deps subset
  // deliberately omits `loadWorkspaceCenter`. The pre-Deck-v2 migration fallback — deriving a fresh 1-up
  // deck from the legacy single-key `loadWorkspaceCenter` when no deck has been persisted yet — needs the
  // FULL `InspectorControllerDeps` this facade holds, so it's resolved HERE and folded into the closure
  // handed down, matching the original restore logic exactly.
  function restoreWorkspaceDeck(): DeckState {
    const restoredDeck = deps.loadWorkspaceDeck?.();
    if (restoredDeck) return restoredDeck;
    const restoredCenter = deps.loadWorkspaceCenter();
    const initialCenter: CenterView = restoredCenter && isValidCenter(restoredCenter) ? restoredCenter : DEFAULT_CENTER;
    return { ...DEFAULT_DECK_STATE, primary: initialCenter };
  }

  centerDeck = createCenterDeckController({
    store: appStore,
    editor,
    deps: {
      saveWorkspaceCenter: deps.saveWorkspaceCenter,
      saveWorkspaceDeck: deps.saveWorkspaceDeck,
      loadWorkspaceDeck: restoreWorkspaceDeck,
      initEdgeResizer: deps.initEdgeResizer,
    },
    hooks: {
      ensureVisibleLoaded,
      loadSourceControl: loadSourceControlHook,
      focusSourceControl: focusSourceControlHook,
      loadSyntaxTree,
      ensureAssistantShown,
      ensureBottomLoaded,
    },
  });

  // refreshActiveSurfaces / invalidateDocViews / onDocEdited now live in surfaceLoaders.tsx (#985 Task 3):
  // the debounced doc-edit repaint rides the docViews slice's OWN `scheduleRefresh` there (its first
  // production caller) rather than a facade-local timer. The public interface below forwards straight to
  // `loaders.onDocEdited` / `loaders.invalidateDocViews` / `loaders.refreshActiveSurfaces`.

  // The center surface switcher + facet sub-strips are now the DeckSpine / DeckCard Preact components
  // (mounted in init()); they call focusPrimary / openBeside / setTech|Output|Docs on the store directly,
  // and the deck/facet subscription applies the chrome — so there are no imperative tab click handlers
  // to wire here anymore.

  // Right rail (Properties/AI Chat/Source Control/Syntax Tree) chrome — the title header sync, the
  // right-edge tool-window stripe (#500), its collapse/expand persistence, `selectRight`/`selectRightView`
  // — the left navigator morph-collapse (#730), `splitCodeCanvas`, and the deck/facet subscription that
  // drives `syncCenterChrome` all now live in centerDeckController (#985 Task 4). This facade's public
  // `selectRight`/`selectBottomTab`/`splitCodeCanvas`/etc. forward straight to it (see the return object).
  //
  // renderCheckIdleIfEmpty / runCheck and the whole emitted-code preview subsystem (setTarget,
  // onPreviewTargetChanged, loadPreview + the Output rail / Copy affordance) live in surfaceLoaders.tsx
  // (#985 Task 3) — `currentTarget` is gone: `setTarget` writes the shared store's `emitTarget` slice
  // (#923's existing top-bar mirror) and every reader loads it fresh from there, so there is no more
  // facade-local closure copy to drift out of step with the top-bar selector.

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

  // --- the "Context Map" tab: the strategic context map, as an interactive GRAPH or the dense TABLE ----
  // Extracted to its own module (inspector/contextMapPanel.tsx, #985 Task 1): the maxGraph handle
  // lifecycle, the Graph/Table mode toggle + its `koine.studio.contextMapView` persistence, the hover
  // tooltip, the relation-details strip, and the ADR 0009 scope-focus repaint all live there now. This
  // facade only wires the host it owns (#panel-contextmap), the narrow LSP surface, and the two
  // navigation side-effects a graph-node click can trigger (filter to a context, jump to its `.koi`
  // declaration) — reusing the SAME `setActiveContext` choke point the status-bar switcher uses.
  const contextMapPanel = createContextMapPanel({
    store: appStore,
    host: contextMapView,
    lsp,
    onNavigate: { setActiveContext: activeContextCtrl.setActiveContext, gotoSourceSpan: deps.gotoSourceSpan },
  });

  // --- surface loaders (#985 Task 3) ------------------------------------------
  // Every lazily-loaded, model-/folder-derived panel — the Generated preview (+ Copy affordance + Output
  // rail), the diagram, the glossary, the left-rail model-index fetch, the ADR/Notes docs pages, Source
  // Control (+ its live dirty-count repaint), the Events/Relationships tables, and the on-demand
  // Compatibility check — now live in surfaceLoaders.tsx, along with the docViews invalidation + the
  // debounced doc-edit repaint (onDocEdited, riding the docViews slice's own `scheduleRefresh`). This
  // facade wires the DOM hosts it already looked up, the write-path deps those loaders need, and the
  // handful of hooks back into facade-private state (the joined model index, the Domain navigator, the
  // chrome functions, Task 1/2's sibling modules) that a loader can't own itself.
  loaders = createSurfaceLoaders({
    store: appStore,
    lsp,
    output,
    platform,
    hosts: {
      preview: previewEl,
      diagrams: diagramsView,
      glossary: glossaryView,
      adr: adrView,
      notes: notesView,
      sourceControl: sourceControlRightView,
      events: eventsPanel,
      relationships: relationshipsPanel,
      check: checkView,
    },
    deps: {
      folderRootToken: deps.folderRootToken,
      setStatus: deps.setStatus,
      onSaveGlossaryDescription: deps.onSaveGlossaryDescription,
      saveAllDirty: deps.saveAllDirty,
      gotoSourceSpan: deps.gotoSourceSpan,
      gotoRange: (start, end) => editor.gotoRange(start, end),
    },
    hooks: {
      ensureModelIndex,
      onModelIndexRebuilt,
      ensureDomainNavigator,
      invalidateModelDerivedCaches,
      ensureTechLoaded,
      ensureOutputLoaded,
      ensureBottomLoaded,
      loadSyntaxTree,
      refreshContextList: activeContextCtrl.refreshContextList,
    },
  });

  // --- boot ------------------------------------------------------------------
  // Boot the chrome into the restored mode (no fetch — ide.ts's boot ladder's refreshActiveSurfaces loads
  // everything once the workspace document is open) + label the Generated sub-tab with the persisted
  // target. `centerDeck.init()` (#985 Task 4) paints the center chrome and mounts the DeckStage/DeckSpine
  // (moved out of this facade's own init()); `loaders.setTarget` runs AFTER it now — a safe reordering,
  // since nothing in the deck mount / chrome paint reads `emitTarget`.
  function init(): void {
    centerDeck.init();
    loaders.setTarget(deps.initialTarget);
  }

  // Cancel any pending debounce/reset timers. The IDE runs for the page lifetime in production (so this
  // is a no-op there), but the test suite boots many controllers into one shared happy-dom; disposing
  // between boots stops a deferred refresh (onDocEdited's 350ms debounce) from firing into a torn-down
  // environment, where `render` would throw "document is not defined".
  function dispose(): void {
    disposed = true;
    clearTimeout(caretSyncTimer); // #890: clear the debounced Syntax Tree caret-sync so it can't re-render a torn-down host
    // Drop the Domain navigator's store subscription so a deferred store change can't repaint a torn-down
    // host (the same hazard the debounce clears, for the navigator's #453 subscription).
    domainNavigator?.unmount();
    // Drop surfaceLoaders' own timers (the Copy-affordance reset, the bottom-panel debounce) and its
    // Source Control dirty-count subscription (#470) — and cancel any pending onDocEdited scheduleRefresh
    // callback (#985 Task 3: it self-guards on a `disposed` flag this call flips).
    loaders.dispose();
    // Drop the Syntax Tree caret-sync subscription (#890) too — its callback re-renders the panel, which
    // must not fire into a torn-down host after dispose.
    unsubscribeCursor();
    // Drop activeContextController's store subscription (#531) too — its callback re-renders scoped
    // surfaces, which would throw into a torn-down host if a deferred slice change fired after dispose.
    activeContextCtrl.dispose();
    // Drop the panel's own store subscriptions AND dispose its mounted maxGraph handle (#1002 — this also
    // fixes the formerly never-disposed graph handle: the pre-extraction dispose() only unsubscribed the
    // view-mode listener and left a live maxGraph instance behind).
    contextMapPanel.dispose();
    // Drop EVERY #985 Task 4 subscription in one call — the deck/facet subscription (re-applies the
    // center chrome + lazy-loads), the right-strip collapse (#500), the left-rail morph-collapse (#730),
    // the rail-axis switch (#453), the bottom-strip collapse (#983), and the center-persist subscription
    // (#980) — none of which must fire into a torn-down host after dispose. Also unmounts the deck Preact
    // trees so their window listeners (the DeckStage keyboard handler) detach, and drops its own
    // independent `resize` listener (the #475 default re-evaluation).
    centerDeck.dispose();
    // Drop the selection subscription (#980) — its callback repaints the inspector / re-applies scope,
    // which must not fire into a torn-down host after dispose.
    unsubscribeSelection();
    // The viewport-resize listener (the #221 inspector-sheet narrow↔wide handling) is registered
    // unconditionally, so always detach it; the sheet teardown is still sheet-gated.
    window.removeEventListener('resize', onViewportResize);
    inspectorSheet?.destroy();
    // Close the status-bar scope menu (#146) and drop its trigger listener, so a torn-down controller
    // leaves no orphaned menu on document.body and no dangling click handler on the persistent
    // #sb-context node (which outlives the controller across a workspace switch).
    scopeMenu.close(false);
    sbContextEl.removeEventListener('click', toggleScopeMenu);
  }

  // Construction has fully succeeded (every required host resolved) — only now register the global
  // `resize` listener, so a throwing lookup above can never leak a half-built closure onto `window`.
  window.addEventListener('resize', onViewportResize);

  return {
    selection,
    activeContext: activeContextCtrl.handle,
    selectCenter: centerDeck.selectCenter,
    showSettings: centerDeck.showSettings,
    setAxis: centerDeck.setAxis,
    selectTech: centerDeck.selectTech,
    selectOutput: centerDeck.selectOutput,
    selectDocsTab,
    selectBottomTab: centerDeck.selectBottomTab,
    selectRight: centerDeck.selectRight,
    splitCodeCanvas: centerDeck.splitCodeCanvas,
    loadPreview: loaders.loadPreview,
    loadDiagrams: loaders.loadDiagrams,
    setTarget: loaders.setTarget,
    onPreviewTargetChanged: loaders.onPreviewTargetChanged,
    runCheck: loaders.runCheck,
    onDocEdited: loaders.onDocEdited,
    invalidateDocViews: loaders.invalidateDocViews,
    invalidateDocsPanel: loaders.invalidateDocsPanel,
    refreshSourceControl: loaders.refreshSourceControl,
    onThemeChanged: loaders.onThemeChanged,
    refreshActiveSurfaces: loaders.refreshActiveSurfaces,
    refreshContextList: activeContextCtrl.refreshContextList,
    restoreActiveContext: activeContextCtrl.restoreActiveContext,
    followActiveFileContext: activeContextCtrl.followActiveFileContext,
    ensureModelIndex,
    getCachedDomainIndex,
    init,
    dispose,
  };
}
