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
import { dirtyCount, saveAllDirtyBuffers } from '@/shell/dirty';
import { matchesInclude } from '@/shell/workspaceSearch';
import { pathToFileUri } from '@/shell/ideUtils';
import { basename } from '@/shared/path';
import type { FsEntry, KoiFile, Platform } from '@/host';
import type { TextEdit, WorkspaceEdit } from '@/lsp/lsp';

/** Outcome of an openFolderPath attempt, so callers (recent-open recovery) can react to a failure. */
export type OpenResult = { ok: true } | { ok: false; reason: 'unreadable' | 'empty' };

/** A client-side open buffer keyed by its file:// uri. Structural match for dirty.ts's SaveableBuffer. */
export interface Buffer {
  uri: string;
  path: string;
  relPath: string;
  name: string;
  text: string;
  dirty: boolean;
  /** The workspace root (from {@link WorkspaceController.rootsList}) this buffer's file lives under. */
  rootToken: string;
}

/** The slice of {@link import('@/lsp/lsp').KoineLsp} the workspace lifecycle drives (a spy in tests). */
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

/** The slice of the {@link import('@/editor/editor').KoineEditor} handle the workspace drives. */
export interface WorkspaceEditor {
  getDoc(): string;
  setDoc(doc: string): void;
  applyEdits(edits: TextEdit[]): void;
}

/** The slice of the {@link import('@/shell/explorer').Explorer} the tree render calls. */
export interface WorkspaceExplorer {
  /** Render one GROUP per workspace root (a single group renders headerless, like the legacy single-root render). */
  renderRoots(groups: { root: string; entries: FsEntry[] }[]): void;
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

  /** Action-feedback pill writer (ide.ts's editorSession.setStatus). */
  setStatus(text: string, kind: 'green' | 'error'): void;
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
  /**
   * Persist the last-opened workspace so a cold boot can restore it (ide.ts's setLastWorkspace, #535).
   * Skipped for transient opens (shared-link imports / the default-workspace flow), exactly like
   * {@link pushRecentFolder} — both are gated on the same `recent` flag.
   */
  rememberLastWorkspace?(folder: string): void;
  /** Folder display name written into the tree title (ide.ts's #filetree-title). */
  setFolderTitle?(name: string): void;
  /** Hide the welcome overlay (ide.ts's welcome.hide) — folder opens dismiss it. */
  hideWelcome?(): void;
}

export interface WorkspaceController {
  /** Every open document, keyed by its file:// uri (read by ide.ts for share/export/palette/etc.). */
  readonly buffers: Map<string, Buffer>;
  /** The uri the editor currently shows / all LSP requests target. */
  activeUri(): string;
  /**
   * The PRIMARY (first) workspace root token ('' before any folder opens). Back-compat shim over the
   * ordered {@link rootsList}: for the single-root case it is byte-identical to the opened folder, which
   * is what ide.ts / the inspector / the store slice still depend on.
   */
  folderRootToken(): string;
  /** Every workspace root, in add order (a copy); the first is the primary ({@link folderRootToken}). */
  rootsList(): string[];
  /** The last explorer entry tree fetched for the primary root. */
  entriesCache(): FsEntry[];

