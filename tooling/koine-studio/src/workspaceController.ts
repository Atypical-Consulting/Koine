// workspaceController: the workspace lifecycle — the open buffer set, the open/save/dirty paths,
// the explorer-driven file mutations, and the cross-buffer WorkspaceEdit application — lifted out of
// ide.ts's init() (Task 5 of the ide.ts decomposition, issue #180).
//
// It OWNS `buffers` (every open document keyed by its file:// uri), `activeUri` (the one shown in
// the editor and targeted by all LSP requests), `folderRootToken` (the opened folder), and
// `entriesCache` (the last explorer tree fetched for that folder). It does NOT own the per-uri
// diagnostics cache — that lives in editorSession (Task 3); the open/activate/mutation paths reach
// it through the injected accessors (showDiagnostics / dropDiagnostics / renameDiagnostics /
// clearDiagnostics).
//
// The construction-order cycle (editorSession + inspectorController are built BEFORE this and read
// `activeUri`/`folderRootToken` via injected thunks, while this calls back into them) is resolved
// WITHOUT a circular import: this module imports neither. Inbound effects come through deps
// (the editor handle, the LSP slice, the diagnostics accessors, the explorer, setStatus); outbound
// effects fire through the `onActiveChanged(uri)` / `onBuffersChanged()` seams, which ide.ts wires to
// editorSession.showDiagnostics + controller.invalidateDocViews/followActiveFileContext and the tree
// render respectively. The accessors are only invoked at runtime, so ide.ts can pass
// `() => workspace.activeUri()` thunks that resolve after this is constructed.
import { dirtyCount, saveAllDirtyBuffers } from './dirty';
import { pathToFileUri } from './ideUtils';
import type { FsEntry, KoiFile, Platform } from './host';
import type { TextEdit, WorkspaceEdit } from './lsp';

/** A client-side open buffer keyed by its file:// uri. Structural match for dirty.ts's SaveableBuffer. */
export interface Buffer {
  uri: string;
  path: string;
  relPath: string;
  name: string;
  text: string;
  dirty: boolean;
}

/** The slice of {@link import('./lsp').KoineLsp} the workspace lifecycle drives (a spy in tests). */
export interface WorkspaceLsp {
  openDoc(uri: string, text: string): void;
  closeDoc(uri: string): void;
  changeDoc(uri: string, text: string): void;
  syncDoc(uri: string, text: string): void;
  setActive(uri: string): void;
  flush(): void;
  didSave(): void;
  format(): Promise<TextEdit[]>;
}

/** The slice of the {@link import('./editor').KoineEditor} handle the workspace drives. */
export interface WorkspaceEditor {
  getDoc(): string;
  setDoc(doc: string): void;
  applyEdits(edits: TextEdit[]): void;
}

/** The slice of the {@link import('./explorer').Explorer} the tree render calls. */
export interface WorkspaceExplorer {
  render(entries: FsEntry[], rootToken: string): void;
}

export interface WorkspaceControllerDeps {
  /** The host backend (folder/file I/O). */
  platform: Platform;
  /** The LSP client (doc sync + format/save). */
  lsp: WorkspaceLsp;
  /** The live editor handle (doc swap + applyEdits). */
  editor: WorkspaceEditor;
  /** The file explorer view the tree renders into. */
  explorer: WorkspaceExplorer;

  /** Status pill writer (ide.ts's editorSession.setStatus). */
  setStatus(text: string, kind: 'connecting' | 'green' | 'error'): void;
  /** Refresh the global unsaved-indicator (title bullet + pill) from the current dirty count. */
  refreshDirtyIndicator(): void;

  // The editorSession diagnostics accessors (the cache lives there — Task 3).
  /** Repaint the editor + strip + status from `uri`'s cached diagnostics (a file switch / fallback). */
  showDiagnostics(uri: string): void;
  /**
   * Invalidate the controller's model-derived doc views so they re-fetch. Used by the delete-fallback
   * path (which repaints the next file WITHOUT firing the full onActiveChanged seam, matching the old
   * activateFallback's narrower effect set: showDiagnostics + invalidateDocViews only).
   */
  invalidateDocViews(): void;
  /** Forget the cached diagnostics for `uri` (a delete). */
  dropDiagnostics(uri: string): void;
  /** Move cached diagnostics from `oldUri` to `newUri` (a rename/move). */
  renameDiagnostics(oldUri: string, newUri: string): void;
  /** Forget every cached diagnostic (a workspace swap). */
  clearDiagnostics(): void;

