// Koine Studio app composition: wires the .koi editor, the live LSP diagnostics,
// the status line, the diagnostics strip, and the tabbed inspector (emitted preview,
// glossary, and context map).
import { createOutputView } from '@/editor/editor';
import {
  KoineLsp,
  type GlossaryEntry,
  type Location,
  type Range,
  type SourceSpan,
  type TextEdit,
} from '@/lsp/lsp';
import {
  fileUriToPath,
  pathToFileUri,
} from '@/shell/ideUtils';
import { createEditorSession } from '@/shell/editorSession';
import { createInspectorController } from '@/shell/inspectorController';
import { initInstantTooltip, LEFT_RAIL_IDS, LeftRail, RightStrip } from '@atypical/koine-ui';
import { ensureOutputScaffold } from '@/shell/outputRail';
import { createCanvasWrite } from '@/shell/canvasWrite';
import { getPlatform } from '@/host';
import { createExplorer } from '@/shell/explorer';
import { koineMark } from '@/shared/logo';
import { basename } from '@/shared/path';
import { domById } from '@/shared/domById';
import { createLifecycleBoot } from '@/shell/lifecycleBoot';
import { createFormatActive } from '@/shell/formatActive';
import { initTheme } from '@/settings/theme';
import {
  peekLegacyScratch,
  effectiveSettings,
  initSecrets,
  loadActiveContext,
  loadSettings,
  loadWorkspaceCenter,
  loadWorkspaceDeck,
  pushRecentFolder,
  saveActiveContext,
  saveWorkspaceCenter,
  saveWorkspaceDeck,
  setLastWorkspace,
  workspaceKeyOf,
  type Settings,
} from '@/settings/persistence';
import { type Template } from '@/welcome/templates';
import { createCommandWiring } from '@/shell/commandWiring';
import { createLayoutController } from '@/shell/layout';
import { createExportShare } from '@/shell/exportShare';
import { type PrefsCallbacks } from '@/settings/prefs';
import { createPanelHost } from '@/shell/panelHost';
import { applyAppearance } from '@/settings/appearance';
import { initEdgeResizer } from '@/shell/resize';
import { formatChord } from '@/shared/platform';
import { setDefaultCanvasZoom } from '@/diagrams/diagramContract';
import { appStore } from '@/store/index';
import { badgeCounts, createDiagCountGate } from '@/diagnostics/diagCountGate';
import { reanchorSelectionAfterRename, type SelectedElement } from '@/model/selection';
import { renameStatusMessage, type InspectorElement } from '@/model/inspector';
import { createReviewStore } from '@/review/reviewStore';
import { resolveReviewAuthor } from '@/review/ReviewPanel';
import { readModelFromHash } from '@/export/share';
import { handleBeforeUnload } from '@/shell/dirty';
import { render } from 'preact';
import { createHistoryController } from '@/shell/historyController';
import { installExportMenuDismiss } from '@/shell/exportMenuDismiss';
import { HistoryControls } from '@/shell/HistoryControls';
import { UnsavedIndicator } from '@/shell/UnsavedIndicator';
import { CompilingIndicator } from '@/shell/CompilingIndicator';
import { createEmitTargetControl } from '@/shell/emitTargetControl';
import { createStatusBar } from '@/shell/statusBar';
import { WorkspaceProblemsBadge } from '@/diagnostics/WorkspaceProblemsBadge';
import { createWorkspaceController, type WorkspaceController } from '@/shell/workspaceController';
import { createSearchPanel } from '@/shell/searchController';
import { type Match } from '@/shell/workspaceSearch';
import { createOverlays } from '@/shell/overlays';

// --- workspace fs contract ---------------------------------------------------
// `KoiFile` (path / name / relPath) is provided by the host platform layer (src/host), whose
// backends supply it from the native filesystem (desktop) or the File System Access API (browser).
// The `Buffer` interface + the whole buffers/open/save/dirty/mutation lifecycle live in
// workspaceController.ts now (Task 5); ide.ts owns the surrounding chrome and the diagram/inspector
// write path, reaching the workspace through the `workspace` handle constructed below.

// Seed model — templates/starters/billing/billing.koi, inlined (the renderer has no fs access).
const SEED = `context Billing {

  value Money {
    amount: Decimal
    currency: Currency
    invariant amount >= 0        "a monetary amount cannot be negative"
  }

  enum Currency { EUR, USD, GBP }

  value Email {
    raw: String
    invariant raw matches /^[^@]+@[^@]+$/   "invalid email address"
  }

  entity Customer identified by CustomerId {
    name: String
    email: Email
  }

  aggregate Order root Order {

    enum OrderStatus { Draft, Placed, Shipped, Cancelled }

    value OrderLine {
      product:   ProductId
      quantity:  Int
      unitPrice: Money
      subtotal:  Money = unitPrice * quantity
    }

    entity Order identified by OrderId {
      customer: CustomerId
      lines:    List<OrderLine>
      status:   OrderStatus = Draft
      invariant status == Draft when lines.isEmpty
    }
  }
}
`;

// What "New" opens: a clean, valid, empty bounded context — NOT the Billing SEED. "New" means a
// fresh canvas; loading a full sample is the welcome screen's example gallery's job, not this one's.
// An empty-bodied context is valid Koine (the same shape `koine init` and the LSP tests use). Exported
// so main.ts can seed the same first model when a user opts to open a cloned-but-empty folder anyway
// (#1017), rather than main.ts (boot-layer code) keeping its own copy to drift out of sync.
export const BLANK = `context NewModel {

  // Describe your bounded context here — add value objects, entities, and aggregates.

}
`;

/** Callbacks the boot layer (main.ts) injects into the IDE — the editor→Home direction of the route
 *  hand-off that complements #368's Home→editor start-intent. */
export interface IdeHooks {
  /**
   * An open-recent start-intent failed to open its folder (#391). Recovery for a dead recent now lives
   * on the Home route, so instead of painting the legacy welcome overlay over the editor the IDE reports
   * the failure here; the boot layer returns to Home and — for an `unreadable` folder — offers to forget
   * the entry there. Absent in tests that drive init() directly.
   */
  onOpenRecentFailed?(path: string, reason: 'unreadable' | 'empty'): void;
  /**
   * An open-recent start-intent's folder opened successfully (#1017). Lets the boot layer clear any
   * one-shot "this path was just cloned" tracking now that the specific attempt it was scoped to has
   * resolved — without this, a clone that opens cleanly (or an "Open anyway" retry that succeeds after
   * seeding a first file) would leave that tracking permanently pinned to the path, misattributing an
   * unrelated LATER failure on the same path (e.g. its files deleted outside Studio) to this clone.
   */
  onOpenRecentSucceeded?(path: string): void;
}