  // --- open paths ---
  /** Load + open every .koi under `folder` as one workspace; activate the first by relPath. */
  openFolderPath(folder: string, opts?: { recent?: boolean }): Promise<OpenResult>;
  /**
   * ADDITIVE: union a second folder's .koi files into the current workspace as a new root (appended to
   * {@link rootsList}), WITHOUT closing existing buffers or changing the active one. An already-present
   * root is a no-op `{ ok: true }`; an unreadable/empty folder reports the reason and is not appended.
   */
  addRoot(folder: string): Promise<OpenResult>;
  /**
   * Remove exactly `folder` from the workspace: close every buffer it owns (LSP closeDoc + drop their
   * diagnostics), drop its cached entries, splice it out of {@link rootsList}. If the active buffer was
   * one of the removed ones, re-point the active buffer via the fallback (or empty the workspace when no
   * buffers remain). A folder not in {@link rootsList} is a harmless no-op.
   */
  removeRoot(folder: string): void;
  /**
   * Boot/empty-state: open (or seed) the host default workspace. Returns `opened` (false when the host
   * can't back one — ide.ts shows the OPFS-needed message) and `pristineSeed` (the single buffer when
   * the workspace is one untouched seed model, so ide.ts can decide whether to surface the welcome).
   */
  openDefaultWorkspaceFlow(seed: string): Promise<{ opened: boolean; pristineSeed: Buffer | null }>;
  /** Open one shared model as a transient 1-file workspace (non-destructive). */
  openWorkspaceWith1File(text: string): Promise<void>;
  /**
   * Every `.koi` file uri under the open folder (the host walk's skip-list already applied), in
   * relPath order; `[]` when no folder is open. An optional comma-separated include glob narrows the
   * result the same way workspace search's `include` does. Used by the workspace search panel to know
   * which files to scan (it reads each one's text from the open buffer, or the host fs when closed).
   */
  listWorkspaceFiles(glob?: string): Promise<string[]>;
  /** Open a .koi file token as a buffer if needed; returns its uri (or null on failure). */
  ensureBuffer(token: string): Promise<string | null>;
  /** Open a file token (if needed) and make it the active editor buffer. */
  openFileToken(token: string): Promise<void>;
  /** Switch the editor + LSP to a different open buffer (flush-then-swap; fires onActiveChanged). */
  activateFile(uri: string): void;
  /**
   * Tear down all open state — close every LSP doc, clear the buffer set and the diagnostics cache —
   * WITHOUT opening anything. The caller is expected to open a fresh workspace next (e.g. New model
   * resets the default workspace then re-opens it); this guarantees the old buffers/diagnostics are
   * gone even if that re-open then fails (an empty/unreadable folder makes openFolderPath early-return
   * before its own teardown runs).
   */
  reset(): void;

  // --- save / dirty ---
  /** Format-then-write the active buffer to disk and clear its dirty flag. Re-entrancy guarded. */
  saveActive(): Promise<void>;
  /** Save every dirty buffer; a failed write stays dirty and is reported. Re-entrancy guarded. */
  saveAllDirty(): Promise<void>;
  /** Enable/disable idle auto-save; disabling cancels any pending debounce. */
  setAutoSave(on: boolean): void;
  /**
   * Arm (or re-arm) the idle auto-save debounce. Called from the editor's onChange on every edit; a
   * no-op when auto-save is off. On fire it runs the same persist as Save all (format-on-save → write
   * dirty buffers → didSave → tree refresh).
   */
  scheduleAutoSave(): void;
  /** True when any open buffer has unsaved changes (the unload / window-close guard). */
  anyDirty(): boolean;
  /**
   * The buffer/dirty half of the editor's onChange: write `doc` back into the active buffer and flip
   * it dirty on first change. Returns whether the active file's dirty dot just appeared (ide.ts
   * re-renders the tree only on that cheap transition). The editor↔LSP sync runs in editorSession.
   */
  syncActiveBuffer(doc: string): boolean;
  /**
   * The uri-keyed buffer/dirty sync: write `doc` into `uri`'s buffer and flip it dirty on first
   * change, returning whether that buffer's dirty dot just appeared. {@link syncActiveBuffer}
   * delegates here with the active uri; the second editor group (group B) routes its edits here with
   * B's CURRENT uri so a B edit never corrupts group A's (active) buffer (#265). A no-op (returns
   * false) when `uri` is not an open buffer.
   */
  syncBuffer(uri: string, doc: string): boolean;

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
  /**
   * Write a full-file body to `relPath`: update + persist an existing open buffer, or CREATE a new
   * file under the primary root and open it. Syncs the open buffer + LSP and clears its dirty flag.
   * Used by the assistant's multi-file apply. Returns the file uri, or null on failure.
   */
  applyFileEdit(relPath: string, body: string): Promise<string | null>;

