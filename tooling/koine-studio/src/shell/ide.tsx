// Koine Studio app composition: wires the .koi editor, the live LSP diagnostics,
// the status line, the diagnostics strip, and the tabbed inspector (emitted preview,
// glossary, and context map).
import { createOutputView } from '@/editor/editor';
import {
  KoineLsp,
  type GlossaryEntry,
  type Location,
  type SourceSpan,
  type StructuredEdit,
  type TextEdit,
} from '@/lsp/lsp';
import {
  fileUriToPath,
  helpRows,
  isSafeShareRelPath,
  pathToFileUri,
} from '@/shell/ideUtils';
import { createEditorSession } from '@/shell/editorSession';
import { createInspectorController } from '@/shell/inspectorController';
import { leftRailMarkup } from '@/shell/leftRail';
import { openInspectorSheet } from '@/shell/inspectorSheet';
import { getPlatform } from '@/host';
import { createExplorer } from '@/shell/explorer';
import { koineMark } from '@/shared/logo';
import { setEmitTargets } from '@/shared/emitTargets';
import { initTheme, onThemeChange, toggleTheme } from '@/settings/theme';
import {
  peekLegacyScratch,
  clearLegacyScratch,
  effectiveSettings,
  initSecrets,
  loadActiveContext,
  loadSettings,
  loadWorkspaceCenter,
  pushRecentFolder,
  removeRecentFolder,
  saveActiveContext,
  saveWorkspaceCenter,
  setLastWorkspace,
  getLastWorkspace,
  workspaceKeyOf,
  type Settings,
} from '@/settings/persistence';
import { createWelcome } from '@/welcome/welcome';
import { takeStartIntent, type StartIntent } from '@/shell/bootIntent';
import { type Template } from '@/welcome/templates';
import { createCommandPalette, type Command } from '@/shared/palette';
import { layoutCommands, type LayoutActions } from '@/shell/layoutCommands';
import { loadLayout, saveLayout, type LayoutState } from '@/shell/layoutStore';
import { devCommands } from '@/shell/devCommands';
import { canStopCompile, stopRunawayCompile } from '@/host/browser/stopCompile';
import { createPreferences } from '@/settings/prefs';
import { applyAppearance } from '@/settings/appearance';
import { initEdgeResizer, initGroupResizer } from '@/shell/resize';
import { createHelpOverlay } from '@/shared/help';
import { createGenerateProject } from '@/export/generateProjectWizard';
import { sanitizeProjectName } from '@/export/generateProject';
import { buildSourceZip } from '@/export/sourceZip';
import { exportDiagram } from '@/export/diagramExport';
import { getActiveDomainExport } from '@/diagrams/diagrams';
import { formatChord } from '@/shared/platform';
import {
  DIAGRAM_ANNOTATION_CREATE_EVENT,
  DIAGRAM_CONNECT_EVENT,
  DIAGRAM_DISCONNECT_EVENT,
  DIAGRAM_REFIT_EVENT,
  DIAGRAM_RELAYOUT_EVENT,
  EMPTY_STATE_PICK_EVENT,
  NODE_EDIT_EVENT,
  NODE_NAVIGATE_EVENT,
  setDiagramEditing,
  setDiagramTouchMode,
  type AddNodeKind,
  type AggregateMemberKind,
  type CanvasAnnotationKind,
  type DiagramAnnotationCreateDetail,
  type DiagramConnectDetail,
  type DiagramDisconnectDetail,
  type DiagramNodeEditDetail,
  type DiagramNodeNavigateDetail,
  type EmptyConceptKind,
  type EmptyStatePickDetail,
} from '@/diagrams/diagramContract';
import { isAllContexts } from '@/model/activeContext';
import { appStore } from '@/store/index';
import { badgeCounts, createDiagCountGate } from '@/diagnostics/diagCountGate';
import { severityErrorOrWarning } from '@/lsp/severity';
import { reanchorSelectionAfterRename, type SelectedElement } from '@/model/selection';
import { resolveInspectableQn } from '@/model/modelIndex';
import { type InspectorElement } from '@/model/inspector';
import { createAssistantPanel, type AssistantPanel, type AssistantContext } from '@/ai/aiPanel';
import { createScenarioPanel, type ScenarioPanel } from '@/scenarios/scenarioPanel';
import { createTerminalPanel, type TerminalPanel } from '@/shell/terminal/terminalPanel';
import { createReviewStore } from '@/review/reviewStore';
import { createReviewPanel, REVIEW_AUTHOR_FALLBACK, type ReviewPanel } from '@/review/ReviewPanel';
import { clearModelHash, readModelFromHash, workspaceShareUrlOrNull } from '@/export/share';
import { handleBeforeUnload } from '@/shell/dirty';
import { render } from 'preact';
import { createHistoryController } from '@/shell/historyController';
import { installExportMenuDismiss } from '@/shell/exportMenuDismiss';
import { HistoryControls } from '@/shell/HistoryControls';
import { MobileZoneBar } from '@/shell/MobileZoneBar';
import { type MobileZone } from '@/store/slices/uiChrome';
import { isNarrowViewport } from '@/shared/breakpoint';
import { buildOverflowItems, toggleOverflowMenu } from '@/shell/toolbarOverflow';
import { UnsavedIndicator } from '@/shell/UnsavedIndicator';
import { WorkspaceProblemsBadge } from '@/diagnostics/WorkspaceProblemsBadge';
import { createWorkspaceController, type WorkspaceController } from '@/shell/workspaceController';
import { createSearchPanel } from '@/shell/searchController';
import { type Match } from '@/shell/workspaceSearch';
import { createConfirmDialog, createPromptDialog } from '@/shared/overlay';

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
// An empty-bodied context is valid Koine (the same shape `koine init` and the LSP tests use).
const BLANK = `context NewModel {

  // Describe your bounded context here — add value objects, entities, and aggregates.

}
`;

// The host's reserved default-workspace token (mirrors host/browser/fs.ts DEFAULT_WS_TOKEN). Parentheses
// can't appear in a real picked-folder name, so it never collides. Used as the lastWorkspace pointer
// after "New" / a default-workspace open (#535).
const DEFAULT_WS_TOKEN = '(default)';

// Which workspace tokens the cold-boot ladder is allowed to silently re-open (#535). OPFS-backed dirs —
// the default workspace and every materialized `example-*` dir — re-acquire from IndexedDB with NO
// permission prompt, so boot can restore them. A *picked* folder handle needs a `requestPermission`
// re-grant that requires a user gesture boot can't supply, so it must stay a manual Recents click.
function isOpfsInternalToken(token: string): boolean {
  return token === DEFAULT_WS_TOKEN || token.startsWith('example-');
}

// Starter shapes the empty-canvas doorways seed (the EMPTY_STATE_PICK_EVENT contract). Each is a strict
// subset of a validated template (templates/starters/{ordering,contextmap}) so it always compiles green;
// seeding one into a fresh model lights up the canvas immediately. A trailing comment points at the next
// edit so the modeller knows the starter is theirs to grow.
const CONCEPT_STARTER: Record<EmptyConceptKind, string> = {
  aggregate: `context Ordering {

  aggregate Sales root Order {

    value OrderLine {
      product:   ProductId
      quantity:  Int
      unitPrice: Decimal
      subtotal:  Decimal = unitPrice * quantity
    }

    entity Order identified by OrderId {
      lines: List<OrderLine>
      // Add the fields, invariants, and behaviours your Order needs.
    }
  }
}
`,
  stateMachine: `context Ordering {

  aggregate Sales root Order {

    enum OrderStatus { Draft, Placed, Shipped, Cancelled }

    entity Order identified by OrderId {
      status: OrderStatus = Draft

      states status {
        Draft  -> Placed
        Placed -> Shipped
        Placed -> Cancelled
        // Add the transitions your lifecycle allows.
      }
    }
  }
}
`,
  contextMap: `context Catalog {
  entity Product identified by ProductId {
    sku:  String
    name: String
  }
}

context Sales {
  value OrderRef {
    value: String
  }
}

contextmap {
  Catalog -> Sales : conformist
  // Map each upstream context onto the downstream ones that depend on it.
}
`,
};

/** Status-bar confirmation shown after a doorway seeds its starter. */
const CONCEPT_SEEDED_MSG: Record<EmptyConceptKind, string> = {
  aggregate: 'Added a starter aggregate — edit it in Code or on the canvas',
  stateMachine: 'Added a starter state machine — edit it in Code or on the canvas',
  contextMap: 'Added a starter context map — edit it in Code or on the canvas',
};

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

