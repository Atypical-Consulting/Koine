// Platform abstraction — everything Koine Studio needs from its host.
//
// The studio's UI (ide.ts / editor.ts / about.ts) and its LSP client (lsp.ts) talk ONLY to
// these interfaces; they never import Tauri or the WASM runtime directly. Two backends
// implement them:
//   • TauriPlatform  (src/host/tauri.ts)   — the desktop shell: brokers a real `koine lsp`
//                                             child over Tauri IPC and uses the native FS.
//   • BrowserPlatform (src/host/browser/)  — a plain browser tab: runs the compiler in process
//                                             via the Koine.Wasm module and uses the File System
//                                             Access API for files.
//
// Folders and saved files are addressed by opaque string TOKENS: an absolute path on the
// desktop, a registry id on the browser. The UI persists tokens (e.g. recent folders) and passes
// them back to the platform — it never interprets them.

import type { ChangeEntry } from '@/host/gitHistory';

/** A `.koi` file discovered under an opened folder. `path` is an opaque read/write token. */
export interface KoiFile {
  path: string; // opaque file token (absolute path on desktop; synthetic on browser)
  name: string; // file name (last path component)
  relPath: string; // path relative to the opened folder, forward-slashed
}

/**
 * One node in the workspace explorer tree under an opened folder — folders are included, not
 * just `.koi` files (so the IDE can render the real directory hierarchy and create into it).
 * `token` is the same opaque read/write token scheme as {@link KoiFile.path}.
 */
export interface FsEntry {
  token: string; // opaque file/folder token (absolute path on desktop; `<folderToken>/<relPath>` on browser)
  name: string; // last path segment
  relPath: string; // path relative to the opened folder, forward-slashed
  kind: 'file' | 'dir';
  children?: FsEntry[]; // populated for directories (full eager tree; folders-first then alpha)
}

/** One open document, as the WASM/LSP layer wants it. */
export interface SourceDoc {
  uri: string;
  text: string;
}

/**
 * Transport for the JSON-RPC language server. {@link import('@/lsp/lsp').KoineLsp} frames the
 * messages; the transport just moves the bytes and surfaces server→client messages. On the
 * desktop this brokers stdio to the `koine lsp` child; in the browser it drives an in-process
 * WASM-backed language server.
 */
export interface LspTransport {
  /** Bring the server up. Resolves once it is ready to receive `send`. */
  start(): Promise<void>;
  /** Send one framed JSON-RPC message (already serialized) to the server. */
  send(message: string): Promise<void>;
  /** Register the handler for every server→client message (JSON string). Call before `start`. */
  onMessage(cb: (json: string) => void): void;
  /** Register the handler for an unexpected server exit (code). */
  onExit(cb: (code: number) => void): void;
  /** Register the handler for a server restart (the client re-handshakes + re-opens docs). */
  onRestart(cb: () => void): void;
  /** Tear the server down. */
  stop(): Promise<void>;
}

/** The host environment the studio runs in, and its capabilities. */
export interface Platform {
  readonly kind: 'tauri' | 'browser';
  /** Whether opening a folder of models is available (native dialog / File System Access API). */
  readonly canOpenFolders: boolean;

  /** Create the LSP transport for this host (one per KoineLsp instance). */
  createLspTransport(): LspTransport;

  /** The application version, for the About dialog. */
  appVersion(): Promise<string>;

  /**
   * The local MCP server endpoint URL (`http://127.0.0.1:PORT/mcp`) to hand to an external MCP
   * client such as LM Studio, or null when the host can't serve one. The desktop shell lazily
   * launches a `koine mcp --http` sidecar and returns the URL it binds; a browser tab cannot listen
   * as a server, so it returns null and the UI hides the affordance.
   */
  mcpEndpoint(): Promise<string | null>;

  /**
   * Stop the local MCP sidecar if one is running and forget its endpoint, so the next
   * {@link mcpEndpoint} re-launches a fresh server. On the desktop this kills the `koine mcp --http`
   * child; in the browser, where nothing is hosted, it is a no-op. Idempotent.
   */
  mcpStop(): Promise<void>;