  /** Whether format-on-save is enabled (read live from ide.ts's `settings`). */
  getFormatOnSave(): boolean;

  /** Fired once a folder finished opening: ide.ts restores context + refreshes the doc surfaces. */
  onFolderOpened(folder: string, opts: { recent: boolean }): void;
  /** Fired when the active buffer was deleted and the workspace is now empty: ide.ts opens a new model. */
  onWorkspaceEmptied(): void;

  /** Persist a recently-opened folder (ide.ts's pushRecentFolder); skipped for transient workspaces. */
  pushRecentFolder?(folder: string): void;
  /** Folder display name written into the tree title (ide.ts's #filetree-title). */
  setFolderTitle?(name: string): void;
  /** Reveal the file-tree chrome after a folder opens (ide.ts's showFileTreeChrome). */
  showFileTreeChrome?(): void;
  /** Hide the welcome overlay (ide.ts's welcome.hide) — folder opens dismiss it. */
  hideWelcome?(): void;
}

export interface WorkspaceController {
  /** Every open document, keyed by its file:// uri (read by ide.ts for share/export/palette/etc.). */
  readonly buffers: Map<string, Buffer>;
  /** The uri the editor currently shows / all LSP requests target. */
  activeUri(): string;
  /** The opened-folder token ('' before a folder opens). */
  folderRootToken(): string;
  /** The last explorer entry tree fetched for the opened folder. */
  entriesCache(): FsEntry[];

  // --- open paths ---
  /** Load + open every .koi under `folder` as one workspace; activate the first by relPath. */
  openFolderPath(folder: string, opts?: { recent?: boolean }): Promise<void>;
  /**
   * Boot/empty-state: open (or seed) the host default workspace. Returns `opened` (false when the host
   * can't back one — ide.ts shows the OPFS-needed message) and `pristineSeed` (the single buffer when
   * the workspace is one untouched seed model, so ide.ts can decide whether to surface the welcome).
   */
  openDefaultWorkspaceFlow(seed: string): Promise<{ opened: boolean; pristineSeed: Buffer | null }>;
  /** Open one shared model as a transient 1-file workspace (non-destructive). */
  openWorkspaceWith1File(text: string): Promise<void>;
  /** Open a .koi file token as a buffer if needed; returns its uri (or null on failure). */
  ensureBuffer(token: string): Promise<string | null>;
  /** Open a file token (if needed) and make it the active editor buffer. */
  openFileToken(token: string): Promise<void>;
  /** Switch the editor + LSP to a different open buffer (flush-then-swap; fires onActiveChanged). */
  activateFile(uri: string): void;

  // --- save / dirty ---
  /** Format-then-write the active buffer to disk and clear its dirty flag. Re-entrancy guarded. */
  saveActive(): Promise<void>;
  /** Save every dirty buffer; a failed write stays dirty and is reported. Re-entrancy guarded. */
  saveAllDirty(): Promise<void>;
  /** True when any open buffer has unsaved changes (the unload / window-close guard). */
  anyDirty(): boolean;
  /**
   * The buffer/dirty half of the editor's onChange: write `doc` back into the active buffer and flip
   * it dirty on first change. Returns whether the active file's dirty dot just appeared (ide.ts
   * re-renders the tree only on that cheap transition). The editor↔LSP sync runs in editorSession.
   */
  syncActiveBuffer(doc: string): boolean;

  // --- mutations (explorer-driven) ---
  handleNewFile(parentDirToken: string, name: string): Promise<void>;
  handleNewFolder(parentDirToken: string, name: string): Promise<void>;
  handleDelete(entry: FsEntry): Promise<void>;
  handleRename(entry: FsEntry, newName: string): Promise<void>;
  handleDuplicate(entry: FsEntry): Promise<void>;
  handleMove(entry: FsEntry, destDirToken: string): Promise<void>;
  /** Re-read the folder's entry tree from the host and re-render the explorer. */
  refreshEntries(): Promise<void>;
  /** Re-render the explorer from the cached entry tree (also syncs the unsaved indicator). */
  renderTree(): void;

