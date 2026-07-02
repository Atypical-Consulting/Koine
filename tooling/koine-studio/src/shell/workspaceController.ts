// workspaceController: the workspace lifecycle — the open buffer set, the open/save/dirty paths,
// the explorer-driven file mutations, and the cross-buffer WorkspaceEdit application — lifted out of
// ide.ts's init() (Task 5 of the ide.ts decomposition, issue #180).
//
// Ownership inverted (#982): the `workspace` SLICE (src/store/slices/workspace.ts) is now the single
// owner of `buffers` (every open document keyed by its file:// uri), `activeUri` (the one shown in the
// editor and targeted by all LSP requests), and `roots` (+ the derived `folderRootToken`). This module
// is the FACADE + effects: it reads those through the injected `store` and writes them through the
// slice's pure actions (upsertBuffer / removeBuffer / rekeyBuffer / syncBufferText / markSaved /
// setActive / setRoots), keeping the side effects (LSP open/close/sync, disk writes, diagnostics rename)
// around those transitions. It STILL owns `entriesByRoot` (the last explorer tree per root — deferred to
// #989). It does NOT own the per-uri diagnostics cache — that lives in editorSession (Task 3 of #180);
// the open/activate/mutation paths reach it through the injected accessors (showDiagnostics /
// dropDiagnostics / renameDiagnostics / clearDiagnostics).
//
// The construction-order cycle (editorSession + inspectorController are built BEFORE this and read
// `activeUri`/`folderRootToken` via injected thunks, while this calls back into them) is resolved
// WITHOUT a circular import: this module's only store dependency is the type-only `AppState` (erased) and
// the `store` handle passed through deps at runtime. Inbound effects come through deps (the editor
// handle, the LSP slice, the diagnostics accessors, the explorer, setStatus); outbound signals are the
// workspace slice's monotonic seq fields (activationSeq / workspaceEditSeq / entriesSeq / saveSeq), which
// ide.ts subscribes to (#982) — showDiagnostics + invalidateDocViews/followActiveFileContext + tree
// render on activation, history.reset on entries, onDocEdited on a workspace edit, the SC refresh on
// save. The accessors are only invoked at runtime, so ide.ts can pass `() => workspace.activeUri()`
// thunks that resolve after this is constructed.
import { matchesInclude } from '@/shell/workspaceSearch';
import { pathToFileUri } from '@/shell/ideUtils';
import { createWorkspaceSave } from './workspaceSave';
import { createWorkspaceBuffers } from './workspaceBuffers';
import { createWorkspaceMutations, nameOf } from './workspaceMutations';
import type { FsEntry, KoiFile, Platform } from '@/host';
import type { TextEdit, WorkspaceEdit } from '@/lsp/lsp';
import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import type { Buffer } from '@/store/slices/workspace';

/** Outcome of an openFolderPath attempt, so callers (recent-open recovery) can react to a failure. */
export type OpenResult = { ok: true } | { ok: false; reason: 'unreadable' | 'empty' };

