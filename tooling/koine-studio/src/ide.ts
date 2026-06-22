// Koine Studio app composition: wires the .koi editor, the live LSP diagnostics,
// the status line, the diagnostics strip, and the tabbed inspector (emitted preview,
// glossary, and context map).
import { createKoineEditor, createOutputView, renderMarkdown, setEditorDiagnostics } from './editor';
import {
  KoineLsp,
  type ContextMapResult,
  type DocsResult,
  type GlossaryEntry,
  type Location,
  type LspDiagnostic,
  type SourceSpan,
  type StructuredEdit,
  type TextEdit,
  type WorkspaceEdit,
} from './lsp';
import {
  diagnosticsInRange,
  fileUriToPath,
  helpRows,
  isSafeShareRelPath,
  pathToFileUri,
  renderCheckMarkdown,
  renderContextMapHtml,
} from './ideUtils';
import { getPlatform, type FsEntry, type KoiFile } from './host';
import { createExplorer } from './explorer';
import { koineMark } from './logo';
import { currentTheme, initTheme, onThemeChange, toggleTheme } from './theme';
import {
  peekLegacyScratch,
  clearLegacyScratch,
  initSecrets,
  loadActiveContext,
  loadSettings,
  loadWorkspaceMode,
  pushRecentFolder,
  saveActiveContext,
  saveWorkspaceMode,
  type Settings,
  type PreviewTarget,
} from './store';
import { createWelcome } from './welcome';
import { type Template } from './templates';
import { createCommandPalette, type Command } from './palette';
import { DEFAULT_MODE_ID, MODES, isValidModeId } from './modes';
import { createPreferences } from './prefs';
import { applyAppearance } from './appearance';
import { initSplitResizer, initEdgeResizer } from './resize';
import { createHelpOverlay } from './help';
import { createAboutDialog } from './about';
import { createGenerateProject } from './generateProjectWizard';
import { sanitizeProjectName } from './generateProject';
import { buildSourceZip } from './sourceZip';
import { formatChord } from './platform';
import { renderDiagrams } from './diagrams';
import {
  DIAGRAM_ADD_TYPE_EVENT,
  DIAGRAM_CONNECT_EVENT,
  DIAGRAM_DISCONNECT_EVENT,
  DIAGRAM_RELAYOUT_EVENT,
  NODE_EDIT_EVENT,
  NODE_NAVIGATE_EVENT,
  setDiagramEditing,
  setDiagramPersistScope,
  type DiagramConnectDetail,
  type DiagramDisconnectDetail,
  type DiagramNodeEditDetail,
  type DiagramNodeNavigateDetail,
} from './diagrams-svg';
import {
  extractEvents,
  extractRelationships,
  mergeDiagramGraphs,
  renderEventsTable,
  renderRelationshipsTable,
} from './modelTables';
import { renderGlossary, type GlossaryHandlers } from './glossary';
import { createDocsStore } from './docsStore';
import { renderDocsPanel, type DocsPanelHandlers } from './docsPanel';
import {
  ALL_CONTEXTS,
  createActiveContextBus,
  fileContextFollow,
  isAllContexts,
  listContexts,
  scopeDocsFiles,
  scopeGlossaryModel,
  scopeGraph,
  type ContextScope,
} from './activeContext';
import { createSelectionBus } from './selection';
import { renderModelOutline, renderOverviewCounts, type ModelOutlineHandlers } from './modelOutline';
import { buildInspectorElement, renderInspector, type InspectorElement, type InspectorHandlers } from './inspector';
import { buildModelIndex, lookupElement, type ModelIndex } from './modelIndex';
import { createAssistantPanel, type AssistantPanel, type AssistantContext, type DomainIndex } from './aiPanel';
import { clearModelHash, readModelFromHash, workspaceShareUrlOrNull } from './share';
import { dirtyCount, handleBeforeUnload, saveAllDirtyBuffers, titleWithDirty } from './dirty';
import { createConfirmDialog } from './overlay';

// --- workspace fs contract ---------------------------------------------------
// `KoiFile` (path / name / relPath) is provided by the host platform layer (src/host), whose
// backends supply it from the native filesystem (desktop) or the File System Access API (browser).

/** A client-side open buffer keyed by its file:// uri. */
interface Buffer {
  uri: string;
  path: string;
  relPath: string;
  name: string;
  text: string;
  dirty: boolean;
}

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

// LSP SymbolKind for a namespace — the kind the language service tags each top-level `context`
// document symbol with (see lsp.ts DocumentSymbol). Used to read a file's bounded context(s).
const SYMBOL_KIND_NAMESPACE = 3;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

