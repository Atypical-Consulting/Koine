// Koine Studio app composition: wires the .koi editor, the live LSP diagnostics,
// the status line, the diagnostics strip, and the tabbed inspector (emitted preview,
// glossary, and context map).
import { createOutputView } from './editor';
import {
  KoineLsp,
  type GlossaryEntry,
  type Location,
  type SourceSpan,
  type StructuredEdit,
  type TextEdit,
  type WorkspaceEdit,
} from './lsp';
import {
  fileUriToPath,
  helpRows,
  isSafeShareRelPath,
  pathToFileUri,
} from './ideUtils';
import { createEditorSession } from './editorSession';
import { createInspectorController } from './inspectorController';
import { getPlatform, type FsEntry, type KoiFile } from './host';
import { createExplorer } from './explorer';
import { koineMark } from './logo';
import { initTheme, onThemeChange, toggleTheme } from './theme';
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
} from './store';
import { createWelcome } from './welcome';
import { type Template } from './templates';
import { createCommandPalette, type Command } from './palette';
import { MODES } from './modes';
import { createPreferences } from './prefs';
import { applyAppearance } from './appearance';
import { initSplitResizer, initEdgeResizer } from './resize';
import { createHelpOverlay } from './help';
import { createAboutDialog } from './about';
import { createGenerateProject } from './generateProjectWizard';
import { sanitizeProjectName } from './generateProject';
import { buildSourceZip } from './sourceZip';
import { formatChord } from './platform';
import {
  DIAGRAM_ADD_TYPE_EVENT,
  DIAGRAM_CONNECT_EVENT,
  DIAGRAM_DISCONNECT_EVENT,
  DIAGRAM_RELAYOUT_EVENT,
  NODE_EDIT_EVENT,
  NODE_NAVIGATE_EVENT,
  setDiagramEditing,
  type DiagramConnectDetail,
  type DiagramDisconnectDetail,
  type DiagramNodeEditDetail,
  type DiagramNodeNavigateDetail,
} from './diagrams-svg';
import { isAllContexts } from './activeContext';
import { type InspectorElement } from './inspector';
import { createAssistantPanel, type AssistantPanel, type AssistantContext } from './aiPanel';
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
  // shown in the editor and targeted by all lsp requests. The per-uri diagnostics cache lives
  // inside `editorSession` now (read/mutated through its accessors); switching files re-renders
  // the active one and the tree badges files with errors via those accessors.
  const buffers = new Map<string, Buffer>();
  let activeUri = '';
  // The opened-folder token and the last explorer tree fetched for it. The explorer is a *view*:
  // it renders this cached tree (re-reading dirty/diagnostics/active state via callbacks), while
  // the open .koi `buffers` remain the compiled workspace. Mutations refresh both.
  let folderRootToken: string = '';
  let entriesCache: FsEntry[] = [];

  // The editor ↔ LSP + diagnostics wiring (issue #180, Task 3): owns the CodeMirror editor and its
  // callback wall (hover/completion/definition/rename/references/code-actions → lsp.*), the per-uri
  // diagnostics cache, the status pill + diagnostics strip, and the LSP publishDiagnostics/exit
  // subscriptions. ide.ts keeps the buffer/dirty/tree side effects of an edit (wired through
  // editorSession.onChange below) and the workspace/model concerns.
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
    activeUri: () => activeUri,
    uriLabel: (uri) => buffers.get(uri)?.relPath ?? (uri.split('/').pop() ?? uri),
    onNavigate: (loc) => navigateToDefinition(loc),
    onApplyWorkspaceEdit: (edit) => applyWorkspaceEdit(edit),
    // Every diagnostics push re-renders the tree so non-active files can badge their error/warning
    // counts (the active file's gutter/strip/status are repainted inside editorSession first).
    onDiagnostics: () => renderTree(),
  });
  const editor = editorSession.editor;
  const setStatus = editorSession.setStatus;

  // The buffer/dirty/tree half of the editor's onChange (the editor↔LSP sync runs inside
  // editorSession). Preserves the original effect order: welcome.hide → buffer text+dirty →
  // onDocEdited → renderTree (only when the active file's dirty dot just appeared).
  editorSession.onChange((doc) => {
    // First edit dismisses the welcome overlay (shown only on a pristine first-run workspace).
    if (welcome.visible) welcome.hide();
    const buf = buffers.get(activeUri);
    let becameDirty = false;
    if (buf) {
      if (!buf.dirty && buf.text !== doc) becameDirty = true;
      buf.text = doc;
      if (becameDirty) buf.dirty = true;
    }
    controller.onDocEdited();
    // Re-render the tree only when the active file's dirty dot just appeared (cheap path).
    if (becameDirty) renderTree();
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

  // --- file tree ------------------------------------------------------------

  function diagCounts(uri: string): { errors: number; warnings: number } {
    const diags = editorSession.diagnosticsFor(uri);
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
        editorSession.dropDiagnostics(buf.uri);
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
      // Move the cached diagnostics with the buffer (no repaint — the gutter re-renders when the
      // active file's diagnostics are next shown / pushed), preserving the old re-key behavior.
      editorSession.renameDiagnostics(buf.uri, newUri);
      buf.uri = newUri;
      buf.path = newPath;
      buf.relPath = relOfToken(newPath);
      buf.name = nameOf(newPath);
      buffers.set(newUri, buf);
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
      editorSession.showDiagnostics(next.uri);
      controller.invalidateDocViews();
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
    editorSession.showDiagnostics(uri);
    controller.invalidateDocViews();
    renderTree();
    void controller.followActiveFileContext();
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
    controller.onDocEdited();
  }

  // Replace the active document's contents (used by the AI "Apply to editor" action). Setting the
  // editor doc dispatches a change, so the editor's onChange handler runs the full sync pipeline
  // (buffer text, lsp.changeDoc, doc-view refresh, tree) — don't repeat it here.
  function replaceActiveDoc(source: string): void {
    editor.setDoc(source);
  }

  // --- inspector / center-view / tab subsystem (extracted, src/inspectorController.ts) -------------
  // The mode switcher, center views (Visual / Code / Documentation), the bottom strip, the per-view
  // lazy loaders, the bounded-context scope (#146), and the selection-driven Properties inspector
  // (#142) all live in the controller now. ide.ts keeps only the editor↔LSP/buffer/workspace wiring
  // and the diagram-authoring + inspector WRITE path (below), which the controller triggers through
  // the injected callbacks. The controller creates + owns the `selection` and `activeContext` buses;
  // ide.ts reads them through these aliases for the diagram write-path and the active-file follow.
  const controller = createInspectorController({
    lsp,
    editor: { view: editor.view, goto: editor.goto, gotoRange: editor.gotoRange },
    output,
    platform,
    activeUri: () => activeUri,
    folderRootToken: () => folderRootToken,
    initialTarget: settings.previewTarget,
    saveWorkspaceMode,
    loadWorkspaceMode,
    saveActiveContext,
    loadActiveContext,
    setStatus,
    onRenameElement: (element, newName) => void renameElement(element, newName),
    onSaveElementDescription: (element, text) => void saveInspectorDescription(element, text),
    onSaveGlossaryDescription: (entry, text) => saveDescription(entry, text),
    onApplyStructuredEdit: (edit, successMsg) => void applyStructuredEdit(edit, successMsg),
    gotoSourceSpan: (span) => void gotoSourceSpan(span),
    ensureAssistant: () => ensureAssistant(),
    initEdgeResizer,
  });
  const { selection, activeContext } = controller;
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
    if (result.uri && result.uri !== activeUri && buffers.has(result.uri)) activateFile(result.uri);
    editor.applyEdits(result.edits);
  }

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
    const index = await controller.ensureModelIndex().catch(() => null);
    const qualifiedName = index?.qnByCtxName.get(detail.qualifiedName) ?? detail.qualifiedName;
    selection.set({ qualifiedName, context: qualifiedName.split('.')[0] });
    await navigateToDiagramNode(detail);
  }

  // Check… — pick a baseline folder and diff the current buffer against it. Owned by the controller
  // (it surfaces in the Code tab's Compatibility sub-view); the button + palette just trigger it.
  el<HTMLButtonElement>('btn-check').addEventListener('click', () => void controller.runCheck());

  // Boot the center chrome into the restored mode + label the Generated sub-tab (no fetch — the boot
  // flow's refreshActiveSurfaces loads everything once the workspace document is open).
  controller.init();

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
    editorSession.clearDiagnostics();

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
    controller.restoreActiveContext();
    controller.invalidateDocViews();
    // The Docs surface is folder-derived (its own `docs/adr`+`docs/notes`), so a folder switch must
    // drop it too — unlike the model-derived views, an edit alone never invalidates it.
    controller.invalidateDocsPanel();
    void controller.refreshContextList();
    // Fetch the full explorer tree (dirs + .koi) and render it; falls back silently on failure.
    await refreshEntries();
    controller.refreshActiveSurfaces();
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
    editorSession.clearDiagnostics();
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
        const diagnostics = editorSession.diagnosticsFor(activeUri).map((d) => ({
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
      const files = Array.from(buffers.values()).map((b) => ({ relPath: b.relPath, text: b.text }));
      const activeRelPath = buffers.get(activeUri)?.relPath;
      const url = workspaceShareUrlOrNull(files, activeRelPath);
      if (url === null) {
        setStatus('Workspace too large to share as a link — export a .koi source zip instead', 'error');
        setTimeout(() => editorSession.updateStatus(editorSession.diagnosticsFor(activeUri)), 1500);
        return;
      }
      await navigator.clipboard.writeText(url);
      setStatus('link copied ✓', 'green');
      setTimeout(() => editorSession.updateStatus(editorSession.diagnosticsFor(activeUri)), 1500);
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
        setTimeout(() => editorSession.updateStatus(editorSession.diagnosticsFor(activeUri)), 1500);
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

  // The bottom panel (resizer + collapse toggle + Problems / Events / Relationships / Context Map tabs
  // and their lazy loaders, issue #144) lives in the inspector controller now — it's wired there from
  // controller.init()'s construction. The diagnostics strip content (#diag-body / #diag-count) is still
  // owned by editorSession; the controller only toggles which bottom panel is visible.

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
      { id: 'check', title: 'Check against baseline…', group: 'File', run: () => void controller.runCheck() },
      { id: 'generate-project', title: 'Generate project…', group: 'File', run: () => generateProject.open() },
      { id: 'export-source-zip', title: 'Export .koi source (.zip)', group: 'File', run: () => void exportSourceZip() },
      { id: 'toggle-theme', title: 'Toggle theme', group: 'View', run: () => toggleTheme() },
      { id: 'prefs', title: 'Settings…', hint: 'mod+,', group: 'View', run: () => prefs.open() },
      { id: 'help', title: 'Keyboard shortcuts', hint: 'F1', group: 'Help', run: () => help.open() },
      { id: 'about', title: 'About Koine Studio', group: 'Help', run: () => about.open() },
      { id: 'view-preview', title: 'Show Emitted Preview', group: 'Workspace', run: () => controller.selectTech('preview') },
      { id: 'view-glossary', title: 'Show Glossary', group: 'Workspace', run: () => controller.selectDocsTab('glossary') },
      { id: 'view-docs', title: 'Show Docs (ADRs & Notes)', group: 'Workspace', run: () => controller.selectDocsTab('adr') },
      { id: 'view-diagrams', title: 'Show Visual Editor', group: 'Workspace', run: () => controller.selectCenter('visual') },
      { id: 'view-contextmap', title: 'Show Context Map', group: 'Workspace', run: () => controller.selectBottomTab('contextmap') },
      { id: 'view-check', title: 'Show Compatibility Check', group: 'Workspace', run: () => controller.selectTech('check') },
      { id: 'view-assistant', title: 'Show Assistant', group: 'Workspace', run: () => controller.selectTech('assistant') },
      { id: 'assistant-explain', title: 'Explain this construct', group: 'Workspace', run: () => { controller.selectTech('assistant'); ensureAssistant().explainSelection(); } },
    ];

    // Top-level workspace modes (#143): mirror the per-view "Show …" entries so modes are reachable
    // from the palette too. Built from MODES, so a new mode gets its command for free.
    for (const mode of MODES) {
      cmds.push({ id: `mode-${mode.id}`, title: `Switch to ${mode.label}`, group: 'Workspace', run: () => controller.selectMode(mode.id) });
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