// The `Buffer` type now LIVES in the store layer (`@/store/slices/workspace`) — the workspace slice is
// its single owner (#982). Re-export it here so the historyController / stories / tests that import
// `Buffer` from this module keep compiling unchanged, and the shell keeps a local name for its own use.
export type { Buffer };

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
  /**
   * The app store (#760 injection): the workspace slice is the single owner of buffers/activeUri/roots,
   * so this controller reads them via `store.getState()` and writes them through the slice's actions.
   * Tests build one with `createAppStore()`.
   */
  store: StoreApi<AppState>;

  /** Action-feedback pill writer (ide.ts's editorSession.setStatus). */
  setStatus(text: string, kind: 'error'): void;
  /**
   * Non-clobbering notification for a user-initiated open of an empty folder (#817). Unlike
   * `setStatus('…', 'error')`, which permanently overwrites a healthy compiled status, this channel
   * is transient — ide.ts implements it as a brief flash that restores the current diagnostics, so
   * the "no .koi files in folder" message surfaces without clobbering the workspace that is already
   * loaded. Optional: when absent the user-initiated path stays silent (same as the boot path).
   */
  notify?(text: string): void;

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
  /** Every open document, keyed by its file:// uri (read by ide.ts for share/export/palette/etc.). A
   *  getter over the store-owned buffer Map (#982), so per-call access always sees the current set. */
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
  /**
   * Load + open every .koi under `folder` as one workspace; activate the first by relPath.
   *
   * `opts.userInitiated` — set to `true` when a user gesture (folder picker / Recent click)
   * directly caused this call. When the folder turns out to be empty AND a workspace is already
   * loaded, the controller emits a non-clobbering notification (via `deps.notify`) instead of
   * staying silent, so the user understands why the open appeared to be a no-op. Leaving it
   * absent/`false` preserves the #627 silent path (boot/late re-scans must not clobber a healthy
   * compiled status).
   */
  openFolderPath(folder: string, opts?: { recent?: boolean; userInitiated?: boolean }): Promise<OpenResult>;
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
  /** Re-render the explorer from the cached entry tree. */
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

  // NOTE (#982): the former onActiveChanged / onBuffersChanged / onEntriesRefreshed / onSaved callback
  // seams are gone — their signals are the workspace slice's activationSeq / workspaceEditSeq /
  // entriesSeq / saveSeq fields, which ide.ts subscribes to via the injected store (captured + disposed
  // in its teardown). The bump points are unchanged: activation on activateFile, workspaceEdit on
  // applyWorkspaceEdit, entries on refreshEntries, saved on each disk-writing save path.
}

/**
 * The shared context the facade hands to each split module (workspaceSave / workspaceBuffers /
 * workspaceMutations). It carries the store handle + the `st()` reader, the injected `deps`, and the
 * facade-owned helpers the modules call back into (store-dependent token<->path resolution, the tree
 * render/refresh, and the open/ensure/activate flows). `rekeyBuffers` is provided BY workspaceBuffers
 * but needed BY workspaceMutations, so the facade late-binds it here — it resolves at call time, after
 * full construction.
 */
export interface WorkspaceModuleCtx {
  store: StoreApi<AppState>;
  st(): AppState;
  deps: WorkspaceControllerDeps;
  rootOfToken(token: string): string | undefined;
  relOfToken(token: string): string;
  renderTree(): void;
  refreshEntries(): Promise<void>;
  ensureBuffer(token: string): Promise<string | null>;
  openFileToken(token: string): Promise<void>;
  syncOpenKoi(): Promise<void>;
  activateFallback(): void;
  rekeyBuffers(oldToken: string, newToken: string): void;
}