// --- the composition-root contract (#757) --------------------------------------------------------
// init() is a THIN composition root: it constructs the shared handles (platform / lsp / editor session /
// workspace / inspector controller / store), news up the feature controllers below, and returns the
// aggregate teardown. It must STAY thin — a vitest line budget (lineBudgets.test.ts) fails CI if it
// regrows. When you add a Studio feature, EXTEND the controller that owns its surface, don't grow init():
//
//   commandWiring.ts  — command palette + command list (getCommands) + toolbar command buttons + global
//                        keyboard shortcuts. (Composes onto the command-registry sibling #758 when it lands.)
//   layout.ts         — #split data-* mirror + inspector/left-rail edge resizers + rail-section disclosure
//                        + the ⌘B file-tree toggle + the layout palette actions.
//   exportShare.ts    — shareable link, .koi source zip, diagram export (SVG/PNG/PlantUML) + Mermaid copy,
//                        Save-to-disk, the Generate Project wizard, shared-workspace import.
//   overlays.ts       — confirm/prompt dialogs, the shortcuts help overlay, the overlay-open gate, the
//                        unsaved-work New guard (requestNewModel), the memory-only banner.
//   panelHost.ts      — the lazily-built Settings page / AI assistant / scenario runner / terminal /
//                        Review panels (nothing constructed until first use).
//   canvasWrite.ts    — the diagram-authoring write-path (#91 model→.koi round-trip), canvas annotations,
//                        the in-editor review-comment composer, the mobile-zone switcher + DIAGRAM_* listeners.
//   lifecycleBoot.ts  — the lsp.start boot ladder, the Home start-intent, the route-intent subscription,
//                        and the aggregate teardown (preserving disposal order).
//
// The buffer/open/save lifecycle (workspaceController), the center views + Properties inspector
// (inspectorController), undo/redo (historyController), workspace search (searchController), and the
// editor↔LSP/diagnostics wiring (editorSession) were extracted earlier (#180/#182) and live beside these.
// What remains in init() is the construction wiring + the inspector rename/description write-path.
export function init(hooks: IdeHooks = {}): () => void {
  // The host backend: the Tauri desktop shell, or a plain browser (compiler via WASM, files via
  // the File System Access API). Everything host-specific — the LSP transport, folder/file I/O,
  // dialogs, the app version — goes through this.
  const platform = getPlatform();

  // Decrypt the assistant API key into store.ts's in-memory cache (and migrate any legacy plaintext
  // key out of localStorage). Fire-and-forget: nothing at boot needs the key synchronously — the
  // assistant reads it lazily per request, long after this resolves.
  void initSecrets();

  // Render the header mark from the shared builder (logo.ts) so the welcome, about, and header marks
  // all flow from one source and can't drift apart on the next tweak.
  const brandLogo = document.querySelector('.brand-logo');
  if (brandLogo) brandLogo.innerHTML = koineMark(); // eslint-disable-line no-restricted-syntax -- static, trusted brand mark from logo.ts (koineMark returns a fixed SVG); same-line keeps the lineBudgets line count

  // Apply the persisted theme + appearance (accent, reduced motion, editor metrics) before
  // CodeMirror is created so the editor picks up the right tokens / size on first paint.
  initTheme();
  // Install the instant tooltip once (replaces native `title` — shows immediately + carries a kbd chip).
  initInstantTooltip();
  let settings: Settings = loadSettings();
  applyAppearance(settings);

  // A model carried in the URL hash (a shared playground link) takes precedence over both the seed
  // and any restored scratch, so opening a link always lands on the shared model.
  // A shared link is a discriminated SharePayload: a single-string model (legacy) or a multi-file
  // workspace. A single model seeds the editor's initial doc directly; a workspace is imported after
  // the language server is up (see the lsp.start callback) so its didOpen resolves cross-file refs.
  const shared = readModelFromHash();
  // One-time migration of the legacy single-file scratch buffer (pre-workspace Studio) into the
  // default workspace's model.koi. Peek only — clearLegacyScratch() is called inside
  // openDefaultWorkspaceFlow once the workspace is confirmed open, so content is never lost
  // if OPFS is unavailable or the open fails.
  const legacyScratch = peekLegacyScratch();
  // First paint before the workspace opens; openFolderPath replaces it with the active file's text.
  const initialDoc = (shared?.kind === 'single' ? shared.text : null) ?? legacyScratch ?? SEED;

  // The read-only emitted-code viewer in #view-preview. Owned here (boot-error + Settings soft-wrap
  // also write to it) and injected into the inspector controller, which owns the Generated-preview
  // load path + the overlaid copy button.
  // The Generated preview is a per-file rail beside a single-file viewer (concept-7 "Flush"). Build the
  // scaffold once inside #view-preview and mount the read-only CodeMirror OutputView into its `.out-code`
  // slot; the inspector controller renders the rail + crumb into the same (idempotently-built) scaffold.
  const outputCodeEl = ensureOutputScaffold(domById('view-preview')).code;
  const output = createOutputView(outputCodeEl, settings.wordWrap);

  const statusEl = domById('status');
  const diagBodyEl = domById('diag-body');
  const diagCountEl = domById('diag-count');

  // Bottom status-bar fields — a pure projection of existing state (no new data sources). Per the
  // single-home contract (docs/shell-bars-contract.md, #756): #sb-connection is the SOLE connection
  // indicator (driven by setConnection over the LSP lifecycle), NOT a mirror of the topbar #status pill
  // — that pill is transient action-feedback only. The #sb-problems split + #sb-cursor are driven by the
  // diagnostics strip / editor (chrome v2, #923), and #sb-version once at boot from the build-time define.
  // (#sb-context is written by the inspector controller's bounded-context switcher.)
  const sbConnEl = domById('sb-connection');
  const sbProblemsErrEl = domById('sb-problems-errors');
  const sbProblemsWarnEl = domById('sb-problems-warnings');
  const sbCursorEl = domById('sb-cursor');
  domById('sb-version').textContent = `v${__APP_VERSION__}`;

  // Global unsaved-work surfacing: the document title gains a `•` and a clickable "N unsaved" pill
  // appears in the status bar (beside validity/problems) whenever any open buffer is dirty. baseTitle
  // is captured once, clean.
  // The pill is now the <UnsavedIndicator> Preact panel (#193) bound to the existing static button: it
  // subscribes to the workspace slice's dirty count, sets the button's text/hidden/aria-label + the
  // title bullet, and wires Save-all. The workspace slice is the single owner of buffers/activeUri now
  // (#982), so the panel re-renders inherently off every slice action — no manual projection push is
  // needed. (The button stays index.html's element, so the controller's `domById(...)` lookups and the
  // test's getElementById are untouched.)
  const baseTitle = document.title;
  const unsavedEl = domById('unsaved-indicator') as HTMLButtonElement;
  // <UnsavedIndicator> renders no tree of its own (it governs the static button via effects), so it
  // mounts into a throwaway holder rather than the button — keeping the reconciler off the button node.
  const unsavedHost = document.createElement('div');
  render(
    <UnsavedIndicator
      store={appStore}
      host={unsavedEl}
      baseTitle={baseTitle}
      onSaveAll={() => commandWiring.run('save-all')}
    />,
    unsavedHost,
  );

  // Workspace-wide problems rollup beside the #sb-problems split (which is active-file only): a status-bar
  // badge summarising every file's diagnostics, hidden while the workspace is clean. Subscribes to the
  // diagnostics slice, so the LSP publish path keeps it current with no extra wiring.
  render(<WorkspaceProblemsBadge store={appStore} />, domById('sb-problems-host'));

  // Transient "compiling…" indicator (#516): surfaces the existing compile-in-flight signal (#469) while
  // the compiler is busy (diagnose / emit-preview / run-scenario), debounced so a fast keystroke-diagnose
  // doesn't flash it. Subscribes to compileActivity's onCompileActivityChange seam — no store wiring.
  render(<CompilingIndicator />, domById('sb-compiling-host'));

  // The bounded-context scope is surfaced in the status-bar "Context" segment and switched via the left
  // Domain navigator (chrome v2, #923 retired the redundant top-bar breadcrumb strip). The inspector
  // controller owns the scope choke point (persist + repaint of every scoped surface).

  // Dev-facing live store inspector (#193 follow-up): a read-only overlay of what the app store thinks
  // right now, toggled from the command palette. Registered only in dev builds (see devCommands), and
  // the panel is dynamic-import()ed here so its chunk never ships in production — the dev-only command
  // is its sole caller, so in a vite build the import is unreachable and drops out of the bundle.
  // The host is created lazily on first toggle and the panel rendered once (it tracks the store
  // thereafter); toggling just flips the host's hidden flag.
  let storeInspectorHost: HTMLElement | null = null;
  let storeInspectorMounting = false;
  async function toggleStoreInspector(): Promise<void> {
    if (!storeInspectorHost) {
      // First invocation: load the panel chunk, create the host (visible by default) and render once.
      // Guard against a double-click racing two mounts while the dynamic import is in flight. Return
      // here so we don't immediately flip it back to hidden — the first toggle SHOWS it.
      if (storeInspectorMounting) return;
      storeInspectorMounting = true;
      try {
        const { StoreInspector } = await import('@/shell/StoreInspector');
        storeInspectorHost = document.createElement('div');
        storeInspectorHost.className = 'koi-store-inspector-overlay';
        document.body.appendChild(storeInspectorHost);
        render(<StoreInspector store={appStore} />, storeInspectorHost);
      } finally {
        // Always clear the flag — even if the dynamic import rejects — so a failed first attempt
        // doesn't wedge the toggle permanently.
        storeInspectorMounting = false;
      }
      return;
    }
    storeInspectorHost.hidden = !storeInspectorHost.hidden;
  }

  // Seed the LSP trace verbosity from the user-level setting (no workspace is open yet at construction,
  // so the effective value equals the user value — mirroring `lineWrap: settings.wordWrap` below). Any
  // per-workspace override is then pushed live via applyEffectiveScoped once a folder opens (#264/#354).
  const lsp = new KoineLsp(platform.createLspTransport(), settings.lspTrace);

  // --- workspace model ------------------------------------------------------
  // The buffers / activeUri / folderRootToken / entriesCache state and the whole open/save/dirty/
  // mutation lifecycle live in `workspace` (workspaceController.ts, Task 5), constructed below.
  // editorSession + the inspector controller are built FIRST and read activeUri/folderRootToken via
  // `() => workspace.…()` thunks (only invoked at runtime, after construction), and they receive the
  // workspace's effects through its onActiveChanged/onBuffersChanged seams — so neither module imports
  // the other and there's no circular import. `workspace` is forward-declared here for those thunks.
  let workspace: WorkspaceController;

  // The current workspace's stable override key (a hash of its sorted roots), or null when no folder
  // is open — the workspace-scoped settings (previewTarget/formatOnSave/wordWrap/lspTrace) merge over
  // the user settings under this key. A `function` declaration so it can reference `workspace` (assigned
  // below): every call happens at runtime, long after construction, so the hoisted binding is safe.
  function wsKey(): string | null {
    const rs = workspace.rootsList();
    return rs.length ? workspaceKeyOf(rs) : null;
  }

  // Apply the workspace-scoped fields that need a LIVE push (word-wrap on both surfaces, the preview
  // target relabel, the LSP trace verbosity) from an already-resolved effective Settings. Shared by the
  // prefs onChange, a folder open, and a root-set change so the three call sites can never drift.
  // (format-on-save reads through the live getFormatOnSave thunk, so it needs no push here.)
  function applyEffectiveScoped(eff: Settings): void {
    editor.setLineWrap(eff.wordWrap);
    output.setLineWrap(eff.wordWrap);
    controller.onPreviewTargetChanged(eff.previewTarget);
    lsp.setTrace(eff.lspTrace);
    // Mirror the effective emit target into the store (#923) so the top-bar selector + status-bar echo
    // reflect it, whichever control changed it (the selector, the Settings Output picker, or a folder/
    // root switch that brought a different workspace override into effect).
    appStore.getState().setEmitTarget(eff.previewTarget);
  }

  // Adding or removing a workspace root changes the workspace identity: folderRootToken() may now point
  // at a different primary folder and wsKey() hashes a different root set, so every folder-derived view
  // and every workspace-scoped behavior must re-sync — exactly like a folder open, minus restoreActive-
  // Context (an additive root change keeps the user's current bounded-context scope rather than resetting
  // it). Without this, removing the primary root strands the Docs/layout/diagram stores on the dead key
  // (#174) and a per-workspace word-wrap/preview-target override goes stale until an unrelated event.
  function onRootSetChanged(): void {
    // The controller already published the new roots into the slice (addRoot/removeRoot call setRoots),
    // so this just re-syncs the folder-derived views + scoped behaviors (#982).
    controller.invalidateDocViews();
    controller.invalidateDocsPanel();
    void controller.refreshContextList();
    controller.refreshActiveSurfaces();
    applyEffectiveScoped(effectiveSettings(settings, wsKey()));
  }

  // The editor ↔ LSP + diagnostics wiring (issue #180, Task 3): owns the CodeMirror editor and its
  // callback wall (hover/completion/definition/rename/references/code-actions → lsp.*), the per-uri
  // diagnostics cache, the status pill + diagnostics strip, and the LSP publishDiagnostics/exit
  // subscriptions. ide.ts keeps the buffer/dirty/tree side effects of an edit (wired through
  // editorSession.onChange below) and the workspace/model concerns.
  // Gate the diagnostics-driven tree rebuild: the LSP republishes a file's diagnostics on every
  // keystroke, but the only diagnostics-driven tree output is each file's error/warning badge, so a
  // push that leaves a file's counts unchanged would rebuild the explorer for an identical result.
  const diagCountGate = createDiagCountGate();

  // The in-editor review threads (#259, Phase 1 collaboration): a Studio-only sidecar persisted to the
  // opened folder's `.koine/reviews.json` (a no-op in-memory in no-folder mode). Created once for the
  // IDE lifetime; `load()` runs on every folder open (onFolderOpened, below). The editors read its
  // `list()` to paint marks, edits remap its spans, and the bottom-panel Review tab renders it.
  const reviewStore = createReviewStore(platform, () => workspace.folderRootToken() || null);

  const editorSession = createEditorSession({
    parent: domById('editor-pane'),
    doc: initialDoc,
    lineWrap: settings.wordWrap,
    minimap: settings.enableMinimap,
    lsp,
    status: statusEl,
    diagCount: diagCountEl,
    diagBody: diagBodyEl,
    sbConnection: sbConnEl,
    sbProblemsErrors: sbProblemsErrEl,
    sbProblemsWarnings: sbProblemsWarnEl,
    sbCursor: sbCursorEl,
    activeUri: () => workspace.activeUri(),
    uriLabel: (uri) => workspace.buffers.get(uri)?.relPath ?? basename(uri),
    onNavigate: (loc) => navigateToDefinition(loc),
    onApplyWorkspaceEdit: (edit) => workspace.applyWorkspaceEdit(edit),
    // A diagnostics push re-renders the tree so non-active files can badge their error/warning counts
    // (the active file's gutter/strip/status are repainted inside editorSession first). Skip the rebuild
    // when the pushed file's counts are unchanged — the badge would be identical, so the keystroke-rate
    // republish no longer churns the whole explorer.
    onDiagnostics: (uri, diags) => {
      if (diagCountGate.changed(uri, diags)) workspace.renderTree();
    },
    // Review threads (#259): the editors paint marks from the store's list() (editorSession file-scopes it
    // per group), opening a comment routes through addReviewComment, and each edit re-anchors only the
    // edited file's pinned spans (editorSession supplies the file).
    getReviewThreads: () => reviewStore.list(),
    onAddComment: (span) => canvasWrite.addReviewComment(span),
    onDocChange: (change, doc, file) => reviewStore.remap(file, change, doc),
  });
  const editor = editorSession.editor;
  const setStatus = editorSession.setStatus;
  // Repaint the editors' review marks on every store change (add/reply/resolve/delete/remap/load). Keep the
  // unsubscribe so init()'s teardown releases it (the editorSession is destroyed there).
  const unsubReviewStore = reviewStore.subscribe(() => editorSession.refreshReviewDecorations());

  // The buffer/dirty/tree half of the editor's onChange (the editor↔LSP sync runs inside
  // editorSession; the buffer text+dirty update lives in workspace.syncBuffer). The callback carries
  // the EDITING group's uri (group A's active uri, or group B's current uri) so the edit syncs into
  // the right buffer — a group-B edit must never write group A's (active) buffer (#265). Preserves the
  // original effect order: buffer text+dirty → onDocEdited → renderTree (only when that file's dirty
  // dot just appeared). The active-file-only side effects (recompile via onDocEdited, history.noteEdit)
  // are gated on `uri === activeUri()`: they are group-A/active-file concerns and a background B edit
  // must not drive the active file's recompile or undo history.
  editorSession.onChange((doc, uri) => {
    // Sync into the EDITING group's own buffer (active or B), flipping its dirty flag on first change.
    const becameDirty = workspace.syncBuffer(uri, doc);
    if (uri === workspace.activeUri()) {
      // Active-file-only effects: recompile the active doc views + record the edit in undo history.
      controller.onDocEdited();
      if (!history.isRestoring) history.noteEdit();
    }
    // Re-render the tree only when THIS file's dirty dot just appeared — so B's dirty badge shows too.
    if (becameDirty) workspace.renderTree();
    // Arm the idle auto-save debounce for both groups (a no-op unless Auto-save is on); B autosaves too.
    workspace.scheduleAutoSave();
  });

  // The left rail's inner markup is owned by the LeftRail Preact component (#759, was the #453
  // leftRailMarkup string builder); index.html keeps <aside id="leftrail"> a thin shell. Render it here —
  // synchronously, before any rail domById(...) lookup or the inspector controller below — so #filetree-body /
  // #rail-domain-pane all resolve. LeftRail never re-renders, so the imperative explorer/outline islands
  // that later mount into those (empty) hosts are never reconciled away.
  // GUARDRAIL: this render-once invariant is load-bearing — do NOT give LeftRail/RightStrip/AssistantView
  // a store subscription or reactive state, and do NOT add a `render(null, host)` teardown for these
  // hosts; either would make Preact reconcile and wipe the imperative islands' DOM. init() runs once and
  // is never torn down (src/main.ts), so a single render is correct.
  render(<LeftRail />, domById<HTMLElement>('leftrail'));

  // The right-edge tool-window stripe's buttons are owned by the RightStrip Preact component (#759, was
  // the #500 rightStripMarkup string builder); index.html keeps <div id="right-strip"> a thin shell.
  // Render synchronously before the inspector controller below so its `.rstrip-btn` lookup + wiring
  // resolve, mirroring the leftRail injection above. RightStrip never re-renders, so the controller's
  // captured nodes + imperative aria-pressed writes are never reconciled away.
  render(<RightStrip />, domById<HTMLElement>('right-strip'));

  const treeBodyEl = domById<HTMLElement>(LEFT_RAIL_IDS.filetreeBody);
  const treeTitleEl = domById<HTMLElement>(LEFT_RAIL_IDS.filetreeTitle);
  const splitEl = domById<HTMLElement>('split');

  // The left-rail section disclosure, the file-tree (⌘B) toggle, and the #split layout (data-* mirror +
  // edge resizers + the layout palette actions) live in the layout controller now (#757), constructed
  // below once the inspector `controller` (whose setAxis ⌘B drives) and the store exist.

  // The workspace file explorer. It deals in opaque fs tokens; ide.ts maps token ↔ file:// uri
  // (pathToFileUri) to keep `buffers`, `activeUri` and the LSP workspace coherent on every mutation.
  const explorer = createExplorer({
    onOpenFile: (token) => void openFile(token),
    onNewFile: (parentDirToken, name) => void workspace.handleNewFile(parentDirToken, name),
    onNewFolder: (parentDirToken, name) => void workspace.handleNewFolder(parentDirToken, name),
    onRename: (entry, newName) => void workspace.handleRename(entry, newName),
    onDelete: (entry) => void workspace.handleDelete(entry),
    onDuplicate: (entry) => void workspace.handleDuplicate(entry),
    onMove: (entry, destDirToken) => void workspace.handleMove(entry, destDirToken),
    isActive: (token) => pathToFileUri(token) === workspace.activeUri(),
    isDirty: (token) => workspace.buffers.get(pathToFileUri(token))?.dirty ?? false,
    diagCounts: (token) => diagCounts(pathToFileUri(token)),
    // Multi-root workspace: the head "Add folder" affordance unions a second folder in as a new root;
    // each group's "Remove" affordance drops just that root's files.
    onAddRoot: () => void addRootViaPicker(),
    onRemoveRoot: (root) => {
      workspace.removeRoot(root);
      onRootSetChanged();
    },
  });
  treeBodyEl.appendChild(explorer.el);

  // --- file tree ------------------------------------------------------------

  function diagCounts(uri: string): { errors: number; warnings: number } {
    // Shares badgeCounts with the diagnostics-count gate so the gate's "did the badge change?" decision
    // and the badge actually rendered here can never disagree (severity 2 ⇒ warning, all else ⇒ error).
    return badgeCounts(editorSession.diagnosticsFor(uri));
  }

  // Cross-file go-to-definition: if the resolved Location is a different OPEN file, activate it
  // before jumping; otherwise jump within the current file. Unknown uris are ignored. (The buffers
  // / open / activate lifecycle lives in workspaceController; this read-only navigation stays here
  // because it pairs with the editor's gotoRange and the diagram/inspector write path below.)
  function navigateToDefinition(loc: Location): void {
    if (loc.uri && loc.uri !== workspace.activeUri() && workspace.buffers.has(loc.uri)) {
      workspace.activateFile(loc.uri);
    }
    editor.gotoRange(loc.range.start, loc.range.end);
  }

  // The Spotlight launcher's go-to (#1143): activate the declaring file (from disk if it isn't a buffer yet),
  // then reveal the range ONLY once that file is actually active so a null token / failed open can't scroll the wrong doc (#1145 review).
  async function revealLocation(uri: string, range: Range): Promise<void> {
    try {
      if (uri !== workspace.activeUri()) {
        if (workspace.buffers.has(uri)) workspace.activateFile(uri);
        else {
          const token = fileUriToPath(uri);
          if (token) await workspace.openFileToken(token);
        }
      }
      if (uri === workspace.activeUri()) editor.gotoRange(range.start, range.end);
    } catch {
      /* best-effort launcher navigation */
    }
  }

  // Open a file from a USER-INITIATED affordance (a file-tree click, a Go-to-File palette pick). Takes an
  // fs token (what the explorer hands us) and routes it through the single editor's activate path. (The
  // former two-group "focused group" routing went away with the editor A/B split — the center split-pane
  // system (#720) is the one splitting primitive now.)
  async function openFile(token: string): Promise<void> {
    await workspace.openFileToken(token);
  }

  // The uri-keyed twin for affordances that already hold an open buffer's uri (the Go-to-File palette
  // iterates workspace.buffers, so the buffer is already loaded — no ensureBuffer needed).
  function openUri(uri: string): void {
    workspace.activateFile(uri);
  }

  // Replace the active document's contents (used by the AI "Apply to editor" action). Setting the
  // editor doc dispatches a change, so the editor's onChange handler runs the full sync pipeline
  // (buffer text, lsp.changeDoc, doc-view refresh, tree) — don't repeat it here.
  function replaceActiveDoc(source: string): void {
    editor.setDoc(source);
  }

  // --- inspector / center-view / tab subsystem (extracted, src/inspectorController.ts) -------------
  // The center views (Visual / Code / Documentation), the bottom strip, the per-view
  // lazy loaders, the bounded-context scope (#146), and the selection-driven Properties inspector
  // (#142) all live in the controller now. ide.ts keeps only the editor↔LSP/buffer/workspace wiring
  // and the diagram-authoring + inspector WRITE path (below), which the controller triggers through
  // the injected callbacks. The `selection` and `activeContext` state lives in the app store (the single
  // source of truth); ide.ts reaches it through these thin shims for the diagram write-path + add-type scope.
  const controller = createInspectorController({
    lsp,
    editor: { view: editor.view, goto: editor.goto, gotoRange: editor.gotoRange },
    output,
    platform,
    store: appStore,
    activeUri: () => workspace.activeUri(),
    folderRootToken: () => workspace.folderRootToken(),
    // #470: the Source Control panel's save-all-before-commit prompt persists every dirty buffer through
    // the shell's existing Save-all (#109). A thunk because `workspace` is constructed after the controller.
    saveAllDirty: () => workspace.saveAllDirty(),
    initialTarget: settings.previewTarget,
    saveWorkspaceCenter,
    loadWorkspaceCenter,
    saveWorkspaceDeck,
    loadWorkspaceDeck,
    saveActiveContext,
    loadActiveContext,
    setStatus,
    onRenameElement: (element, newName) => void renameElement(element, newName),
    onSaveElementDescription: (element, text) => void saveInspectorDescription(element, text),
    onSaveGlossaryDescription: (entry, text) => saveDescription(entry, text),
    onApplyStructuredEdit: (edit) => void canvasWrite.applyStructuredEdit(edit),
    onAddConstruct: (kind) => void canvasWrite.applyDiagramAddType({ kind }),
    onAddAnnotation: (kind) => canvasWrite.createCanvasAnnotation(kind),
    onAddAggregateMember: (kind, aggregateQn) => void canvasWrite.applyDiagramAddAggregateMember(kind, aggregateQn),
    onExportDiagram: (format) => void exportShare.exportActiveDiagram(format),
    onCopyDiagramMermaid: () => void exportShare.copyActiveDiagramMermaid(),
    gotoSourceSpan: (span) => void gotoSourceSpan(span),
    // Cross-axis "Reveal in Files" (#453): the tactical leaf already switched the rail to the Files axis
    // (setAxis) before this fires, so we just point the explorer at the context's `.koi`.
    revealInFiles: (context) => explorer.revealByContext(context),
    // Files-tree scope emphasis (ADR 0009 / #1188): the controller's scope fan-out points the explorer at
    // the active context so its `.koi` lights up and the other contexts' files de-emphasise.
    scopeFiles: (context) => explorer.setActiveContext(context),
    ensureAssistant: () => panelHost.ensureAssistant(),
    ensureScenarios: () => panelHost.ensureScenarios(),
    ensureTerminal: () => panelHost.ensureTerminal(),
    ensureReview: () => panelHost.ensureReview(),
    initEdgeResizer,
  });
  // A thin shim over the app store (the single source of truth): the inspector rename write-path
  // re-anchors the selection after a rename. (The diagram write-path + canvas gesture listeners moved
  // to the canvasWrite controller (#757), constructed below.)
  const selection = {
    set: (element: SelectedElement | null) => appStore.getState().setSelection(element),
  };

  // --- inspector write path (the #91 round-trip) ----------------------------
  // These perform the actual `.koi` mutations (rename / set-description) and span navigation. They stay
  // in ide.ts because they reach the buffers / workspace edit path; the controller triggers them via the
  // injected callbacks above and re-renders in step on success.

  /**
   * Persists a description by asking the server for the doc-comment edit and applying it to the
   * buffer. The applied edit fires onChange → onDocEdited, which reloads the glossary (debounced),
   * refreshing coverage. A no-op result (e.g. an unknown id) needs no action — the inline editor
   * has already closed optimistically. The error is surfaced by the controller (in the glossary
   * pane, its original home), so this lets it propagate.
   */
  async function saveDescription(entry: GlossaryEntry, text: string): Promise<void> {
    const result = await lsp.setDoc(entry.id, text);
    if (!result.edits.length) return;
    if (result.uri && result.uri !== workspace.activeUri() && workspace.buffers.has(result.uri)) workspace.activateFile(result.uri);
    editor.applyEdits(result.edits);
  }

  // Rename the selected element from the Properties panel, reusing the LSP rename refactor (the same
  // seam the editor's F2 uses): resolve the workspace edit at the element's name position, then apply it.
  // The position is aimed one char INTO the name, not at its start: the language service's token locator
  // treats a cursor on a token's start offset as belonging to the preceding token (its match window is
  // `(start, end]`), so passing nameRange.start verbatim resolved nothing and the rename was a silent
  // no-op. A rename that resolves to no edits is surfaced (not swallowed), so the user gets feedback.
  async function renameElement(element: InspectorElement, newName: string): Promise<void> {
    const start = element.nameRange.start;
    try {
      const edit = await lsp.rename(start.line, start.character + 1, newName);
      if (!edit?.changes || Object.keys(edit.changes).length === 0) {
        setStatus('Rename rejected', 'error');
        return;
      }
      workspace.applyWorkspaceEdit(edit);
      // Re-anchor the selection to the renamed element's new identity (#537). Selection is keyed by
      // qualified name; applyWorkspaceEdit rebuilds the model under the NEW name but leaves the stored
      // selection on the OLD one — so the Properties panel's lookup misses (empty "Select an element…"
      // state) and the breadcrumb shows the stale name. The rename already validated (non-empty changes
      // ⇒ a renameable symbol + a valid identifier), so the new qualified name is deterministic. `element`
      // carries the identity (canonical qn + context + old name) needed to match a selection in either
      // key form. The set is idempotent and the Properties panel + breadcrumb both subscribe to the
      // selection slice, so they follow it (the panel repopulates once the model index rebuilds on
      // onDocEdited's refresh).
      const current = appStore.getState().selection;
      const reanchored = reanchorSelectionAfterRename(current, element, newName);
      if (reanchored !== current) selection.set(reanchored);
      // Flag it when the co-rename of an aggregate root's convention-linked <Root>Id identity (#550) was
      // ambiguous / the new Id name collided and the id was left behind; nothing to show otherwise.
      const idWarning = renameStatusMessage(element, newName, edit);
      if (idWarning) setStatus(idWarning, 'error');
    } catch (e) {
      setStatus('Rename failed: ' + String(e), 'error');
    }
  }

  // Persist the selected element's description from the Properties panel, reusing the glossary's setDoc
  // seam (writes a `///` doc comment). The applied edit fires onChange → the surfaces refresh.
  async function saveInspectorDescription(element: InspectorElement, text: string): Promise<void> {
    try {
      const result = await lsp.setDoc(element.id, text);
      if (!result.edits.length) return;
      if (result.uri && result.uri !== workspace.activeUri() && workspace.buffers.has(result.uri)) workspace.activateFile(result.uri);
      editor.applyEdits(result.edits);
    } catch (e) {
      setStatus('Saving description failed: ' + String(e), 'error');
    }
  }

  // Jump-to-source for a RAW 1-based source span: the shared core of diagram-node navigation (issue #93)
  // and the bottom-panel tables' row click (issue #144). Opens the owning file if it isn't an open buffer
  // yet (the span's `file` is the same `file://` uri buffers are keyed by, so folder-mode is usually
  // "already open"), then moves the caret. No-ops on a missing file or a malformed/zero span rather than
  // jumping somewhere bogus — both call sites are read-only navigation.
  async function gotoSourceSpan(
    span: Pick<SourceSpan, 'file' | 'line' | 'column' | 'endLine' | 'endColumn'>,
  ): Promise<void> {
    const uri = span.file;
    if (!uri) return;
    if (!(span.line >= 1 && span.column >= 1 && span.endLine >= 1 && span.endColumn >= 1)) return;

    if (!workspace.buffers.has(uri)) {
      const token = fileUriToPath(uri);
      if (token == null) return;
      const opened = await workspace.ensureBuffer(token);
      if (opened == null || opened !== uri) return;
    }

    // Convert the RAW 1-based span to a 0-based LSP Location (start.character = column - 1, end likewise).
    const location: Location = {
      uri,
      range: {
        start: { line: span.line - 1, character: span.column - 1 },
        end: { line: span.endLine - 1, character: span.endColumn - 1 },
      },
    };
    navigateToDefinition(location);
  }

  // The author attributed to a review comment opened from Studio: the configured Settings "Display name"
  // (#479), resolved through resolveReviewAuthor so a blank/unset name falls back to the shared 'You'.
  function reviewAuthorName(): string {
    return resolveReviewAuthor(loadSettings().displayName);
  }

  // Check… — pick a baseline folder and diff the current buffer against it. Owned by the controller
  // (it surfaces in the Code tab's Compatibility sub-view). Chrome v2 (#923) dropped the top-bar Check
  // button; it is triggered solely through the `check` command (palette / mobile overflow) now.

  // Boot the center chrome into the restored mode + label the Generated sub-tab (no fetch — the boot
  // flow's refreshActiveSurfaces loads everything once the workspace document is open).
  controller.init();

  // --- open folder (directory-mode workspace) -------------------------------

  const openFolderBtn = domById<HTMLButtonElement>('btn-open-folder');
  openFolderBtn.addEventListener('click', () => void openFolder());
  // Opening a folder relies on the File System Access API (Chromium-only). On browsers without it, the
  // button would look active but only ever raise an error toast — so disable it with an explanatory
  // tooltip rather than leaving a dead control. (Examples + share links + in-memory editing still work.)
  if (!platform.canOpenFolders) {
    openFolderBtn.disabled = true;
    openFolderBtn.title = 'Opening a folder needs a Chromium-based browser (try Chrome or Edge)';
  }

  async function openFolder(): Promise<void> {
    if (!platform.canOpenFolders) {
      setStatus('opening a folder needs a Chromium-based browser', 'error');
      return;
    }
    let folder: string | null;
    try {
      folder = await platform.pickFolder('Open a folder of .koi models');
    } catch (e) {
      setStatus('could not open folder picker', 'error');
      console.error('Open folder dialog failed:', e);
      return;
    }
    if (!folder) return; // cancelled
    await workspace.openFolderPath(folder, { userInitiated: true });
  }

  // ADDITIVE multi-root open (the explorer's "Add folder" affordance): pick a folder and union its
  // .koi files into the current workspace as a new root WITHOUT closing the open buffers — mirrors
  // openFolder's guard/picker/try-catch, but calls addRoot instead of openFolderPath.
  async function addRootViaPicker(): Promise<void> {
    if (!platform.canOpenFolders) {
      setStatus('opening a folder needs a Chromium-based browser', 'error');
      return;
    }
    let folder: string | null;
    try {
      folder = await platform.pickFolder('Add a folder to the workspace');
    } catch (e) {
      setStatus('could not open folder picker', 'error');
      console.error('Add folder dialog failed:', e);
      return;
    }
    if (!folder) return; // cancelled
    const result = await workspace.addRoot(folder);
    // Only re-sync the folder-derived views + scoped behaviors when the root set actually changed; an
    // unreadable/empty pick (or an already-open root) leaves the workspace untouched.
    if (result.ok) onRootSetChanged();
  }

  // The workspace lifecycle (buffers + open/save/dirty + file mutations, src/workspaceController.ts,
  // Task 5). It OWNS buffers/activeUri/folderRootToken/entriesCache and reaches back into the editor /
  // LSP / explorer / status / diagnostics-cache through these deps, while its own effects surface
  // through the onActiveChanged / onBuffersChanged seams below — so it imports neither editorSession
  // nor the inspector controller (no circular import), and they read its state through the thunks set
  // up above. Constructed AFTER both so its onFolderOpened / onActiveChanged callbacks can drive them.
  workspace = createWorkspaceController({
    platform,
    lsp,
    editor,
    explorer,
    setStatus,
    // Non-clobbering notification for a user-initiated open of an empty folder (#817): flash the
    // message transiently then restore the status back to the current diagnostics so the healthy
    // compiled status is not permanently overwritten (unlike the global red setStatus path).
    notify: (text) => {
      setStatus(text, 'error');
      setTimeout(() => editorSession.updateStatus(editorSession.diagnosticsFor(workspace.activeUri())), 2000);
    },
    // The workspace slice is the single owner of buffers/activeUri/roots (#982); the controller reads +
    // writes it through this store handle, so the UnsavedIndicator/StoreInspector repaint inherently.
    store: appStore,
    showDiagnostics: (uri) => editorSession.showDiagnostics(uri),
    invalidateDocViews: () => controller.invalidateDocViews(),
    // Keep the diag-count gate in step with the diagnostics slice: a file that reopens with the same
    // counts after a clear/drop/rename must still re-badge, so forget its remembered counts here.
    dropDiagnostics: (uri) => {
      editorSession.dropDiagnostics(uri);
      diagCountGate.forget(uri);
    },
    renameDiagnostics: (oldUri, newUri) => {
      editorSession.renameDiagnostics(oldUri, newUri);
      diagCountGate.forget(oldUri);
    },
    clearDiagnostics: () => {
      editorSession.clearDiagnostics();
      diagCountGate.reset();
    },
    getFormatOnSave: () => effectiveSettings(settings, wsKey()).formatOnSave,
    // A folder finished opening: restore this workspace's bounded-context scope (#146) BEFORE the
    // first scoped render and refresh the switcher's options from the new model. The bus value drives
    // the render paths, so the initial ensureLoaded is already scoped even before the dropdown
    // finishes repainting. The Docs surface is folder-derived, so a folder switch must drop it too.
    onFolderOpened: () => {
      // openFolderPath already published the new roots into the slice (setRoots derives folderRootToken,
      // so the folder-derived <DocsPanelHost> reloaded — the #174 contract). This just restores the
      // bounded-context scope and refreshes the doc surfaces.
      controller.restoreActiveContext();
      controller.invalidateDocViews();
      controller.invalidateDocsPanel();
      void controller.refreshContextList();
      controller.refreshActiveSurfaces();
      // Switching folders changes wsKey(), so re-apply the now-effective workspace-scoped behaviors:
      // this folder's overrides for word-wrap, preview target, and LSP trace take effect immediately.
      // (format-on-save reads through the live getFormatOnSave thunk, so it auto-picks up.)
      applyEffectiveScoped(effectiveSettings(settings, wsKey()));
      // Hydrate this folder's review threads from `.koine/reviews.json` (a no-op in no-folder mode),
      // then repaint the editor marks. Fires on boot too — openDefaultWorkspaceFlow routes through here.
      void reviewStore.load().then(() => editorSession.refreshReviewDecorations());
    },
    // The active buffer was deleted and the workspace is now empty: reset to a fresh blank model.
    onWorkspaceEmptied: () => void newModel(),
    pushRecentFolder,
    // Remember the opened workspace so a reload restores it instead of the empty default (#535). Gated
    // (in the controller) on the same `recent` flag as pushRecentFolder, so transient opens don't set it.
    rememberLastWorkspace: setLastWorkspace,
    setFolderTitle: (name) => {
      treeTitleEl.textContent = name;
    },
  });
  // Arm idle auto-save from the persisted setting so it's live at boot (the prefs onChange re-applies
  // it on every toggle); a no-op until an edit calls scheduleAutoSave above.
  workspace.setAutoSave(settings.autoSave);
  // The workspace-level undo/redo timeline (code = the single source of truth). It snapshots the open
  // buffers' text; restore writes code back and onRestored re-derives every view. canUndo/canRedo are
  // published into the store for the <HistoryControls> buttons.
  const history = createHistoryController({
    buffers: () => workspace.buffers,
    activeUri: () => workspace.activeUri(),
    editor: { getDoc: () => editor.getDoc(), setDoc: (d) => editor.setDoc(d) },
    lsp: { syncDoc: (uri, text) => lsp.syncDoc(uri, text) },
    activateFile: (uri) => workspace.activateFile(uri),
    onRestored: () => {
      controller.onDocEdited();
      workspace.renderTree();
    },
    publish: (s) => appStore.getState().setHistoryState(s),
  });
  // The top-bar Undo/Redo buttons (reactive enable/disable via the store).
  render(
    <HistoryControls
      store={appStore}
      onUndo={() => commandWiring.run('undo')}
      onRedo={() => commandWiring.run('redo')}
      undoTitle={`Undo (${formatChord('mod+Z')})`}
      redoTitle={`Redo (${formatChord('mod+Shift+Z')})`}
    />,
    domById('history-controls-host'),
  );

  // The top-bar emit-target selector (#923), wired by its own module so init() stays thin (#757).
  createEmitTargetControl({
    store: appStore,
    host: domById('emit-target-host'),
    wsKey,
    getSettings: () => settings,
    setSettings: (s) => void (settings = s),
    applyEffectiveScoped,
  });

  // The status-bar reactive wiring (#923): the docs-coverage ring + emit echo panels, the Problems-tab
  // click, and the git-branch segment. Extracted to keep init() thin (#757).
  const statusBar = createStatusBar({
    store: appStore,
    platform,
    folderRootToken: () => workspace.folderRootToken(),
    onOpenProblems: () => controller.selectBottomTab('problems'),
  });

  // The workspace-slice seams (#982): the controller signals transitions by bumping the slice's seq
  // fields (activationSeq/workspaceEditSeq/entriesSeq/saveSeq) at the points the old on* callbacks fired;
  // subscribe ONCE and run the matching body when one advances. Each action bumps AT MOST ONE seq per
  // set(), so ≤1 body runs per change and the branch order below is not significant. The activation body
  // reads activeUri from the SAME snapshot; folder open / delete-fallback move the pointer without
  // bumpActivation, so it doesn't run for them. The unsubscribe is captured + disposed in teardown (#980).
  const unsubWorkspaceSeams = appStore.subscribe((s, prev) => {
    if (s.entriesSeq !== prev.entriesSeq) history.reset(); // folder open / structural op re-read the tree
    if (s.activationSeq !== prev.activationSeq) {
      const uri = s.activeUri; // a file switch: repaint diagnostics, refresh doc views, follow context
      editorSession.showDiagnostics(uri);
      controller.invalidateDocViews();
      workspace.renderTree();
      void controller.followActiveFileContext();
    }
    if (s.workspaceEditSeq !== prev.workspaceEditSeq) {
      controller.onDocEdited(); // a cross-file WorkspaceEdit: reload the model-derived surfaces
      history.noteEdit({ immediate: true });
    }
    if (s.saveSeq !== prev.saveSeq) controller.refreshSourceControl(); // a save hit disk (#470)
  });

  // Dismiss the diagram Export ▾ disclosure on an outside-click or when any overlay opens, so the
  // native <details> menu can't linger above a modal scrim (#534). Teardown runs on IDE unmount.
  const teardownExportMenuDismiss = installExportMenuDismiss();

  // --- save (format + write to disk) ----------------------------------------
  // The editor intercepts Cmd/Ctrl-S and calls onFormat; we additionally write the formatted
  // active buffer to disk. To run AFTER the format edits land, save is also wired here on the
  // window so it can read the post-format editor text. The editor's own format keymap already
  // ran preventDefault, so this listener only persists. The save/dirty machinery lives in workspace.
  //
  // Named (not anonymous) so disposeEditorKeys() can removeEventListener them — anonymous functions
  // have no stable identity and cannot be removed from window. (#789)
  const onSaveKey = (e: KeyboardEvent): void => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    if (overlays.overlayOpen()) return; // don't act on the editor under an open overlay
    // Mod+Alt+S → Save all. Match on e.code (the physical S key): on macOS, Option composes e.key
    // into another glyph (e.g. 'ß'), so `e.key === 's'` would miss the chord.
    if (e.altKey && e.code === 'KeyS') {
      // Save-all dispatches through the command registry by id (#758); Save-active (below) has no command
      // catalog entry, so it stays a direct call.
      e.preventDefault();
      commandWiring.run('save-all');
    } else if (!e.altKey && (e.key === 's' || e.key === 'S')) {
      // Mod+S → save / format the active buffer (unchanged single-file behaviour).
      e.preventDefault();
      void workspace.saveActive();
    }
  };
  window.addEventListener('keydown', onSaveKey);

  // Undo/redo drive the single workspace history (CodeMirror's own history was removed). Match on
  // e.code (physical Z/Y) so macOS Option-composed glyphs don't slip past. These chords stay a direct
  // history call — like every global chord other than Cmd-K and Save-all, they are folded through the
  // command registry wholesale by #432 (the HistoryControls *buttons* already dispatch run('undo'/'redo'),
  // so today the chord and button reach the same effect since undo/redo carry no when() gate).
  //
  // Named for the same removability reason as onSaveKey above. (#789)
  const onHistoryKey = (e: KeyboardEvent): void => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    if (overlays.overlayOpen()) return;
    if (e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) history.redo();
      else history.undo();
    } else if (e.code === 'KeyY' && !e.shiftKey) {
      e.preventDefault();
      history.redo();
    }
  };
  window.addEventListener('keydown', onHistoryKey);

  // Guard against closing/reloading with unsaved work: when any open buffer is dirty, the browser
  // shows its native "Leave site?" prompt. Dirty buffers live only in memory, so without this a tab
  // close silently drops them. On the desktop host this covers reloads; the window-close confirm is
  // wired separately in the Tauri host.
  window.addEventListener('beforeunload', (e) => handleBeforeUnload(e, () => workspace.anyDirty()));

  // Stop the brokered shell when the page genuinely goes away (#256). `pagehide` (not the cancellable
  // `beforeunload`) is used so aborting a close doesn't kill a live terminal; the desktop PTY also
  // gets SIGHUP when the process exits, but this disposes cleanly on a webview reload too.
  window.addEventListener('pagehide', () => panelHost.disposeTerminal());

  // --- new model ----------------------------------------------------
  // Reset the default workspace to a single untouched BLANK model: empty it on disk, recreate
  // model.koi, close every open doc, and reopen. The raw reset with no confirmation; user-initiated
  // New goes through overlays.requestNewModel() (overlays.ts), which guards unsaved work first.
  async function newModel(): Promise<void> {
    const token = await platform.defaultWorkspace(BLANK);
    if (!token) {
      setStatus("couldn't initialize a workspace", 'error');
      return;
    }
    try {
      for (const entry of await platform.listEntries(token)) await platform.deleteEntry(entry.token);
      await platform.createFile(token, 'model.koi', BLANK);
    } catch (e) {
      console.error('resetting the default workspace failed:', e);
      setStatus('could not reset the workspace', 'error');
    }
    // Tear down the old buffers + diagnostics unconditionally BEFORE re-opening: openFolderPath only
    // clears once it's past its empty/unreadable-folder guards, so if the reset above deleted every
    // file but failed to re-create model.koi, the open would early-return and leave stale state.
    workspace.reset();
    // openFolderPath then activates model.koi (= BLANK) and renders the tree.
    await workspace.openFolderPath(token, { recent: false });
    // The user deliberately went back to a blank default, so repoint lastWorkspace at the default
    // (#535): without this, a reload would reopen the example they just left behind. `token` is the
    // host's reserved '(default)' token.
    setLastWorkspace(token);
  }

  // --- overlays + polish surfaces -------------------------------------------

  // Open a starter template as a real workspace: multi-file templates materialize all their files; a
  // single-source template materializes a 1-file workspace. Both reuse the folder-mode path.
  async function openExample(template: Template): Promise<void> {
    const files = template.files?.length
      ? template.files
      : [{ relPath: 'model.koi', contents: template.source }];
    // persist:true — keep the example's OPFS workspace across reloads so edits aren't silently lost;
    // re-opening the same example reuses it (seeded only on first open).
    const token = await platform.materializeWorkspace(template.id, files, true);
    if (!token) {
      setStatus('could not open template', 'error');
      return;
    }
    // recent:true — record the example in Recents so it shows on the Start screen and is one click to
    // re-open, AND (via the controller's rememberLastWorkspace) mark it the last workspace so a reload
    // restores it rather than silently reverting to the empty default (#535). The example token is an
    // OPFS-internal `example-<id>`, which the cold-boot ladder is allowed to auto-restore.
    await workspace.openFolderPath(token, { recent: true });
  }

  // Return to the Home route (#368): Home and the editor are distinct routes now, so "back to start"
  // navigates rather than popping an overlay over the editor. The boot switch (main.ts) swaps #app out
  // and mounts the Home view; the editor stays initialised behind it for an instant return. Wired to
  // the brand logo and the palette.
  function goHome(): void {
    appStore.getState().navigate('home');
  }

  // Open a folder from the Recent list (reached via the Home open-recent start-intent, #368),
  // recovering gracefully when it's gone. Recovery now lives on the Home route (#391): on any failure
  // the IDE reports it to the boot layer rather than painting an overlay over the editor — the boot
  // layer returns to Home (never stranding the user) and, for a vanished folder/handle, offers to
  // forget the entry there.
  async function openRecentFolder(path: string): Promise<void> {
    const result = await workspace.openFolderPath(path, { userInitiated: true });
    if (result.ok) {
      hooks.onOpenRecentSucceeded?.(path);
      return;
    }
    hooks.onOpenRecentFailed?.(path, result.reason);
  }

  // Workspace search (Mod-Shift-F): a non-modal panel that scans every .koi file in the open folder
  // via the pure search core. The shell supplies the four seams the panel can't own — list the files,
  // read a closed file, reveal a match in the editor, snapshot the open buffers — plus a label fn.
  function searchLabelForUri(uri: string): string {
    const buf = workspace.buffers.get(uri);
    if (buf) return buf.relPath;
    const token = fileUriToPath(uri) ?? uri;
    const root = workspace.folderRootToken();
    if (root && (token.startsWith(root + '/') || token.startsWith(root + '\\'))) {
      return token.slice(root.length + 1).replace(/\\/g, '/');
    }
    return basename(token);
  }
  async function revealSearchMatch(uri: string, match: Match): Promise<void> {
    // Make the matched file the active buffer (opening it from disk if it isn't open yet), then select
    // the match's range. gotoRange wants 0-based LSP positions; Match is 1-based line / 0-based column.
    if (uri !== workspace.activeUri()) {
      if (workspace.buffers.has(uri)) {
        workspace.activateFile(uri);
      } else {
        const token = fileUriToPath(uri);
        if (token) await workspace.openFileToken(token);
      }
    }
    // Derive the END position from the active document so a match that spans lines (a regex with
    // `\n` / `[\s\S]`) selects the whole span rather than clamping to the start line. CodeMirror's
    // doc lines are 1-based; offsets are clamped against the doc in case a stale match runs long.
    const doc = editor.view.state.doc;
    const startLine = Math.min(Math.max(match.line, 1), doc.lines);
    const startOffset = Math.min(doc.line(startLine).from + match.column, doc.length);
    const endOffset = Math.min(startOffset + match.length, doc.length);
    const startInfo = doc.lineAt(startOffset);
    const endInfo = doc.lineAt(endOffset);
    editor.gotoRange(
      { line: startInfo.number - 1, character: startOffset - startInfo.from },
      { line: endInfo.number - 1, character: endOffset - endInfo.from },
    );
  }
  const search = createSearchPanel({
    listFiles: (glob) => workspace.listWorkspaceFiles(glob),
    readFile: async (uri) => {
      const token = fileUriToPath(uri);
      if (!token) return null;
      try {
        return await platform.readTextFile(token);
      } catch {
        return null;
      }
    },
    openAndReveal: (uri, match) => void revealSearchMatch(uri, match),
    getActiveBuffers: () => {
      const m = new Map<string, string>();
      for (const buf of workspace.buffers.values()) m.set(buf.uri, buf.text);
      return m;
    },
    labelOf: searchLabelForUri,
    replaceInBuffer: (uri, newText) => {
      // Route the new text through the cross-buffer WorkspaceEdit path: the active buffer goes through
      // the editor (one undoable transaction), other open buffers are patched + marked dirty + synced,
      // so the unsaved indicator updates. A single whole-document edit over the buffer's current text.
      const current = workspace.buffers.get(uri)?.text ?? '';
      const lines = current.split('\n');
      const edit: TextEdit = {
        range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines[lines.length - 1].length } },
        newText,
      };
      workspace.applyWorkspaceEdit({ changes: { [uri]: [edit] } });
    },
    writeFile: async (uri, newText) => {
      const token = fileUriToPath(uri);
      if (!token) return;
      // Surface a failed replace-to-disk on the status line, mirroring the other write paths — a
      // silent failure would let the user believe every match was replaced when some were not.
      try {
        await platform.writeTextFile(token, newText);
      } catch (e) {
        setStatus('could not write replaced file', 'error');
        console.error('replace writeTextFile failed for', token, e);
      }
    },
  });

  // The single PrefsCallbacks object, shared by BOTH the (legacy) Settings modal and the gear-launched
  // Settings center page (createSettingsPage), so a change applied from either surface runs the exact
  // same live-apply path.
  const prefsCallbacks: PrefsCallbacks = {
    onChange: (s) => {
      // `s` is the USER/global settings (prefs keeps the global value untouched when a row is scoped to
      // Workspace), so it stays the user-level source of truth here.
      settings = s;
      // The workspace-scoped fields (wordWrap, previewTarget) must apply from the EFFECTIVE view so a
      // Workspace override drives the live behavior even though `settings` stays user-level.
      const eff = effectiveSettings(s, wsKey());
      // onChange is the single re-skin path: apply the document-level appearance, then sync the
      // pieces prefs can't reach — soft-wrap on both the source editor and the output preview.
      applyAppearance(s);
      editor.setMinimap(s.enableMinimap);
      editor.setTabSize(s.tabSize);
      workspace.setAutoSave(s.autoSave);
      // Keep the diagram renderer's default zoom in lockstep with the setting (#762); applies to the
      // NEXT freshly-opened canvas (a live canvas keeps its current zoom until re-rendered).
      setDefaultCanvasZoom(s.defaultCanvasZoom);
      // The scoped fields (word-wrap on both surfaces + the Generated-tab relabel via the preview
      // target) apply from the EFFECTIVE view so a Workspace override drives live behavior.
      applyEffectiveScoped(eff);
    },
    // Desktop hosts launch a `koine mcp --http` sidecar and return its loopback URL; the browser
    // returns null, so Settings hides the MCP affordance there.
    mcpEndpoint: () => platform.mcpEndpoint(),
    mcpStop: () => platform.mcpStop(),
    // Only a host that can serve the sidecar exposes the toggle; others show recipes but disable it.
    mcpHostable: platform.canHostMcp,
    // Terminal shell args row: only shown where the integrated terminal exists (Tauri desktop).
    hasIntegratedTerminal: platform.canRunShell,
    // Workspace root: only the browser (File System Access API) can save projects to a root dir.
    canSaveProjects: platform.canSaveProjects,
    workspaceRootName: () => platform.workspaceRootName(),
    pickWorkspaceRoot: () => platform.pickWorkspaceRoot(),
    // The current workspace's override key (null when no folder is open) — drives the per-row
    // User/Workspace scope toggle and routes scoped commits to the workspace override store.
    workspaceKey: () => wsKey(),
    // Live-apply a keybinding remap from Settings → Keyboard: reconfigure the editor's keymap
    // compartment in place.
    onKeybindingsChanged: () => {
      editor.reconfigureKeybindings();
    },
  };

  // The modal-overlay surface — confirm/prompt dialogs, the shortcuts help overlay, the overlay-open
  // gate, the unsaved-work New guard, and the memory-only banner — lives in the overlays controller now
  // (#757). It reaches the workspace's dirty check + blank-model reset through these two deps.
  const overlays = createOverlays({
    anyDirty: () => workspace.anyDirty(),
    newModel: () => newModel(),
  });

  // Desktop window-close guard (Tauri only): mirror the web beforeunload — confirm before closing
  // the window when any buffer is dirty. The browser host omits onCloseRequested (its beforeunload
  // guard already covers tab close / reload), so this is a no-op there.
  void platform.onCloseRequested?.(async () => {
    if (!workspace.anyDirty()) return true;
    return overlays.confirm.ask({
      title: 'Close Koine Studio?',
      message: `Files with unsaved changes will lose them. Save with ${formatChord('mod+Alt+S')} first to keep them.`,
      confirmLabel: 'Close & discard',
      danger: true,
    });
  });
  // The lazy-panel host — the Settings center page, the AI assistant, the scenario runner, the
  // integrated terminal, and the Review panel — lives in panelHost now (#757). Each is built on first
  // ensure*/openSettings and reused; nothing here loads until the user opens it. The host reaches the
  // editor / workspace / inspector controller / LSP / review store through these deps. The assistant's
  // selection + source readers stay here as thunks (they peek into the live CodeMirror view).
  const panelHost = createPanelHost({
    prefsCallbacks,
    settingsCategory: () => appStore.getState().settingsCategory ?? undefined,
    showSettings: (category) => controller.showSettings(category),
    closeSettings: () => appStore.getState().closeSettings(),
    getSource: () => editor.getDoc(),
    getSelection: () => {
      const sel = editor.view.state.selection.main;
      if (!sel.empty) return { text: editor.view.state.sliceDoc(sel.from, sel.to) };
      // No selection: fall back to the (non-blank) line under the cursor; null → panel uses whole file.
      const line = editor.view.state.doc.lineAt(sel.head);
      return line.text.trim() ? { text: line.text } : null;
    },
    applyModel: replaceActiveDoc,
    diagnosticsFor: (uri) => editorSession.diagnosticsFor(uri),
    workspace,
    getCachedDomainIndex: () => controller.getCachedDomainIndex(),
    lsp,
    platform,
    reviewStore,
    gotoSourceSpan: (span) => void gotoSourceSpan(span),
    reviewAuthorName: () => reviewAuthorName(),
  });

  // The diagram-authoring + canvas write-path — the #91 model→.koi round-trip (node rename/delete,
  // connect/disconnect, add type/member), the empty-canvas concept seeder, canvas annotations, the
  // in-editor review-comment composer, and the mobile-zone switcher — lives in the canvasWrite controller
  // now (#757). It binds the DIAGRAM_* gesture listeners on #center-visual and renders the mobile zone bar;
  // ide.tsx reaches its add-construct / annotate / review-comment entry points through the handle below.
  const canvasWrite = createCanvasWrite({
    editor,
    workspace,
    lsp,
    controller,
    setStatus,
    prompt: overlays.prompt,
    confirm: overlays.confirm,
    reviewStore,
    refreshReviewDecorations: () => editorSession.refreshReviewDecorations(),
    reviewAuthorName: () => reviewAuthorName(),
    gotoSourceSpan: (span) => gotoSourceSpan(span),
    splitEl,
    defaultCanvasZoom: settings.defaultCanvasZoom,
    blank: BLANK,
  });

  // Diagrams are rendered with a theme-matched Mermaid palette; re-render on a theme flip (covers
  // the toolbar toggle, the command palette, and Preferences — all route through setTheme). The
  // controller owns the diagram cache + center state, so it decides whether to re-render now. The
  // integrated terminal (#751) paints from concrete xterm colours that can't read var(), so re-resolve
  // its theme here too — ide.tsx owns the panel handle and this fan-out (the same way it drives fit()).
  const unsubscribeTheme = appStore.subscribe((s, prev) => {
    if (s.theme !== prev.theme) { controller.onThemeChanged(); panelHost.applyTerminalTheme(); }
  });

  // The export / share / save-to-disk surface — shareable link, .koi source zip, live-diagram export +
  // Mermaid copy, Save-to-disk, the Generate Project wizard, and shared-workspace import — lives in the
  // exportShare controller now (#757). It reaches the host / workspace / editor / status pill through
  // these deps; the post-flash status-pill refresh (#271) is wrapped as a single thunk.
  const exportShare = createExportShare({
    platform,
    lsp,
    workspace,
    editor,
    setStatus,
    refreshStatusFromDiagnostics: () =>
      editorSession.updateStatus(editorSession.diagnosticsFor(workspace.activeUri())),
    promptDialog: overlays.prompt,
  });

  // Esc-to-dismiss the Settings overlay (#746). Registered AFTER panelHost so it can call
  // panelHost.closeSettings() which restores focus to the opener. Only active while Settings is open,
  // so it cannot interfere with other Esc semantics (palette, modals). The handler runs independently
  // of overlayOpen() — the mod-key listeners are the ones gated on it.
  //
  // Named for the same removability reason as onSaveKey / onHistoryKey above. (#789)
  const onSettingsEscKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    if (!appStore.getState().settingsOpen) return;
    panelHost.closeSettings();
  };
  window.addEventListener('keydown', onSettingsEscKey);

  // Paired disposer for all three named keydown listeners above. Folded into lifecycleBoot's
  // disposers so the aggregate teardown leaves no ide.tsx-owned global keydown listener attached
  // to window. (#789)
  const disposeEditorKeys = (): void => {
    window.removeEventListener('keydown', onSaveKey);
    window.removeEventListener('keydown', onHistoryKey);
    window.removeEventListener('keydown', onSettingsEscKey);
  };

  // --- view layout: editor split + repositionable panels (issue #265) -------
  // The #split data-* mirror, the inspector + left-rail edge resizers (and their live re-wiring on a
  // side-rail flip), the left-sidebar section disclosure, the file-tree (⌘B) toggle, and the layout
  // palette actions all live in the layout controller now (#757). View-only state, persisted via
  // layoutStore — it NEVER round-trips into the .koi model.
  const layoutController = createLayoutController({
    splitEl,
    setAxis: (axis) => controller.setAxis(axis),
    toggleRightCollapsed: () => appStore.getState().toggleRightCollapsed(),
    toggleLeftCollapsed: () => appStore.getState().toggleLeftCollapsed(),
  });
  const layoutActions = layoutController.actions;

  // The bottom panel (resizer + collapse toggle + Problems / Events / Relationships / Context Map tabs
  // and their lazy loaders, issue #144) lives in the inspector controller now — it's wired there from
  // controller.init()'s construction. The diagnostics strip content (#diag-body / #diag-count) is still
  // owned by editorSession; the controller only toggles which bottom panel is visible.

  // Format the active document via the LSP (shared by the palette command); a response landing after
  // a file switch or fresh keystrokes is discarded instead of garbling the newer doc (formatActive.ts).
  const formatActive = createFormatActive({
    format: () => lsp.format(),
    getDoc: () => editor.getDoc(),
    applyEdits: (edits) => editor.applyEdits(edits),
    activeUri: () => workspace.activeUri(),
  });

  // The command surface — the palette, the command list (getCommands), the toolbar command buttons
  // (Home / New / Generate / Save-to-disk / Theme / Settings + the mobile overflow ⋮), and the global
  // keyboard shortcuts — lives in commandWiring now (#757). It reaches the rest of the shell through this
  // typed deps bag of thunks; init() constructs it here, once everything it dispatches to exists. The
  // Cmd/Ctrl-S save + undo/redo keydown listeners stay below — they persist edits, not commands.
  const commandWiring = createCommandWiring({
    history,
    format: () => void formatActive(),
    goHome,
    openFolder: () => void openFolder(),
    search,
    requestNewModel: () => void overlays.requestNewModel(),
    workspace: { saveAllDirty: () => void workspace.saveAllDirty(), buffers: () => workspace.buffers },
    copyShareLink: () => void exportShare.copyShareLink(),
    controller,
    generateProject: exportShare.generateProject,
    exportSourceZip: () => void exportShare.exportSourceZip(),
    exportActiveDiagram: (format) => void exportShare.exportActiveDiagram(format),
    copyActiveDiagramMermaid: () => void exportShare.copyActiveDiagramMermaid(),
    saveProjectToDisk: () => void exportShare.saveProjectToDisk(),
    canSaveProjects: platform.canSaveProjects,
    layoutActions,
    openSettings: panelHost.openSettings,
    openHelp: () => overlays.openHelp(),
    toggleHelp: () => overlays.toggleHelp(),
    toggleStoreInspector: () => void toggleStoreInspector(),
    ensureAssistant: panelHost.ensureAssistant,
    editor,
    openUri,
    overlayOpen: () => overlays.overlayOpen(),
    toggleFileTree: () => layoutController.toggleFileTree(),
    // Spotlight launcher seams (#1143): the joined model index, the host git surface, and the
    // open-file-and-reveal navigation the per-result quick actions dispatch to.
    modelIndex: () => controller.ensureModelIndex(),
    canUseGit: platform.canUseGit,
    gitLog: () => (platform.canUseGit ? platform.gitLog(workspace.folderRootToken()) : null),
    revealLocation: (uri, range) => void revealLocation(uri, range),
  });

  // The boot sequence (the lsp.start ladder + emit-target seed + the shared/single/restored/default
  // workspace open), the route-intent subscription, and the aggregate teardown live in the lifecycleBoot
  // controller now (#757). Newing it up RUNS the boot ladder; init() returns its teardown — so init() is
  // now a thin composition root: construct deps → new up controllers → return the aggregate teardown.
  const lifecycleBoot = createLifecycleBoot({
    lsp: {
      onServerRestart: (cb) => lsp.onServerRestart(cb),
      start: () => lsp.start(),
      emitTargets: () => lsp.emitTargets(),
    },
    shared,
    legacyScratch,
    seed: SEED,
    importSharedWorkspace: (files, active) => exportShare.importSharedWorkspace(files, active),
    openWorkspaceWith1File: (text) => workspace.openWorkspaceWith1File(text),
    openFolderPath: (folder, opts) => workspace.openFolderPath(folder, opts),
    isAutoRestorableToken: (token) => platform.isAutoRestorableToken(token),
    hasOpenWorkspace: () => workspace.rootsList().length > 0 || workspace.buffers.size > 0,
    confirmReplaceWork: (title, label) => overlays.confirmReplaceWork(title, label),
    openHostDefaultWorkspaceFlow: (seed) => workspace.openDefaultWorkspaceFlow(seed),
    setStatus,
    setOutput: (content, lang) => output.setContent(content, lang),
    invalidateDocViews: () => controller.invalidateDocViews(),
    refreshActiveSurfaces: () => controller.refreshActiveSurfaces(),
    persistsWorkspace: platform.persistsWorkspace,
    showMemoryOnlyBanner: () => overlays.showMemoryOnlyBanner(),
    newModel: () => newModel(),
    openFolder: () => openFolder(),
    openRecentFolder: (path) => openRecentFolder(path),
    openExample: (template) => openExample(template),
    disposers: {
      controller: () => controller.dispose(),
      editorSession: () => editorSession.destroy(),
      commandWiring: () => commandWiring.dispose(),
      layout: () => layoutController.dispose(),
      overlays: () => overlays.dispose(),
      canvasWrite: () => canvasWrite.dispose(),
      panels: () => panelHost.dispose(),
      reviewStoreSub: () => unsubReviewStore(),
      workspaceSeams: () => unsubWorkspaceSeams(),
      theme: () => unsubscribeTheme(),
      autoSave: () => workspace.setAutoSave(false),
      exportMenuDismiss: () => teardownExportMenuDismiss(),
      editorKeys: () => disposeEditorKeys(),
      statusBar: () => statusBar.dispose(),
      explorer: () => explorer.dispose(),
    },
  });

  // The host's teardown: production (main.ts) runs for the page lifetime and ignores it; the test suite
  // calls it between boots so pending debounce timers can't fire into a torn-down happy-dom.
  return () => lifecycleBoot.teardown();
}