  /**
   * Execute a Koine compiler tool (`koine_validate` / `koine_compile` / `koine_format`) by name with a
   * JSON args string, resolving its result as text for the Assistant's agentic tool loop (src/ai.ts).
   * The browser host runs it in-process via Koine.Wasm; the desktop host proxies it to the
   * `koine mcp --http` sidecar. Both hosts implement it; a host that couldn't would omit it and the
   * Assistant would stay plain chat. Resolves an error string (never throws) on bad input so the model
   * can recover.
   */
  runCompilerTool?(name: string, argsJson: string): Promise<string>;

  /**
   * Open an absolute http(s) URL in the user's default browser. In the browser host this is a new
   * tab; on the desktop it hands off to the OS via the opener plugin (a normal `<a>` navigation
   * would otherwise try to load the page inside the Tauri webview). Used by the About dialog's
   * project links.
   */
  openExternal(url: string): void;

  /** Prompt for a folder. Resolves to its opaque token, or null when cancelled/unsupported. */
  pickFolder(title: string): Promise<string | null>;

  /**
   * Whether the host can save the current workspace as a real, reopenable on-disk project. True in
   * the browser when the File System Access API is present; false on the Tauri desktop for now.
   */
  readonly canSaveProjects: boolean;

  /**
   * Whether an opened workspace PERSISTS across reloads. True with real storage (OPFS in the browser,
   * the desktop filesystem on Tauri); false on the browser's in-memory fallback used when OPFS is
   * unavailable (Safari / Firefox Private) — there the editor still works, but work is session-only,
   * so the shell warns the user.
   */
  readonly persistsWorkspace: boolean;

  /**
   * Write the given files as a named project under the host's workspace root (picked once and
   * remembered), registering the new folder so it reopens like any opened folder. Returns the new
   * folder token, null when the user dismisses the root picker, and throws `already exists` on a
   * name collision. Browser-only today; the desktop stub returns null.
   */
  saveProjectToRoot(name: string, files: { relPath: string; contents: string }[]): Promise<string | null>;

  /** The remembered workspace root's display name (for Settings), or null before one is picked. */
  workspaceRootName(): Promise<string | null>;

  /** Re-pick the workspace root (Settings → Change…); returns its name, or null if dismissed/unsupported. */
  pickWorkspaceRoot(): Promise<string | null>;

  /**
   * Materialize a set of in-memory files into a real, openable workspace folder and return its
   * token (then opened via the normal folder-mode path, so the explorer + file mutations all
   * work). Used by the multi-file starter examples. `name` is a stable per-example slug; `files`
   * carry forward-slashed relPaths.
   *
   * `persist` (default false) controls the lifecycle: when true the workspace is addressed by a
   * stable token, seeded only on first creation, and remembered across reloads — so a user's edits
   * to an opened example survive (the examples pass true). When false it is recreated fresh on every
   * call under a session-only token, so each call reflects exactly its own files (shared-link imports
   * pass false / omit it).
   */
  materializeWorkspace(
    name: string,
    files: { relPath: string; contents: string }[],
    persist?: boolean,
  ): Promise<string | null>;

  /**
   * Open (or first-time create + seed) the host's persistent default workspace — the single-model
   * workspace Studio boots into when no folder/share is opened. Seeds one `model.koi` with `seed`
   * only on first creation; never clobbers existing files. Returns its token (opened via the normal
   * folder-mode path), or null when the host can't back one (e.g. no OPFS in the browser).
   */
  defaultWorkspace(seed: string): Promise<string | null>;

  /** A human-readable display name for a folder token (the last path segment). */
  folderName(token: string): string;

  /** Every `.koi` file under an opened folder, sorted by relPath. */
  listKoiFiles(token: string): Promise<KoiFile[]>;