export function createWorkspaceController(deps: WorkspaceControllerDeps): WorkspaceController {
  const { platform, lsp, editor, explorer, store } = deps;

  // The workspace slice is the single owner of buffers/activeUri/roots (#982). `st()` reads the current
  // slice state; writes go through its pure actions (upsertBuffer / removeBuffer / rekeyBuffer /
  // syncBufferText / markSaved / setActive / setRoots) so publishing to the UI is inherent, not projected.
  const st = () => store.getState();

  // --- owned state ----------------------------------------------------------
  // The explorer entry tree per root STAYS controller-owned (moving it into the store is deferred to
  // #989); this task still renders one group per root from this map through the explorer.
  const entriesByRoot = new Map<string, FsEntry[]>();

  // --- token <-> path helpers (unchanged from ide.ts) -----------------------

  /**
   * The root in the workspace that `token` IS, or lives under (separator-aware). When several roots
   * match (a nested root), the LONGEST wins so a token under the inner root resolves to it. Returns
   * undefined when no root owns the token (e.g. before any folder opens, or a foreign path).
   */
  function rootOfToken(token: string): string | undefined {
    let best: string | undefined;
    for (const root of st().roots) {
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

  // --- tree render ----------------------------------------------------------

  // Re-render the explorer from the cached entry tree. Cheap to call on any state change (dirty,
  // diagnostics, active file) — the explorer reads those per row via the callbacks. The global unsaved
  // indicator no longer needs a manual push here: dirty transitions publish inherently through the
  // slice actions (#982).
  function renderTree(): void {
    const roots = st().roots;
    if (roots.length === 0) return;
    // Feed the explorer EVERY root's entries (one render group per root, in add order). The explorer
    // renders a single group headerless (byte-identical to the old single-root path) and 2+ groups with
    // per-root headers + a Remove affordance.
    explorer.renderRoots(roots.map((r) => ({ root: r, entries: entriesByRoot.get(r) ?? [] })));
  }

  /** Re-read EVERY root's entry tree from the host (into entriesByRoot) and re-render the explorer. */
  async function refreshEntries(): Promise<void> {
    const roots = st().roots;
    if (roots.length === 0) return;
    for (const root of roots) {
      try {
        entriesByRoot.set(root, await platform.listEntries(root));
      } catch (e) {
        console.error('listEntries failed:', e);
      }
    }
    renderTree();
    st().bumpEntries(); // the onEntriesRefreshed seam: ide.ts subscribes to entriesSeq (history.reset)
  }

  // --- open paths -----------------------------------------------------------

  // Every .koi uri under the open folder, reusing the host walk (which already skips bin/obj/.git/
  // node_modules — see fs.ts SKIP_DIRS). The optional glob narrows the set through the same engine
  // workspace search's `include` uses. Returns [] (not an error) when no folder is open or the walk
  // fails, so the search panel degrades to "no results" rather than throwing.
  async function listWorkspaceFiles(glob?: string): Promise<string[]> {
    const roots = st().roots;
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
    if (st().buffers.has(uri)) return uri;
    let text: string;
    try {
      text = await platform.readTextFile(token);
    } catch (e) {
      console.error('readTextFile failed for', token, e);
      return null;
    }
    // ensureBuffer runs OUTSIDE the open flow (roots is already populated), so the owning root is
    // derivable; fall back to the primary root for a token that no root owns (matches relOfToken).
    const rootToken = rootOfToken(token) ?? st().roots[0] ?? '';
    st().upsertBuffer({
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
    const roots = st().roots;
    if (roots.length === 0) return;
    for (const root of roots) {
      let files: KoiFile[];
      try {
        files = await platform.listKoiFiles(root);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!st().buffers.has(pathToFileUri(f.path))) await ensureBuffer(f.path);
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
      st().upsertBuffer({
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
  // the leaving buffer first (preserving unsaved edits), swaps the doc, points lsp at the new uri, then
  // bumps activationSeq — the activation seam ide.ts subscribes to (it re-renders diagnostics +
  // invalidates the doc views).
  function activateFile(uri: string): void {
    if (uri === st().activeUri) return;
    // Flush the leaving file's debounced edits to the server before switching: the shared change
    // timer is re-armed for the new file on setDoc below, which would otherwise drop them.
    lsp.flush();
    const leaving = st().buffers.get(st().activeUri);
    // Capture the leaving file's latest editor text before the swap. The onChange sync has usually
    // already written it, so skip the Map copy when the buffer is already current.
    if (leaving && leaving.text !== editor.getDoc()) st().upsertBuffer({ ...leaving, text: editor.getDoc() });
    const next = st().buffers.get(uri);
    if (!next) return;
    // Move activeUri BEFORE the doc swap (so the setDoc-triggered onChange sees the new active — the old
    // `activeUriValue = uri` at :481), then fire the activation seam AFTER it (the old `onActiveChanged`
    // at :484): setActive moves the pointer, bumpActivation runs ide.ts's activation subscriber once the
    // doc is live.
    st().setActive(uri);
    lsp.setActive(uri);
    editor.setDoc(next.text);
    st().bumpActivation();
  }

  // After the active buffer is deleted, fall back to another open file, or open a new blank model
  // when the workspace is now empty. NOTE: this repaints the next file through showDiagnostics +
  // invalidateDocViews ONLY — it deliberately does NOT fire onActiveChanged (no followActiveFileContext
  // / tree render here), matching the old activateFallback; handleDelete's trailing refreshEntries
  // re-renders the tree. So the re-point moves the active pointer with setActive but never bumpActivation
  // — no activation seam fires.
  function activateFallback(): void {
    const next = Array.from(st().buffers.values()).sort((a, b) => a.relPath.localeCompare(b.relPath))[0];
    if (next) {
      st().setActive(next.uri);
      lsp.setActive(next.uri);
      editor.setDoc(next.text);
      deps.showDiagnostics(next.uri);
      deps.invalidateDocViews();
      return;
    }
    // Empty workspace: reset to a fresh blank model (ide.ts owns the BLANK reset).
    deps.onWorkspaceEmptied();
  }

  // --- module composition (Task 5 of #982) ----------------------------------
  // The mutation / buffer / save concerns live in sibling modules; the facade wires them together
  // through a shared ctx. This module still OWNS the token<->path helpers, the tree render/refresh, and
  // the open/ensure/activate flows (above + below). `rekeyBuffers` is created BY `buffers` but needed BY
  // `mutations`, so it is late-bound through the ctx arrow — resolved at call time, after construction.
  let buffers: ReturnType<typeof createWorkspaceBuffers>;
  const ctx: WorkspaceModuleCtx = {
    store,
    st,
    deps,
    rootOfToken,
    relOfToken,
    renderTree,
    refreshEntries,
    ensureBuffer,
    openFileToken,
    syncOpenKoi,
    activateFallback,
    rekeyBuffers: (oldToken, newToken) => buffers.rekeyBuffers(oldToken, newToken),
  };
  const save = createWorkspaceSave(ctx);
  buffers = createWorkspaceBuffers(ctx);
  const mutations = createWorkspaceMutations(ctx);

  // Close every open LSP doc, drop the buffer set, and clear the diagnostics cache — no re-open.
  // Used by the New-model reset so stale buffers/diagnostics can't survive a subsequent open that
  // early-returns (e.g. the reset deleted everything but re-creating model.koi failed).
  function reset(): void {
    save.clearAutoSaveTimer(); // tearing the workspace down — cancel any armed auto-save first
    for (const uri of Array.from(st().buffers.keys())) {
      lsp.closeDoc(uri);
      st().removeBuffer(uri);
    }
    deps.clearDiagnostics();
  }

  // Load + open every .koi file under `folder` as one workspace. Shared by the toolbar
  // button (which picks a folder first) and the welcome screen's recent-folder items
  // (which pass a known path directly).
  async function openFolderPath(folder: string, opts: { recent?: boolean; userInitiated?: boolean } = {}): Promise<OpenResult> {
    let files: KoiFile[];
    try {
      files = await platform.listKoiFiles(folder);
    } catch (e) {
      deps.setStatus('could not read folder', 'error');
      console.error('listKoiFiles failed:', e);
      return { ok: false, reason: 'unreadable' };
    }
    if (!files.length) {
      // Three cases for an empty listing (#817 / #627):
      //
      //  1. No workspace loaded (buffers.size === 0): the user (or boot) opened a genuinely empty
      //     folder and there is nothing to clobber — use the global red status so the empty-folder
      //     condition is unmissable. This is unchanged from before.
      //
      //  2. Workspace loaded + user-initiated call: the user explicitly picked a folder (toolbar
      //     button / Recent click) that turned out to be empty. Surface a non-clobbering notification
      //     via deps.notify so the open does NOT look like a silent no-op, while the healthy compiled
      //     status of the already-loaded workspace is preserved (#817).
      //
      //  3. Workspace loaded + NOT user-initiated: a boot/late automatic re-scan (e.g. the
      //     materialized-example race in #627 where compile-green renders first and an empty folder
      //     scan arrives after). Stay completely silent so the false "no .koi files in folder" error
      //     never clobbers the healthy status. This is the original #627 guard, preserved exactly.
      //
      // The check runs BEFORE the reset below so `buffers` still reflects the loaded workspace.
      if (st().buffers.size === 0) {
        deps.setStatus('no .koi files in folder', 'error');
      } else if (opts.userInitiated) {
        deps.notify?.('no .koi files in folder');
      }
      return { ok: false, reason: 'empty' };
    }

    // Re-opening a folder is a RESET to a single root: close every previously open file first and drop
    // the multi-root state (every prior root's buffers + cached entries). NB: `roots` is NOT cleared to
    // [] here — it is set to [folder] in ONE transition below (or [] on the all-reads-failed path), so a
    // folder switch is a single folderRootToken change (old → new) rather than old → '' → new, which
    // would flash the folder-derived <DocsPanelHost> through an empty key.
    save.clearAutoSaveTimer(); // a pending auto-save belongs to the workspace we're leaving — drop it
    for (const uri of Array.from(st().buffers.keys())) {
      lsp.closeDoc(uri);
      st().removeBuffer(uri);
    }
    entriesByRoot.clear();
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
    // between list and read). The workspace is now empty, so clear the roots too.
    if (st().buffers.size === 0) {
      st().setRoots([]);
      deps.setStatus('could not read any files in folder', 'error');
      return { ok: false, reason: 'unreadable' };
    }

    st().setRoots([folder]);
    // Activate the first file (sorted by relPath). Folder open moves the active pointer but must NOT
    // fire the activation seam (the :489 contract — no bumpActivation); ide.ts drives the folder-open
    // effects via onFolderOpened.
    const first = Array.from(st().buffers.values()).sort((a, b) => a.relPath.localeCompare(b.relPath))[0];
    st().setActive(first.uri);
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
    const only = st().buffers.size === 1 ? Array.from(st().buffers.values())[0] : null;
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
    if (st().roots.includes(folder)) return { ok: true };

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
      if (st().buffers.size === 0) deps.setStatus('no .koi files in folder', 'error');
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

    st().setRoots([...st().roots, folder]);
    await refreshEntries();
    return { ok: true };
  }

  // Remove exactly `folder` from the workspace: close every buffer it owns (LSP closeDoc + drop its
  // diagnostics), drop its cached entries, splice it out of `roots`. If the active buffer was one of the
  // removed ones, re-point active via the existing activateFallback (which falls back to another open
  // buffer, or calls onWorkspaceEmptied when none remain — so removing the LAST root empties the
  // workspace). A folder not in `roots` is a harmless no-op.
  function removeRoot(folder: string): void {
    const roots = st().roots;
    if (!roots.includes(folder)) return; // not a root — nothing to do

    let activeRemoved = false;
    for (const buf of [...st().buffers.values()]) {
      if (buf.rootToken !== folder) continue;
      if (buf.uri === st().activeUri) activeRemoved = true;
      lsp.closeDoc(buf.uri);
      st().removeBuffer(buf.uri);
      deps.dropDiagnostics(buf.uri);
    }
    entriesByRoot.delete(folder);
    st().setRoots(roots.filter((r) => r !== folder));
    if (activeRemoved) activateFallback();
    // Re-render the explorer so the removed root's group + rows disappear immediately. Unlike
    // handleDelete, removeRoot has no trailing refreshEntries; without this the removed group would
    // linger (clickable, but its buffers are gone) until some unrelated render fires. A now-empty
    // workspace renders nothing (roots.length === 0), and onWorkspaceEmptied's fresh-model open will
    // render once it seeds a new root.
    renderTree();
  }

  return {
    // A getter over the store-owned buffer Map (#982): per-call access always returns the current set.
    // The slice types it ReadonlyMap; the runtime value is a real Map and no consumer mutates it, so the
    // back-compat `Map<string, Buffer>` surface is preserved.
    get buffers() {
      return st().buffers as Map<string, Buffer>;
    },
    activeUri: () => st().activeUri,
    // Back-compat: the PRIMARY root (the legacy single opened folder); '' before any folder opens.
    folderRootToken: () => st().folderRootToken,
    rootsList: () => [...st().roots],
    // Back-compat: the PRIMARY root's entry tree (Task 3 surfaces the per-root map to the explorer).
    entriesCache: () => entriesByRoot.get(st().roots[0] ?? '') ?? [],
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
    saveActive: save.saveActive,
    saveAllDirty: save.saveAllDirty,
    setAutoSave: save.setAutoSave,
    scheduleAutoSave: save.scheduleAutoSave,
    anyDirty: buffers.anyDirty,
    syncActiveBuffer: buffers.syncActiveBuffer,
    syncBuffer: buffers.syncBuffer,
    handleNewFile: mutations.handleNewFile,
    handleNewFolder: mutations.handleNewFolder,
    handleDelete: mutations.handleDelete,
    handleRename: mutations.handleRename,
    handleDuplicate: mutations.handleDuplicate,
    handleMove: mutations.handleMove,
    refreshEntries,
    renderTree,
    applyWorkspaceEdit: buffers.applyWorkspaceEdit,
    applyFileEdit: buffers.applyFileEdit,
  };
}