  // --- seams (ide.ts wires editorSession/controller through these to avoid a circular import) ---
  /** Register the active-file-changed callback (ide.ts: showDiagnostics + invalidateDocViews + follow). */
  onActiveChanged(cb: (uri: string) => void): void;
  /** Register the buffer-set-changed callback (ide.ts re-renders the tree etc.). */
  onBuffersChanged(cb: () => void): void;
  /** Fired after the explorer entry tree is re-read (a folder open or any structural file op). */
  onEntriesRefreshed(cb: () => void): void;
  /**
   * Fired after a save writes buffer(s) to disk (single-file save, Save-all, or the assistant's
   * multi-file apply) — i.e. whenever a buffer's dirty flag was cleared by a successful `writeTextFile`.
   * ide.ts wires this to the Source Control panel's live refresh-on-save (#470): the on-disk git status
   * just changed, so re-fetch it when the SC tab is open.
   */
  onSaved(cb: () => void): void;
}

export function createWorkspaceController(deps: WorkspaceControllerDeps): WorkspaceController {
  const { platform, lsp, editor, explorer } = deps;

  // --- owned state ----------------------------------------------------------
  const buffers = new Map<string, Buffer>();
  let activeUriValue = '';
  // The workspace's roots in add order — the first is the PRIMARY root (the legacy single `folderRoot`).
  // Every emptiness guard that used `folderRoot === ''` is now `roots.length === 0`.
  let roots: string[] = [];
  // The explorer entry tree per root (Task 3 renders one group per root; this task still renders only
  // the primary root's slice through the unchanged single-root explorer.render signature).
  const entriesByRoot = new Map<string, FsEntry[]>();

  // --- outward seams --------------------------------------------------------
  let activeChanged: ((uri: string) => void) | null = null;
  let buffersChanged: (() => void) | null = null;
  let entriesRefreshed: (() => void) | null = null;
  // Fired after a successful disk write clears a buffer's dirty flag (#470 — SC live refresh-on-save).
  let onSavedCb: (() => void) | null = null;

  // --- token <-> path helpers (unchanged from ide.ts) -----------------------

  /**
   * The root in `roots` that `token` IS, or lives under (separator-aware). When several roots match
   * (a nested root), the LONGEST wins so a token under the inner root resolves to it. Returns undefined
   * when no root owns the token (e.g. before any folder opens, or a foreign path).
   */
  function rootOfToken(token: string): string | undefined {
    let best: string | undefined;
    for (const root of roots) {
      if (token === root || token.startsWith(root + '/') || token.startsWith(root + '\\')) {
        if (best === undefined || root.length > best.length) best = root;
      }
    }
    return best;
  }

  /** The root-relative, forward-slashed path of a token under its OWNING root ('' for the root itself).
   *  Falls back to the token unchanged when no root owns it (preserving the single-root behavior). */
  function relOfToken(token: string): string {
    const root = rootOfToken(token);
    if (root === undefined) return token;
    if (token === root) return '';
    return token.slice(root.length + 1).replace(/\\/g, '/');
  }

  /** True if `path` is the token itself or lives under the `ancestor` directory token (any separator). */
  function isUnder(path: string, ancestor: string): boolean {
    return path === ancestor || path.startsWith(ancestor + '/') || path.startsWith(ancestor + '\\');
  }

  function nameOf(token: string): string {
    return basename(token);
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
    if (roots.length === 0) return;
    // Feed the explorer EVERY root's entries (one render group per root, in add order). The explorer
    // renders a single group headerless (byte-identical to the old single-root path) and 2+ groups with
    // per-root headers + a Remove affordance.
    explorer.renderRoots(roots.map((r) => ({ root: r, entries: entriesByRoot.get(r) ?? [] })));
  }

  /** Re-read EVERY root's entry tree from the host (into entriesByRoot) and re-render the explorer. */
  async function refreshEntries(): Promise<void> {
    if (roots.length === 0) return;
    for (const root of roots) {
      try {
        entriesByRoot.set(root, await platform.listEntries(root));
      } catch (e) {
        console.error('listEntries failed:', e);
      }
    }
    renderTree();
    entriesRefreshed?.();
  }

  // --- open paths -----------------------------------------------------------

  // Every .koi uri under the open folder, reusing the host walk (which already skips bin/obj/.git/
  // node_modules — see fs.ts SKIP_DIRS). The optional glob narrows the set through the same engine
  // workspace search's `include` uses. Returns [] (not an error) when no folder is open or the walk
  // fails, so the search panel degrades to "no results" rather than throwing.
  async function listWorkspaceFiles(glob?: string): Promise<string[]> {
    if (roots.length === 0) return [];
    const uris: string[] = [];
    for (const root of roots) {
      let files: KoiFile[];
      try {
        files = await platform.listKoiFiles(root);
      } catch (e) {
        console.error('listKoiFiles failed:', e);
        continue; // one unreadable root shouldn't blank the whole workspace's search set
      }
      for (const f of files) uris.push(pathToFileUri(f.path));
    }
    return glob && glob.trim() !== '' ? uris.filter((uri) => matchesInclude(uri, glob)) : uris;
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
    // ensureBuffer runs OUTSIDE the open flow (roots is already populated), so the owning root is
    // derivable; fall back to the primary root for a token that no root owns (matches relOfToken).
    const rootToken = rootOfToken(token) ?? roots[0] ?? '';
    buffers.set(uri, {
      uri,
      path: token,
      relPath: relOfToken(token),
      name: nameOf(token),
      text,
      dirty: false,
      rootToken,
    });
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
    if (roots.length === 0) return;
    for (const root of roots) {
      let files: KoiFile[];
      try {
        files = await platform.listKoiFiles(root);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!buffers.has(pathToFileUri(f.path))) await ensureBuffer(f.path);
      }
    }
  }

  // Open a set of file records as workspace buffers in one pass, all owned by `rootToken`. Each record
  // becomes an open buffer keyed by its file:// uri and a corresponding LSP didOpen, so cross-file (and
  // cross-root) refs resolve. The single seam shared by folder-open and addRoot — neither sets dirty,
  // neither activates (callers pick the active buffer). The owning root is passed in explicitly because
  // openFolderPath calls this BEFORE it assigns `roots` (so rootOfToken can't yet resolve it).
  function populateBuffers(
    rootToken: string,
    records: { path: string; relPath: string; name: string; text: string }[],
  ): void {
    for (const rec of records) {
      const uri = pathToFileUri(rec.path);
      buffers.set(uri, {
        uri,
        path: rec.path,
        relPath: rec.relPath,
        name: rec.name,
        text: rec.text,
        dirty: false,
        rootToken,
      });
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

  // Close every open LSP doc, drop the buffer set, and clear the diagnostics cache — no re-open.
  // Used by the New-model reset so stale buffers/diagnostics can't survive a subsequent open that
  // early-returns (e.g. the reset deleted everything but re-creating model.koi failed).
  function reset(): void {
    clearAutoSaveTimer(); // tearing the workspace down — cancel any armed auto-save first
    for (const uri of Array.from(buffers.keys())) {
      lsp.closeDoc(uri);
    }
    buffers.clear();
    deps.clearDiagnostics();
  }

  // Load + open every .koi file under `folder` as one workspace. Shared by the toolbar
  // button (which picks a folder first) and the welcome screen's recent-folder items
  // (which pass a known path directly).
  async function openFolderPath(folder: string, opts: { recent?: boolean } = {}): Promise<OpenResult> {
    let files: KoiFile[];
    try {
      files = await platform.listKoiFiles(folder);
    } catch (e) {
      deps.setStatus('could not read folder', 'error');
      console.error('listKoiFiles failed:', e);
      return { ok: false, reason: 'unreadable' };
    }
    if (!files.length) {
      // Only surface the global red error when no model is currently loaded. A populated workspace
      // means this empty listing is a spurious/late re-scan (e.g. the materialized-example race in
      // #627, where compile-green renders first and an empty folder scan arrives after); raising the
      // error here would clobber the healthy status with a false "no .koi files in folder". The
      // emptiness is checked BEFORE the reset below, so `buffers` still reflects the loaded workspace.
      if (buffers.size === 0) deps.setStatus('no .koi files in folder', 'error');
      return { ok: false, reason: 'empty' };
    }

    // Re-opening a folder is a RESET to a single root: close every previously open file first and drop
    // the multi-root state (every prior root's buffers + cached entries).
    clearAutoSaveTimer(); // a pending auto-save belongs to the workspace we're leaving — drop it
    for (const uri of Array.from(buffers.keys())) {
      lsp.closeDoc(uri);
    }
    buffers.clear();
    entriesByRoot.clear();
    roots = [];
    deps.clearDiagnostics();

    // Read + open every file as one workspace (cross-file refs resolve via didOpen). Read text
    // from disk first (skipping unreadable files), then hand the successful records to the shared
    // populateBuffers seam so folder-open and addRoot open files through one path. The owning root is
    // passed explicitly because `roots` is assigned only AFTER this (the construction-order gotcha).
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
    populateBuffers(folder, records);

    // Every read failed after a non-empty listing (files deleted / permissions revoked
    // between list and read).
    if (buffers.size === 0) {
      deps.setStatus('could not read any files in folder', 'error');
      return { ok: false, reason: 'unreadable' };
    }

    roots = [folder];
    // Activate the first file (sorted by relPath).
    const first = Array.from(buffers.values()).sort((a, b) => a.relPath.localeCompare(b.relPath))[0];
    activeUriValue = first.uri;
    lsp.setActive(first.uri);
    editor.setDoc(first.text);
    deps.hideWelcome?.(); // dismiss the start screen only now that the open has succeeded
    deps.setFolderTitle?.(platform.folderName(folder));
    // NB: opening a workspace no longer auto-switches the rail to the Files axis — the rail defaults to
    // (and stays on) Domain, the DDD navigator. The file tree is one click away (the Files axis button /
    // ⌘B), and the Domain navigator's "Reveal in Files" still switches deliberately.
    if (opts.recent ?? true) {
      deps.pushRecentFolder?.(folder);
      // Remember this as the last-opened workspace so a reload restores it (#535). Gated on the same
      // `recent` flag as pushRecentFolder, so transient opens (shared-link import via
      // openWorkspaceWith1File, the default-workspace flow) don't overwrite the pointer.
      deps.rememberLastWorkspace?.(folder);
    }
    // ide.ts restores this workspace's bounded-context scope BEFORE the first scoped render and
    // refreshes the doc surfaces. The bus value drives the render paths, so the initial ensureLoaded
    // is already scoped even before the dropdown finishes repainting.
    deps.onFolderOpened(folder, { recent: opts.recent ?? true });
    // Fetch the full explorer tree (dirs + .koi) and render it; falls back silently on failure.
    await refreshEntries();
    return { ok: true };
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

  // ADDITIVE multi-root open: union `folder`'s .koi files into the workspace as a new root. Unlike
  // openFolderPath this closes NOTHING and does NOT change the active buffer — it appends `folder` to
  // `roots` and opens its files through the shared populateBuffers seam (each gets an lsp.openDoc so
  // cross-root refs resolve), then refreshes the per-root entries.
  async function addRoot(folder: string): Promise<OpenResult> {
    // Already a root → no-op success (don't re-read or re-open anything).
    if (roots.includes(folder)) return { ok: true };

    let files: KoiFile[];
    try {
      files = await platform.listKoiFiles(folder);
    } catch (e) {
      deps.setStatus('could not read folder', 'error');
      console.error('listKoiFiles failed:', e);
      return { ok: false, reason: 'unreadable' };
    }
    if (!files.length) {
      // addRoot is additive, so a loaded workspace is the normal case — an empty union must not raise
      // the global red error and clobber the healthy status (#627). Only surface it when nothing is
      // loaded (buffers.size === 0); the caller still gets reason:'empty' and the root isn't appended.
      if (buffers.size === 0) deps.setStatus('no .koi files in folder', 'error');
      return { ok: false, reason: 'empty' };
    }

    // Read each file's text (skip unreadable ones, like openFolderPath) and open them stamped with this
    // root. The owning root is passed explicitly because the buffers are opened BEFORE `folder` is in
    // `roots` (so rootOfToken couldn't resolve it yet).
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
    populateBuffers(folder, records);

    roots.push(folder);
    await refreshEntries();
    return { ok: true };
  }

  // Remove exactly `folder` from the workspace: close every buffer it owns (LSP closeDoc + drop its
  // diagnostics), drop its cached entries, splice it out of `roots`. If the active buffer was one of the
  // removed ones, re-point active via the existing activateFallback (which falls back to another open
  // buffer, or calls onWorkspaceEmptied when none remain — so removing the LAST root empties the
  // workspace). A folder not in `roots` is a harmless no-op.
  function removeRoot(folder: string): void {
    const idx = roots.indexOf(folder);
    if (idx < 0) return; // not a root — nothing to do

    let activeRemoved = false;
    for (const buf of [...buffers.values()]) {
      if (buf.rootToken !== folder) continue;
      if (buf.uri === activeUriValue) activeRemoved = true;
      lsp.closeDoc(buf.uri);
      buffers.delete(buf.uri);
      deps.dropDiagnostics(buf.uri);
    }
    entriesByRoot.delete(folder);
    roots.splice(idx, 1);
    if (activeRemoved) activateFallback();
    // Re-render the explorer (and re-sync the dirty indicator via renderTree → refreshDirtyIndicator)
    // so the removed root's group + rows disappear immediately. Unlike handleDelete, removeRoot has no
    // trailing refreshEntries; without this the removed group would linger (clickable, but its buffers
    // are gone) until some unrelated render fires. A now-empty workspace renders nothing (roots.length
    // === 0), and onWorkspaceEmptied's fresh-model open will render once it seeds a new root.
    renderTree();
  }

  // --- workspace mutations (create / rename / delete / move) -----------------
  // The explorer surfaces user intent as opaque tokens; these handlers do the host fs op, then keep
  // `buffers` / `activeUri` / the LSP workspace coherent and refresh the tree. relPaths handed to the
  // host are relative to the OWNING root of the operated token (rootOfToken), so multi-root ops target
  // the right folder; for the single-root case the owning root is always the primary root, identical
  // to the old `folderRoot`.

  async function handleNewFile(parentDirToken: string, name: string): Promise<void> {
    if (roots.length === 0) return;
    const owningRoot = rootOfToken(parentDirToken) ?? roots[0];
    const parentRel = relOfToken(parentDirToken);
    // The explorer only surfaces directories and .koi files, so default an extensionless name to
    // `.koi` — otherwise the created file would be invisible (listEntries filters it out) and the
    // user would think New File silently failed.
    const fileName = name.includes('.') ? name : `${name}.koi`;
    const relPath = parentRel ? `${parentRel}/${fileName}` : fileName;
    try {
      const token = await platform.createFile(owningRoot, relPath, '');
      await refreshEntries();
      if (token.toLowerCase().endsWith('.koi')) await openFileToken(token);
    } catch (e) {
      deps.setStatus('could not create file', 'error');
      console.error('createFile failed:', e);
    }
  }

  async function handleNewFolder(parentDirToken: string, name: string): Promise<void> {
    if (roots.length === 0) return;
    const owningRoot = rootOfToken(parentDirToken) ?? roots[0];
    const parentRel = relOfToken(parentDirToken);
    const relPath = parentRel ? `${parentRel}/${name}` : name;
    try {
      await platform.createFolder(owningRoot, relPath);
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
    if (roots.length === 0) return;
    const owningRoot = rootOfToken(entry.token) ?? roots[0];
    const parentRel = relOfToken(parentTokenOf(entry.token) ?? owningRoot);
    // Try "<base> copy", then "<base> copy 2", … until the host accepts a non-colliding name.
    for (let i = 1; i <= 50; i++) {
      const dupName = copyName(entry.name, i, entry.kind === 'file');
      const relPath = parentRel ? `${parentRel}/${dupName}` : dupName;
      try {
        const token = await platform.moveEntry(entry.token, owningRoot, relPath, true);
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
    if (roots.length === 0) return;
    // The move targets the destination's owning root (a cross-root drag reparents into that root).
    const owningRoot = rootOfToken(destDirToken) ?? roots[0];
    const destRel = relOfToken(destDirToken);
    const newRelPath = destRel ? `${destRel}/${entry.name}` : entry.name;
    let newToken: string;
    try {
      newToken = await platform.moveEntry(entry.token, owningRoot, newRelPath, false);
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
      // Re-derive the owning root: a cross-root move changes it; an in-root rename keeps it. Fall back
      // to the existing rootToken when no root owns the new path (mirrors ensureBuffer's resolution).
      buf.rootToken = rootOfToken(newPath) ?? buf.rootToken;
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

  // Write one full-file body to `relPath` for the assistant's multi-file apply. An EXISTING open buffer
  // (matched by relPath) is updated in place — reflected in the editor when it's the active one (so the
  // change shows + fires onChange), synced to the LSP, persisted, and left CLEAN. A relPath with no open
  // buffer is CREATED under the primary root and opened. Returns the file uri, or null on failure.
  async function applyFileEdit(relPath: string, body: string): Promise<string | null> {
    const existing = [...buffers.values()].find((b) => b.relPath === relPath);
    if (existing) {
      if (existing.uri === activeUriValue) editor.setDoc(body); // reflect in the open editor (fires onChange → dirty)
      existing.text = body;
      lsp.changeDoc(existing.uri, body);
      try {
        await platform.writeTextFile(existing.path, body);
      } catch (e) {
        console.error('applyFileEdit write failed:', e);
        return null;
      }
      existing.dirty = false; // set AFTER setDoc's onChange so the buffer ends clean
      if (existing.uri === activeUriValue) lsp.didSave(); // didSave() targets the ACTIVE doc — only valid then
      deps.refreshDirtyIndicator();
      renderTree(); // setDoc's onChange repainted the explorer dirty dot; repaint it clean now
      onSavedCb?.(); // #470: this buffer hit disk — refresh the SC panel if its tab is open
      return existing.uri;
    }
    const owningRoot = roots[0];
    if (!owningRoot) return null;
    try {
      const token = await platform.createFile(owningRoot, relPath, body); // new file under the folder root
      await refreshEntries();
      onSavedCb?.(); // #470: a new (untracked) file hit disk — refresh the SC panel if its tab is open
      return await ensureBuffer(token);
    } catch (e) {
      console.error('applyFileEdit create failed:', e);
      return null;
    }
  }

  // --- buffer / dirty sync --------------------------------------------------

  // The buffer/dirty half of the editor's onChange. ide.ts keeps welcome.hide + controller.onDocEdited
  // around this and re-renders the tree on the returned becameDirty (preserving the original order).
  // Uri-keyed so the second editor group (group B) can sync its OWN file's buffer without touching the
  // active (group-A) buffer (#265): a no-op when `uri` is not an open buffer.
  function syncBuffer(uri: string, doc: string): boolean {
    const buf = buffers.get(uri);
    let becameDirty = false;
    if (buf) {
      if (!buf.dirty && buf.text !== doc) becameDirty = true;
      buf.text = doc;
      if (becameDirty) buf.dirty = true;
    }
    return becameDirty;
  }

  // The active-buffer convenience wrapper used by group A's onChange: identical behavior to the
  // pre-#265 syncActiveBuffer, now expressed as syncBuffer(activeUri, doc).
  function syncActiveBuffer(doc: string): boolean {
    return syncBuffer(activeUriValue, doc);
  }

  // --- save (format + write to disk) ----------------------------------------

  function anyDirty(): boolean {
    return dirtyCount(buffers) > 0;
  }

  let saveQueued = false;
  async function saveActive(): Promise<void> {
    if (saveQueued) return;
    saveQueued = true;
    clearAutoSaveTimer(); // an explicit save subsumes any pending idle auto-save
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
        onSavedCb?.(); // #470: the on-disk git status changed — refresh the SC panel if its tab is open
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
    clearAutoSaveTimer(); // a manual Save all subsumes any pending idle auto-save (no-op when auto-save fired this)
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
        onSavedCb?.(); // #470: at least one buffer hit disk — refresh the SC panel if its tab is open
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

  // --- idle auto-save (#268) ------------------------------------------------
  // Opt-in: when enabled, every edit (re)arms a ~1000ms timer; on fire it persists through the exact
  // saveAllDirty path (format-on-save, didSave, tree refresh, the saveAllQueued guard against an
  // in-flight manual save). Disabling cancels any pending timer so a stale edit can't write after the
  // user turns it off.
  const AUTO_SAVE_DEBOUNCE_MS = 1000;
  let autoSaveOn = false;
  let autoSaveTimer: ReturnType<typeof setTimeout> | undefined;

  function clearAutoSaveTimer(): void {
    if (autoSaveTimer !== undefined) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = undefined;
    }
  }

  function setAutoSave(on: boolean): void {
    autoSaveOn = on;
    if (!on) clearAutoSaveTimer();
  }

  function scheduleAutoSave(): void {
    // Arm only when auto-save is on AND there is actually unsaved work. The editor's onChange fires on
    // every programmatic setDoc too (a file switch, a history restore, the first folder open), which
    // dirties nothing — without this guard each such swap would arm a timer that 1s later runs a no-op
    // saveAllDirty and clobbers the status line with "No unsaved changes".
    if (!autoSaveOn || dirtyCount(buffers) === 0) return;
    clearAutoSaveTimer();
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = undefined;
      // Yield to an in-flight manual save (Mod-S saveActive / Save all) rather than racing format +
      // write on the same buffer; the next edit re-arms the debounce.
      if (saveQueued || saveAllQueued) return;
      void saveAllDirty();
    }, AUTO_SAVE_DEBOUNCE_MS);
  }

  return {
    buffers,
    activeUri: () => activeUriValue,
    // Back-compat: the PRIMARY root (the legacy single opened folder); '' before any folder opens.
    folderRootToken: () => roots[0] ?? '',
    rootsList: () => [...roots],
    // Back-compat: the PRIMARY root's entry tree (Task 3 surfaces the per-root map to the explorer).
    entriesCache: () => entriesByRoot.get(roots[0] ?? '') ?? [],
    openFolderPath,
    openDefaultWorkspaceFlow,
    openWorkspaceWith1File,
    addRoot,
    removeRoot,
    listWorkspaceFiles,
    ensureBuffer,
    openFileToken,
    activateFile,
    reset,
    saveActive,
    saveAllDirty,
    setAutoSave,
    scheduleAutoSave,
    anyDirty,
    syncActiveBuffer,
    syncBuffer,
    handleNewFile,
    handleNewFolder,
    handleDelete,
    handleRename,
    handleDuplicate,
    handleMove,
    refreshEntries,
    renderTree,
    applyWorkspaceEdit,
    applyFileEdit,
    onActiveChanged(cb) {
      activeChanged = cb;
    },
    onBuffersChanged(cb) {
      buffersChanged = cb;
    },
    onEntriesRefreshed(cb) {
      entriesRefreshed = cb;
    },
    onSaved(cb) {
      onSavedCb = cb;
    },
  };
}