export function init(): void {
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

  const editor = createKoineEditor({
    parent: el('editor-pane'),
    doc: initialDoc,
    lineWrap: settings.wordWrap,
    onChange: (doc) => {
      // First edit dismisses the welcome overlay (shown only on a pristine first-run workspace).
      if (welcome.visible) welcome.hide();
      const buf = buffers.get(activeUri);
      let becameDirty = false;
      if (buf) {
        if (!buf.dirty && buf.text !== doc) becameDirty = true;
        buf.text = doc;
        if (becameDirty) buf.dirty = true;
      }
      lsp.changeDoc(activeUri, doc);
      onDocEdited();
      // Re-render the tree only when the active file's dirty dot just appeared (cheap path).
      if (becameDirty) renderTree();
    },
    onHover: (line, character) => lsp.hover(line, character),
    onCompletion: (line, character) => lsp.completion(line, character),
    onDefinition: (line, character) => lsp.definition(line, character),
    onNavigate: (loc) => navigateToDefinition(loc),
    // Refactors + quick fixes (F2 rename, Shift-F12 references, Mod-. code actions). The editor
    // owns the in-editor widgets; ide.ts resolves the data and applies the resulting edits.
    onPrepareRename: (line, character) => lsp.prepareRename(line, character),
    onRename: (line, character, newName) => lsp.rename(line, character, newName),
    onReferences: (line, character) => lsp.references(line, character),
    onNavigateLocation: (loc) => navigateToDefinition(loc),
    uriLabel: (uri) => buffers.get(uri)?.relPath ?? (uri.split('/').pop() ?? uri),
    onCodeActions: (range) => lsp.codeActions(range, diagnosticsInRange(diagnosticsByUri.get(activeUri) ?? [], range)),
    onApplyWorkspaceEdit: (edit) => applyWorkspaceEdit(edit),
    // Save (Cmd/Ctrl-S) is owned by ide.ts's window keydown handler below: it formats AND
    // writes the active buffer to disk. We deliberately do NOT pass onFormat here so the
    // editor's Mod-s keymap stays inert and there's exactly one save path.
  });
  const output = createOutputView(el('view-preview'), settings.wordWrap);

  // A copy affordance overlaid on the emitted-preview pane (auto-hidden with the pane when another
  // inspector tab is active). Tracks the most recent generated output; disabled until there is some.
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

  const statusEl = el('status');
  const diagBodyEl = el('diag-body');
  const diagCountEl = el('diag-count');

  // Bottom status-bar fields — a pure projection of existing state (no new data sources). #status stays
  // in the toolbar; #sb-connection mirrors its kind here. #sb-context is written by the context switcher,
  // #sb-validity by the diagnostics strip, and #sb-version once at boot from the build-time define.
  const sbConnEl = el('sb-connection');
  const sbContextEl = el('sb-context');
  const sbValidityEl = el('sb-validity');
  el('sb-version').textContent = `v${__APP_VERSION__}`;

  // Bottom-panel (Problems / Events / Relationships, issue #144) state + refs live here — beside the
  // diagnostics refs and initialised before any model invalidation can fire — so `invalidateBottomPanels`
  // (called from `invalidateDocViews`) never touches a not-yet-initialised binding. The tab wiring and
  // the Events/Relationships data loaders are set up further down, with the strip.
  const diagEl = el('diagnostics');
  const eventsPanel = el('panel-events');
  const relationshipsPanel = el('panel-relationships');
  // The context map moved from a right-panel tab into the bottom strip's "Context Map" tab (mockup).
  const contextMapView = el('panel-contextmap');
  type BottomTab = 'problems' | 'events' | 'relationships' | 'contextmap';
  let activeBottomTab: BottomTab = 'problems';
  const bottomLoaded = { events: false, relationships: false, contextmap: false };
  let bottomPanelDebounce: ReturnType<typeof setTimeout> | undefined;

  // Global unsaved-work surfacing: the document title gains a `•` and a clickable "N unsaved" pill
  // appears beside the status whenever any open buffer is dirty. baseTitle is captured once, clean.
  const baseTitle = document.title;
  const unsavedEl = el('unsaved-indicator') as HTMLButtonElement;
  unsavedEl.addEventListener('click', () => void saveAllDirty());
  // The indicator is refreshed from every renderTree(); cache the last count so an unchanged dirty
  // total (the common case — most renders don't change it) skips the title/DOM writes.
  let lastDirtyCount = -1;
  function refreshDirtyIndicator(): void {
    const n = dirtyCount(buffers);
    if (n === lastDirtyCount) return;
    lastDirtyCount = n;
    document.title = titleWithDirty(baseTitle, n);
    if (n > 0) {
      unsavedEl.textContent = `${n} unsaved`;
      unsavedEl.setAttribute('aria-label', `Save ${n} unsaved file${n === 1 ? '' : 's'}`);
      unsavedEl.hidden = false;
    } else {
      unsavedEl.textContent = '';
      unsavedEl.hidden = true;
    }
  }

  const lsp = new KoineLsp(platform.createLspTransport());

  // --- workspace model ------------------------------------------------------
  // `buffers` holds every open document keyed by its file:// uri; `activeUri` is the one
  // shown in the editor and targeted by all lsp requests. `diagnosticsByUri` keeps the
  // latest pushed diagnostics per uri so switching files can re-render the active one and
  // the tree can badge files with errors.
  const buffers = new Map<string, Buffer>();
  const diagnosticsByUri = new Map<string, LspDiagnostic[]>();
  let activeUri = '';
  // The opened-folder token and the last explorer tree fetched for it. The explorer is a *view*:
  // it renders this cached tree (re-reading dirty/diagnostics/active state via callbacks), while
  // the open .koi `buffers` remain the compiled workspace. Mutations refresh both.
  let folderRootToken: string = '';
  let entriesCache: FsEntry[] = [];

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
    onOpenFile: (token) => void openFileToken(token),
    onNewFile: (parentDirToken, name) => void handleNewFile(parentDirToken, name),
    onNewFolder: (parentDirToken, name) => void handleNewFolder(parentDirToken, name),
    onRename: (entry, newName) => void handleRename(entry, newName),
    onDelete: (entry) => void handleDelete(entry),
    onDuplicate: (entry) => void handleDuplicate(entry),
    onMove: (entry, destDirToken) => void handleMove(entry, destDirToken),
    isActive: (token) => pathToFileUri(token) === activeUri,
    isDirty: (token) => buffers.get(pathToFileUri(token))?.dirty ?? false,
    diagCounts: (token) => diagCounts(pathToFileUri(token)),
  });
  treeBodyEl.appendChild(explorer.el);

  function setStatus(text: string, kind: 'connecting' | 'green' | 'error'): void {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind;
    // Mirror the connection state into the status bar as a stable label (the toolbar pill keeps the
    // live text). "Locale" reflects that the model is compiled in-process, not against a remote server.
    sbConnEl.textContent = kind === 'connecting' ? 'Connecting…' : kind === 'error' ? 'Offline' : 'Local';
  }

  function renderStrip(diags: LspDiagnostic[]): void {
    const errors = diags.filter((d) => d.severity === 1 || d.severity == null).length;
    const warnings = diags.filter((d) => d.severity === 2).length;
    // Status-bar validity: a plain-language read of the same error count that feeds #diag-count.
    if (errors) {
      sbValidityEl.textContent = errors === 1 ? '1 error' : `${errors} errors`;
      sbValidityEl.dataset.kind = 'error';
    } else {
      sbValidityEl.textContent = 'No errors';
      sbValidityEl.dataset.kind = 'ok';
    }
    if (!errors && !warnings) {
      diagCountEl.textContent = 'clean';
      diagCountEl.dataset.kind = 'clean';
    } else {
      const parts: string[] = [];
      if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
      if (warnings) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
      diagCountEl.textContent = parts.join(' · ');
      diagCountEl.dataset.kind = errors ? 'error' : 'warn';
    }

    diagBodyEl.innerHTML = '';
    if (!diags.length) {
      const span = document.createElement('span');
      span.className = 'diag-empty';
      span.textContent = 'No diagnostics.';
      diagBodyEl.appendChild(span);
      return;
    }
    for (const d of diags) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = d.severity === 2 ? 'diag diag-warn' : 'diag diag-err';
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      const code = d.code != null ? `${d.code}: ` : '';
      row.textContent = `${d.severity === 2 ? 'warn' : 'error'} ${line}:${col}  ${code}${d.message}`;
      row.addEventListener('click', () => editor.goto(line, col));
      diagBodyEl.appendChild(row);
    }
  }

  function updateStatus(diags: LspDiagnostic[]): void {
    const errors = diags.filter((d) => d.severity === 1 || d.severity == null).length;
    const warnings = diags.filter((d) => d.severity === 2).length;
    if (errors === 0 && warnings === 0) {
      setStatus('green ✓', 'green');
    } else {
      const parts: string[] = [];
      if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
      if (warnings) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
      setStatus(parts.join(' / '), 'error');
    }
  }

  // Diagnostics are pushed per-uri for every file in the workspace. Store them all; only the
  // ACTIVE file's diagnostics drive the editor gutter, the strip, and the status pill. The
  // tree is re-rendered so non-active files can badge their error/warning counts.
  lsp.onPublishDiagnostics((uri, diags) => {
    diagnosticsByUri.set(uri, diags);
    if (uri === activeUri) {
      setEditorDiagnostics(editor.view, diags);
      renderStrip(diags);
      updateStatus(diags);
    }
    renderTree();
  });
  lsp.onServerExit((code) => {
    setStatus(`server exited (${code})`, 'error');
  });

  // --- file tree ------------------------------------------------------------

  function diagCounts(uri: string): { errors: number; warnings: number } {
    const diags = diagnosticsByUri.get(uri) ?? [];
    let errors = 0;
    let warnings = 0;
    for (const d of diags) {
      if (d.severity === 2) warnings++;
      else errors++; // severity 1 or unset = error
    }
    return { errors, warnings };
  }

  // Re-render the explorer from the cached entry tree. Cheap to call on any state change (dirty,
  // diagnostics, active file) — the explorer reads those per row via the callbacks.
  function renderTree(): void {
    // Sync the global unsaved indicator on every tree render — this is the common path for every
    // dirty transition (edit, save, save-all, cross-file rename, workspace swap).
    refreshDirtyIndicator();
    if (folderRootToken === '') return;
    explorer.render(entriesCache, folderRootToken);
  }

  // --- workspace mutations (create / rename / delete / move) -----------------
  // The explorer surfaces user intent as opaque tokens; these handlers do the host fs op, then keep
  // `buffers` / `activeUri` / the LSP workspace coherent and refresh the tree. relPaths handed to
  // the host are always relative to the opened folder (folderRootToken).

  /** The folder-relative, forward-slashed path of a token under the opened folder ('' for the root). */
  function relOfToken(token: string): string {
    if (folderRootToken === '' || token === folderRootToken) return '';
    // Require a real separator boundary after the root prefix so a sibling that merely shares the
    // root as a string prefix (e.g. root `/work/app`, token `/work/app2/x`) isn't mis-sliced. Then
    // strip the prefix + separator and normalise Windows '\' to '/'.
    if (token.startsWith(folderRootToken + '/') || token.startsWith(folderRootToken + '\\')) {
      return token.slice(folderRootToken.length + 1).replace(/\\/g, '/');
    }
    return token;
  }

  /** Re-read the folder's entry tree from the host and re-render the explorer. */
  async function refreshEntries(): Promise<void> {
    if (folderRootToken === '') return;
    try {
      entriesCache = await platform.listEntries(folderRootToken);
    } catch (e) {
      console.error('listEntries failed:', e);
    }
    renderTree();
  }

  /** Open a .koi file token as a buffer if it isn't open yet; returns its uri (or null on failure). */
  async function ensureBuffer(token: string): Promise<string | null> {
    const uri = pathToFileUri(token);
    if (buffers.has(uri)) return uri;
    let text: string;
    try {
      text = await platform.readTextFile(token);
    } catch (e) {
      console.error('readTextFile failed for', token, e);
      return null;
    }
    buffers.set(uri, { uri, path: token, relPath: relOfToken(token), name: nameOf(token), text, dirty: false });
    lsp.openDoc(uri, text);
    return uri;
  }

  // Clicking a file row: open it (if needed) and make it the active editor buffer.
  async function openFileToken(token: string): Promise<void> {
    const uri = await ensureBuffer(token);
    if (uri) activateFile(uri);
  }

  async function handleNewFile(parentDirToken: string, name: string): Promise<void> {
    if (folderRootToken == null) return;
    const parentRel = relOfToken(parentDirToken);
    // The explorer only surfaces directories and .koi files, so default an extensionless name to
    // `.koi` — otherwise the created file would be invisible (listEntries filters it out) and the
    // user would think New File silently failed.
    const fileName = name.includes('.') ? name : `${name}.koi`;
    const relPath = parentRel ? `${parentRel}/${fileName}` : fileName;
    try {
      const token = await platform.createFile(folderRootToken, relPath, '');
      await refreshEntries();
      if (token.toLowerCase().endsWith('.koi')) await openFileToken(token);
    } catch (e) {
      setStatus('could not create file', 'error');
      console.error('createFile failed:', e);
    }
  }

  async function handleNewFolder(parentDirToken: string, name: string): Promise<void> {
    if (folderRootToken == null) return;
    const parentRel = relOfToken(parentDirToken);
    const relPath = parentRel ? `${parentRel}/${name}` : name;
    try {
      await platform.createFolder(folderRootToken, relPath);
      await refreshEntries();
    } catch (e) {
      setStatus('could not create folder', 'error');
      console.error('createFolder failed:', e);
    }
  }

  async function handleDelete(entry: FsEntry): Promise<void> {
    try {
      await platform.deleteEntry(entry.token);
    } catch (e) {
      setStatus('could not delete', 'error');
      console.error('deleteEntry failed:', e);
      return;
    }
    // Close every open buffer at or under the deleted token; re-point active if it was one of them.
    let activeRemoved = false;
    for (const buf of [...buffers.values()]) {
      if (isUnder(buf.path, entry.token)) {
        if (buf.uri === activeUri) activeRemoved = true;
        lsp.closeDoc(buf.uri);
        buffers.delete(buf.uri);
        diagnosticsByUri.delete(buf.uri);
      }
    }
    if (activeRemoved) activateFallback();
    await refreshEntries();
  }

  async function handleRename(entry: FsEntry, newName: string): Promise<void> {
    let newToken: string;
    try {
      newToken = await platform.renameEntry(entry.token, newName);
    } catch (e) {
      setStatus('could not rename', 'error');
      console.error('renameEntry failed:', e);
      return;
    }
    rekeyBuffers(entry.token, newToken);
    await refreshEntries();
  }

  async function handleDuplicate(entry: FsEntry): Promise<void> {
    if (folderRootToken == null) return;
    const parentRel = relOfToken(parentTokenOf(entry.token) ?? folderRootToken);
    // Try "<base> copy", then "<base> copy 2", … until the host accepts a non-colliding name.
    for (let i = 1; i <= 50; i++) {
      const dupName = copyName(entry.name, i, entry.kind === 'file');
      const relPath = parentRel ? `${parentRel}/${dupName}` : dupName;
      try {
        const token = await platform.moveEntry(entry.token, folderRootToken, relPath, true);
        await refreshEntries();
        if (entry.kind === 'file' && token.toLowerCase().endsWith('.koi')) await openFileToken(token);
        else await syncOpenKoi(); // a duplicated folder may contain new .koi files
        return;
      } catch (e) {
        // A collision means "try the next candidate name".
        if (isAlreadyExists(e)) continue;
        setStatus('could not duplicate', 'error');
        console.error('duplicate failed:', e);
        return;
      }
    }
    // Every candidate name collided — don't fail silently.
    setStatus('could not duplicate (too many copies)', 'error');
  }

  // Drag-and-drop move: reparent `entry` into `destDirToken` (the opened folder for root), keeping its
  // name. The explorer already rejects no-op and into-own-subtree drops, so this just performs the host
  // move and re-keys the open buffers / LSP workspace, mirroring rename.
  async function handleMove(entry: FsEntry, destDirToken: string): Promise<void> {
    if (folderRootToken == null) return;
    const destRel = relOfToken(destDirToken);
    const newRelPath = destRel ? `${destRel}/${entry.name}` : entry.name;
    let newToken: string;
    try {
      newToken = await platform.moveEntry(entry.token, folderRootToken, newRelPath, false);
    } catch (e) {
      // A name clash at the destination is the common, recoverable case — surface it, don't overwrite.
      if (isAlreadyExists(e)) {
        setStatus(`“${entry.name}” already exists there`, 'error');
      } else {
        setStatus('could not move', 'error');
        console.error('moveEntry failed:', e);
      }
      return;
    }
    rekeyBuffers(entry.token, newToken);
    await refreshEntries();
    if (entry.kind === 'dir') await syncOpenKoi(); // moved folder may carry .koi files to re-key
  }

  // --- mutation helpers ------------------------------------------------------

  /** True if `path` is the token itself or lives under the `ancestor` directory token (any separator). */
  function isUnder(path: string, ancestor: string): boolean {
    return path === ancestor || path.startsWith(ancestor + '/') || path.startsWith(ancestor + '\\');
  }

  function nameOf(token: string): string {
    return token.split(/[\\/]/).filter(Boolean).pop() ?? token;
  }

  function parentTokenOf(token: string): string | null {
    const slash = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
    return slash >= 0 ? token.slice(0, slash) : null;
  }

  /**
   * True when a host fs op failed because the destination name is taken. The desktop (Tauri) host
   * rejects with a plain string and the browser with an Error, so match the message text (not the
   * type) — shared by handleDuplicate (retry next name) and handleMove (surface the clash).
   */
  function isAlreadyExists(e: unknown): boolean {
    return String(e instanceof Error ? e.message : e).includes('already exists');
  }

  /** "order.koi" → "order copy.koi" (i=1) / "order copy 2.koi" (i=2); dirs get no extension split. */
  function copyName(name: string, i: number, isFile: boolean): string {
    const suffix = i === 1 ? ' copy' : ` copy ${i}`;
    const dot = isFile ? name.lastIndexOf('.') : -1;
    if (dot > 0) return `${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
    return `${name}${suffix}`;
  }

  // Re-key every buffer at/under `oldToken` to its path under `newToken` (a file or folder rename/
  // move), preserving each buffer's unsaved text + dirty flag and keeping the LSP workspace in sync.
  function rekeyBuffers(oldToken: string, newToken: string): void {
    for (const buf of [...buffers.values()]) {
      if (!isUnder(buf.path, oldToken)) continue;
      const newPath = newToken + buf.path.slice(oldToken.length);
      const newUri = pathToFileUri(newPath);
      const wasActive = buf.uri === activeUri;
      lsp.closeDoc(buf.uri);
      buffers.delete(buf.uri);
      const diags = diagnosticsByUri.get(buf.uri);
      diagnosticsByUri.delete(buf.uri);
      buf.uri = newUri;
      buf.path = newPath;
      buf.relPath = relOfToken(newPath);
      buf.name = nameOf(newPath);
      buffers.set(newUri, buf);
      if (diags) diagnosticsByUri.set(newUri, diags);
      lsp.openDoc(newUri, buf.text);
      if (wasActive) {
        activeUri = newUri;
        lsp.setActive(newUri);
      }
    }
  }

  // After the active buffer is deleted, fall back to another open file, or open a new blank model
  // when the workspace is now empty.
  function activateFallback(): void {
    const next = Array.from(buffers.values())
      .sort((a, b) => a.relPath.localeCompare(b.relPath))[0];
    if (next) {
      activeUri = next.uri;
      lsp.setActive(next.uri);
      editor.setDoc(next.text);
      const diags = diagnosticsByUri.get(next.uri) ?? [];
      setEditorDiagnostics(editor.view, diags);
      renderStrip(diags);
      updateStatus(diags);
      invalidateDocViews();
      return;
    }
    // Empty workspace: reset to a fresh blank model.
    void newModel();
  }

  // Open any .koi file present in the folder but not yet buffered (used after creating/duplicating
  // folders that may introduce new .koi files), so the compiled workspace stays complete.
  async function syncOpenKoi(): Promise<void> {
    if (folderRootToken === '') return;
    let files: KoiFile[];
    try {
      files = await platform.listKoiFiles(folderRootToken);
    } catch {
      return;
    }
    for (const f of files) {
      if (!buffers.has(pathToFileUri(f.path))) await ensureBuffer(f.path);
    }
  }

  // Switch the editor + lsp to a different open buffer. Saves the current editor text back to
  // the leaving buffer first (preserving unsaved edits), swaps the doc, points lsp at the new
  // uri, re-renders diagnostics for it, and invalidates the doc views so they re-fetch.
  function activateFile(uri: string): void {
    if (uri === activeUri) return;
    // Flush the leaving file's debounced edits to the server before switching: the shared change
    // timer is re-armed for the new file on setDoc below, which would otherwise drop them.
    lsp.flush();
    const leaving = buffers.get(activeUri);
    if (leaving) leaving.text = editor.getDoc();
    const next = buffers.get(uri);
    if (!next) return;
    activeUri = uri;
    lsp.setActive(uri);
    editor.setDoc(next.text);
    const diags = diagnosticsByUri.get(uri) ?? [];
    setEditorDiagnostics(editor.view, diags);
    renderStrip(diags);
    updateStatus(diags);
    invalidateDocViews();
    renderTree();
    void followActiveFileContext();
  }

  // When the active .koi file changes, follow the bounded-context switcher to that file's context so
  // the top bar — and every scoped surface (outline / diagram / counts / tables) — reflects the file
  // you're now editing: the file-explorer counterpart of the selection-follow below. The file's
  // primary context is its first top-level document symbol (the LSP emits one Namespace symbol per
  // `context`). View-only (applyScope persist=false), like the selection-follow: navigating between
  // files shouldn't overwrite the user's deliberately chosen, persisted scope, so a reload restores
  // it. A response for a file the user has already switched away from is dropped (so rapid file
  // switching can't strand the scope on a stale file), and a file with no determinable context
  // (empty/unparseable → no symbols, or its context already active) leaves the scope untouched.
  async function followActiveFileContext(): Promise<void> {
    const uri = activeUri;
    let contexts: string[];
    try {
      const symbols = await lsp.documentSymbols();
      // Top-level document symbols are the file's `context` declarations (SymbolKind 3 = Namespace).
      contexts = symbols.filter((s) => s.kind === SYMBOL_KIND_NAMESPACE).map((s) => s.name);
    } catch {
      return;
    }
    if (activeUri !== uri) return; // the user switched files while the symbols were in flight
    const next = fileContextFollow(contexts, activeContext.get());
    if (next !== undefined) applyScope(next, false);
  }

  // Cross-file go-to-definition: if the resolved Location is a different OPEN file, activate it
  // before jumping; otherwise jump within the current file. Unknown uris are ignored.
  function navigateToDefinition(loc: Location): void {
    if (loc.uri && loc.uri !== activeUri && buffers.has(loc.uri)) {
      activateFile(loc.uri);
    }
    editor.gotoRange(loc.range.start, loc.range.end);
  }

  // Apply LSP TextEdits to a plain string (for non-active buffers in a cross-file rename). Edits
  // are applied from the end backward so earlier edits don't shift the offsets of later ones.
  function applyTextEditsToString(text: string, edits: TextEdit[]): string {
    const lines = text.split('\n');
    const offsetOf = (line: number, character: number): number => {
      const ln = Math.min(Math.max(line, 0), lines.length - 1);
      let offset = 0;
      for (let i = 0; i < ln; i++) offset += lines[i].length + 1; // + the '\n'
      return offset + Math.min(Math.max(character, 0), lines[ln].length);
    };
    const sorted = edits
      .map((e) => ({
        from: offsetOf(e.range.start.line, e.range.start.character),
        to: offsetOf(e.range.end.line, e.range.end.character),
        insert: e.newText,
      }))
      .sort((a, b) => b.from - a.from);
    let result = text;
    for (const edit of sorted) result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to);
    return result;
  }

  // Apply a rename/code-action WorkspaceEdit across open buffers. The active file is edited through
  // the editor (so undo history + the onChange sync path fire); other OPEN files are patched in
  // their stored text and pushed to the server immediately. Edits to non-open files are ignored.
  function applyWorkspaceEdit(edit: WorkspaceEdit): void {
    if (!edit?.changes) return;
    let treeChanged = false;
    for (const [uri, edits] of Object.entries(edit.changes)) {
      if (!edits.length) continue;
      if (uri === activeUri) {
        editor.applyEdits(edits); // dispatch → onChange updates the buffer + lsp + doc views
      } else {
        const buf = buffers.get(uri);
        if (!buf) continue;
        buf.text = applyTextEditsToString(buf.text, edits);
        buf.dirty = true;
        lsp.syncDoc(uri, buf.text);
        treeChanged = true;
      }
    }
    if (treeChanged) renderTree();
    onDocEdited();
  }

  // Replace the active document's contents (used by the AI "Apply to editor" action). Setting the
  // editor doc dispatches a change, so the editor's onChange handler runs the full sync pipeline
  // (buffer text, lsp.changeDoc, doc-view refresh, tree) — don't repeat it here.
  function replaceActiveDoc(source: string): void {
    editor.setDoc(source);
  }

  // --- tabbed inspector (preview / glossary / context map) ------------------

  // The shared "selected element" bus (issue #142): the spine that keeps the model outline, the
  // diagram, and the element inspector in sync. Clicking a node in the outline OR the diagram sets
  // the same selection; the inspector + outline cross-highlight subscribe to it.
  const selection = createSelectionBus();

  // Left-rail hosts (always visible, repainted together from the model): the Explorer construct
  // tree and the Overview per-context counts.
  const explorerBody = el('rail-explorer-body');
  const overviewBody = el('rail-overview-body');
  // The Documentation center tab's two sub-views: Glossary (the ubiquitous language) and Docs (the
  // ADR & Notes surface, #174).
  const glossaryView = el('view-glossary');
  const docsView = el('view-docs');
  // Center hosts: the diagram canvas (Visual) and the code editor's companion sub-views.
  const diagramsView = el('center-visual');
  const assistantView = el('view-assistant');
  const checkView = el('view-check');
  // Right-rail host: the element inspector (Properties). Fixed — never torn down on a model reload.
  const inspectorHost = el('inspector-host');

  // Active workspace mode (#143): the toolbar's Domain/Code/Docs buttons, repointed as region-focus
  // shortcuts now that each view has a fixed home (Domain → Visual, Code → Code,
  // Docs → the Documentation tab). Restore the persisted mode, defaulting to Domain when absent/invalid.
  const restoredMode = loadWorkspaceMode();
  let activeMode: string = restoredMode && isValidModeId(restoredMode) ? restoredMode : DEFAULT_MODE_ID;
  // The switcher buttons (Domain / Code / Docs) are built from the MODES data — a new mode is one
  // array entry, not new markup — and carry data-mode for the click handler.
  const modeButtons = MODES.map((mode) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mode-btn';
    btn.dataset.mode = mode.id;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(mode.id === activeMode));
    btn.textContent = mode.label;
    btn.addEventListener('click', () => selectMode(mode.id));
    return btn;
  });
  el('mode-switcher').append(...modeButtons);

  // Active bounded-context switcher (#146): a header-level <select> that scopes the model-derived
  // surfaces (outline, counts, the bottom Events/Relationships tables — and, via Task 3, the diagram
  // and inspector) to ONE bounded context, with an "All contexts" option. Scope is a pure filter over
  // existing data; the bus is the single source of truth the render paths read at paint time, so the
  // compiler/LSP/model stay untouched. A native <select> is the switcher — it scales to any number of
  // contexts, shows the current one, and is keyboard/screen-reader operable for free — paired with an
  // aria-live "Current context: X" readout.
  const activeContext = createActiveContextBus();
  const contextSwitcher = el('context-switcher');
  const contextLabel = document.createElement('span');
  contextLabel.className = 'context-switcher-label';
  contextLabel.id = 'context-switcher-label';
  contextLabel.textContent = 'Context';
  const contextSelect = document.createElement('select');
  contextSelect.className = 'context-select';
  contextSelect.setAttribute('aria-labelledby', 'context-switcher-label');
  const contextReadout = document.createElement('span');
  contextReadout.className = 'context-readout';
  contextReadout.setAttribute('aria-live', 'polite');
  contextSwitcher.append(contextLabel, contextSelect, contextReadout);
  contextSelect.addEventListener('change', () => setActiveContext(contextSelect.value));

  /** The per-workspace storage key for the active scope (folder identity, or 'scratch'). */
  function contextWorkspaceKey(): string {
    return folderRootToken || 'scratch';
  }

  /** The human label for a scope: the context name, or "All contexts" for the unscoped sentinel. */
  function scopeLabel(scope: ContextScope): string {
    return isAllContexts(scope) ? 'All contexts' : scope;
  }

  /** Mirror the active scope onto the control + readout (no persistence, no re-render). */
  function syncContextSwitcherUi(): void {
    const scope = activeContext.get();
    if (contextSelect.value !== scope) contextSelect.value = scope;
    contextReadout.textContent = `Current context: ${scopeLabel(scope)}`;
    sbContextEl.textContent = `Context: ${scopeLabel(scope)}`;
  }

  // The single choke point for every scope change (the <select>, a restored value's validation, and
  // Task 3's select-outside-scope path all route through here): update the bus, optionally persist it
  // for this workspace, sync the control, and re-render the scoped surfaces. `persist` is the user's
  // intent flag — only a deliberate switcher choice persists; non-deliberate changes (following a
  // selection, or falling back off a vanished context) are view-only so they never overwrite the
  // user's last explicit choice in storage.
  function applyScope(scope: ContextScope, persist: boolean): void {
    activeContext.set(scope);
    if (persist) saveActiveContext(contextWorkspaceKey(), scope);
    syncContextSwitcherUi();
    rerenderScopedSurfaces();
  }

  /** A deliberate scope change from the switcher — persisted so a reload restores it. */
  function setActiveContext(scope: ContextScope): void {
    applyScope(scope, true);
  }

  // Rebuild the switcher's options from the current model's contexts ("All contexts" first, then each
  // context). Hidden when the model has no contexts (empty/scratch).
  function setContextOptions(contexts: string[]): void {
    contextSwitcher.hidden = contexts.length === 0;
    const options = [ALL_CONTEXTS, ...contexts];
    contextSelect.replaceChildren(
      ...options.map((value) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = scopeLabel(value);
        return opt;
      }),
    );
    // Fall back to "All contexts" ONLY when we positively know the model's contexts (a non-empty list)
    // and the active scope isn't among them — a genuine rename/removal. An EMPTY list is a transient or
    // cold state (the LSP still warming up right after open, or a momentarily-unparseable model mid-edit),
    // so preserve the scope rather than clobber it. The fallback is view-only (not persisted), so the
    // user's last explicit choice survives in storage and a reload restores it once the context is back.
    const scope = activeContext.get();
    if (contexts.length > 0 && !isAllContexts(scope) && !contexts.includes(scope)) {
      applyScope(ALL_CONTEXTS, false);
    } else {
      syncContextSwitcherUi();
    }
  }

  // Refresh the switcher's context list from the workspace model (best-effort; empties on failure).
  // The glossary model lists every declared type with its owning context, so it's the most complete
  // source for "every context that has anything in it".
  async function refreshContextList(): Promise<void> {
    try {
      const model = await lsp.glossaryModel();
      setContextOptions(listContexts(model));
    } catch {
      setContextOptions([]);
    }
  }

  // Restore the persisted scope for the just-opened workspace, before the first scoped render. The
  // control catches up when refreshContextList rebuilds the options (the bus value is what the render
  // paths read, so the initial render is already scoped regardless of the dropdown's paint timing).
  function restoreActiveContext(): void {
    const stored = loadActiveContext(contextWorkspaceKey());
    activeContext.set(stored && stored.length > 0 ? stored : ALL_CONTEXTS);
    syncContextSwitcherUi();
  }

  // Re-render the scoped, model-derived surfaces after a scope change. Scope is applied at paint time
  // from the bus and the model itself is unchanged (scope is a pure filter), so the cached model index
  // is kept — only the visible surfaces repaint. The model/diagram doc caches are marked stale so a
  // not-currently-visible one re-renders scoped on its next visit.
  function rerenderScopedSurfaces(): void {
    docViewsLoaded.model = false;
    docViewsLoaded.diagrams = false;
    // The left-rail Explorer + Overview are always visible, so re-scope them immediately.
    void loadModel();
    // The diagram only re-scopes when the visual center is showing it.
    if (activeCenter === 'visual') void loadDiagrams();
    invalidateBottomPanels(); // the Events/Relationships/Context Map tables are graph-derived too
  }

  // Track which lazily-loaded surfaces need a (re)fetch — invalidated on every edit so a switch
  // always shows data for the current model rather than a stale render. The check view (on-demand via
  // the Check button) and the assistant (interactive) are excluded. The Explorer/Overview
  // (model) and Documentation (glossary) are always visible, so they repaint on every edit.
  const docViewsLoaded: Record<'preview' | 'model' | 'glossary' | 'diagrams', boolean> = {
    preview: false,
    model: false,
    glossary: false,
    diagrams: false,
  };

  // The assistant's domain index is another model-derived view (built from the same context-map +
  // glossary the views above use), so it's cached the same way: `null` = stale/unbuilt, `{ value }` =
  // built (value undefined for a scratch/empty model). invalidateDocViews() clears it on any model
  // change, so a chat about an unedited model reuses it instead of re-running the LSP recompiles.
  let cachedDomainIndex: { value: DomainIndex | undefined } | null = null;

  // Build the assistant's domain index from the COMPILED workspace (contexts/aggregates/relations +
  // glossary coverage), best-effort: any failing LSP endpoint just drops the index — this never
  // throws, so the chat stays usable even when the LSP is down. Returns undefined for a scratch/empty
  // model so the system prompt stays clean. Cached by getContext (see cachedDomainIndex).
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

  function docMessage(view: HTMLElement, text: string, kind: 'muted' | 'error' = 'muted'): void {
    // Build the node with textContent rather than interpolating into innerHTML — `text` often carries
    // an error string (String(e)) that can embed host paths or user-influenced file/folder names, so
    // raw interpolation would be an HTML-injection sink.
    view.innerHTML = '';
    const p = document.createElement('p');
    p.className = kind === 'error' ? 'doc-error' : 'muted';
    p.textContent = text;
    view.appendChild(p);
  }

  // The glossary tab is the ubiquitous-language editor (#67): it lists every concept across
  // contexts with a documentation-coverage gauge, and lets anyone (especially non-coders) add or
  // edit a plain-prose description that is written back into the `.koi` as a `///` doc comment.
  async function loadGlossary(): Promise<void> {
    docMessage(glossaryView, 'Loading glossary…');
    try {
      const model = await lsp.glossaryModel();
      if (!model.entries.length) {
        docMessage(glossaryView, 'No concepts yet — declare some types, or fix syntax errors to populate the glossary.');
      } else {
        glossaryView.innerHTML = '';
        glossaryView.appendChild(renderGlossary(model, glossaryHandlers));
      }
      docViewsLoaded.glossary = true;
    } catch (e) {
      docMessage(glossaryView, 'Glossary request failed: ' + String(e), 'error');
    }
  }

  // Wires the pure (testable) glossary view in ./glossary to the editor + LSP: jump-to-source and
  // persist-a-description. The view builds the DOM; these handlers are the only side effects.
  const glossaryHandlers: GlossaryHandlers = {
    onGoto: (range) => editor.gotoRange(range.start, range.end),
    onSave: (entry, text) => void saveDescription(entry, text),
  };

  /**
   * Persists a description by asking the server for the doc-comment edit and applying it to the
   * buffer. The applied edit fires onChange → onDocEdited, which reloads the glossary (debounced),
   * refreshing coverage. A no-op result (e.g. an unknown id) needs no action — the inline editor
   * has already closed optimistically.
   */
  async function saveDescription(entry: GlossaryEntry, text: string): Promise<void> {
    try {
      const result = await lsp.setDoc(entry.id, text);
      if (!result.edits.length) return;
      if (result.uri && result.uri !== activeUri && buffers.has(result.uri)) activateFile(result.uri);
      editor.applyEdits(result.edits);
    } catch (e) {
      docMessage(glossaryView, 'Saving description failed: ' + String(e), 'error');
    }
  }

  // The DDD-aware workspace (#142): the left rail's Explorer (a construct-grouped, per-context
  // navigator) + Overview (per-context counts) and the right rail's read-only element inspector
  // (Properties). All are driven by the shared selection bus — clicking a node in the Explorer OR a
  // diagram selects the same element and refreshes the inspector.

  // The Docs sub-tab of the Documentation center tab is the ADR & Notes documentation surface (#174):
  // plain-Markdown architecture decision records (`docs/adr/NNNN-*.md`) and notes (`docs/notes/*.md`)
  // in the opened workspace, read and written through docsStore over the host fs. Unlike the
  // model-derived views it is folder-derived (not invalidated by `.koi` edits): it reloads when the
  // workspace folder changes (openFolderPath flips docsLoaded) and after any create/save in the panel.
  // In no-folder mode the store reports canWrite=false and the panel renders a read-only empty state.
  let docsLoaded = false;
  async function loadDocs(): Promise<void> {
    const store = createDocsStore(platform, folderRootToken);
    // Creating an ADR/note adds a row, so rebuild the panel from disk; an edit (save) is applied in
    // place by the panel itself (it refreshes the row head + detail), so saves don't reload — which
    // also keeps the open editor from collapsing.
    const reload = (): void => {
      docsLoaded = false;
      void loadDocs();
    };
    // Surface a failure on the status line — NOT by overwriting the panel — so the ADR/Notes list and
    // any in-progress editor survive a transient create/save error and the user can simply retry.
    const fail = (verb: string) => (e: unknown) => setStatus(`Could not ${verb}: ${String(e)}`, 'error');
    const handlers: DocsPanelHandlers = {
      onCreateAdr: (title) => void store.createAdr(title).then(reload).catch(fail('create the ADR')),
      onSaveAdr: (file, adr) => void store.saveAdr(file.token, adr).catch(fail('save the ADR')),
      onCreateNote: (title) => void store.createNote(title).then(reload).catch(fail('create the note')),
      onReadNote: (file) => store.readNote(file.token),
      onSaveNote: (file, md) => void store.saveNote(file.token, md).catch(fail('save the note')),
    };
    docMessage(docsView, 'Loading docs…');
    try {
      const [adrs, notes] = await Promise.all([store.listAdrs(), store.listNotes()]);
      docsView.innerHTML = '';
      docsView.appendChild(renderDocsPanel({ canWrite: store.canWrite, adrs, notes, renderMarkdown }, handlers));
      docsLoaded = true;
    } catch (e) {
      docMessage(docsView, 'Docs request failed: ' + String(e), 'error');
    }
  }

  const modelOutlineHandlers: ModelOutlineHandlers = {
    onSelect: (entry) => selection.set({ qualifiedName: entry.qualifiedName, context: entry.context }),
    goto: (line, col) => editor.goto(line, col),
    onOpenContextMap: () => selectBottomTab('contextmap'),
    onOpenGlossary: () => focusDocs(),
  };
  const inspectorHandlers: InspectorHandlers = {
    onGoto: (range) => editor.gotoRange(range.start, range.end),
    onRename: (element, newName) => void renameElement(element, newName),
    onSaveDescription: (element, text) => void saveInspectorDescription(element, text),
    // Property editing rides the same #91 round-trip the canvas uses (applyStructuredEdit), so editing a
    // field here rewrites the `.koi` AND re-renders the diagram + this panel in step.
    onAddProperty: (element, name, type) =>
      void applyStructuredEdit(
        { kind: 'addField', target: element.qualifiedName, name, type },
        `Added ${name}: ${type} to ${element.name}`,
      ),
    onRemoveProperty: (element, propName) =>
      void applyStructuredEdit(
        { kind: 'removeMember', target: `${element.qualifiedName}.${propName}` },
        `Removed ${propName} from ${element.name}`,
      ),
    onRenameProperty: (element, oldName, newName) =>
      void applyStructuredEdit(
        { kind: 'renameMember', target: `${element.qualifiedName}.${oldName}`, name: newName },
        `Renamed ${oldName} → ${newName}`,
      ),
    onChangeType: (element, propName, newType) =>
      void applyStructuredEdit(
        { kind: 'changeFieldType', target: `${element.qualifiedName}.${propName}`, type: newType },
        `Changed ${propName} to ${newType}`,
      ),
  };

  // Rename the selected element from the Properties panel, reusing the LSP rename refactor (the same
  // seam the editor's F2 uses): resolve the workspace edit at the element's name position, then apply it.
  async function renameElement(element: InspectorElement, newName: string): Promise<void> {
    try {
      const edit = await lsp.rename(element.nameRange.start.line, element.nameRange.start.character, newName);
      if (edit) applyWorkspaceEdit(edit);
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
      if (result.uri && result.uri !== activeUri && buffers.has(result.uri)) activateFile(result.uri);
      editor.applyEdits(result.edits);
    } catch (e) {
      setStatus('Saving description failed: ' + String(e), 'error');
    }
  }

  // The joined model index (#142, see modelIndex.ts): the workspace-merged glossary joined with the
  // richest matching `DiagramNode`. Cached and invalidated on edit; `indexPromise` de-dups concurrent
  // builders (a model reload AND a diagram click can both request it before the fetch resolves). The
  // inspector host (`inspectorHost`, above) is a fixed right-rail node, so a selection render always
  // has a live target — no detach/null dance.
  let modelIndex: ModelIndex | null = null;
  let indexPromise: Promise<ModelIndex> | null = null;

  /** Build (or reuse) the joined model index. `livingDocs` is best-effort — a glossary-only index still works. */
  function ensureModelIndex(): Promise<ModelIndex> {
    if (modelIndex) return Promise.resolve(modelIndex);
    indexPromise ??= Promise.all([
      lsp.glossaryModel(),
      lsp.livingDocs().catch(() => ({ files: [] }) as DocsResult),
    ])
      .then(([glossary, docs]) => (modelIndex = buildModelIndex(glossary, docs)))
      .finally(() => {
        indexPromise = null;
      });
    return indexPromise;
  }

  // Cross-highlight (#142, Task 4): mark the outline leaf — and the diagram node, best-effort — that
  // matches the current selection, so selecting in one surface lights up the other. `lookupElement`
  // resolves either key form to the canonical glossary qualified name (the outline leaves' key); the
  // SVG nodes key on `context.simpleName`, derived from the resolved element.
  function applySelectionHighlight(): void {
    const sel = selection.get();
    const hit = sel && modelIndex ? lookupElement(modelIndex, sel.qualifiedName) : null;
    const canonicalQn = hit?.canonicalQn ?? sel?.qualifiedName ?? null;
    for (const leaf of Array.from(explorerBody.querySelectorAll<HTMLElement>('.koi-model-leaf'))) {
      leaf.classList.toggle('is-selected', canonicalQn != null && leaf.dataset.qname === canonicalQn);
    }
    const ctxName = hit ? `${hit.element.entry.context}.${hit.element.entry.name}` : null;
    // Scope to the primary diagram SVG — the minimap (#145) clones the node layer as a decorative
    // thumbnail, so an unscoped query would also (wrongly) highlight the clone.
    for (const node of Array.from(diagramsView.querySelectorAll<HTMLElement>('.koi-svg-diagram .koi-svg-node'))) {
      node.classList.toggle('is-selected', ctxName != null && node.dataset.qname === ctxName);
    }
  }

  // Project the current selection through the index into an inspector element and (re)render it into
  // the right-rail Properties host. No index / no selection → the inspector's own empty state.
  function renderSelectedInspector(): void {
    const sel = selection.get();
    const hit = sel && modelIndex ? lookupElement(modelIndex, sel.qualifiedName) : null;
    const element: InspectorElement | null = hit
      ? buildInspectorElement(hit.element.entry, hit.element.node)
      : null;
    inspectorHost.replaceChildren(renderInspector(element, inspectorHandlers));
  }

  // Repaint the always-visible left rail: the Explorer construct tree + the Overview counts,
  // both scoped to the active bounded context (#146). The inspector resolves any selection against the
  // whole model, so only the navigator + counts are narrowed.
  async function loadModel(): Promise<void> {
    docMessage(explorerBody, 'Loading model…');
    try {
      const index = await ensureModelIndex();
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
        docViewsLoaded.model = true;
        return;
      }
      // Explorer = the construct tree with its inline counts suppressed; the dedicated Overview
      // section owns the tallies (renderOverviewCounts), so the two never double up.
      explorerBody.replaceChildren(renderModelOutline(scopedGlossary, modelOutlineHandlers, { counts: false }));
      overviewBody.replaceChildren(renderOverviewCounts(scopedGlossary));
      renderSelectedInspector();
      applySelectionHighlight();
      docViewsLoaded.model = true;
    } catch (e) {
      docMessage(explorerBody, 'Model request failed: ' + String(e), 'error');
    }
  }

  // The inspector + cross-highlight track the selection bus for the app's lifetime (a diagram click
  // can select an element while the Model tab is closed; opening it then shows the right inspector).
  selection.subscribe((sel) => {
    // Jump-to-source works across scope (the editor navigation is scope-independent), but a selection
    // landing OUTSIDE the active context would otherwise leave the scoped surfaces showing a different
    // context than the inspector. Follow it: switch the scope to the selected element's context so the
    // outline/diagram/counts stay coherent with what's being inspected (#146). This follow is view-only
    // (applyScope with persist=false) — a read-only inspect shouldn't overwrite the user's deliberately
    // chosen, persisted scope, so a reload returns to that choice. In-scope selections and the unscoped
    // ("All contexts") view leave the scope untouched. applyScope re-renders the scoped surfaces, which
    // also refreshes the inspector/cross-highlight for the Model tab — the explicit calls below cover the
    // cross-highlight when another view is active.
    if (sel && !isAllContexts(activeContext.get()) && sel.context !== activeContext.get()) {
      applyScope(sel.context, false);
    }
    renderSelectedInspector();
    applySelectionHighlight();
  });

  // Live domain diagrams: fetch the DocsEmitter output (Mermaid-in-Markdown) and render it.
  // Marked loaded only on success so a transient failure re-fetches on the next visit. A monotonic
  // token drops the result of a render that a newer one (edit / theme flip / refresh) superseded.
  let diagramsSeq = 0;
  async function loadDiagrams(): Promise<void> {
    const seq = ++diagramsSeq;
    docMessage(diagramsView, 'Rendering diagrams…');
    try {
      const res = await lsp.livingDocs();
      if (seq !== diagramsSeq) return;
      // Scope the diagrams to the active bounded context (#146): each diagram's graph is narrowed and
      // emptied diagrams/files drop out, so a context shows only its own diagrams. "All" is the identity.
      const files = scopeDocsFiles(res.files, activeContext.get());
      // Scope persisted node positions to this workspace so a folder restores its own manual layout.
      setDiagramPersistScope(contextWorkspaceKey());
      await renderDiagrams(diagramsView, files, currentTheme(), () => seq === diagramsSeq);
      if (seq === diagramsSeq) docViewsLoaded.diagrams = true;
    } catch (e) {
      if (seq === diagramsSeq) docMessage(diagramsView, 'Diagrams request failed: ' + String(e), 'error');
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

    if (!buffers.has(uri)) {
      const token = fileUriToPath(uri);
      if (token == null) return;
      const opened = await ensureBuffer(token);
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
    void loadDiagrams();
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
  diagramsView.addEventListener(DIAGRAM_ADD_TYPE_EVENT, () => void applyDiagramAddType());

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
    applyWorkspaceEdit(edit);
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
    applyWorkspaceEdit({ changes: { [result.uri]: result.edits } });
    setStatus(successMsg, 'green');
    return true;
  }

  // Drawing a relationship on the canvas = adding a field on the source typed as the target. The default
  // field name is the target's lower-cased simple name; the user can refine it (or cancel).
  async function applyDiagramConnect(detail: DiagramConnectDetail): Promise<void> {
    const targetSimple = detail.targetQualifiedName.slice(detail.targetQualifiedName.lastIndexOf('.') + 1);
    const suggested = targetSimple.charAt(0).toLowerCase() + targetSimple.slice(1);
    const fieldName = window.prompt(`Add a field on ${detail.sourceLabel} referencing ${detail.targetLabel}:`, suggested)?.trim();
    if (!fieldName) return;
    await applyStructuredEdit(
      { kind: 'addField', target: detail.sourceQualifiedName, name: fieldName, type: targetSimple },
      `Added ${fieldName}: ${targetSimple} to ${detail.sourceLabel}`,
    );
  }

  // Removing a relationship = removing the field that backs it.
  async function applyDiagramDisconnect(detail: DiagramDisconnectDetail): Promise<void> {
    if (!window.confirm(`Remove ${detail.label}? This rewrites the .koi source.`)) return;
    await applyStructuredEdit({ kind: 'removeMember', target: detail.backingMember }, `Removed ${detail.label}`);
  }

  // Adding a node = inserting a new value-object skeleton into the active context (addType). The canvas
  // doesn't know the contexts, so the target is the active scope; the user names the type.
  async function applyDiagramAddType(): Promise<void> {
    const scope = activeContext.get();
    if (isAllContexts(scope)) {
      setStatus('Pick a bounded context (top-left) before adding a type', 'error');
      return;
    }
    const name = window.prompt(`New value type in ${scope}:`, 'NewType')?.trim();
    if (!name) return;
    await applyStructuredEdit({ kind: 'addType', target: scope, name }, `Added ${name} to ${scope}`);
  }

  // Clicking a diagram node both jumps to its declaration AND selects it, so the element inspector
  // (#142) populates from the same gesture. A diagram node is named `context.simpleName`; map it back
  // to the canonical glossary qualified name (the selection key) through the index when it's reachable.
  async function selectFromDiagram(detail: DiagramNodeNavigateDetail): Promise<void> {
    const index = await ensureModelIndex().catch(() => null);
    const qualifiedName = index?.qnByCtxName.get(detail.qualifiedName) ?? detail.qualifiedName;
    selection.set({ qualifiedName, context: qualifiedName.split('.')[0] });
    await navigateToDiagramNode(detail);
  }

  // --- center (Visual / Code / Documentation) + right rail + region focus ----

  // The center column toggles between the visual diagram canvas, the technical code view (sub-tabs:
  // editor / emitted preview / compatibility check / assistant) and the Documentation view (sub-tabs:
  // Glossary / Docs — the ADR & Notes panel).
  type CenterView = 'visual' | 'technical' | 'docs';
  type TechView = 'editor' | 'preview' | 'check' | 'assistant';
  type DocsView = 'glossary' | 'adr';
  // The restored mode picks the initial center so the highlighted Domain/Code/Docs button and the
  // shown center tab agree on boot (Domain → Visual, Code → Code, Docs → Documentation).
  const centerForMode = (mode: string): CenterView => (mode === 'code' ? 'technical' : mode === 'docs' ? 'docs' : 'visual');
  let activeCenter: CenterView = centerForMode(activeMode);
  let activeTech: TechView = 'editor';
  let activeDocs: DocsView = 'glossary';

  const centerVisualEl = el('center-visual');
  const centerTechnicalEl = el('center-technical');
  const centerDocsEl = el('center-docs');
  const editorPaneEl = el('editor-pane');
  const previewEl = el('view-preview');
  const centerTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.center-tab'));
  const techTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.tech-tab'));
  const docsTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.docs-tab'));

  // Pure chrome: surface the active center panel + its technical sub-view and mark the tabs. No data
  // fetch, so the boot frame can land before the workspace document is open.
  function applyCenterChrome(): void {
    centerVisualEl.hidden = activeCenter !== 'visual';
    centerTechnicalEl.hidden = activeCenter !== 'technical';
    centerDocsEl.hidden = activeCenter !== 'docs';
    // The bottom strip (Problems/Events/Relationships/Context Map) sits under the canvas/editor — it
    // serves both Visual and Code, but not Documentation.
    diagEl.hidden = activeCenter === 'docs';
    for (const t of centerTabs) t.setAttribute('aria-selected', String(t.dataset.center === activeCenter));
    const techVisible = activeCenter === 'technical';
    editorPaneEl.hidden = !(techVisible && activeTech === 'editor');
    previewEl.hidden = !(techVisible && activeTech === 'preview');
    checkView.hidden = !(techVisible && activeTech === 'check');
    assistantView.hidden = !(techVisible && activeTech === 'assistant');
    for (const t of techTabs) t.setAttribute('aria-selected', String(t.dataset.tech === activeTech));
    // Documentation sub-views: Glossary (the ubiquitous language) vs the ADR/Notes Docs panel.
    const docsVisible = activeCenter === 'docs';
    glossaryView.hidden = !(docsVisible && activeDocs === 'glossary');
    docsView.hidden = !(docsVisible && activeDocs === 'adr');
    for (const t of docsTabs) t.setAttribute('aria-selected', String(t.dataset.docs === activeDocs));
    // CodeMirror measures lazily; revealing it from display:none leaves stale geometry until the next
    // layout tick, so force a re-measure whenever the editor becomes visible.
    if (!editorPaneEl.hidden) editor.view.requestMeasure();
  }

  function selectCenter(view: CenterView): void {
    activeCenter = view;
    applyCenterChrome();
    if (view === 'visual' && !docViewsLoaded.diagrams) void loadDiagrams();
    else if (view === 'technical') ensureTechLoaded();
    else if (view === 'docs') ensureDocsLoaded();
  }

  // Lazy-load the active Documentation sub-view: the glossary is model-derived, the Docs (ADR/Notes)
  // panel is folder-derived.
  function ensureDocsLoaded(): void {
    if (activeCenter !== 'docs') return;
    if (activeDocs === 'glossary' && !docViewsLoaded.glossary) void loadGlossary();
    else if (activeDocs === 'adr' && !docsLoaded) void loadDocs();
  }

  function selectDocsTab(view: DocsView): void {
    activeDocs = view;
    activeCenter = 'docs';
    applyCenterChrome();
    ensureDocsLoaded();
  }

  function selectTech(view: TechView): void {
    activeTech = view;
    activeCenter = 'technical';
    applyCenterChrome();
    ensureTechLoaded();
  }

  // Lazy-load the active technical sub-view: the emitted preview is the only model-derived one; the
  // editor is live, the check is on-demand, and the assistant is interactive (it re-points to the
  // current folder's conversation before focus, the single choke point for that swap).
  function ensureTechLoaded(): void {
    if (activeCenter !== 'technical') return;
    if (activeTech === 'preview' && !docViewsLoaded.preview) void loadPreview();
    else if (activeTech === 'assistant') {
      const a = ensureAssistant();
      a.syncWorkspace();
      a.focusInput();
    }
  }

  // Surface the Documentation center tab (the "Docs" mode focus and the Explorer's "Ubiquitous
  // Language" shortcut both route here).
  function focusDocs(): void {
    selectDocsTab('glossary');
  }

  // Repaint the always-visible left rail (Explorer + Overview + the right-rail Properties inspector) +
  // whatever the center is currently showing.
  function refreshActiveSurfaces(): void {
    void loadModel();
    if (activeCenter === 'visual') void loadDiagrams();
    // The glossary is model-derived (refresh on edit); the ADR/Notes Docs panel is folder-derived, so
    // an edit never invalidates it — it reloads on folder change / its own create/save.
    else if (activeCenter === 'docs' && activeDocs === 'glossary') void loadGlossary();
    else if (activeCenter === 'technical') ensureTechLoaded();
  }

  // Mark the cached, model-derived surfaces stale (e.g. after an edit or a file switch).
  function invalidateDocViews(): void {
    docViewsLoaded.preview = false;
    docViewsLoaded.model = false;
    docViewsLoaded.glossary = false;
    docViewsLoaded.diagrams = false;
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

  // The toolbar's Domain/Code/Docs buttons (#143) are kept as region-focus shortcuts now that every
  // view has a fixed home. Highlight the active button + persist the choice (only on a real change, so
  // re-selecting the same mode doesn't churn localStorage).
  function applyModeChrome(id: string): void {
    if (id !== activeMode) saveWorkspaceMode(id);
    activeMode = id;
    for (const btn of modeButtons) btn.setAttribute('aria-selected', String(btn.dataset.mode === id));
  }

  // Enter a mode from the header switcher: focus its region. Domain → the visual canvas, Code → the
  // technical code view, Docs → the Documentation rail (the center is left as-is for Docs).
  function selectMode(id: string): void {
    applyModeChrome(id);
    if (id === 'code') selectCenter('technical');
    else if (id === 'docs') focusDocs();
    else selectCenter('visual');
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

  // Right rail: Properties (the inspector) / Rules / Notes. Rules/Notes are placeholder panels for
  // now — the tab chrome matches the mockup while the inspector stays read-only.
  const rightTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.rtab'));
  const rightViews: Record<string, HTMLElement> = {
    props: inspectorHost,
    rules: el('rview-rules'),
    notes: el('rview-notes'),
  };
  function selectRightView(view: string): void {
    for (const t of rightTabs) t.setAttribute('aria-selected', String(t.dataset.rview === view));
    for (const [key, node] of Object.entries(rightViews)) node.hidden = key !== view;
  }
  for (const t of rightTabs) {
    t.addEventListener('click', () => selectRightView(t.dataset.rview as string));
  }

  // Boot the center chrome into the restored mode (no fetch — the boot flow's refreshActiveSurfaces
  // loads everything once the workspace document is open).
  applyModeChrome(activeMode);
  applyCenterChrome();

  // Check… — pick a baseline folder and diff the current buffer against it. Needs Stream F's
  // Rust dialog plugin + capability to function at runtime; the build does not depend on it.
  el<HTMLButtonElement>('btn-check').addEventListener('click', () => void runCheck());

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
      // The browser has no server-side filesystem: read the baseline sources here and pass them to
      // the in-process compiler. The desktop server reads the folder path itself.
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

  // Destination language for the emitted-code preview. The choice lives in Settings → Output
  // (persisted); this keeps a live copy and labels the "Generated" sub-tab with the active language.
  const LANGS: { id: PreviewTarget; name: string }[] = [
    { id: 'csharp', name: 'C#' },
    { id: 'typescript', name: 'TypeScript' },
    { id: 'python', name: 'Python' },
    { id: 'php', name: 'PHP' },
  ];
  let currentTarget: PreviewTarget = settings.previewTarget;

  const previewTabEl = el<HTMLButtonElement>('tech-tab-preview');

  function setTarget(target: PreviewTarget): void {
    currentTarget = target;
    const meta = LANGS.find((l) => l.id === target)!;
    previewTabEl.textContent = `Generated · ${meta.name}`;
  }

  // Emit the current target into the preview pane. Folded into the doc-view lifecycle (like the
  // glossary/diagrams tabs) so it loads on open and tracks edits live — no button press required. A
  // monotonic token drops a stale emit that a newer edit or target switch has superseded; the prior
  // output stays on screen across a refresh (only the very first load shows a placeholder) so live
  // typing never flashes the pane empty.
  let previewSeq = 0;
  async function loadPreview(): Promise<void> {
    const seq = ++previewSeq;
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
      docViewsLoaded.preview = true;
    } catch (e) {
      if (seq !== previewSeq) return;
      output.setContent('// preview request failed\n' + String(e), 'plain');
      lastPreview = '';
      copyBtn.disabled = true;
    }
  }

  // Label the "Generated" sub-tab with the persisted target on boot.
  setTarget(currentTarget);

  // --- open folder (directory-mode workspace) -------------------------------

  el<HTMLButtonElement>('btn-open-folder').addEventListener('click', () => void openFolder());

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
    await openFolderPath(folder);
  }

  // Open a set of file records as workspace buffers in one pass. Each record becomes an open
  // buffer keyed by its file:// uri and a corresponding LSP didOpen, so cross-file refs resolve.
  // The single seam shared by folder-open and shared-import — neither sets dirty,
  // neither activates (callers pick the active buffer).
  function populateBuffers(records: { path: string; relPath: string; name: string; text: string }[]): void {
    for (const rec of records) {
      const uri = pathToFileUri(rec.path);
      buffers.set(uri, { uri, path: rec.path, relPath: rec.relPath, name: rec.name, text: rec.text, dirty: false });
      lsp.openDoc(uri, rec.text);
    }
  }

  // Load + open every .koi file under `folder` as one workspace. Shared by the toolbar
  // button (which picks a folder first) and the welcome screen's recent-folder items
  // (which pass a known path directly).
  async function openFolderPath(folder: string, opts: { recent?: boolean } = {}): Promise<void> {
    welcome.hide();
    let files: KoiFile[];
    try {
      files = await platform.listKoiFiles(folder);
    } catch (e) {
      setStatus('could not read folder', 'error');
      console.error('listKoiFiles failed:', e);
      return;
    }
    if (!files.length) {
      setStatus('no .koi files in folder', 'error');
      return;
    }

    // Re-opening a folder: close every previously open file first.
    for (const uri of Array.from(buffers.keys())) {
      lsp.closeDoc(uri);
    }
    buffers.clear();
    diagnosticsByUri.clear();

    // Read + open every file as one workspace (cross-file refs resolve via didOpen). Read text
    // from disk first (skipping unreadable files), then hand the successful records to the shared
    // populateBuffers seam so folder-open and shared-import open files through one path.
    const records: { path: string; relPath: string; name: string; text: string }[] = [];
    for (const f of files) {
      let text: string;
      try {
        text = await platform.readTextFile(f.path);
      } catch (e) {
        console.error('readTextFile failed for', f.path, e);
        continue;
      }
      records.push({ path: f.path, relPath: f.relPath, name: f.name, text });
    }
    populateBuffers(records);

    // Every read failed after a non-empty listing (files deleted / permissions revoked
    // between list and read).
    if (buffers.size === 0) {
      setStatus('could not read any files in folder', 'error');
      return;
    }

    folderRootToken = folder;
    // Activate the first file (sorted by relPath) and show the tree.
    const first = Array.from(buffers.values()).sort((a, b) => a.relPath.localeCompare(b.relPath))[0];
    activeUri = first.uri;
    lsp.setActive(first.uri);
    editor.setDoc(first.text);
    treeTitleEl.textContent = platform.folderName(folder);
    showFileTreeChrome();
    if (opts.recent ?? true) pushRecentFolder(folder);
    // Restore this workspace's bounded-context scope (#146) BEFORE the first scoped render, and
    // refresh the switcher's options from the new model. The bus value drives the render paths, so the
    // initial ensureLoaded below is already scoped even before the dropdown finishes repainting.
    restoreActiveContext();
    invalidateDocViews();
    // The Docs surface is folder-derived (its own `docs/adr`+`docs/notes`), so a folder switch must
    // drop it too — unlike the model-derived views, an edit alone never invalidates it.
    docsLoaded = false;
    void refreshContextList();
    // Fetch the full explorer tree (dirs + .koi) and render it; falls back silently on failure.
    await refreshEntries();
    refreshActiveSurfaces();
  }

  // Boot/empty-state: open the host's persistent default workspace (creating + seeding it the first
  // time), then surface the welcome overlay only when it is pristine (a single untouched SEED model).
  async function openDefaultWorkspaceFlow(seed: string): Promise<void> {
    const token = await platform.defaultWorkspace(seed);
    if (!token) {
      setStatus("couldn't initialize a workspace", 'error');
      output.setContent('// Koine Studio needs OPFS (a modern browser) to store your model.', 'plain');
      return;
    }
    // Token confirmed — the workspace is open. Clear the legacy scratch key now so the migration
    // is non-destructive: content was never lost even if OPFS was unavailable on a prior load.
    clearLegacyScratch();
    await openFolderPath(token, { recent: false });
    const only = buffers.size === 1 ? Array.from(buffers.values())[0] : null;
    if (only && only.text === SEED) welcome.show();
  }

  // Open one shared model as a transient 1-file workspace (non-destructive: it does not touch the
  // user's default workspace). The hash is cleared by the caller so a reload returns home.
  async function openWorkspaceWith1File(text: string): Promise<void> {
    const token = await platform.materializeWorkspace('shared', [{ relPath: 'model.koi', contents: text }]);
    if (!token) {
      setStatus('could not open shared model', 'error');
      return;
    }
    await openFolderPath(token, { recent: false });
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
  // ran preventDefault, so this listener only persists.
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    if (overlayOpen()) return; // don't act on the editor under an open overlay
    // Mod+Alt+S → Save all. Match on e.code (the physical S key): on macOS, Option composes e.key
    // into another glyph (e.g. 'ß'), so `e.key === 's'` would miss the chord.
    if (e.altKey && e.code === 'KeyS') {
      e.preventDefault();
      void saveAllDirty();
    } else if (!e.altKey && (e.key === 's' || e.key === 'S')) {
      // Mod+S → save / format the active buffer (unchanged single-file behaviour).
      e.preventDefault();
      void saveActive();
    }
  });

  // Guard against closing/reloading with unsaved work: when any open buffer is dirty, the browser
  // shows its native "Leave site?" prompt. Dirty buffers live only in memory, so without this a tab
  // close silently drops them. On the desktop host this covers reloads; the window-close confirm is
  // wired separately in the Tauri host.
  function anyDirty(): boolean {
    return dirtyCount(buffers) > 0;
  }
  window.addEventListener('beforeunload', (e) => handleBeforeUnload(e, anyDirty));

  let saveQueued = false;
  async function saveActive(): Promise<void> {
    if (saveQueued) return;
    saveQueued = true;
    try {
      // Format first (mirrors the editor's Mod-S) when format-on-save is enabled, then persist.
      if (settings.formatOnSave) {
        try {
          const edits = await lsp.format();
          editor.applyEdits(edits);
        } catch (e) {
          console.error('format on save failed:', e);
        }
      }
      const buf = buffers.get(activeUri);
      if (!buf) return;
      buf.text = editor.getDoc();
      lsp.changeDoc(activeUri, buf.text);
      try {
        await platform.writeTextFile(buf.path, buf.text);
        buf.dirty = false;
        lsp.didSave();
        renderTree();
      } catch (e) {
        setStatus('save failed', 'error');
        console.error('writeTextFile failed:', e);
      }
    } finally {
      saveQueued = false;
    }
  }

  // Save EVERY dirty buffer (Mod+Alt+S / "Save all"), so editing several files and then closing
  // can't silently drop the ones you didn't individually Mod-S. Mirrors saveActive's format+write
  // but across the whole workspace: the active buffer is formatted + synced from the editor first
  // (the others already hold their edited text in memory), then each dirty buffer is written. A
  // per-file write failure leaves that buffer dirty and reports it; the rest still save. The
  // single-file Mod-S path (saveActive) is unchanged.
  let saveAllQueued = false;
  async function saveAllDirty(): Promise<void> {
    if (saveAllQueued) return;
    saveAllQueued = true;
    try {
      if (settings.formatOnSave) {
        try {
          editor.applyEdits(await lsp.format());
        } catch (e) {
          console.error('format on save failed:', e);
        }
      }
      const active = buffers.get(activeUri);
      if (active) {
        active.text = editor.getDoc();
        lsp.changeDoc(activeUri, active.text);
      }

      if (dirtyCount(buffers) === 0) {
        setStatus('No unsaved changes', 'green');
        return;
      }

      let failures = 0;
      const saved = await saveAllDirtyBuffers(buffers, {
        write: (buf) => platform.writeTextFile(buf.path, buf.text),
        onError: (buf, err) => {
          failures++;
          console.error('writeTextFile failed for', buf.path, err);
        },
      });
      if (saved > 0) {
        lsp.didSave();
        renderTree();
      }
      if (failures > 0) {
        setStatus(`Save failed for ${failures} file${failures === 1 ? '' : 's'}`, 'error');
      } else {
        setStatus(`Saved ${saved} file${saved === 1 ? '' : 's'}`, 'green');
      }
    } finally {
      saveAllQueued = false;
    }
  }

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
    for (const uri of Array.from(buffers.keys())) lsp.closeDoc(uri);
    buffers.clear();
    diagnosticsByUri.clear();
    await openFolderPath(token, { recent: false }); // activates model.koi (= BLANK) and renders the tree
    welcome.hide();
  }

  // Does the workspace hold unsaved work that New would destroy? Files live on disk,
  // so only a dirty open buffer is at risk.
  function hasUnsavedWork(): boolean {
    return Array.from(buffers.values()).some((b) => b.dirty);
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
    const token = await platform.materializeWorkspace(template.id, files);
    if (!token) {
      setStatus('could not open template', 'error');
      return;
    }
    await openFolderPath(token, { recent: false });
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
    await openFolderPath(token, { recent: false });
    // openFolderPath activates the first file by relPath; honour the share's `active` when present.
    if (active) {
      const target = Array.from(buffers.values()).find((b) => b.relPath === active);
      if (target) activateFile(target.uri);
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

  const welcome = createWelcome({
    onNewModel: () => void requestNewModel(),
    onOpenFolder: () => void leaveHomeFor('Open a folder?', () => openFolder()),
    onOpenRecent: (path) => void leaveHomeFor('Open this folder?', () => openFolderPath(path)),
    onOpenExample: (template) => void leaveHomeFor('Open this template?', () => openExample(template)),
  });

  const palette = createCommandPalette(() => getCommands());
  const prefs = createPreferences({
    onChange: (s) => {
      settings = s;
      // onChange is the single re-skin path: apply the document-level appearance, then sync the
      // pieces prefs can't reach — soft-wrap on both the source editor and the output preview.
      applyAppearance(s);
      editor.setLineWrap(s.wordWrap);
      output.setLineWrap(s.wordWrap);
      // Destination language now lives in Settings → Output. Adopt a change to the live target and
      // re-emit the Generated preview if it's the visible sub-view (else it reloads next open).
      if (s.previewTarget !== currentTarget) {
        setTarget(s.previewTarget);
        docViewsLoaded.preview = false;
        if (activeCenter === 'technical' && activeTech === 'preview') void loadPreview();
      }
    },
    // Desktop hosts launch a `koine mcp --http` sidecar and return its loopback URL; the browser
    // returns null, so Settings hides the MCP affordance there.
    mcpEndpoint: () => platform.mcpEndpoint(),
    mcpStop: () => platform.mcpStop(),
    // Only the desktop shell can host the sidecar; the web build shows recipes but disables the toggle.
    mcpHostable: platform.kind === 'tauri',
  });
  const help = createHelpOverlay(helpRows());
  const about = createAboutDialog();
  // Guards the user-initiated New command against silently discarding unsaved work.
  const confirmDialog = createConfirmDialog();

  // Desktop window-close guard (Tauri only): mirror the web beforeunload — confirm before closing
  // the window when any buffer is dirty. The browser host omits onCloseRequested (its beforeunload
  // guard already covers tab close / reload), so this is a no-op there.
  void platform.onCloseRequested?.(async () => {
    if (!anyDirty()) return true;
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
        const diagnostics = (diagnosticsByUri.get(activeUri) ?? []).map((d) => ({
          line: d.range.start.line + 1,
          col: d.range.start.character + 1,
          severity: (d.severity === 2 ? 'warning' : 'error') as 'warning' | 'error',
          message: d.message,
        }));
        const base: AssistantContext = {
          fileName: buffers.get(activeUri)?.name ?? 'model.koi',
          source: editor.getDoc(),
          diagnostics,
        };
        // The file/diagnostics snapshot above is cheap and per-call; the domain index is the expensive
        // part (two LSP recompiles), so build it once and reuse until the model changes (see
        // cachedDomainIndex / invalidateDocViews) rather than rebuilding it on every send.
        if (cachedDomainIndex === null) {
          cachedDomainIndex = { value: await buildDomainIndex() };
        }
        const domainIndex = cachedDomainIndex.value;
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
      getWorkspaceKey: () => folderRootToken ?? 'scratch',
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

  // Diagrams are rendered with a theme-matched Mermaid palette; re-render on a theme flip (covers
  // the toolbar toggle, the command palette, and Preferences — all route through setTheme).
  onThemeChange(() => {
    docViewsLoaded.diagrams = false;
    if (activeCenter === 'visual') void loadDiagrams();
  });

  // Copy a shareable playground link (the current model encoded in the URL hash) to the clipboard,
  // flashing a transient confirmation in the status pill. After the flash, re-derive the pill from
  // the CURRENT diagnostics rather than restoring a snapshot (which could clobber a fresh push).
  //
  // Shares the WHOLE workspace (every open buffer) under a versioned envelope, with the active file
  // flagged so the recipient lands on it. A workspace that overflows the URL-length cap is not
  // copied as a broken link — instead we steer the user to the `.koi` source zip export.
  async function copyShareLink(): Promise<void> {
    try {
      const files = Array.from(buffers.values()).map((b) => ({ relPath: b.relPath, text: b.text }));
      const activeRelPath = buffers.get(activeUri)?.relPath;
      const url = workspaceShareUrlOrNull(files, activeRelPath);
      if (url === null) {
        setStatus('Workspace too large to share as a link — export a .koi source zip instead', 'error');
        setTimeout(() => updateStatus(diagnosticsByUri.get(activeUri) ?? []), 1500);
        return;
      }
      await navigator.clipboard.writeText(url);
      setStatus('link copied ✓', 'green');
      setTimeout(() => updateStatus(diagnosticsByUri.get(activeUri) ?? []), 1500);
    } catch (e) {
      console.error('copy share link failed:', e);
    }
  }

  // Bundle every open `.koi` document into a zip and hand it to the host's saveZip seam (Blob
  // download in the browser, native picker on desktop). Names the archive after the opened folder.
  // The whole bundle is DOM-free in sourceZip.ts so it can be unit-tested in isolation.
  async function exportSourceZip(): Promise<void> {
    try {
      const files = Array.from(buffers.values()).map((b) => ({ relPath: b.relPath, text: b.text }));
      const root = sanitizeProjectName(platform.folderName(folderRootToken));
      const bytes = await buildSourceZip(files, { root });
      const saved = await platform.saveZip(`${root}.zip`, bytes);
      if (saved === true) {
        setStatus('source exported ✓', 'green');
        setTimeout(() => updateStatus(diagnosticsByUri.get(activeUri) ?? []), 1500);
      }
    } catch (e) {
      setStatus('export failed', 'error');
      console.error('export source zip failed:', e);
    }
  }

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

  // Bottom panel — draggable height (anchored to the center's bottom edge, since the strip lives inside
  // #center now) + collapse toggle + the Problems / Events / Relationships / Context Map tabs (issue
  // #144). `diagEl` and the panel refs/state are declared up top; this block adds the resizer, the
  // collapse toggle, the tab switching, and the lazy data loaders.
  initEdgeResizer({
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
    if (!collapsed) ensureBottomLoaded(activeBottomTab); // expanding → fill the active table if stale
  });

  // Tab switching: only the active panel body is shown; the count pill belongs to Problems. The first
  // time Events/Relationships is shown it loads lazily; clicking a tab also expands a collapsed panel.
  const bottomTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.diag-tab'));
  function selectBottomTab(tab: BottomTab): void {
    activeBottomTab = tab;
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

  // Row click → jump to the construct's `.koi` declaration, via the same span navigation the diagram uses.
  const bottomTableHandlers = { goto: (span: SourceSpan) => void gotoSourceSpan(span) };

  // The merged DiagramGraph projection behind both tables: every per-diagram graph from livingDocs fused
  // into one (node ids disambiguated) so the extractors see all aggregates + the integration-event flow
  // at once. It's the SAME source the diagram renders from, so the tables and the diagram never drift.
  // Narrowed to the active bounded context (#146) so the tables track the scope alongside every other
  // model-derived surface; "All contexts" is the identity, so the unscoped view is unchanged.
  async function bottomGraph() {
    const docs = await lsp.livingDocs();
    const merged = mergeDiagramGraphs(docs.files.flatMap((f) => f.diagrams.map((d) => d.graph)));
    return scopeGraph(merged, activeContext.get());
  }

  function ensureBottomLoaded(tab: BottomTab): void {
    if (tab === 'events' && !bottomLoaded.events) void loadEventsPanel();
    if (tab === 'relationships' && !bottomLoaded.relationships) void loadRelationshipsPanel();
    if (tab === 'contextmap' && !bottomLoaded.contextmap) void loadContextMapPanel();
  }

  // The "Context Map" tab: the strategic context map (moved here from a right-panel tab). A simple
  // monotonic guard mirrors the Events/Relationships loaders so a superseded fetch can't clobber a
  // newer render or mark the panel loaded with stale data.
  async function loadContextMapPanel(): Promise<void> {
    const seq = ++bottomSeq.contextmap;
    docMessage(contextMapView, 'Loading context map…');
    try {
      const res = await lsp.contextMap();
      if (seq !== bottomSeq.contextmap) return;
      contextMapView.innerHTML = `<div class="koi-md">${renderContextMapHtml(res)}</div>`;
      bottomLoaded.contextmap = true;
    } catch (e) {
      if (seq === bottomSeq.contextmap) docMessage(contextMapView, 'Context map request failed: ' + String(e), 'error');
    }
  }

  // Each loader is guarded by a per-panel monotonic token so a slow fetch superseded by an edit/refresh
  // can't clobber a newer render — AND can't mark the panel loaded with stale data: invalidation bumps
  // the token (below), so a superseded in-flight load fails its `seq !== bottomSeq` check before setting
  // `bottomLoaded`, leaving the panel due for a fresh reload. An empty/erroring model degrades to the
  // renderer's own empty-state (parse errors → no diagrams → "No events/relationships yet").
  const bottomSeq = { events: 0, relationships: 0, contextmap: 0 };
  async function loadEventsPanel(): Promise<void> {
    const seq = ++bottomSeq.events;
    docMessage(eventsPanel, 'Loading events…');
    try {
      const graph = await bottomGraph();
      if (seq !== bottomSeq.events) return;
      eventsPanel.replaceChildren(renderEventsTable(extractEvents(graph), bottomTableHandlers));
      bottomLoaded.events = true;
    } catch (e) {
      if (seq === bottomSeq.events) docMessage(eventsPanel, 'Events request failed: ' + String(e), 'error');
    }
  }

  async function loadRelationshipsPanel(): Promise<void> {
    const seq = ++bottomSeq.relationships;
    docMessage(relationshipsPanel, 'Loading relationships…');
    try {
      const [graph, ctxMap] = await Promise.all([
        bottomGraph(),
        lsp.contextMap().catch(() => ({ contexts: [], relations: [] }) as ContextMapResult),
      ]);
      if (seq !== bottomSeq.relationships) return;
      // bottomGraph() already scoped the structural edges; narrow the strategic relations too (#146) so a
      // scoped Relationships table keeps only the relations the active context takes part in (as upstream
      // or downstream). "All contexts" keeps every relation.
      const scope = activeContext.get();
      const scopedCtxMap = isAllContexts(scope)
        ? ctxMap
        : { ...ctxMap, relations: ctxMap.relations.filter((r) => r.upstream === scope || r.downstream === scope) };
      relationshipsPanel.replaceChildren(
        renderRelationshipsTable(extractRelationships(graph, scopedCtxMap), bottomTableHandlers),
      );
      bottomLoaded.relationships = true;
    } catch (e) {
      if (seq === bottomSeq.relationships) {
        docMessage(relationshipsPanel, 'Relationships request failed: ' + String(e), 'error');
      }
    }
  }

  // Mark the Events/Relationships tables stale (called from invalidateDocViews on any model change). The
  // token bump invalidates any in-flight load so a fetch that started against the old model can neither
  // render nor mark the panel loaded. If one is on screen and expanded, live-refresh it (debounced) so it
  // tracks edits like the inspector; Problems is refreshed by the diagnostics push, and a collapsed panel
  // reloads when next expanded.
  function invalidateBottomPanels(): void {
    bottomSeq.events++;
    bottomSeq.relationships++;
    bottomSeq.contextmap++;
    bottomLoaded.events = false;
    bottomLoaded.relationships = false;
    bottomLoaded.contextmap = false;
    if (activeBottomTab === 'problems' || diagEl.classList.contains('collapsed')) return;
    clearTimeout(bottomPanelDebounce);
    bottomPanelDebounce = setTimeout(() => ensureBottomLoaded(activeBottomTab), 350);
  }

  // Toolbar buttons unique to this phase.
  const hintEl = document.querySelector('.palette-hint');
  if (hintEl) {
    hintEl.textContent = formatChord('mod+K'); // ⌘+K / Ctrl+K per platform
    hintEl.addEventListener('click', () => palette.toggle());
  }
  el<HTMLButtonElement>('btn-home').addEventListener('click', () => goHome());
  el<HTMLButtonElement>('btn-new').addEventListener('click', () => void requestNewModel());
  el<HTMLButtonElement>('btn-generate-project').addEventListener('click', () => generateProject.open());
  el<HTMLButtonElement>('btn-theme').addEventListener('click', () => toggleTheme());
  el<HTMLButtonElement>('btn-prefs').addEventListener('click', () => prefs.open());
  el<HTMLButtonElement>('btn-about').addEventListener('click', () => about.open());

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
      { id: 'format', title: 'Format document', hint: 'mod+S', group: 'Edit', run: () => void formatActive() },
      { id: 'home', title: 'Go to start screen', group: 'File', run: () => goHome() },
      { id: 'open-folder', title: 'Open folder…', hint: 'mod+Shift+O', group: 'File', run: () => void openFolder() },
      { id: 'new-model', title: 'New model', hint: 'mod+N', group: 'File', run: () => void requestNewModel() },
      { id: 'save-all', title: 'Save all', hint: 'mod+Alt+S', group: 'File', run: () => void saveAllDirty() },
      { id: 'share', title: 'Copy shareable link', group: 'File', run: () => void copyShareLink() },
      { id: 'check', title: 'Check against baseline…', group: 'File', run: () => void runCheck() },
      { id: 'generate-project', title: 'Generate project…', group: 'File', run: () => generateProject.open() },
      { id: 'export-source-zip', title: 'Export .koi source (.zip)', group: 'File', run: () => void exportSourceZip() },
      { id: 'toggle-theme', title: 'Toggle theme', group: 'View', run: () => toggleTheme() },
      { id: 'prefs', title: 'Settings…', hint: 'mod+,', group: 'View', run: () => prefs.open() },
      { id: 'help', title: 'Keyboard shortcuts', hint: 'F1', group: 'Help', run: () => help.open() },
      { id: 'about', title: 'About Koine Studio', group: 'Help', run: () => about.open() },
      { id: 'view-preview', title: 'Show Emitted Preview', group: 'Workspace', run: () => selectTech('preview') },
      { id: 'view-glossary', title: 'Show Glossary', group: 'Workspace', run: () => selectDocsTab('glossary') },
      { id: 'view-docs', title: 'Show Docs (ADRs & Notes)', group: 'Workspace', run: () => selectDocsTab('adr') },
      { id: 'view-diagrams', title: 'Show Visual Editor', group: 'Workspace', run: () => selectCenter('visual') },
      { id: 'view-contextmap', title: 'Show Context Map', group: 'Workspace', run: () => selectBottomTab('contextmap') },
      { id: 'view-check', title: 'Show Compatibility Check', group: 'Workspace', run: () => selectTech('check') },
      { id: 'view-assistant', title: 'Show Assistant', group: 'Workspace', run: () => selectTech('assistant') },
      { id: 'assistant-explain', title: 'Explain this construct', group: 'Workspace', run: () => { selectTech('assistant'); ensureAssistant().explainSelection(); } },
    ];

    // Top-level workspace modes (#143): mirror the per-view "Show …" entries so modes are reachable
    // from the palette too. Built from MODES, so a new mode gets its command for free.
    for (const mode of MODES) {
      cmds.push({ id: `mode-${mode.id}`, title: `Switch to ${mode.label}`, group: 'Workspace', run: () => selectMode(mode.id) });
    }

    // Surface every open file as a "Go to File" entry so the palette doubles as a
    // fuzzy quick-open (type part of a path to jump). The palette re-reads this on each open.
    for (const buf of Array.from(buffers.values()).sort((a, b) => a.relPath.localeCompare(b.relPath))) {
      cmds.push({ id: 'goto:' + buf.uri, title: buf.relPath, group: 'Go to File', run: () => activateFile(buf.uri) });
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
    invalidateDocViews();
    refreshActiveSurfaces();
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
          await openWorkspaceWith1File(shared.text);
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
}
