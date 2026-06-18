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
 * Transport for the JSON-RPC language server. {@link import('../lsp').KoineLsp} frames the
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

  /** Prompt for a folder. Resolves to its opaque token, or null when cancelled/unsupported. */
  pickFolder(title: string): Promise<string | null>;

  /** A human-readable display name for a folder token (the last path segment). */
  folderName(token: string): string;

  /** Every `.koi` file under an opened folder, sorted by relPath. */
  listKoiFiles(token: string): Promise<KoiFile[]>;

  /** Read a file's UTF-8 text by its token. */
  readTextFile(path: string): Promise<string>;

  /** Write UTF-8 text to a file token, creating/replacing it. */
  writeTextFile(path: string, contents: string): Promise<void>;

  /** Prompt for a destination to save a new scratch file. Resolves to its token, or null. */
  pickSavePath(defaultName: string): Promise<string | null>;

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