  /**
   * The git change history of lines `startLine..endLine` (1-based, inclusive) of the file addressed by
   * `path` — the per-element "Change history" the inspector renders (issue #150). The desktop host
   * shells out to `git log -L start,end:file` in the file's directory; the browser host (no git) returns
   * `null`. Resolves `null` — never rejects — whenever history is unavailable (not a git repo, git
   * missing, the file untracked), so the caller simply hides the section. Newest commit first.
   */
  gitLogForRange(path: string, startLine: number, endLine: number): Promise<ChangeEntry[] | null>;

  /** Read a file's UTF-8 text by its token. */
  readTextFile(path: string): Promise<string>;

  /** Write UTF-8 text to a file token, creating/replacing it. */
  writeTextFile(path: string, contents: string): Promise<void>;

  /**
   * Save binary bytes (a generated-project `.zip`) to a host-chosen destination: a browser
   * download in the web host, or a native save dialog + write on the desktop. `defaultName` is the
   * suggested file name (e.g. `Shop.zip`). Resolves `true` once the bytes are delivered, or `false`
   * when the user cancels a native save dialog (so callers don't report a false success).
   */
  saveZip(defaultName: string, data: Uint8Array): Promise<boolean>;

  /**
   * Read every `.koi` source under an opened folder as `{uri,text}`. Used by the browser
   * compatibility check, which must pass the baseline contents to the in-process compiler
   * (there is no filesystem to read a path from). Unused on the desktop.
   */
  readFolderSources(token: string): Promise<SourceDoc[]>;

  /**
   * Register a guard for the desktop window's close button. `decide` runs when the user tries to
   * close the window and resolves whether the close should proceed (e.g. true once unsaved work is
   * saved, or the user confirms discarding it). Desktop-only — the browser host omits it and relies
   * on the `beforeunload` guard instead.
   */
  onCloseRequested?(decide: () => Promise<boolean>): Promise<void>;

  // --- workspace file management (explorer tree + mutations) ------------------
  // All operations are addressed by opaque tokens; the UI never parses a token. `relPath` is
  // forward-slashed and relative to the opened folder. Mutating ops return the NEW token of the
  // affected entry so the caller can re-key its in-memory state and the LSP workspace.

  /**
   * The full entry tree (directories AND `.koi` files) under an opened folder, for the explorer.
   * Directories are included even when empty; build-output/VCS dirs are skipped. Sorted
   * folders-first then alphabetically at every level.
   */
  listEntries(folderToken: string): Promise<FsEntry[]>;

  /**
   * The IMMEDIATE children (files AND directories, regardless of extension) of `relPath` under an
   * opened folder — a flat, single-level listing for non-`.koi` workspace docs such as the ADR /
   * Notes surface (`docs/adr/*.md`). The counterpart to {@link listEntries}, which is the recursive,
   * `.koi`-only explorer tree. Children carry no `children` array (no recursion), and every listed
   * file is registered so {@link readTextFile}/{@link writeTextFile} resolve its token afterwards.
   * `relPath` is forward-slashed and relative to the opened folder. Rejects when the directory does
   * not exist — callers (the docs store) treat that as an empty list / "no docs yet".
   */
  listDir(folderToken: string, relPath: string): Promise<FsEntry[]>;

  /** Create a file at `relPath` under the folder (creating intermediate dirs); returns its file token. */
  createFile(folderToken: string, relPath: string, contents?: string): Promise<string>;

  /** Create a (possibly nested) directory at `relPath` under the folder; returns its folder token. */
  createFolder(folderToken: string, relPath: string): Promise<string>;

  /** Rename a file or directory in place to `newName`; returns the new token. */
  renameEntry(token: string, newName: string): Promise<string>;

  /** Delete a file, or a directory and everything under it. */
  deleteEntry(token: string): Promise<void>;

  /**
   * Move (or, when `copy` is true, duplicate) the entry to `newRelPath` under `destFolderToken`.
   * Returns the new token. On the browser this is implemented as create-at-destination + copy +
   * (unless `copy`) delete-source, since the File System Access API has no atomic rename/move.
   */
  moveEntry(token: string, destFolderToken: string, newRelPath: string, copy?: boolean): Promise<string>;
}
