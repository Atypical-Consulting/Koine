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
} from '@/lsp/lsp';
import {
  fileUriToPath,
  helpRows,
  isSafeShareRelPath,
  pathToFileUri,
} from '@/shell/ideUtils';
import { createEditorSession } from '@/shell/editorSession';
import { createInspectorController } from '@/shell/inspectorController';
import { getPlatform } from '@/host';
import { createExplorer } from '@/shell/explorer';
import { koineMark } from '@/shared/logo';
import { initTheme, onThemeChange, toggleTheme } from '@/settings/theme';
import {
  peekLegacyScratch,
  clearLegacyScratch,
  initSecrets,
  loadActiveContext,
  loadSettings,
  loadWorkspaceCenter,
  pushRecentFolder,
  removeRecentFolder,
  saveActiveContext,
  saveWorkspaceCenter,
  type Settings,
} from '@/settings/persistence';
import { createWelcome } from '@/welcome/welcome';
import { type Template } from '@/welcome/templates';
import { createCommandPalette, type Command } from '@/shared/palette';
import { createPreferences } from '@/settings/prefs';
import { applyAppearance } from '@/settings/appearance';
import { initSplitResizer, initEdgeResizer } from '@/shell/resize';
import { createHelpOverlay } from '@/shared/help';
import { createGenerateProject } from '@/export/generateProjectWizard';
import { sanitizeProjectName } from '@/export/generateProject';
import { buildSourceZip } from '@/export/sourceZip';
import { formatChord } from '@/shared/platform';
import {
  DIAGRAM_CONNECT_EVENT,
  DIAGRAM_DISCONNECT_EVENT,
  DIAGRAM_RELAYOUT_EVENT,
  EMPTY_STATE_PICK_EVENT,
  NODE_EDIT_EVENT,
  NODE_NAVIGATE_EVENT,
  setDiagramEditing,
  type AddNodeKind,
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
import { type SelectedElement } from '@/model/selection';
import { resolveInspectableQn } from '@/model/modelIndex';
import { type InspectorElement } from '@/model/inspector';
import { createAssistantPanel, type AssistantPanel, type AssistantContext } from '@/ai/aiPanel';
import { createScenarioPanel, type ScenarioPanel } from '@/scenarios/scenarioPanel';
import { clearModelHash, readModelFromHash, workspaceShareUrlOrNull } from '@/export/share';
import { handleBeforeUnload } from '@/shell/dirty';
import { render } from 'preact';
import { createHistoryController } from '@/shell/historyController';
import { HistoryControls } from '@/shell/HistoryControls';
import { MobileZoneBar } from '@/shell/MobileZoneBar';
import { type MobileZone } from '@/store/slices/uiChrome';
import { BP_NARROW } from '@/shared/breakpoint';
import { UnsavedIndicator } from '@/shell/UnsavedIndicator';
import { WorkspaceProblemsBadge } from '@/diagnostics/WorkspaceProblemsBadge';
import { StoreInspector } from '@/shell/StoreInspector';
import { createWorkspaceController, type WorkspaceController } from '@/shell/workspaceController';
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
  // right now, toggled from the command palette. Its host is created lazily on first toggle and the
  // panel rendered once (it tracks the store thereafter); toggling just flips the host's hidden flag.
  let storeInspectorHost: HTMLElement | null = null;
  function toggleStoreInspector(): void {
    if (!storeInspectorHost) {
      // First invocation: create the host (visible by default) and render the panel once. Return here
      // so we don't immediately flip it back to hidden — the first toggle SHOWS it.
      storeInspectorHost = document.createElement('div');
      storeInspectorHost.className = 'koi-store-inspector-overlay';
      document.body.appendChild(storeInspectorHost);
      render(<StoreInspector store={appStore} />, storeInspectorHost);
      return;
    }
    storeInspectorHost.hidden = !storeInspectorHost.hidden;
  }

  const lsp = new KoineLsp(platform.createLspTransport());

  // --- workspace model ------------------------------------------------------
  // The buffers / activeUri / folderRootToken / entriesCache state and the whole open/save/dirty/
  // mutation lifecycle live in `workspace` (workspaceController.ts, Task 5), constructed below.
  // editorSession + the inspector controller are built FIRST and read activeUri/folderRootToken via
  // `() => workspace.…()` thunks (only invoked at runtime, after construction), and they receive the
  // workspace's effects through its onActiveChanged/onBuffersChanged seams — so neither module imports
  // the other and there's no circular import. `workspace` is forward-declared here for those thunks.
  let workspace: WorkspaceController;

  // The editor ↔ LSP + diagnostics wiring (issue #180, Task 3): owns the CodeMirror editor and its
  // callback wall (hover/completion/definition/rename/references/code-actions → lsp.*), the per-uri
  // diagnostics cache, the status pill + diagnostics strip, and the LSP publishDiagnostics/exit
  // subscriptions. ide.ts keeps the buffer/dirty/tree side effects of an edit (wired through
  // editorSession.onChange below) and the workspace/model concerns.
  // Gate the diagnostics-driven tree rebuild: the LSP republishes a file's diagnostics on every
  // keystroke, but the only diagnostics-driven tree output is each file's error/warning badge, so a
  // push that leaves a file's counts unchanged would rebuild the explorer for an identical result.
  const diagCountGate = createDiagCountGate();

  const editorSession = createEditorSession({
    parent: el('editor-pane'),
    doc: initialDoc,
    lineWrap: settings.wordWrap,
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
  });
  const editor = editorSession.editor;
  const setStatus = editorSession.setStatus;

  // The buffer/dirty/tree half of the editor's onChange (the editor↔LSP sync runs inside
  // editorSession; the buffer text+dirty update lives in workspace.syncActiveBuffer). Preserves the
  // original effect order: welcome.hide → buffer text+dirty → onDocEdited → renderTree (only when the
  // active file's dirty dot just appeared).
  editorSession.onChange((doc) => {
    // First edit dismisses the welcome overlay (shown only on a pristine first-run workspace).
    if (welcome.visible) welcome.hide();
    const becameDirty = workspace.syncActiveBuffer(doc);
    controller.onDocEdited();
    if (!history.isRestoring) history.noteEdit();
    // Re-render the tree only when the active file's dirty dot just appeared (cheap path).
    if (becameDirty) workspace.renderTree();
  });

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

  // The Files section of the single left sidebar is collapsible; the section header (and ⌘B) toggle
  // it, and the choice is persisted. (The file tree no longer has its own column — it's one section
  // of the unified rail.)
  const FILETREE_VIS_KEY = 'koine.studio.filetree';
  function applyFileTreeVisibility(visible: boolean): void {
    setRailSectionOpen(filesSect, visible);
  }
  function showFileTreeChrome(): void {
    applyFileTreeVisibility((localStorage.getItem(FILETREE_VIS_KEY) ?? '1') !== '0');
  }
  function toggleFileTree(): void {
    const visible = filesSect.dataset.open === 'false'; // currently collapsed → expand
    applyFileTreeVisibility(visible);
    try {
      localStorage.setItem(FILETREE_VIS_KEY, visible ? '1' : '0');
    } catch {
      // ignore — no persistence available
    }
  }

  // The workspace file explorer. It deals in opaque fs tokens; ide.ts maps token ↔ file:// uri
  // (pathToFileUri) to keep `buffers`, `activeUri` and the LSP workspace coherent on every mutation.
  const explorer = createExplorer({
    onOpenFile: (token) => void workspace.openFileToken(token),
    onNewFile: (parentDirToken, name) => void workspace.handleNewFile(parentDirToken, name),
    onNewFolder: (parentDirToken, name) => void workspace.handleNewFolder(parentDirToken, name),
    onRename: (entry, newName) => void workspace.handleRename(entry, newName),
    onDelete: (entry) => void workspace.handleDelete(entry),
    onDuplicate: (entry) => void workspace.handleDuplicate(entry),
    onMove: (entry, destDirToken) => void workspace.handleMove(entry, destDirToken),
    isActive: (token) => pathToFileUri(token) === workspace.activeUri(),
    isDirty: (token) => workspace.buffers.get(pathToFileUri(token))?.dirty ?? false,
    diagCounts: (token) => diagCounts(pathToFileUri(token)),
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
    gotoSourceSpan: (span) => void gotoSourceSpan(span),
    ensureAssistant: () => ensureAssistant(),
    ensureScenarios: () => ensureScenarios(),
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

  // Jump-to-source from a diagram node: the SVG renderer draws each navigable node as a `<g>` that
  // dispatches a bubbling NODE_NAVIGATE_EVENT carrying its RAW 1-based source span; one delegated
  // listener on the diagrams container (below) routes it here.
  async function navigateToDiagramNode(detail: DiagramNodeNavigateDetail): Promise<void> {
    await gotoSourceSpan(detail);
  }

  diagramsView.addEventListener(NODE_NAVIGATE_EVENT, (e) => {
    const detail = (e as CustomEvent<DiagramNodeNavigateDetail>).detail;
    if (detail) void selectFromDiagram(detail);
  });

  // Drag-to-edit (issue #93, Task 5): a diagram node gesture (double-click = rename, right-click =
  // delete) round-trips through the model→.koi seam (#91). Enabled now that the seam exists; the
  // renderer keeps the gestures inert until this flips the switch, so the read-only tab is unchanged.
  setDiagramEditing(true);
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
  };

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
    getFormatOnSave: () => settings.formatOnSave,
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
    },
    // The active buffer was deleted and the workspace is now empty: reset to a fresh blank model.
    onWorkspaceEmptied: () => void newModel(),
    pushRecentFolder,
    setFolderTitle: (name) => {
      treeTitleEl.textContent = name;
    },
    showFileTreeChrome,
    hideWelcome: () => welcome.hide(),
  });
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
    appStore.getState().setMobileZone(zone);
    if (zone === 'diagram') controller.selectCenter('visual');
    else if (zone === 'code') controller.selectCenter('technical');
  }
  render(<MobileZoneBar store={appStore} onSelect={selectMobileZone} />, el('mobile-zone-bar-host'));
  splitEl.dataset.mobileZone = appStore.getState().mobileZone;
  // Mirror only when mobileZone actually changes — the listener fires on every store write, so guard
  // on prevState (the inspectorController idiom) to avoid rewriting the attribute on unrelated updates.
  appStore.subscribe((s, prev) => {
    if (s.mobileZone !== prev.mobileZone) splitEl.dataset.mobileZone = s.mobileZone;
  });
  // On a narrow (phone) first paint, land on the default mobile zone's surface so the bottom bar's
  // active tab and the visible #center surface agree from the start — otherwise the bar highlights the
  // default 'code' zone while #center still shows the desktop-restored Visual surface until the first
  // tap. Gated on BP_NARROW (the JS mirror of $bp-narrow) so the desktop shell keeps its restored center.
  if (window.innerWidth <= BP_NARROW) selectMobileZone(appStore.getState().mobileZone);
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

  // Boot/empty-state: open the host's persistent default workspace, then surface the welcome overlay
  // only when it is pristine (a single untouched SEED model). The clearLegacyScratch + the OPFS-error
  // output line are ide-specific, so they wrap workspace.openDefaultWorkspaceFlow here.
  async function openDefaultWorkspaceFlow(seed: string): Promise<void> {
    const { opened, pristineSeed } = await workspace.openDefaultWorkspaceFlow(seed);
    if (!opened) {
      // The browser now falls back to an in-memory workspace, so this only fires if even that failed
      // (or a host that genuinely can't back one). An honest message beats a blank editor.
      output.setContent('// Koine Studio could not open a workspace in this browser.', 'plain');
      return;
    }
    // Token confirmed — the workspace is open. Clear the legacy scratch key now so the migration is
    // non-destructive: content was never lost even if OPFS was unavailable on a prior load.
    clearLegacyScratch();
    // No-OPFS browsers (Safari / Firefox Private) run on the in-memory fallback: the editor + compiler
    // work, but a reload loses everything. Warn once so the user exports their work rather than losing it.
    if (!platform.persistsWorkspace) showMemoryOnlyBanner();
    if (pristineSeed && pristineSeed.text === SEED) welcome.show();
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
    await workspace.openFolderPath(token, { recent: false });
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

  // Reopen the start screen ("home"). Non-destructive: it's an overlay over the current model, so
  // showing it loses nothing — only its actions navigate. Wired to the brand logo and the palette.
  function goHome(): void {
    welcome.show();
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
  const prefs = createPreferences({
    onChange: (s) => {
      settings = s;
      // onChange is the single re-skin path: apply the document-level appearance, then sync the
      // pieces prefs can't reach — soft-wrap on both the source editor and the output preview.
      applyAppearance(s);
      editor.setLineWrap(s.wordWrap);
      output.setLineWrap(s.wordWrap);
      // Destination language now lives in Settings → Output. The controller relabels the Generated
      // tab, marks the preview stale, and re-emits it when that sub-view is the one showing.
      controller.onPreviewTargetChanged(s.previewTarget);
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

  // The AI assistant panel is created lazily the first time its tab is shown (the Anthropic SDK
  // is dynamically imported inside ai.ts, so creating the panel does not load it — only sending).
  // ide.ts owns the assistant's lifecycle; the controller only nudges its tab (syncWorkspace/focus)
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

  // The drag handles are a desktop (mouse) idiom; on mobile they're display:none (see _split.scss),
  // so these listeners are inert below $bp-narrow (BP_NARROW). No JS gate needed — CSS owns visibility.
  // A persisted --koi-inspector-w / --koi-leftrail-w on #split is also harmless under the mobile
  // grid-template-columns: 1fr: those custom props aren't referenced inside the @media block.
  initSplitResizer({ split: el('split'), handle: el('split-resizer') });

  // Left sidebar width — the single rail (Files / Explorer / Overview / Documentation).
  initEdgeResizer({
    target: splitEl,
    handle: el('leftrail-resizer'),
    cssVar: '--koi-leftrail-w',
    anchor: 'left',
    storageKey: 'koine.studio.leftrailWidth',
    min: 200,
    max: (w) => w * 0.5,
  });

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
      { id: 'new-model', title: 'New model', hint: 'mod+N', group: 'File', run: () => void requestNewModel() },
      { id: 'save-all', title: 'Save all', hint: 'mod+Alt+S', group: 'File', run: () => void workspace.saveAllDirty() },
      { id: 'share', title: 'Copy shareable link', group: 'File', run: () => void copyShareLink() },
      { id: 'check', title: 'Check against baseline…', group: 'File', run: () => void controller.runCheck() },
      { id: 'generate-project', title: 'Generate project…', group: 'File', run: () => generateProject.open() },
      { id: 'export-source-zip', title: 'Export .koi source (.zip)', group: 'File', run: () => void exportSourceZip() },
      ...(platform.canSaveProjects
        ? [{ id: 'save-project-to-disk', title: 'Save to disk…', group: 'File', run: () => void saveProjectToDisk() } as Command]
        : []),
      { id: 'toggle-theme', title: 'Toggle theme', group: 'View', run: () => toggleTheme() },
      { id: 'prefs', title: 'Settings…', hint: 'mod+,', group: 'View', run: () => prefs.open() },
      { id: 'help', title: 'Keyboard shortcuts', hint: 'F1', group: 'Help', run: () => help.open() },
      { id: 'about', title: 'About Koine Studio', group: 'Help', run: () => prefs.open('about') },
      { id: 'toggle-store-inspector', title: 'Toggle store inspector (debug)', group: 'Help', run: () => toggleStoreInspector() },
      { id: 'view-preview', title: 'Show Emitted Preview', group: 'Workspace', run: () => controller.selectTech('preview') },
      { id: 'view-glossary', title: 'Show Glossary', group: 'Workspace', run: () => controller.selectDocsTab('glossary') },
      { id: 'view-decisions', title: 'Show Decisions (ADRs)', group: 'Workspace', run: () => controller.selectDocsTab('adr') },
      { id: 'view-notes', title: 'Show Notes', group: 'Workspace', run: () => controller.selectDocsTab('notes') },
      { id: 'view-diagrams', title: 'Show Visual Editor', group: 'Workspace', run: () => controller.selectCenter('visual') },
      { id: 'view-contextmap', title: 'Show Context Map', group: 'Workspace', run: () => controller.selectBottomTab('contextmap') },
      { id: 'view-check', title: 'Show Compatibility Check', group: 'Workspace', run: () => controller.selectTech('check') },
      { id: 'view-scenarios', title: 'Show Scenario Runner', group: 'Workspace', run: () => controller.selectTech('scenarios') },
      { id: 'view-assistant', title: 'Show Assistant', group: 'Workspace', run: () => controller.selectTech('assistant') },
      { id: 'assistant-explain', title: 'Explain this construct', group: 'Workspace', run: () => { controller.selectTech('assistant'); ensureAssistant().explainSelection(); } },
    ];

    // Surface every open file as a "Go to File" entry so the palette doubles as a
    // fuzzy quick-open (type part of a path to jump). The palette re-reads this on each open.
    for (const buf of Array.from(workspace.buffers.values()).sort((a, b) => a.relPath.localeCompare(b.relPath))) {
      cmds.push({ id: 'goto:' + buf.uri, title: buf.relPath, group: 'Go to File', run: () => workspace.activateFile(buf.uri) });
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

    if (mod && e.shiftKey && (e.key === 'o' || e.key === 'O')) {
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
        await openDefaultWorkspaceFlow(legacyScratch ?? SEED);
      }
    })
    .catch((e) => {
      setStatus('connection failed', 'error');
      output.setContent('// failed to start language server\n' + String(e), 'plain');
    });

  // A teardown the host can call to release the IDE's deferred work. Production (main.ts) runs for the
  // page lifetime and ignores it; the test suite calls it between boots so the controller's pending
  // debounce timers can't fire into a torn-down happy-dom (where `render` throws "document is not defined").
  return () => controller.dispose();
}