export function init(): () => void {
  // The host backend: the Tauri desktop shell, or a plain browser (compiler via WASM, files via
  // the File System Access API). Everything host-specific — the LSP transport, folder/file I/O,
  // dialogs, the app version — goes through this.
  const platform = getPlatform();

  // Decrypt the assistant API key into store.ts's in-memory cache (and migrate any legacy plaintext
  // key out of localStorage). Fire-and-forget: nothing at boot needs the key synchronously — the
  // assistant reads it lazily per request, long after this resolves.
  void initSecrets();

  // Render the header monogram from the shared template ('h' = a stable gradient id) so the welcome,
  // about, and header marks all flow from logo.ts and can't drift apart on the next tweak.
  const brandLogo = document.querySelector('.brand-logo');
  if (brandLogo) brandLogo.innerHTML = koineMark('h');

  // Apply the persisted theme + appearance (accent, reduced motion, editor metrics) before
  // CodeMirror is created so the editor picks up the right tokens / size on first paint.
  initTheme();
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
  const output = createOutputView(el('view-preview'), settings.wordWrap);

  const statusEl = el('status');
  const diagBodyEl = el('diag-body');
  const diagCountEl = el('diag-count');

  // Bottom status-bar fields — a pure projection of existing state (no new data sources). #status stays
  // in the toolbar; #sb-connection mirrors its kind here. #sb-validity by the diagnostics strip, and
  // #sb-version once at boot from the build-time define. (#sb-context is written by the inspector
  // controller's bounded-context switcher.)
  const sbConnEl = el('sb-connection');
  const sbValidityEl = el('sb-validity');
  el('sb-version').textContent = `v${__APP_VERSION__}`;

  // Global unsaved-work surfacing: the document title gains a `•` and a clickable "N unsaved" pill
  // appears beside the status whenever any open buffer is dirty. baseTitle is captured once, clean.
  // The pill is now the <UnsavedIndicator> Preact panel (#193) bound to the existing static button: it
  // subscribes to the workspace slice's dirty count, sets the button's text/hidden/aria-label + the
  // title bullet, and wires Save-all. So `refreshDirtyIndicator` here just projects the controller's
  // live buffers Map into the slice on every dirty transition (edit, save, save-all, rename, swap) —
  // the panel re-renders off the slice. (The button stays index.html's element, so the controller's
  // `el(...)` lookups and the test's getElementById are untouched.)
  const baseTitle = document.title;
  const unsavedEl = el('unsaved-indicator') as HTMLButtonElement;
  // <UnsavedIndicator> renders no tree of its own (it governs the static button via effects), so it
  // mounts into a throwaway holder rather than the button — keeping the reconciler off the button node.
  const unsavedHost = document.createElement('div');
  render(
    <UnsavedIndicator
      store={appStore}
      host={unsavedEl}
      baseTitle={baseTitle}
      onSaveAll={() => void workspace.saveAllDirty()}
    />,
    unsavedHost,
  );
  function refreshDirtyIndicator(): void {
    appStore.getState().setBuffers(Object.fromEntries(workspace.buffers));
    appStore.getState().setActiveUri(workspace.activeUri());
  }

  // Workspace-wide problems rollup beside #sb-validity (which is active-file only): a status-bar badge
  // summarising every file's diagnostics, hidden while the workspace is clean. Subscribes to the
  // diagnostics slice, so the LSP publish path keeps it current with no extra wiring.
  render(<WorkspaceProblemsBadge store={appStore} />, el('sb-problems-host'));

  // The top-bar "scope path" breadcrumb (the bounded-context selector + the selected element) is owned by
  // the inspector controller — it holds the contexts list + model index the breadcrumb needs, and routes
  // a scope pick through its persist-and-repaint choke point. It renders into #breadcrumb-host from init().

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
  }

  // Adding or removing a workspace root changes the workspace identity: folderRootToken() may now point
  // at a different primary folder and wsKey() hashes a different root set, so every folder-derived view
  // and every workspace-scoped behavior must re-sync — exactly like a folder open, minus restoreActive-
  // Context (an additive root change keeps the user's current bounded-context scope rather than resetting
  // it). Without this, removing the primary root strands the Docs/layout/diagram stores on the dead key
  // (#174) and a per-workspace word-wrap/preview-target override goes stale until an unrelated event.
  function onRootSetChanged(): void {
    appStore.getState().setFolderRootToken(workspace.folderRootToken());
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
    parent: el('editor-pane'),
    // The second editor group (group B) mounts here when the user splits the editor; docFor reads a
    // uri's live text from the shared buffer set so opening a file in B shows the same content group A
    // would. Both are wired through the layout commands + boot below (Task 4 / issue #265).
    groupBParent: el('editor-pane-b'),
    docFor: (uri) => workspace.buffers.get(uri)?.text ?? '',
    doc: initialDoc,
    lineWrap: settings.wordWrap,
    minimap: settings.enableMinimap,
    lsp,
    status: statusEl,
    diagCount: diagCountEl,
    diagBody: diagBodyEl,
    sbConnection: sbConnEl,
    sbValidity: sbValidityEl,
    activeUri: () => workspace.activeUri(),
    uriLabel: (uri) => workspace.buffers.get(uri)?.relPath ?? (uri.split('/').pop() ?? uri),
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
    onAddComment: (span) => addReviewComment(span),
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
  // original effect order: welcome.hide → buffer text+dirty → onDocEdited → renderTree (only when that
  // file's dirty dot just appeared). The active-file-only side effects (recompile via onDocEdited,
  // history.noteEdit) are gated on `uri === activeUri()`: they are group-A/active-file concerns and a
  // background B edit must not drive the active file's recompile or undo history.
  editorSession.onChange((doc, uri) => {
    // First edit dismisses the welcome overlay (shown only on a pristine first-run workspace). Both
    // groups dismiss it.
    if (welcome.visible) welcome.hide();
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

  // The left rail's inner markup is owned by leftRail.ts (single source of truth, #453); index.html keeps
  // <aside id="leftrail"> a thin shell. Inject it here — synchronously, before any rail el(...) lookup or
  // the inspector controller below — so #filetree-body / #rail-domain-pane / the doclinks all resolve.
  el<HTMLElement>('leftrail').innerHTML = leftRailMarkup();

  const treeBodyEl = el<HTMLElement>('filetree-body');
  const treeTitleEl = el<HTMLElement>('filetree-title');
  const filesSect = el<HTMLElement>('rail-files');
  const splitEl = el<HTMLElement>('split');

  // Open/collapse a left-sidebar section, keeping its header's aria-expanded in step. The single
  // source of truth for section state.
  function setRailSectionOpen(sect: HTMLElement, open: boolean): void {
    sect.dataset.open = open ? 'true' : 'false';
    sect.querySelector('.rail-sect-head')?.setAttribute('aria-expanded', String(open));
  }

  // Since #453 the rail's AXIS (Domain vs Files) is the single source of truth for the file tree's
  // visibility — `controller.setAxis` owns + persists it (RAIL_AXIS_KEY) and `applyAxis` toggles the
  // Files pane. So opening a folder/workspace surfaces the Files axis (matching the "Reveal in Files"
  // path), rather than poking `dataset.open` on a pane the default Domain axis keeps hidden.
  function showFileTreeChrome(): void {
    controller.setAxis('files');
  }
  function toggleFileTree(): void {
    // ⌘B shows/hides "the file tree", which since #453 lives on the rail's Files axis — so this toggles
    // the Domain↔Files axis (the controller owns + persists the axis, and re-expands the Files section
    // when it surfaces). When the Files pane is hidden the Domain view holds the rail, so ⌘B reveals it.
    controller.setAxis(filesSect.hidden ? 'files' : 'domain');
  }

  // The workspace file explorer. It deals in opaque fs tokens; ide.ts maps token ↔ file:// uri
  // (pathToFileUri) to keep `buffers`, `activeUri` and the LSP workspace coherent on every mutation.
  const explorer = createExplorer({
    onOpenFile: (token) => void openFileInFocusedGroup(token),
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

  // Route a USER-INITIATED "open this file" affordance (a file-tree click, a Go-to-File palette pick)
  // to whichever editor group has focus. Group A is primary: when it is focused this is the normal
  // openFileToken/activateFile path that changes workspace.activeUri(). When group B is focused the
  // file loads into B as a SECONDARY view — group A's active file AND workspace.activeUri() stay
  // untouched. The buffer is ensured open first (#265) so editorSession.docFor and the LSP have its
  // text before B reads it. Only these UI affordances honour focus; programmatic navigations
  // (navigateToDefinition above, diagram/inspector jumps) deliberately bypass this and always target
  // group A via workspace.activateFile. Takes an fs token (what the explorer hands us).
  async function openFileInFocusedGroup(token: string): Promise<void> {
    if (editorSession.focusedGroup() === 'b' && editorSession.groupBEditor()) {
      const uri = await workspace.ensureBuffer(token);
      if (uri) {
        editorSession.openFocusedGroup(uri);
        persistGroupBUri(uri); // remember B's new file so reload restores it (#265)
      }
      return;
    }
    await workspace.openFileToken(token);
  }

  // The uri-keyed twin of openFileInFocusedGroup for affordances that already hold an open buffer's
  // uri (the Go-to-File palette iterates workspace.buffers, so the buffer is already loaded — no
  // ensureBuffer needed). Same focus contract: B when focused+open, else the group-A activateFile path.
  function openUriInFocusedGroup(uri: string): void {
    if (editorSession.focusedGroup() === 'b' && editorSession.groupBEditor()) {
      editorSession.openFocusedGroup(uri);
      persistGroupBUri(uri); // remember B's new file so reload restores it (#265)
    } else {
      workspace.activateFile(uri);
    }
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
    saveActiveContext,
    loadActiveContext,
    setStatus,
    onRenameElement: (element, newName) => void renameElement(element, newName),
    onSaveElementDescription: (element, text) => void saveInspectorDescription(element, text),
    onSaveGlossaryDescription: (entry, text) => saveDescription(entry, text),
    onApplyStructuredEdit: (edit, successMsg) => void applyStructuredEdit(edit, successMsg),
    onAddConstruct: (kind) => void applyDiagramAddType({ kind }),
    onAddAnnotation: (kind) => createCanvasAnnotation(kind),
    onAddAggregateMember: (kind, aggregateQn) => void applyDiagramAddAggregateMember(kind, aggregateQn),
    onExportDiagram: (format) => void exportActiveDiagram(format),
    onCopyDiagramMermaid: () => void copyActiveDiagramMermaid(),
    gotoSourceSpan: (span) => void gotoSourceSpan(span),
    // Cross-axis "Reveal in Files" (#453): the tactical leaf already switched the rail to the Files axis
    // (setAxis) before this fires, so we just point the explorer at the context's `.koi`.
    revealInFiles: (context) => explorer.revealByContext(context),
    ensureAssistant: () => ensureAssistant(),
    ensureScenarios: () => ensureScenarios(),
    ensureTerminal: () => ensureTerminal(),
    ensureReview: () => ensureReview(),
    initEdgeResizer,
  });
  // Thin shims over the app store (the single source of truth) for the two state reads ide.ts needs:
  // the diagram write-path sets the selection, and the add-type path reads the active scope.
  const selection = {
    set: (element: SelectedElement | null) => appStore.getState().setSelection(element),
  };
  const activeContext = {
    get: () => appStore.getState().activeContext,
  };
  // The diagram canvas host — the controller renders into it, but ide.ts owns the authoring gesture
  // listeners (the diagram write-path stays here), which are bound to this node below.
  const diagramsView = el('center-visual');

  // --- diagram-authoring + inspector write path (the #91 round-trip) --------
  // These perform the actual `.koi` mutations (rename / structured edit / set-description) and span
  // navigation. They stay in ide.ts because they reach the buffers / workspace edit path; the
  // controller triggers them via the injected callbacks above and re-renders in step on success.

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
      setStatus(`Renamed ${element.name} → ${newName}`, 'green');
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

  // The author attributed to a review comment opened from Studio. No Settings display-name field exists
  // yet (#259 Phase 1) → the shared fallback; a Phase-2 follow-up can feed a real name from Settings here.
  function reviewAuthorName(): string {
    return REVIEW_AUTHOR_FALLBACK;
  }

  // Open a review thread on the editor's current selection (#259). editorSession already pinned `span.file`
  // to the INVOKING group's uri (so a split view comments on the right file, not just group A's active
  // one); we just prompt for the comment text. The window.prompt is a deliberate Phase-1 MVP affordance —
  // a richer inline composer is a fine Phase-2 follow-up. An empty/cancelled prompt bails; otherwise we add
  // the thread, reveal the Review tab, and repaint the editor marks.
  function addReviewComment(span: SourceSpan): void {
    const file = span.file ?? workspace.activeUri();
    if (!file) return;
    const text = window.prompt('Add a review comment:')?.trim();
    if (!text) return;
    reviewStore.add(file, { ...span, file }, text, reviewAuthorName());
    controller.selectBottomTab('review');
    editorSession.refreshReviewDecorations();
  }

  // Jump-to-source from a diagram node: the SVG renderer draws each navigable node as a `<g>` that
  // dispatches a bubbling NODE_NAVIGATE_EVENT carrying its RAW 1-based source span; one delegated
  // listener on the diagrams container (below) routes it here.
  async function navigateToDiagramNode(detail: DiagramNodeNavigateDetail): Promise<void> {
    await gotoSourceSpan(detail);
  }

  diagramsView.addEventListener(NODE_NAVIGATE_EVENT, (e) => {
    const detail = (e as CustomEvent<DiagramNodeNavigateDetail>).detail;
    if (!detail) return;
    void selectFromDiagram(detail);
    // On a phone the Properties rail is a bottom sheet (#221, Task 2): a node TAP raises it to half, so
    // tapping a node doubles as "open this node's editor". Gated on $bp-narrow — desktop keeps its fixed
    // rail (and openInspectorSheet would otherwise pop the hidden sheet over the page).
    if (isNarrowViewport()) openInspectorSheet('half');
  });

  // Drag-to-edit (issue #93, Task 5): a diagram node gesture (double-click = rename, right-click =
  // delete) round-trips through the model→.koi seam (#91). Enabled now that the seam exists; the
  // renderer keeps the gestures inert until this flips the switch, so the read-only tab is unchanged.
  setDiagramEditing(true);
  // Touch (tap-to-edit) presentation for the canvas (#221, Task 3): below $bp-narrow, freehand gestures
  // (drag-move/connect, double-click-rename, right-click-delete) are swapped for tap-to-navigate + drag-to-
  // pan so a phone drives the canvas by tapping. INDEPENDENT of the editing flag above — the mobile shell
  // stays editing-capable (the palette + auto-arrange still author). Set from the initial viewport, then
  // re-evaluated only when the breakpoint is actually crossed, re-rendering the canvas so the renderer
  // re-wires its gestures for the new mode.
  setDiagramTouchMode(isNarrowViewport());
  let diagramWasNarrow = isNarrowViewport();
  // Named so the init() teardown can removeEventListener it — otherwise this listener (and its closed-over
  // controller) outlives the IDE and a breakpoint cross would call loadDiagrams() on a torn-down controller.
  const onDiagramViewportResize = (): void => {
    const narrow = isNarrowViewport();
    if (narrow === diagramWasNarrow) return; // act on a CROSS only — not on every resize tick
    diagramWasNarrow = narrow;
    setDiagramTouchMode(narrow);
    void controller.loadDiagrams(); // rebuild the canvas with the now-correct gesture wiring
  };
  window.addEventListener('resize', onDiagramViewportResize);
  diagramsView.addEventListener(NODE_EDIT_EVENT, (e) => {
    const detail = (e as CustomEvent<DiagramNodeEditDetail>).detail;
    if (detail) void applyDiagramEdit(detail);
  });

  // Auto-arrange (authoring): the canvas cleared its saved positions; re-render so ELK lays it out fresh.
  diagramsView.addEventListener(DIAGRAM_RELAYOUT_EVENT, () => {
    void controller.loadDiagrams();
  });

  // Connect / disconnect (authoring): drawing or removing a relationship round-trips into `.koi`.
  diagramsView.addEventListener(DIAGRAM_CONNECT_EVENT, (e) => {
    const detail = (e as CustomEvent<DiagramConnectDetail>).detail;
    if (detail) void applyDiagramConnect(detail);
  });
  diagramsView.addEventListener(DIAGRAM_DISCONNECT_EVENT, (e) => {
    const detail = (e as CustomEvent<DiagramDisconnectDetail>).detail;
    if (detail) void applyDiagramDisconnect(detail);
  });
  // Empty-canvas doorway: seed a validated starter for the picked concept. Non-destructive — an untouched
  // BLANK seed is replaced outright (the common first-run case), otherwise the starter is appended so no
  // existing work is lost. The buffer edit fires onDocEdited → the canvas re-renders with real nodes.
  diagramsView.addEventListener(EMPTY_STATE_PICK_EVENT, (e) => {
    const detail = (e as CustomEvent<EmptyStatePickDetail>).detail;
    if (detail) seedConcept(detail.kind);
  });

  function seedConcept(kind: EmptyConceptKind): void {
    const starter = CONCEPT_STARTER[kind];
    const current = editor.getDoc();
    const pristine = current.trim() === '' || current.trim() === BLANK.trim();
    editor.setDoc(pristine ? starter : `${current.replace(/\s+$/, '')}\n\n${starter}`);
    setStatus(CONCEPT_SEEDED_MSG[kind], 'green');
  }

  // Map a node gesture to a StructuredEdit, apply it through #91's round-trip, and patch the buffer.
  // An edit that would break the model comes back as a KOIxxxx diagnostic (and no edits): surface it
  // and roll back (nothing is applied), exactly as the spec requires.
  async function applyDiagramEdit(detail: DiagramNodeEditDetail): Promise<void> {
    if (detail.action === 'delete') {
      // Deleting a node removes the whole type declaration (round-trips through removeType).
      await applyStructuredEdit({ kind: 'removeType', target: detail.qualifiedName }, `Deleted ${detail.label}`);
      return;
    }
    // Renaming a TYPE is a workspace-wide rename (every reference moves), so it uses the editor's
    // cross-file rename at the declaration's name position rather than a span-local member edit.
    if (detail.newName && detail.line != null && detail.column != null) {
      await renameTypeAt(detail.line - 1, detail.column - 1, detail.newName, detail.label);
    }
  }

  // Cross-file rename of the symbol at a 0-based position (the diagram-node rename gesture).
  async function renameTypeAt(line: number, character: number, newName: string, label: string): Promise<void> {
    let edit;
    try {
      edit = await lsp.rename(line, character, newName);
    } catch {
      setStatus('Rename failed', 'error');
      return;
    }
    if (!edit?.changes || Object.keys(edit.changes).length === 0) {
      setStatus('Rename rejected', 'error');
      return;
    }
    workspace.applyWorkspaceEdit(edit);
    setStatus(`Renamed ${label} → ${newName}`, 'green');
  }

  // The shared write path for every canvas authoring gesture: apply a StructuredEdit through #91's
  // round-trip, patch the buffer on success (which fires onDocEdited → the diagram AND the inspector
  // re-render in step), or surface the rejecting KOIxxxx and roll back. Returns whether it applied.
  async function applyStructuredEdit(edit: StructuredEdit, successMsg: string): Promise<boolean> {
    let result;
    try {
      result = await lsp.applyModelEdit(edit);
    } catch {
      setStatus('Diagram edit failed', 'error');
      return false;
    }
    if (result.diagnostics.length > 0 || result.uri == null || result.edits.length === 0) {
      const reason = result.diagnostics[0];
      setStatus(reason ? `${reason.code}: ${reason.message}` : 'Edit rejected', 'error');
      return false; // rolled back — nothing is patched
    }
    workspace.applyWorkspaceEdit({ changes: { [result.uri]: result.edits } });
    setStatus(successMsg, 'green');
    return true;
  }

  // Drawing a relationship on the canvas = adding a field on the source typed as the target. The default
  // field name is the target's lower-cased simple name; the user can refine it (or cancel).
  async function applyDiagramConnect(detail: DiagramConnectDetail): Promise<void> {
    const targetSimple = detail.targetQualifiedName.slice(detail.targetQualifiedName.lastIndexOf('.') + 1);
    const suggested = targetSimple.charAt(0).toLowerCase() + targetSimple.slice(1);
    const fieldName = await promptDialog.ask({
      title: 'Add field',
      message: `On ${detail.sourceLabel}, referencing ${detail.targetLabel}.`,
      label: 'Field name',
      initialValue: suggested,
      mono: true,
      confirmLabel: 'Add field',
    });
    if (!fieldName) return;
    await applyStructuredEdit(
      { kind: 'addField', target: detail.sourceQualifiedName, name: fieldName, type: targetSimple },
      `Added ${fieldName}: ${targetSimple} to ${detail.sourceLabel}`,
    );
  }

  // Removing a relationship = removing the field that backs it.
  async function applyDiagramDisconnect(detail: DiagramDisconnectDetail): Promise<void> {
    const ok = await confirmDialog.ask({
      title: `Remove ${detail.label}?`,
      message: 'This rewrites the .koi source.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    await applyStructuredEdit({ kind: 'removeMember', target: detail.backingMember }, `Removed ${detail.label}`);
  }

  // Adding a node = inserting a new construct skeleton into the active context (addType). The canvas
  // doesn't know the contexts, so the target is the active scope; the kind comes from the palette button
  // (defaulting to value) and the user names the type.
  const ADD_DEFAULT_NAME: Record<AddNodeKind, string> = {
    value: 'NewValue',
    entity: 'NewEntity',
    aggregate: 'NewAggregate',
    event: 'NewEvent',
    enum: 'NewEnum',
    service: 'NewService',
  };

  // Canvas-only annotations (#255): a note/group is a VIEW concern (persisted in koine.layout.json, never
  // `.koi`), so creation is delegated to the renderer — the holder of the live graph + current selection —
  // via a document event. The renderer prompts for the text/label, places the cell behind the nodes, and
  // persists it. No model edit and no LSP round-trip, unlike applyDiagramAddType below.
  function createCanvasAnnotation(kind: CanvasAnnotationKind): void {
    document.dispatchEvent(
      new CustomEvent<DiagramAnnotationCreateDetail>(DIAGRAM_ANNOTATION_CREATE_EVENT, { detail: { kind } }),
    );
  }

  async function applyDiagramAddType(detail?: { kind: AddNodeKind }): Promise<void> {
    let scope = activeContext.get();
    if (isAllContexts(scope)) {
      // "All contexts" has no unambiguous home — except when the model has exactly one context, which is
      // then the only possible target (the palette enables its buttons to match). 2+ contexts still need
      // a deliberate pick.
      const all = appStore.getState().contexts;
      if (all.length !== 1) {
        setStatus('Pick a bounded context (top-left) before adding a type', 'error');
        return;
      }
      scope = all[0];
    }
    const kind = detail?.kind ?? 'value';
    const name = await promptDialog.ask({
      title: `New ${kind}`,
      message: `In ${scope}.`,
      label: 'Name',
      initialValue: ADD_DEFAULT_NAME[kind],
      mono: true,
      confirmLabel: 'Create',
    });
    if (!name) return;
    // The AddNodeKind string IS the construct keyword the server's TryAddType switches on (StructuredEdit.Type).
    await applyStructuredEdit({ kind: 'addType', target: scope, name, type: kind }, `Added ${name} to ${scope}`);
  }

  // Insert a construct that lives INSIDE an aggregate (#254). Unlike applyDiagramAddType, the target is the
  // SELECTED aggregate's qualified name (the palette gates these buttons on an aggregate selection), and the
  // edit is `addAggregateMember`. A rule (an aggregate-scoped `spec`) is named; a repository is anonymous,
  // so it inserts directly. The Type string IS the member keyword the server's TryAddAggregateMember switches on.
  async function applyDiagramAddAggregateMember(kind: AggregateMemberKind, aggregateQn: string): Promise<void> {
    const aggregateName = aggregateQn.split('.').pop() ?? aggregateQn;
    if (kind === 'rule') {
      const name = await promptDialog.ask({
        title: 'New rule',
        message: `An aggregate-scoped specification over ${aggregateName}.`,
        label: 'Name',
        initialValue: 'NewRule',
        mono: true,
        confirmLabel: 'Create',
      });
      if (!name) return;
      await applyStructuredEdit(
        { kind: 'addAggregateMember', target: aggregateQn, name, type: 'rule' },
        `Added rule ${name} to ${aggregateName}`,
      );
      return;
    }
    await applyStructuredEdit(
      { kind: 'addAggregateMember', target: aggregateQn, type: 'repository' },
      `Added a repository to ${aggregateName}`,
    );
  }

  // Clicking a diagram node both jumps to its declaration AND selects it, so the element inspector
  // (#142) populates from the same gesture. A diagram node is named `context.simpleName`; map it back
  // to the canonical glossary qualified name (the selection key) through the index when it's reachable.
  async function selectFromDiagram(detail: DiagramNodeNavigateDetail): Promise<void> {
    const index = await controller.ensureModelIndex().catch(() => null);
    // Resolve the clicked node to the nearest INSPECTABLE element so the Properties panel actually
    // populates: aggregate/value-object/event nodes resolve directly; a state box (Context.Aggregate.State)
    // walks up to its owning aggregate; a bare context node resolves to nothing. Previously this set the
    // selection to the node's raw qualified name, which the inspector couldn't resolve for state/context
    // nodes — so clicking them left the panel blank. Without an index yet, fall back to the raw qn.
    const qualifiedName = index ? resolveInspectableQn(index, detail.qualifiedName) : detail.qualifiedName;
    if (qualifiedName) selection.set({ qualifiedName, context: qualifiedName.split('.')[0] });
    await navigateToDiagramNode(detail);
  }

  // Check… — pick a baseline folder and diff the current buffer against it. Owned by the controller
  // (it surfaces in the Code tab's Compatibility sub-view); the button + palette just trigger it.
  el<HTMLButtonElement>('btn-check').addEventListener('click', () => void controller.runCheck());

  // Boot the center chrome into the restored mode + label the Generated sub-tab (no fetch — the boot
  // flow's refreshActiveSurfaces loads everything once the workspace document is open).
  controller.init();

  // --- open folder (directory-mode workspace) -------------------------------

  const openFolderBtn = el<HTMLButtonElement>('btn-open-folder');
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
    await workspace.openFolderPath(folder);
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
    refreshDirtyIndicator,
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
      // Publish the new folder token into the workspace slice so the folder-derived <DocsPanelHost>
      // reloads (it subscribes ONLY to folderRootToken, never to model edits — the #174 contract).
      appStore.getState().setFolderRootToken(workspace.folderRootToken());
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
    showFileTreeChrome,
    hideWelcome: () => welcome.hide(),
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
  // Reset history whenever the explorer tree is re-read: a folder open (fresh baseline) or any
  // structural file op (rename/move/delete/create) whose snapshots would reference stale uris.
  workspace.onEntriesRefreshed(() => history.reset());
  // The top-bar Undo/Redo buttons (reactive enable/disable via the store).
  render(
    <HistoryControls
      store={appStore}
      onUndo={() => history.undo()}
      onRedo={() => history.redo()}
      undoTitle={`Undo (${formatChord('mod+Z')})`}
      redoTitle={`Redo (${formatChord('mod+Shift+Z')})`}
    />,
    el('history-controls-host'),
  );

  // The bottom mobile zone switcher (#220): a tablist shown only below $bp-narrow that picks which of
  // the four zones (Files / Code / Diagram / Props) fills the single-column phone shell. Selecting a
  // zone writes the store; Code/Diagram additionally flip the center tab (both live in #center, so the
  // center tab decides which surface shows). The active zone is mirrored onto #split[data-mobile-zone]
  // so the @media rules can show/hide zones without remounting any DOM.
  function selectMobileZone(zone: MobileZone): void {
    // Props is a single inspector surface: the bottom SHEET (#221), an overlay — not a swapped-in #right
    // rail. Write the slice for EVERY zone (including 'props') so the tablist's aria-selected + roving
    // tabIndex reflect the active tab (the bug: returning before the write left Props un-selectable, and
    // arrow-key nav onto it opened the sheet without updating the tab). For 'props' we additionally raise
    // the sheet OVER the current zone; the data-mobile-zone MIRROR (below) keeps the underlying real zone
    // visible for 'props', so the single-column shell never switches to the empty #right rail. The other
    // three are real zones: writing the slice (plus, for code/diagram, the center tab) surfaces them.
    appStore.getState().setMobileZone(zone);
    if (zone === 'props') openInspectorSheet('half');
    else if (zone === 'diagram') {
      controller.selectCenter('visual');
      // The Diagram zone was hidden (display:none) until this reveal, so the canvas mounted at zero size:
      // `fit()` no-op'd and the Outline minimap read no geometry (#529). Ask the live canvas to re-fit and
      // rebuild its minimap on the NEXT frame, once the zone's CSS reveal has applied and the surface is
      // measurable. Dispatched on `document` (the renderer listens there) so it reaches whichever canvas is
      // mounted, without ide.tsx holding a handle to it.
      requestAnimationFrame(() => document.dispatchEvent(new Event(DIAGRAM_REFIT_EVENT)));
    } else if (zone === 'code') controller.selectCenter('technical');
  }
  render(<MobileZoneBar store={appStore} onSelect={selectMobileZone} />, el('mobile-zone-bar-host'));
  // Mirror the active zone onto #split[data-mobile-zone] so the @media rules show/hide the single-column
  // zone. 'props' is the exception: the inspector is a bottom-sheet OVERLAY, so selecting it must KEEP the
  // underlying real zone (Files/Code/Diagram) visible rather than reveal the empty #right rail — we only
  // mirror REAL zones, leaving the attribute on the last real zone beneath the sheet.
  function mirrorMobileZone(zone: MobileZone): void {
    if (zone !== 'props') splitEl.dataset.mobileZone = zone;
  }
  mirrorMobileZone(appStore.getState().mobileZone);
  // Mirror only when mobileZone actually changes — the listener fires on every store write, so guard
  // on prevState (the inspectorController idiom) to avoid rewriting the attribute on unrelated updates.
  appStore.subscribe((s, prev) => {
    if (s.mobileZone !== prev.mobileZone) mirrorMobileZone(s.mobileZone);
  });
  // On a narrow (phone) first paint, land on the default mobile zone's surface so the bottom bar's
  // active tab and the visible #center surface agree from the start — otherwise the bar highlights the
  // default 'code' zone while #center still shows the desktop-restored Visual surface until the first
  // tap. Gated on the narrow breakpoint (the JS mirror of $bp-narrow) so the desktop shell keeps its restored center.
  if (isNarrowViewport()) selectMobileZone(appStore.getState().mobileZone);
  // Switching files: repaint the active file's diagnostics, invalidate the doc views so they re-fetch,
  // and follow the new file's bounded context. Preserves the exact effect order of the old activateFile.
  workspace.onActiveChanged((uri) => {
    editorSession.showDiagnostics(uri);
    controller.invalidateDocViews();
    workspace.renderTree();
    void controller.followActiveFileContext();
  });
  // Fired after a WorkspaceEdit was applied across the open buffers (the old applyWorkspaceEdit tail).
  // The tree re-render for any patched non-active buffer already ran inside the workspace; ide.ts only
  // reloads the model-derived doc surfaces here, exactly as before (which is unconditional — the active
  // file's own edit path also reaches onDocEdited via the editor onChange).
  workspace.onBuffersChanged(() => {
    controller.onDocEdited();
    history.noteEdit({ immediate: true });
  });
  // A save wrote buffer(s) to disk: the on-disk git status just changed, so live-refresh the Source
  // Control panel when its tab is open (#470). A no-op otherwise — the next SC open re-fetches anyway.
  workspace.onSaved(() => controller.refreshSourceControl());

  // Boot/empty-state: open the host's persistent default workspace. The clearLegacyScratch + the
  // OPFS-error output line are ide-specific, so they wrap workspace.openDefaultWorkspaceFlow here.
  // NOTE: this no longer surfaces the welcome screen. Home is now a distinct route (#368) mounted by
  // the boot switch (main.ts) — the IDE only runs on the editor route, so a pristine boot lands on the
  // Home route and never paints the editor first. Showing the welcome overlay here is exactly the
  // async-gated, post-paint reveal that caused the IDE→Home flash, so it's gone.
  async function openDefaultWorkspaceFlow(seed: string): Promise<void> {
    const { opened } = await workspace.openDefaultWorkspaceFlow(seed);
    if (!opened) {
      // The browser now falls back to an in-memory workspace, so this only fires if even that failed
      // (or a host that genuinely can't back one). An honest message beats a blank editor.
      output.setContent('// Koine Studio could not open a workspace in this browser.', 'plain');
      return;
    }
    // The default workspace is now the open one, so point lastWorkspace at it (#535): a later reload
    // returns here rather than reopening a stale example the user has since left via "New". '(default)'
    // is OPFS-internal, so the boot ladder may auto-restore it.
    setLastWorkspace(DEFAULT_WS_TOKEN);
    // Token confirmed — the workspace is open. Clear the legacy scratch key now so the migration is
    // non-destructive: content was never lost even if OPFS was unavailable on a prior load.
    clearLegacyScratch();
    // No-OPFS browsers (Safari / Firefox Private) run on the in-memory fallback: the editor + compiler
    // work, but a reload loses everything. Warn once so the user exports their work rather than losing it.
    if (!platform.persistsWorkspace) showMemoryOnlyBanner();
  }

  // Perform the action the user chose on the Home route (#368), handed across via the start-intent.
  // These reuse the same action functions the in-editor start console wires, so a Home "Open folder"
  // behaves exactly like the editor's own — there's no second code path to keep in sync. No unsaved
  // work can exist at a fresh boot, so these skip the confirm-and-replace guard the in-editor versions
  // apply (newModel directly, not requestNewModel).
  async function runStartIntent(intent: StartIntent): Promise<void> {
    switch (intent.kind) {
      case 'new':
        await newModel();
        break;
      case 'open-folder':
        await openFolder();
        break;
      case 'open-recent':
        await openRecentFolder(intent.path);
        break;
      case 'open-example':
        await openExample(intent.template);
        break;
    }
  }

  // A one-time, dismissible top banner shown when the workspace is memory-only (no OPFS) — so work
  // that won't survive a reload is never lost silently. Points at the durable escape hatches.
  function showMemoryOnlyBanner(): void {
    if (document.getElementById('koi-memory-banner')) return;
    const bar = document.createElement('div');
    bar.id = 'koi-memory-banner';
    bar.className = 'koi-memory-banner';
    bar.setAttribute('role', 'status');
    const msg = document.createElement('span');
    msg.className = 'koi-memory-banner-msg';
    msg.textContent =
      'This browser can’t save to disk — your work lives only in this tab and is lost on reload. Use “Copy shareable link”, or open Studio in Chrome/Edge to keep it.';
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'koi-memory-banner-dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.textContent = '✕';
    dismiss.addEventListener('click', () => bar.remove());
    bar.append(msg, dismiss);
    document.getElementById('app')?.prepend(bar);
  }

  // True when the command palette or a modal dialog (prefs/help/about) is open, so global
  // shortcuts don't fire 'through' an overlay at the editor underneath. The welcome screen is
  // deliberately excluded — its own actions own that surface.
  function overlayOpen(): boolean {
    return document.querySelector('.koi-palette-backdrop:not([hidden]), .koi-modal-backdrop:not([hidden])') !== null;
  }

  // Dismiss the diagram Export ▾ disclosure on an outside-click or when any overlay opens, so the
  // native <details> menu can't linger above a modal scrim (#534). Teardown runs on IDE unmount.
  const teardownExportMenuDismiss = installExportMenuDismiss();

  // --- save (format + write to disk) ----------------------------------------
  // The editor intercepts Cmd/Ctrl-S and calls onFormat; we additionally write the formatted
  // active buffer to disk. To run AFTER the format edits land, save is also wired here on the
  // window so it can read the post-format editor text. The editor's own format keymap already
  // ran preventDefault, so this listener only persists. The save/dirty machinery lives in workspace.
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    if (overlayOpen()) return; // don't act on the editor under an open overlay
    // Mod+Alt+S → Save all. Match on e.code (the physical S key): on macOS, Option composes e.key
    // into another glyph (e.g. 'ß'), so `e.key === 's'` would miss the chord.
    if (e.altKey && e.code === 'KeyS') {
      e.preventDefault();
      void workspace.saveAllDirty();
    } else if (!e.altKey && (e.key === 's' || e.key === 'S')) {
      // Mod+S → save / format the active buffer (unchanged single-file behaviour).
      e.preventDefault();
      void workspace.saveActive();
    }
  });

  // Undo/redo drive the single workspace history (CodeMirror's own history was removed). Match on
  // e.code (physical Z/Y) so macOS Option-composed glyphs don't slip past.
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    if (overlayOpen()) return;
    if (e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) history.redo();
      else history.undo();
    } else if (e.code === 'KeyY' && !e.shiftKey) {
      e.preventDefault();
      history.redo();
    }
  });

  // Guard against closing/reloading with unsaved work: when any open buffer is dirty, the browser
  // shows its native "Leave site?" prompt. Dirty buffers live only in memory, so without this a tab
  // close silently drops them. On the desktop host this covers reloads; the window-close confirm is
  // wired separately in the Tauri host.
  window.addEventListener('beforeunload', (e) => handleBeforeUnload(e, () => workspace.anyDirty()));

  // Stop the brokered shell when the page genuinely goes away (#256). `pagehide` (not the cancellable
  // `beforeunload`) is used so aborting a close doesn't kill a live terminal; the desktop PTY also
  // gets SIGHUP when the process exits, but this disposes cleanly on a webview reload too.
  window.addEventListener('pagehide', () => terminal?.dispose());

  // --- new model ----------------------------------------------------
  // Reset the default workspace to a single untouched BLANK model: empty it on disk, recreate
  // model.koi, close every open doc, and reopen. The raw reset with no confirmation; user-initiated
  // New goes through requestNewModel() (below), which guards unsaved work first.
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
    welcome.hide();
  }

  // Does the workspace hold unsaved work that New would destroy? Files live on disk,
  // so only a dirty open buffer is at risk.
  function hasUnsavedWork(): boolean {
    return workspace.anyDirty();
  }

  // Confirm before an action that would replace the current model and lose unsaved work. Resolves
  // true to proceed (nothing to lose, or the user confirmed), false to abort. Shared by New and the
  // start-screen actions that swap the workspace (open folder / recent / example).
  async function confirmReplaceWork(title: string, confirmLabel: string): Promise<boolean> {
    if (!hasUnsavedWork()) return true;
    const save = formatChord('mod+S');
    return confirmDialog.ask({
      title,
      message: `Files with unsaved changes will lose them. Save with ${save} first to keep them.`,
      confirmLabel,
      danger: true,
    });
  }

  // User-initiated New (button, ⌘N, palette, welcome). Confirms before discarding unsaved work;
  // proceeds straight to a fresh blank model when there's nothing to lose.
  async function requestNewModel(): Promise<void> {
    if (await confirmReplaceWork('Start a new model?', 'Discard & start new')) await newModel();
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

  // Import a multi-file workspace carried in a share link. Materializes a real workspace and opens
  // it in folder mode (mirrors openExample). Runs from the lsp.start callback so the server is up
  // and the resulting didOpens resolve cross-file refs.
  async function importSharedWorkspace(
    files: { relPath: string; text: string }[],
    active?: string,
  ): Promise<void> {
    // A share link is untrusted input. Drop any file whose relPath could escape the workspace root
    // before it reaches platform.materializeWorkspace (which writes to disk) — defense in depth
    // against a malicious `..`/absolute path in the payload.
    const safeFiles = files.filter((f) => isSafeShareRelPath(f.relPath));
    // Nothing (safe) to import — fall through to the default workspace that already booted.
    if (safeFiles.length === 0) return;

    // Materialize a real workspace and open it in folder mode (mirrors openExample).
    const token = await platform.materializeWorkspace(
      'shared-workspace',
      safeFiles.map((f) => ({ relPath: f.relPath, contents: f.text })),
    );
    if (!token) {
      setStatus('could not open shared workspace', 'error');
      return;
    }
    await workspace.openFolderPath(token, { recent: false });
    // openFolderPath activates the first file by relPath; honour the share's `active` when present.
    if (active) {
      const target = Array.from(workspace.buffers.values()).find((b) => b.relPath === active);
      if (target) workspace.activateFile(target.uri);
    }
  }

  // Return to the Home route (#368): Home and the editor are distinct routes now, so "back to start"
  // navigates rather than popping an overlay over the editor. The boot switch (main.ts) swaps #app out
  // and mounts the Home view; the editor stays initialised behind it for an instant return. Wired to
  // the brand logo and the palette.
  function goHome(): void {
    appStore.getState().navigate('home');
  }

  // A start-screen action that swaps the workspace. Confirms unsaved work first. On cancel we do
  // nothing: the welcome already hid itself when the action was clicked, so the user lands back in
  // the editor with their unsaved work intact — Cancel means "keep what I have", not "back to home".
  async function leaveHomeFor(title: string, action: () => void | Promise<void>): Promise<void> {
    if (await confirmReplaceWork(title, 'Discard & open')) await action();
  }

  // Open a folder from the Recent list, recovering gracefully when it's gone. The welcome's recent
  // row hides the start screen on click, so on failure we re-show it (never strand the user) and, for
  // a vanished folder/handle, offer to forget the entry.
  async function openRecentFolder(path: string): Promise<void> {
    const result = await workspace.openFolderPath(path);
    if (result.ok) return;
    welcome.show();
    if (result.reason === 'unreadable') {
      const forget = await confirmDialog.ask({
        title: `"${platform.folderName(path)}" is no longer available`,
        message: 'Its folder may have moved, been deleted, or had its permission revoked. Remove it from Recent?',
        confirmLabel: 'Remove from Recent',
        danger: true,
      });
      if (forget) {
        removeRecentFolder(path);
        welcome.refreshRecent(); // rebuild the list in place — welcome is already shown, so show() would no-op
      }
    }
  }

  const welcome = createWelcome(
    {
      onNewModel: () => void requestNewModel(),
      onOpenFolder: () => void leaveHomeFor('Open a folder?', () => openFolder()),
      onOpenRecent: (path) => void leaveHomeFor('Open this folder?', () => openRecentFolder(path)),
      onOpenExample: (template) => void leaveHomeFor('Open this template?', () => openExample(template)),
    },
    undefined, // templates default to the bundled set
    platform.canOpenFolders,
  );

  const palette = createCommandPalette(() => getCommands());

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
    return token.split(/[\\/]/).pop() ?? uri;
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

  const prefs = createPreferences({
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
      workspace.setAutoSave(s.autoSave);
      // The scoped fields (word-wrap on both surfaces + the Generated-tab relabel via the preview
      // target) apply from the EFFECTIVE view so a Workspace override drives live behavior.
      applyEffectiveScoped(eff);
    },
    // Desktop hosts launch a `koine mcp --http` sidecar and return its loopback URL; the browser
    // returns null, so Settings hides the MCP affordance there.
    mcpEndpoint: () => platform.mcpEndpoint(),
    mcpStop: () => platform.mcpStop(),
    // Only the desktop shell can host the sidecar; the web build shows recipes but disables the toggle.
    mcpHostable: platform.kind === 'tauri',
    // Workspace root: only the browser (File System Access API) can save projects to a root dir.
    canSaveProjects: platform.canSaveProjects,
    workspaceRootName: () => platform.workspaceRootName(),
    pickWorkspaceRoot: () => platform.pickWorkspaceRoot(),
    // The current workspace's override key (null when no folder is open) — drives the per-row
    // User/Workspace scope toggle and routes scoped commits to the workspace override store.
    workspaceKey: () => wsKey(),
    // Live-apply a keybinding remap from Settings → Keyboard: reconfigure each open editor's keymap
    // compartment in place. Group A is always present; group B exists only when the split view is open.
    onKeybindingsChanged: () => {
      editor.reconfigureKeybindings();
      editorSession.groupBEditor()?.reconfigureKeybindings();
    },
  });
  const help = createHelpOverlay(helpRows());
  // Guards the user-initiated New command against silently discarding unsaved work.
  const confirmDialog = createConfirmDialog();
  // Single-field text prompts (name a new construct, a field, a project) — Koine's own modal, not the browser's.
  const promptDialog = createPromptDialog();

  // Desktop window-close guard (Tauri only): mirror the web beforeunload — confirm before closing
  // the window when any buffer is dirty. The browser host omits onCloseRequested (its beforeunload
  // guard already covers tab close / reload), so this is a no-op there.
  void platform.onCloseRequested?.(async () => {
    if (!workspace.anyDirty()) return true;
    return confirmDialog.ask({
      title: 'Close Koine Studio?',
      message: `Files with unsaved changes will lose them. Save with ${formatChord('mod+Alt+S')} first to keep them.`,
      confirmLabel: 'Close & discard',
      danger: true,
    });
  });
  // Generate Project wizard: compiles the active model, then bundles the emitted files into a
  // downloadable archive. I/O is injected so the wizard stays decoupled from the LSP/host wiring.
  const generateProject = createGenerateProject({
    emitPreview: (target) => lsp.emitPreview(target),
    glossary: () => lsp.glossary(),
    saveZip: (name, data) => platform.saveZip(name, data),
  });

  // The AI assistant panel is created lazily the first time its center pane is shown (the Anthropic SDK
  // is dynamically imported inside ai.ts, so creating the panel does not load it — only sending).
  // ide.ts owns the assistant's lifecycle; the controller only nudges it (syncWorkspace/focus)
  // via the injected ensureAssistant callback, so the #view-assistant host is looked up here.
  const assistantView = el('view-assistant');
  let assistant: AssistantPanel | null = null;
  function ensureAssistant(): AssistantPanel {
    if (assistant) return assistant;
    assistant = createAssistantPanel({
      container: assistantView,
      getProvider: () => loadSettings().aiProvider,
      getBaseUrl: () => loadSettings().aiBaseUrl,
      getApiKey: () => loadSettings().aiApiKey,
      getModel: () => {
        const s = loadSettings();
        return s.aiProvider === 'openai' ? s.aiModelOpenai : s.aiModel;
      },
      getContext: async () => {
        const diagnostics = editorSession.diagnosticsFor(workspace.activeUri()).map((d) => ({
          line: d.range.start.line + 1,
          col: d.range.start.character + 1,
          severity: severityErrorOrWarning(d.severity),
          message: d.message,
        }));
        const base: AssistantContext = {
          fileName: workspace.buffers.get(workspace.activeUri())?.name ?? 'model.koi',
          source: editor.getDoc(),
          diagnostics,
        };
        // The file/diagnostics snapshot above is cheap and per-call; the domain index is the expensive
        // part (two LSP recompiles), so the controller builds it once and reuses it until the next edit
        // clears the cache (invalidateDocViews) rather than rebuilding it on every send.
        const domainIndex = await controller.getCachedDomainIndex();
        return domainIndex ? { ...base, domainIndex } : base;
      },
      getSelection: () => {
        const sel = editor.view.state.selection.main;
        if (!sel.empty) return { text: editor.view.state.sliceDoc(sel.from, sel.to) };
        // No selection: fall back to the (non-blank) line under the cursor; null → panel uses whole file.
        const line = editor.view.state.doc.lineAt(sel.head);
        return line.text.trim() ? { text: line.text } : null;
      },
      onApplyModel: (source) => replaceActiveDoc(source),
      onOpenPrefs: () => prefs.open(),
      // Per-workspace conversation key: each opened folder keeps its own transcript; scratch mode
      // (no host folder behind it) uses the literal 'scratch'. selectView calls syncWorkspace on tab
      // show so re-opening the Assistant after a folder switch loads that folder's history.
      getWorkspaceKey: () => workspace.folderRootToken() ?? 'scratch',
      // Let the assistant call koine tools (validate/compile/format), executed by the host: in-WASM in
      // the browser, via the `koine mcp --http` sidecar on the desktop.
      runCompilerTool: platform.runCompilerTool
        ? (name, argsJson) => platform.runCompilerTool!(name, argsJson)
        : undefined,
      // Opt-in: advertising tools makes local servers (LM Studio) buffer instead of stream, so the
      // tools are only offered when the user enables them in Settings → Assistant.
      getUseTools: () => loadSettings().aiAgenticTools,
      // On by default (#257): constrain a grammar-capable local model to the Koine GBNF, and
      // validate-and-repair every other provider's output before "Apply to editor" is enabled.
      getConstrainGrammar: () => loadSettings().aiConstrainGrammar,
      // The GBNF comes from the host's resident compiler. Browser-host only — the desktop host omits
      // gbnfGrammar(), so the panel falls back to parse-and-repair there.
      getGrammar: platform.gbnfGrammar ? () => platform.gbnfGrammar!() : undefined,
      // Workspace snapshot for multi-file agentic editing: relPath→current text of every open buffer.
      getWorkspaceFiles: () => Object.fromEntries([...workspace.buffers.values()].map((b) => [b.relPath, b.text])),
      // Host executor for the staged list/read/write edit tools (browser WASM / desktop MCP).
      runEditTool: platform.runEditTool ? (name, argsJson, session) => platform.runEditTool!(name, argsJson, session) : undefined,
      // Commit an accepted multi-file change set through the controller (new files under the folder root).
      // applyFileEdit returns null (not throw) on a failed write/create — collect those relPaths so the
      // panel reports a partial apply instead of a false "Applied ✓".
      onApplyChangeSet: async (files) => {
        const failed: string[] = [];
        for (const f of files) {
          if ((await workspace.applyFileEdit(f.relPath, f.body)) === null) failed.push(f.relPath);
        }
        return { failed };
      },
    });
    return assistant;
  }

  // The scenario-runner panel (#149) is created lazily the first time its tab is shown; the controller
  // calls refresh() on every open so the catalog tracks the latest model. ide.ts owns the #view-scenarios
  // host lookup; the panel itself is backend-agnostic (it only talks to the lsp client).
  const scenariosView = el('view-scenarios');
  let scenarios: ScenarioPanel | null = null;
  function ensureScenarios(): ScenarioPanel {
    if (scenarios) return scenarios;
    scenarios = createScenarioPanel({
      container: scenariosView,
      lsp,
      setStatus: (message) => setStatus(message, 'green'),
    });
    return scenarios;
  }

  // The integrated terminal panel (#256), created lazily the first time its bottom-panel tab is shown
  // (the scenarios/assistant pattern). It is rooted at the opened workspace folder (or no cwd in
  // no-folder mode); the desktop host brokers a real PTY, the browser host renders a placeholder.
  let terminal: TerminalPanel | null = null;
  function ensureTerminal(): TerminalPanel {
    if (terminal) return terminal;
    terminal = createTerminalPanel({
      parent: el('panel-terminal'),
      platform,
      cwd: () => workspace.folderRootToken() || null,
    });
    return terminal;
  }

  // The Review panel (#259), created lazily the first time its bottom-panel tab is shown (the
  // terminal/scenarios pattern). It renders the review store grouped by file; clicking a thread jumps the
  // editor to its span via the shared gotoSourceSpan.
  let review: ReviewPanel | null = null;
  function ensureReview(): void {
    if (review) return;
    review = createReviewPanel({
      parent: el('panel-review'),
      store: reviewStore,
      onNavigate: (file, span) =>
        void gotoSourceSpan({ file, line: span.line, column: span.column, endLine: span.endLine, endColumn: span.endColumn }),
    });
  }

  // Diagrams are rendered with a theme-matched Mermaid palette; re-render on a theme flip (covers
  // the toolbar toggle, the command palette, and Preferences — all route through setTheme). The
  // controller owns the diagram cache + center state, so it decides whether to re-render now.
  onThemeChange(() => controller.onThemeChanged());

  // Copy a shareable playground link (the current model encoded in the URL hash) to the clipboard,
  // flashing a transient confirmation in the status pill. After the flash, re-derive the pill from
  // the CURRENT diagnostics rather than restoring a snapshot (which could clobber a fresh push).
  //
  // Shares the WHOLE workspace (every open buffer) under a versioned envelope, with the active file
  // flagged so the recipient lands on it. A workspace that overflows the URL-length cap is not
  // copied as a broken link — instead we steer the user to the `.koi` source zip export.
  async function copyShareLink(): Promise<void> {
    try {
      const files = Array.from(workspace.buffers.values()).map((b) => ({ relPath: b.relPath, text: b.text }));
      const activeRelPath = workspace.buffers.get(workspace.activeUri())?.relPath;
      const url = workspaceShareUrlOrNull(files, activeRelPath);
      if (url === null) {
        setStatus('Workspace too large to share as a link — export a .koi source zip instead', 'error');
        setTimeout(() => editorSession.updateStatus(editorSession.diagnosticsFor(workspace.activeUri())), 1500);
        return;
      }
      await navigator.clipboard.writeText(url);
      setStatus('link copied ✓', 'green');
      setTimeout(() => editorSession.updateStatus(editorSession.diagnosticsFor(workspace.activeUri())), 1500);
    } catch (e) {
      console.error('copy share link failed:', e);
    }
  }

  // Bundle every open `.koi` document into a zip and hand it to the host's saveZip seam (Blob
  // download in the browser, native picker on desktop). Names the archive after the opened folder.
  // The whole bundle is DOM-free in sourceZip.ts so it can be unit-tested in isolation.
  async function exportSourceZip(): Promise<void> {
    try {
      const files = Array.from(workspace.buffers.values()).map((b) => ({ relPath: b.relPath, text: b.text }));
      const root = sanitizeProjectName(platform.folderName(workspace.folderRootToken()));
      const bytes = await buildSourceZip(files, { root });
      const saved = await platform.saveZip(`${root}.zip`, bytes);
      if (saved === true) {
        setStatus('source exported ✓', 'green');
        setTimeout(() => editorSession.updateStatus(editorSession.diagnosticsFor(workspace.activeUri())), 1500);
      }
    } catch (e) {
      setStatus('export failed', 'error');
      console.error('export source zip failed:', e);
    }
  }

  // Flash a transient confirmation in the status pill, then re-derive it from the CURRENT diagnostics (so a
  // fresh push isn't clobbered) — the shared idiom behind the diagram export/copy handlers (#271).
  function flashStatus(message: string, kind: Parameters<typeof setStatus>[1]): void {
    setStatus(message, kind);
    setTimeout(() => editorSession.updateStatus(editorSession.diagnosticsFor(workspace.activeUri())), 1500);
  }

  // Export the live Visual canvas in the chosen format (#271): SVG/PNG serialize the actual drawing, PlantUML
  // is mapped from the structured graph client-side. Routes the bytes through the host's saveZip seam (Blob
  // download in the browser, native save dialog on desktop) with a caption-derived filename. A no-op with a
  // hint when no diagram is on screen; a user-cancelled save is silent (saveZip resolves false).
  async function exportActiveDiagram(format: 'svg' | 'png' | 'plantuml'): Promise<void> {
    const active = getActiveDomainExport();
    if (!active) {
      flashStatus('open the Visual diagram to export', 'error');
      return;
    }
    try {
      const saved = await exportDiagram(format, active.diagram, active.handle, (name, bytes) => platform.saveZip(name, bytes));
      if (saved === true) flashStatus('diagram exported ✓', 'green');
    } catch (e) {
      setStatus('export failed', 'error');
      console.error('export diagram failed:', e);
    }
  }

  // Copy the current diagram's Mermaid to the clipboard (#271), mirroring copyShareLink's flash. The fused
  // canvas is emitted as one Mermaid document; an empty model has nothing to copy.
  async function copyActiveDiagramMermaid(): Promise<void> {
    const mermaid = getActiveDomainExport()?.diagram.mermaid?.trim();
    if (!mermaid) {
      flashStatus('no diagram to copy', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(mermaid);
      flashStatus('Mermaid copied ✓', 'green');
    } catch (e) {
      setStatus('copy failed', 'error');
      console.error('copy mermaid failed:', e);
    }
  }

  // Save the current workspace as a real, reopenable on-disk project (browser host only). Promotes an
  // ephemeral example/Untitled workspace into <root>/<name>/, registers it in Recent, and reopens it
  // from disk so the workspace now IS that folder (further ⌘S writes there).
  async function saveProjectToDisk(): Promise<void> {
    if (!platform.canSaveProjects) return;
    // Flush the active editor's debounced text into its buffer so the snapshot is current.
    workspace.syncActiveBuffer(editor.getDoc());
    const files = [...workspace.buffers.values()].map((b) => ({ relPath: b.relPath, contents: b.text }));
    if (files.length === 0) {
      setStatus('nothing to save', 'error');
      return;
    }
    let seedValue = workspace.folderRootToken() ? platform.folderName(workspace.folderRootToken()) : 'my-project';
    let seedError = ''; // a name clash from a prior attempt, shown inline on the re-prompt
    for (;;) {
      const name = await promptDialog.ask({
        title: 'Save project',
        message: 'Saved to your projects folder and added to Recent.',
        label: 'Project name',
        initialValue: seedValue,
        confirmLabel: 'Save',
        error: seedError,
      });
      if (!name) return; // cancelled / empty
      try {
        const token = await platform.saveProjectToRoot(name, files);
        if (!token) return; // root picker dismissed
        await workspace.openFolderPath(token, { recent: true });
        setStatus('Project saved ✓', 'green');
        return;
      } catch (e) {
        if (String(e instanceof Error ? e.message : e).includes('already exists')) {
          // Re-ask with the clash surfaced inline (no second alert) and the rejected name pre-filled.
          seedError = `A project named "${name}" already exists — choose another name.`;
          seedValue = name;
          continue;
        }
        setStatus('save to disk failed', 'error');
        console.error('saveProjectToDisk failed:', e);
        return;
      }
    }
  }

  // --- view layout: editor split + repositionable panels (issue #265) -------
  // View-only state (orientation / panel side / side-rail side / whether the split is open and on
  // which uri), persisted in localStorage via layoutStore — it NEVER round-trips into the .koi model.
  // On boot we read it, paint #split's data-* attributes (CSS reflows the grid), open group B if it
  // was split, and anchor the inspector / left-rail resizers on the side each pane currently sits.
  // `let` (not const): each layout action below reassigns it from saveLayout's MERGED return value, so
  // that return is the single source of truth the next action reads (no per-field manual shadow).
  let layout = loadLayout();

  // Mirror the layout enums onto #split as data-* attributes; _split.scss keys the grid off them
  // (data-orientation lays the two editor groups side-by-side or stacked; data-panel-side docks the
  // bottom panel bottom/right; data-siderail-side moves the inspector rail left/right).
  function applyLayoutAttrs(l: LayoutState): void {
    splitEl.dataset.split = l.splitOpen ? 'true' : 'false';
    splitEl.dataset.orientation = l.orientation;
    splitEl.dataset.panelSide = l.panelSide;
    splitEl.dataset.siderailSide = l.sideRail;
  }
  applyLayoutAttrs(layout);

  // The drag handles are a desktop (mouse) idiom; on mobile they're display:none (see _split.scss),
  // so these listeners are inert below $bp-narrow (BP_NARROW). No JS gate needed — CSS owns visibility.
  // A persisted --koi-inspector-w / --koi-leftrail-w on #split is also harmless under the mobile
  // grid-template-columns: 1fr: those custom props aren't referenced inside the @media block.
  //
  // The inspector + left-rail resizers anchor to the side each pane sits on. With the default layout
  // the inspector is the right rail and the file-rail is the left, so this matches the historical
  // wiring; when sideRail==='left' the two swap (the inspector becomes the left rail, the file-rail
  // the right). Each resizer's disposer is kept so a live side-rail/panel/orientation toggle can tear
  // the stale wiring down and re-init with the new anchor — the handle then drags correctly without a
  // reload (the grid already reflowed via the data-* swap, but initEdgeResizer captures its anchor at
  // wire time, so re-init is how we repoint it).
  let disposeInspectorResizer: () => void;
  let disposeLeftRailResizer: () => void;
  let disposeGroupResizer: () => void;

  // (Re)wire the inspector + left-rail handles from the current sideRail side. Disposes any prior
  // wiring first so toggling never stacks listeners (and the stale anchor never lingers).
  function wireRailResizers(sideRail: LayoutState['sideRail']): void {
    disposeInspectorResizer?.();
    disposeLeftRailResizer?.();
    const inspectorOnRight = sideRail === 'right';
    disposeInspectorResizer = initEdgeResizer({
      target: splitEl,
      handle: el('split-resizer'),
      cssVar: '--koi-inspector-w',
      anchor: inspectorOnRight ? 'right' : 'left',
      storageKey: 'koine.studio.splitWidth',
      min: 220,
    });
    // Left sidebar width — the single rail (Files / Explorer / Overview / Documentation).
    disposeLeftRailResizer = initEdgeResizer({
      target: splitEl,
      handle: el('leftrail-resizer'),
      cssVar: '--koi-leftrail-w',
      anchor: inspectorOnRight ? 'left' : 'right',
      storageKey: 'koine.studio.leftrailWidth',
      min: 200,
      max: (w) => w * 0.5,
    });
  }

  // (Re)wire the editor-group divider for the current orientation. Disposed + re-init on a flip so the
  // divider drags along the NEW axis (--koi-group-w ↔ --koi-group-h, anchor right ↔ bottom) live.
  function wireGroupResizer(orientation: LayoutState['orientation']): void {
    disposeGroupResizer?.();
    disposeGroupResizer = initGroupResizer({ split: splitEl, handle: el('group-resizer'), orientation });
  }

  wireRailResizers(layout.sideRail);
  wireGroupResizer(layout.orientation);

  // Switch the routing target for the next file-open by which editor pane the user points at. Group B
  // is nested inside #editor-pane, so a pointerdown in B bubbles to A's listener too — A's guard
  // ignores events that originate inside #editor-pane-b so the inner pane wins. focusGroup only moves
  // the ROUTING target (editorSession owns the caret/DOM focus); harmless when B is closed (focus 'b'
  // with no group B just falls back to A inside openFocusedGroup). pointerdown (not focusin) so a plain
  // click anywhere in a pane — gutter, padding — retargets, not only landing the caret in the editor.
  const editorPaneEl = el('editor-pane');
  const editorPaneBEl = el('editor-pane-b');
  editorPaneEl.addEventListener('pointerdown', (e) => {
    if (editorPaneBEl.contains(e.target as Node)) return; // a B-pane click is handled by B's listener
    editorSession.focusGroup('a');
  });
  editorPaneBEl.addEventListener('pointerdown', () => editorSession.focusGroup('b'));

  // Restore the split if it was open. Boot leaves the routing target on group A (a page reload starts
  // on the primary group — the natural place a returning user resumes); a FRESH "Split editor" (the
  // split() action below) instead focuses the NEW group B so the very next file-open lands in it, which
  // is the manual-check flow. openGroupB internally sets focus to 'b', so boot explicitly normalises
  // back to 'a' — the one place the two paths intentionally differ, documented here so they don't
  // silently diverge.
  if (layout.splitOpen) {
    editorSession.openGroupB(layout.groupActiveUris[1] || workspace.activeUri());
    editorSession.focusGroup('a');
  }

  // The five palette commands' effects: each persists the change via saveLayout, then re-applies the
  // #split data-* attributes (CSS does the reflow) and drives group B. closeGroup tears B down; split
  // opens/focuses it; the toggles flip the corresponding enum AND re-wire the affected resizer so its
  // drag handle is live immediately (no reload). The persisted state is what boot reads, so the
  // arrangement survives a reload too.
  const layoutActions: LayoutActions = {
    split() {
      // Open group B (or focus it if already open) and remember it in the persisted layout. A fresh
      // split mirrors group A's active uri into B so the user immediately sees a second view to retarget;
      // openGroupB leaves focus on B so the next file-open lands there (the manual-check flow). Persist
      // B's CURRENT uri, not blindly A's: if B is already open on another file (re-split), keep that
      // file so reload restores it (#265). The group resizer was disposed on the last closeGroup — wire
      // it again so the divider drags on this open.
      editorSession.openGroupB(workspace.activeUri());
      const bUri = editorSession.groupBUri() || workspace.activeUri();
      layout = saveLayout({ splitOpen: true, groupActiveUris: [workspace.activeUri(), bUri] });
      applyLayoutAttrs(layout);
      wireGroupResizer(layout.orientation);
    },
    toggleOrientation() {
      const next = layout.orientation === 'horizontal' ? 'vertical' : 'horizontal';
      layout = saveLayout({ orientation: next });
      applyLayoutAttrs(layout);
      wireGroupResizer(next); // re-point the divider to the new axis live
    },
    closeGroup() {
      editorSession.closeGroupB();
      disposeGroupResizer?.(); // tear down the group divider's listeners so a re-split doesn't stack them (#265)
      layout = saveLayout({ splitOpen: false });
      applyLayoutAttrs(layout);
    },
    togglePanelSide() {
      const next = layout.panelSide === 'bottom' ? 'right' : 'bottom';
      layout = saveLayout({ panelSide: next });
      applyLayoutAttrs(layout);
    },
    toggleSideRail() {
      const next = layout.sideRail === 'right' ? 'left' : 'right';
      layout = saveLayout({ sideRail: next });
      applyLayoutAttrs(layout);
      wireRailResizers(next); // re-point the inspector + left-rail handles to their swapped anchors live
    },
  };

  // Persist group B's re-pointed file so reload restores B to the file the user last opened into it,
  // not the stale split-open file (#265). Only the B slot of groupActiveUris moves; A's slot tracks the
  // live active uri. A no-op shape when the split isn't open (B isn't shown), but the callers only
  // invoke this on the B-routing branch, so the split is open by construction. Declared as a hoisted
  // function so the earlier openFileInFocusedGroup / openUriInFocusedGroup can call it.
  function persistGroupBUri(bUri: string): void {
    layout = saveLayout({ groupActiveUris: [workspace.activeUri(), bUri] });
  }

  // Left-sidebar section disclosure: clicking a header collapses/expands its body (routed through
  // setRailSectionOpen, the single source of truth for section state).
  for (const head of Array.from(document.querySelectorAll<HTMLButtonElement>('.rail-sect-head'))) {
    head.addEventListener('click', () => {
      const sect = head.closest<HTMLElement>('.rail-sect');
      if (sect) setRailSectionOpen(sect, sect.dataset.open === 'false');
    });
  }

  // The bottom panel (resizer + collapse toggle + Problems / Events / Relationships / Context Map tabs
  // and their lazy loaders, issue #144) lives in the inspector controller now — it's wired there from
  // controller.init()'s construction. The diagnostics strip content (#diag-body / #diag-count) is still
  // owned by editorSession; the controller only toggles which bottom panel is visible.

  // Toolbar buttons unique to this phase.
  const hintEl = document.querySelector('.palette-hint');
  if (hintEl) {
    // Render the chord into an aria-hidden span: the visible "⌘+K" is decorative chrome, while the
    // button's accessible name stays "Open command palette" (aria-label). Setting textContent directly
    // would make the chord the visible label and break WCAG 2.5.3 (Label in Name).
    hintEl.replaceChildren();
    const chord = document.createElement('span');
    chord.setAttribute('aria-hidden', 'true');
    chord.textContent = formatChord('mod+K'); // ⌘+K / Ctrl+K per platform
    hintEl.appendChild(chord);
    hintEl.addEventListener('click', () => palette.toggle());
  }
  el<HTMLButtonElement>('btn-home').addEventListener('click', () => goHome());
  el<HTMLButtonElement>('btn-new').addEventListener('click', () => void requestNewModel());
  el<HTMLButtonElement>('btn-generate-project').addEventListener('click', () => generateProject.open());
  const saveProjectBtn = el<HTMLButtonElement>('btn-save-project');
  saveProjectBtn.addEventListener('click', () => void saveProjectToDisk());
  if (!platform.canSaveProjects) saveProjectBtn.hidden = true;
  el<HTMLButtonElement>('btn-theme').addEventListener('click', () => toggleTheme());
  el<HTMLButtonElement>('btn-prefs').addEventListener('click', () => prefs.open());

  // Mobile overflow "More" (⋮) menu (#528): at ≤ $bp-narrow the toolbar hides its secondary actions
  // (Save/Check/Install/⌘K/theme/Settings) and reveals this kebab, which collects them into a floating
  // menu. Items reuse the command-palette handlers (getCommands) so they never drift; Install is gated
  // on its affordance being revealed (#442) and reuses the #btn-install handler.
  const overflowBtn = el<HTMLButtonElement>('btn-toolbar-overflow');
  overflowBtn.addEventListener('click', () =>
    toggleOverflowMenu(overflowBtn, () =>
      buildOverflowItems({
        commands: getCommands(),
        openPalette: () => palette.open(),
        installAvailable: !el<HTMLElement>('install-affordance').hidden,
        install: () => el<HTMLButtonElement>('btn-install').click(),
      }),
    ),
  );

  // Format the active document via the LSP and apply the edits (shared by the palette command
  // and format-on-save). Degrades silently if the request fails.
  async function formatActive(): Promise<void> {
    try {
      const edits = await lsp.format();
      editor.applyEdits(edits);
    } catch (e) {
      console.error('format failed:', e);
    }
  }

  // --- command palette command set ------------------------------------------
  // Hints are authored with a literal 'mod' and formatted to ⌘ / Ctrl per platform so the
  // palette, help overlay, and toolbar hint all show the same key.
  function getCommands(): Command[] {
    const cmds: Command[] = [
      { id: 'undo', title: 'Undo', hint: 'mod+Z', group: 'Edit', run: () => history.undo() },
      { id: 'redo', title: 'Redo', hint: 'mod+Shift+Z', group: 'Edit', run: () => history.redo() },
      { id: 'format', title: 'Format document', hint: 'mod+S', group: 'Edit', run: () => void formatActive() },
      { id: 'home', title: 'Go to start screen', group: 'File', run: () => goHome() },
      { id: 'open-folder', title: 'Open folder…', hint: 'mod+Shift+O', group: 'File', run: () => void openFolder() },
      { id: 'search', title: 'Search across files…', hint: 'mod+Shift+F', group: 'Edit', run: () => search.focus() },
      { id: 'new-model', title: 'New model', hint: 'mod+N', group: 'File', run: () => void requestNewModel() },
      { id: 'save-all', title: 'Save all', hint: 'mod+Alt+S', group: 'File', run: () => void workspace.saveAllDirty() },
      { id: 'share', title: 'Copy shareable link', group: 'File', run: () => void copyShareLink() },
      { id: 'check', title: 'Check against baseline…', group: 'File', run: () => void controller.runCheck() },
      { id: 'generate-project', title: 'Generate project…', group: 'File', run: () => generateProject.open() },
      { id: 'export-source-zip', title: 'Export .koi source (.zip)', group: 'File', run: () => void exportSourceZip() },
      { id: 'export-diagram-svg', title: 'Export diagram as SVG', group: 'File', run: () => void exportActiveDiagram('svg') },
      { id: 'export-diagram-png', title: 'Export diagram as PNG', group: 'File', run: () => void exportActiveDiagram('png') },
      { id: 'export-diagram-plantuml', title: 'Export diagram as PlantUML', group: 'File', run: () => void exportActiveDiagram('plantuml') },
      { id: 'copy-diagram-mermaid', title: 'Copy diagram as Mermaid', group: 'File', run: () => void copyActiveDiagramMermaid() },
      ...(platform.canSaveProjects
        ? [{ id: 'save-project-to-disk', title: 'Save to disk…', group: 'File', run: () => void saveProjectToDisk() } as Command]
        : []),
      { id: 'toggle-theme', title: 'Toggle theme', group: 'View', run: () => toggleTheme() },
      // The editor-split + panel-reposition commands (issue #265). Built from the pure layoutCommands
      // module so the list is unit-tested; each run() drives the layoutActions wired at boot above.
      ...layoutCommands(layoutActions),
      { id: 'prefs', title: 'Settings…', hint: 'mod+,', group: 'View', run: () => prefs.open() },
      { id: 'help', title: 'Keyboard shortcuts', hint: 'F1', group: 'Help', run: () => help.open() },
      { id: 'about', title: 'About Koine Studio', group: 'Help', run: () => prefs.open('about') },
      ...devCommands(() => void toggleStoreInspector()),
      { id: 'view-preview', title: 'Show Emitted Preview', group: 'Workspace', run: () => controller.selectTech('preview') },
      { id: 'view-glossary', title: 'Show Glossary', group: 'Workspace', run: () => controller.selectDocsTab('glossary') },
      { id: 'view-decisions', title: 'Show Decisions (ADRs)', group: 'Workspace', run: () => controller.selectDocsTab('adr') },
      { id: 'view-notes', title: 'Show Notes', group: 'Workspace', run: () => controller.selectDocsTab('notes') },
      { id: 'view-diagrams', title: 'Show Visual Editor', group: 'Workspace', run: () => controller.selectCenter('visual') },
      { id: 'view-contextmap', title: 'Show Context Map', group: 'Workspace', run: () => controller.selectBottomTab('contextmap') },
      { id: 'view-check', title: 'Show Compatibility Check', group: 'Workspace', run: () => controller.selectTech('check') },
      { id: 'view-scenarios', title: 'Show Scenario Runner', group: 'Workspace', run: () => controller.selectTech('scenarios') },
      { id: 'view-assistant', title: 'Show Assistant', group: 'Workspace', run: () => controller.selectCenter('assistant') },
      { id: 'assistant-explain', title: 'Explain this construct', group: 'Workspace', run: () => { controller.selectCenter('assistant'); ensureAssistant().explainSelection(); } },
      { id: 'add-comment', title: 'Add review comment', group: 'Review', run: () => editor.addCommentAtSelection() },
      { id: 'view-review', title: 'Show Review', group: 'Workspace', run: () => controller.selectBottomTab('review') },
    ];

    // Stop a runaway compile: terminate the WASM worker and boot a fresh one (#353). Offered only while a
    // compile is actually in flight on the worker boot path (#469) — in the main-thread fallback there is
    // nothing to terminate, and an idle Stop would pointlessly restart the worker. getCommands() re-runs
    // on every palette open, so the command appears and disappears with the live in-flight state.
    if (canStopCompile()) {
      cmds.push({
        id: 'stop-compile',
        title: 'Stop compilation (restart compiler)',
        group: 'Workspace',
        run: () => stopRunawayCompile(),
      });
    }

    // Surface every open file as a "Go to File" entry so the palette doubles as a
    // fuzzy quick-open (type part of a path to jump). The palette re-reads this on each open.
    for (const buf of Array.from(workspace.buffers.values()).sort((a, b) => a.relPath.localeCompare(b.relPath))) {
      cmds.push({ id: 'goto:' + buf.uri, title: buf.relPath, group: 'Go to File', run: () => openUriInFocusedGroup(buf.uri) });
    }

    return cmds.map((c) => (c.hint ? { ...c, hint: formatChord(c.hint) } : c));
  }

  // --- global keyboard shortcuts --------------------------------------------
  // The existing Cmd/Ctrl-S save listener lives below this. This handler owns the rest of
  // the global chords; each overlay binds its own Esc, so Esc is intentionally not handled here.
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod && e.key !== 'F1') return;

    // mod+K always toggles the palette (so it can also dismiss itself); every other global
    // shortcut is suppressed while an overlay is open so it doesn't act on the editor beneath.
    if (mod && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      palette.toggle();
      return;
    }
    if (overlayOpen()) return;

    if (mod && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
      // Mod+Shift+F → open/focus the workspace search panel (toggle closes it).
      e.preventDefault();
      search.toggle();
    } else if (mod && e.shiftKey && (e.key === 'o' || e.key === 'O')) {
      e.preventDefault();
      void openFolder();
    } else if (mod && !e.shiftKey && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault();
      void requestNewModel();
    } else if (mod && e.key === ',') {
      e.preventDefault();
      prefs.open();
    } else if (e.key === 'F1') {
      e.preventDefault();
      help.toggle();
    } else if (mod && (e.key === 'b' || e.key === 'B')) {
      // Toggle the file tree.
      e.preventDefault();
      toggleFileTree();
    }
  });

  // Boot: attach listeners (inside start) before messages flow, then open the doc.
  setStatus('connecting…', 'connecting');
  lsp.onServerRestart(() => {
    // Fresh sidecar is back in sync; refresh whatever doc view is showing.
    controller.invalidateDocViews();
    controller.refreshActiveSurfaces();
  });
  lsp
    .start()
    .then(async () => {
      // Seed the emit-target list from the backend capability query once the server is up (issue
      // #282). Fire-and-forget: a slow or unresponsive query must NOT block the rest of boot, so we
      // don't await it. The built-in list (the default) keeps every target surface rendering until it
      // resolves, and the picker / wizard / Generated-tab / preview read the list LIVE, so they pick
      // up the seeded set on their next render. A failed query falls back to the built-ins.
      void lsp.emitTargets().then(setEmitTargets, (e) => {
        console.error('fetching emit targets failed; using the built-in list:', e);
        setEmitTargets(null);
      });

      // The workspace opens once the server is up so each file's didOpen resolves cross-file refs.
      // Isolated try/finally per branch: an open failure must not masquerade as a connection failure,
      // and any model hash is cleared so a reload doesn't re-trigger a failing import.
      if (shared?.kind === 'workspace') {
        try {
          await importSharedWorkspace(shared.files, shared.active);
        } catch (e) {
          console.error('importing shared workspace failed:', e);
          setStatus('could not open shared workspace', 'error');
        } finally {
          clearModelHash();
        }
      } else if (shared?.kind === 'single') {
        try {
          await workspace.openWorkspaceWith1File(shared.text);
        } catch (e) {
          console.error('opening shared model failed:', e);
          setStatus('could not open shared model', 'error');
        } finally {
          clearModelHash();
        }
      } else {
        // A start action chosen on the Home route (#368) is queued as a one-shot intent and performed
        // here, once, instead of opening the default workspace. A plain editor boot (cold `#/editor`
        // deep link, or a returning user) has no intent: restore the workspace it was last on (#535) —
        // an opened example otherwise reverted to the empty default on reload (silent data loss).
        //
        // Only an `example-*` dir is re-opened through openFolderPath here: it persists a handle in
        // IndexedDB that re-acquires with NO permission prompt. A *picked* folder is not OPFS-internal
        // (needs a user gesture) → never auto-restored, by design. The default workspace IS OPFS-internal
        // but its '(default)' handle is registered lazily (never put in IndexedDB), so openFolderPath
        // can't re-open it at cold boot — it flows through openDefaultWorkspaceFlow below instead, which
        // is its proper path (seeds the model, migrates legacy scratch, shows the memory-only banner).
        // On any restore failure (example dir evicted / IndexedDB cleared) we also fall through to the
        // default, so the user is never stranded on a blank editor.
        const intent = takeStartIntent();
        if (intent) {
          await runStartIntent(intent);
        } else {
          const last = getLastWorkspace();
          const restoredExample =
            !!last && last !== DEFAULT_WS_TOKEN && isOpfsInternalToken(last)
              ? (await workspace.openFolderPath(last, { recent: false })).ok
              : false;
          // Legacy-scratch migration is deliberately NOT done on the example-restore path: the scratch
          // content is only ever preserved by being seeded into the default workspace, so clearing it
          // here (without seeding) would lose it. It stays untouched until a default-workspace open.
          if (!restoredExample) await openDefaultWorkspaceFlow(legacyScratch ?? SEED);
        }
      }
    })
    .catch((e) => {
      setStatus('connection failed', 'error');
      output.setContent('// failed to start language server\n' + String(e), 'plain');
    });

  // The IDE shell boots once and stays alive across Home↔Editor route swaps (main.ts toggles
  // visibility, it doesn't re-init). The boot ladder above consumes a start-intent only on that first
  // boot — so a start action taken on a *return* visit to Home (which navigates back here without
  // re-initing) would otherwise be dropped. Consume any queued intent on every later transition INTO
  // the editor route. The first transition already happened before this listener exists (init() runs
  // synchronously from the navigate that flipped the route), so it never double-fires with the ladder.
  const unsubRouteIntent = appStore.subscribe((s, prev) => {
    if (s.route === 'editor' && prev.route !== 'editor') {
      const intent = takeStartIntent();
      if (intent) void runStartIntent(intent);
    }
  });

  // A teardown the host can call to release the IDE's deferred work. Production (main.ts) runs for the
  // page lifetime and ignores it; the test suite calls it between boots so the controller's pending
  // debounce timers can't fire into a torn-down happy-dom (where `render` throws "document is not defined").
  // setAutoSave(false) cancels the workspace's idle auto-save timer for the same reason.
  return () => {
    controller.dispose();
    editorSession.destroy();
    window.removeEventListener('resize', onDiagramViewportResize);
    terminal?.dispose(); // stop the brokered shell + dispose xterm (#256)
    review?.dispose(); // unmount the Review panel + release its store subscription (#259)
    unsubReviewStore(); // release the editor-repaint subscription (the editorSession is destroyed above)
    workspace.setAutoSave(false);
    unsubRouteIntent();
    teardownExportMenuDismiss(); // drop the global Export-menu dismissal listeners (#534)
  };
}