  // --- workspace edits ---
  /** Apply a rename/code-action WorkspaceEdit across open buffers (active via editor, others patched). */
  applyWorkspaceEdit(edit: WorkspaceEdit): void;

  // --- seams (ide.ts wires editorSession/controller through these to avoid a circular import) ---
  /** Register the active-file-changed callback (ide.ts: showDiagnostics + invalidateDocViews + follow). */
  onActiveChanged(cb: (uri: string) => void): void;
  /** Register the buffer-set-changed callback (ide.ts re-renders the tree etc.). */
  onBuffersChanged(cb: () => void): void;
}

export function createWorkspaceController(deps: WorkspaceControllerDeps): WorkspaceController {
  const { platform, lsp, editor, explorer } = deps;

  // --- owned state ----------------------------------------------------------
  const buffers = new Map<string, Buffer>();
  let activeUriValue = '';
  let folderRoot = '';
  let entries: FsEntry[] = [];

  // --- outward seams --------------------------------------------------------
  let activeChanged: ((uri: string) => void) | null = null;
  let buffersChanged: (() => void) | null = null;

  // --- token <-> path helpers (unchanged from ide.ts) -----------------------

  /** The folder-relative, forward-slashed path of a token under the opened folder ('' for the root). */
  function relOfToken(token: string): string {
    if (folderRoot === '' || token === folderRoot) return '';
    if (token.startsWith(folderRoot + '/') || token.startsWith(folderRoot + '\\')) {
      return token.slice(folderRoot.length + 1).replace(/\\/g, '/');
    }
    return token;
  }

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

  // --- tree render ----------------------------------------------------------

  // Re-render the explorer from the cached entry tree. Cheap to call on any state change (dirty,
  // diagnostics, active file) — the explorer reads those per row via the callbacks.
  function renderTree(): void {
    // Sync the global unsaved indicator on every tree render — this is the common path for every
    // dirty transition (edit, save, save-all, cross-file rename, workspace swap).
    deps.refreshDirtyIndicator();
    if (folderRoot === '') return;
    explorer.render(entries, folderRoot);
  }

  /** Re-read the folder's entry tree from the host and re-render the explorer. */
  async function refreshEntries(): Promise<void> {
    if (folderRoot === '') return;
    try {
      entries = await platform.listEntries(folderRoot);
    } catch (e) {
      console.error('listEntries failed:', e);
    }
    renderTree();
  }

  // --- open paths -----------------------------------------------------------

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

  // Open any .koi file present in the folder but not yet buffered (used after creating/duplicating
  // folders that may introduce new .koi files), so the compiled workspace stays complete.
  async function syncOpenKoi(): Promise<void> {
    if (folderRoot === '') return;
    let files: KoiFile[];
    try {
      files = await platform.listKoiFiles(folderRoot);
    } catch {
      return;
    }
    for (const f of files) {
      if (!buffers.has(pathToFileUri(f.path))) await ensureBuffer(f.path);
    }
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

  // Switch the editor + lsp to a different open buffer. Saves the current editor text back to
  // the leaving buffer first (preserving unsaved edits), swaps the doc, points lsp at the new
  // uri, then fires onActiveChanged (ide.ts re-renders diagnostics + invalidates the doc views).
  function activateFile(uri: string): void {
    if (uri === activeUriValue) return;
    // Flush the leaving file's debounced edits to the server before switching: the shared change
    // timer is re-armed for the new file on setDoc below, which would otherwise drop them.
    lsp.flush();
    const leaving = buffers.get(activeUriValue);
    if (leaving) leaving.text = editor.getDoc();
    const next = buffers.get(uri);
    if (!next) return;
    activeUriValue = uri;
    lsp.setActive(uri);
    editor.setDoc(next.text);
    activeChanged?.(uri);
  }

  // After the active buffer is deleted, fall back to another open file, or open a new blank model
  // when the workspace is now empty. NOTE: this repaints the next file through showDiagnostics +
  // invalidateDocViews ONLY — it deliberately does NOT fire onActiveChanged (no followActiveFileContext
  // / tree render here), matching the old activateFallback; handleDelete's trailing refreshEntries
  // re-renders the tree.
  function activateFallback(): void {
    const next = Array.from(buffers.values()).sort((a, b) => a.relPath.localeCompare(b.relPath))[0];
    if (next) {
      activeUriValue = next.uri;
      lsp.setActive(next.uri);
      editor.setDoc(next.text);
      deps.showDiagnostics(next.uri);
      deps.invalidateDocViews();
      return;
    }
    // Empty workspace: reset to a fresh blank model (ide.ts owns the BLANK reset).
    deps.onWorkspaceEmptied();
  }

  // Load + open every .koi file under `folder` as one workspace. Shared by the toolbar
  // button (which picks a folder first) and the welcome screen's recent-folder items
  // (which pass a known path directly).
  async function openFolderPath(folder: string, opts: { recent?: boolean } = {}): Promise<void> {
    deps.hideWelcome?.();
    let files: KoiFile[];
    try {
      files = await platform.listKoiFiles(folder);
    } catch (e) {
      deps.setStatus('could not read folder', 'error');
      console.error('listKoiFiles failed:', e);
      return;
    }
    if (!files.length) {
      deps.setStatus('no .koi files in folder', 'error');
      return;
    }

    // Re-opening a folder: close every previously open file first.
    for (const uri of Array.from(buffers.keys())) {
      lsp.closeDoc(uri);
    }
    buffers.clear();
    deps.clearDiagnostics();

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
      deps.setStatus('could not read any files in folder', 'error');
      return;
    }

    folderRoot = folder;
    // Activate the first file (sorted by relPath) and show the tree.
    const first = Array.from(buffers.values()).sort((a, b) => a.relPath.localeCompare(b.relPath))[0];
    activeUriValue = first.uri;
    lsp.setActive(first.uri);
    editor.setDoc(first.text);
    deps.setFolderTitle?.(platform.folderName(folder));
    deps.showFileTreeChrome?.();
    if (opts.recent ?? true) deps.pushRecentFolder?.(folder);
    // ide.ts restores this workspace's bounded-context scope BEFORE the first scoped render and
    // refreshes the doc surfaces. The bus value drives the render paths, so the initial ensureLoaded
    // is already scoped even before the dropdown finishes repainting.
    deps.onFolderOpened(folder, { recent: opts.recent ?? true });
    // Fetch the full explorer tree (dirs + .koi) and render it; falls back silently on failure.
    await refreshEntries();
  }

  // Boot/empty-state: open the host's persistent default workspace (creating + seeding it the first
  // time). Returns `opened` (false when the host can't back one) and the single seed buffer when the
  // workspace is pristine (one untouched seed model) — ide.ts uses these to clear the legacy scratch
  // key, show the OPFS-needed message, and decide whether to surface the welcome overlay.
  async function openDefaultWorkspaceFlow(seed: string): Promise<{ opened: boolean; pristineSeed: Buffer | null }> {
    const token = await platform.defaultWorkspace(seed);
    if (!token) {
      deps.setStatus("couldn't initialize a workspace", 'error');
      return { opened: false, pristineSeed: null };
    }
    await openFolderPath(token, { recent: false });
    const only = buffers.size === 1 ? Array.from(buffers.values())[0] : null;
    return { opened: true, pristineSeed: only && only.text === seed ? only : null };
  }

  // Open one shared model as a transient 1-file workspace (non-destructive: it does not touch the
  // user's default workspace). The hash is cleared by the caller so a reload returns home.
  async function openWorkspaceWith1File(text: string): Promise<void> {
    const token = await platform.materializeWorkspace('shared', [{ relPath: 'model.koi', contents: text }]);
    if (!token) {
      deps.setStatus('could not open shared model', 'error');
      return;
    }
    await openFolderPath(token, { recent: false });
  }

  // --- workspace mutations (create / rename / delete / move) -----------------
  // The explorer surfaces user intent as opaque tokens; these handlers do the host fs op, then keep
  // `buffers` / `activeUri` / the LSP workspace coherent and refresh the tree. relPaths handed to
  // the host are always relative to the opened folder (folderRoot).

  async function handleNewFile(parentDirToken: string, name: string): Promise<void> {
    if (folderRoot == null) return;
    const parentRel = relOfToken(parentDirToken);
    // The explorer only surfaces directories and .koi files, so default an extensionless name to
    // `.koi` — otherwise the created file would be invisible (listEntries filters it out) and the
    // user would think New File silently failed.
    const fileName = name.includes('.') ? name : `${name}.koi`;
    const relPath = parentRel ? `${parentRel}/${fileName}` : fileName;
    try {
      const token = await platform.createFile(folderRoot, relPath, '');
      await refreshEntries();
      if (token.toLowerCase().endsWith('.koi')) await openFileToken(token);
    } catch (e) {
      deps.setStatus('could not create file', 'error');
      console.error('createFile failed:', e);
    }
  }

  async function handleNewFolder(parentDirToken: string, name: string): Promise<void> {
    if (folderRoot == null) return;
    const parentRel = relOfToken(parentDirToken);
    const relPath = parentRel ? `${parentRel}/${name}` : name;
    try {
      await platform.createFolder(folderRoot, relPath);
      await refreshEntries();
    } catch (e) {
      deps.setStatus('could not create folder', 'error');
      console.error('createFolder failed:', e);
    }
  }

  async function handleDelete(entry: FsEntry): Promise<void> {
    try {
      await platform.deleteEntry(entry.token);
    } catch (e) {
      deps.setStatus('could not delete', 'error');
      console.error('deleteEntry failed:', e);
      return;
    }
    // Close every open buffer at or under the deleted token; re-point active if it was one of them.
    let activeRemoved = false;
    for (const buf of [...buffers.values()]) {
      if (isUnder(buf.path, entry.token)) {
        if (buf.uri === activeUriValue) activeRemoved = true;
        lsp.closeDoc(buf.uri);
        buffers.delete(buf.uri);
        deps.dropDiagnostics(buf.uri);
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
      deps.setStatus('could not rename', 'error');
      console.error('renameEntry failed:', e);
      return;
    }
    rekeyBuffers(entry.token, newToken);
    await refreshEntries();
  }

  async function handleDuplicate(entry: FsEntry): Promise<void> {
    if (folderRoot == null) return;
    const parentRel = relOfToken(parentTokenOf(entry.token) ?? folderRoot);
    // Try "<base> copy", then "<base> copy 2", … until the host accepts a non-colliding name.
    for (let i = 1; i <= 50; i++) {
      const dupName = copyName(entry.name, i, entry.kind === 'file');
      const relPath = parentRel ? `${parentRel}/${dupName}` : dupName;
      try {
        const token = await platform.moveEntry(entry.token, folderRoot, relPath, true);
        await refreshEntries();
        if (entry.kind === 'file' && token.toLowerCase().endsWith('.koi')) await openFileToken(token);
        else await syncOpenKoi(); // a duplicated folder may contain new .koi files
        return;
      } catch (e) {
        // A collision means "try the next candidate name".
        if (isAlreadyExists(e)) continue;
        deps.setStatus('could not duplicate', 'error');
        console.error('duplicate failed:', e);
        return;
      }
    }
    // Every candidate name collided — don't fail silently.
    deps.setStatus('could not duplicate (too many copies)', 'error');
  }

  // Drag-and-drop move: reparent `entry` into `destDirToken` (the opened folder for root), keeping its
  // name. The explorer already rejects no-op and into-own-subtree drops, so this just performs the host
  // move and re-keys the open buffers / LSP workspace, mirroring rename.
  async function handleMove(entry: FsEntry, destDirToken: string): Promise<void> {
    if (folderRoot == null) return;
    const destRel = relOfToken(destDirToken);
    const newRelPath = destRel ? `${destRel}/${entry.name}` : entry.name;
    let newToken: string;
    try {
      newToken = await platform.moveEntry(entry.token, folderRoot, newRelPath, false);
    } catch (e) {
      // A name clash at the destination is the common, recoverable case — surface it, don't overwrite.
      if (isAlreadyExists(e)) {
        deps.setStatus(`“${entry.name}” already exists there`, 'error');
      } else {
        deps.setStatus('could not move', 'error');
        console.error('moveEntry failed:', e);
      }
      return;
    }
    rekeyBuffers(entry.token, newToken);
    await refreshEntries();
    if (entry.kind === 'dir') await syncOpenKoi(); // moved folder may carry .koi files to re-key
  }

  // Re-key every buffer at/under `oldToken` to its path under `newToken` (a file or folder rename/
  // move), preserving each buffer's unsaved text + dirty flag and keeping the LSP workspace in sync.
  function rekeyBuffers(oldToken: string, newToken: string): void {
    for (const buf of [...buffers.values()]) {
      if (!isUnder(buf.path, oldToken)) continue;
      const newPath = newToken + buf.path.slice(oldToken.length);
      const newUri = pathToFileUri(newPath);
      const wasActive = buf.uri === activeUriValue;
      lsp.closeDoc(buf.uri);
      buffers.delete(buf.uri);
      // Move the cached diagnostics with the buffer (no repaint — the gutter re-renders when the
      // active file's diagnostics are next shown / pushed), preserving the old re-key behavior.
      deps.renameDiagnostics(buf.uri, newUri);
      buf.uri = newUri;
      buf.path = newPath;
      buf.relPath = relOfToken(newPath);
      buf.name = nameOf(newPath);
      buffers.set(newUri, buf);
      lsp.openDoc(newUri, buf.text);
      if (wasActive) {
        activeUriValue = newUri;
        lsp.setActive(newUri);
      }
    }
  }

  // --- workspace edits ------------------------------------------------------

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
      if (uri === activeUriValue) {
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
    buffersChanged?.();
  }

  // --- buffer / dirty sync --------------------------------------------------

  // The buffer/dirty half of the editor's onChange. ide.ts keeps welcome.hide + controller.onDocEdited
  // around this and re-renders the tree on the returned becameDirty (preserving the original order).
  function syncActiveBuffer(doc: string): boolean {
    const buf = buffers.get(activeUriValue);
    let becameDirty = false;
    if (buf) {
      if (!buf.dirty && buf.text !== doc) becameDirty = true;
      buf.text = doc;
      if (becameDirty) buf.dirty = true;
    }
    return becameDirty;
  }

  // --- save (format + write to disk) ----------------------------------------

  function anyDirty(): boolean {
    return dirtyCount(buffers) > 0;
  }

  let saveQueued = false;
  async function saveActive(): Promise<void> {
    if (saveQueued) return;
    saveQueued = true;
    try {
      // Format first (mirrors the editor's Mod-S) when format-on-save is enabled, then persist.
      if (deps.getFormatOnSave()) {
        try {
          const edits = await lsp.format();
          editor.applyEdits(edits);
        } catch (e) {
          console.error('format on save failed:', e);
        }
      }
      const buf = buffers.get(activeUriValue);
      if (!buf) return;
      buf.text = editor.getDoc();
      lsp.changeDoc(activeUriValue, buf.text);
      try {
        await platform.writeTextFile(buf.path, buf.text);
        buf.dirty = false;
        lsp.didSave();
        renderTree();
      } catch (e) {
        deps.setStatus('save failed', 'error');
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
      if (deps.getFormatOnSave()) {
        try {
          editor.applyEdits(await lsp.format());
        } catch (e) {
          console.error('format on save failed:', e);
        }
      }
      const active = buffers.get(activeUriValue);
      if (active) {
        active.text = editor.getDoc();
        lsp.changeDoc(activeUriValue, active.text);
      }

      if (dirtyCount(buffers) === 0) {
        deps.setStatus('No unsaved changes', 'green');
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
        deps.setStatus(`Save failed for ${failures} file${failures === 1 ? '' : 's'}`, 'error');
      } else {
        deps.setStatus(`Saved ${saved} file${saved === 1 ? '' : 's'}`, 'green');
      }
    } finally {
      saveAllQueued = false;
    }
  }

  return {
    buffers,
    activeUri: () => activeUriValue,
    folderRootToken: () => folderRoot,
    entriesCache: () => entries,
    openFolderPath,
    openDefaultWorkspaceFlow,
    openWorkspaceWith1File,
    ensureBuffer,
    openFileToken,
    activateFile,
    saveActive,
    saveAllDirty,
    anyDirty,
    syncActiveBuffer,
    handleNewFile,
    handleNewFolder,
    handleDelete,
    handleRename,
    handleDuplicate,
    handleMove,
    refreshEntries,
    renderTree,
    applyWorkspaceEdit,
    onActiveChanged(cb) {
      activeChanged = cb;
    },
    onBuffersChanged(cb) {
      buffersChanged = cb;
    },
  };
}
