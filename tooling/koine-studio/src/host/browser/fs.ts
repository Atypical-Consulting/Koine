// Browser workspace filesystem backed by the File System Access API. Opened folders and saved
// files are addressed by opaque tokens; directory handles are persisted in IndexedDB so the
// recent-folders list survives reloads (re-acquiring permission on demand). Where the API is
// unavailable (e.g. Firefox), folder-open reports unsupported and save falls back to a download.
//
// Tokens: a folder token is its directory name, suffixed `~n` only when needed to stay unique
// against both in-memory and PERSISTED tokens (so it survives reloads without colliding); a file
// token under a folder is `<folderToken>/<relPath>`; a saved scratch file's token is its file name.
import type { FsEntry, KoiFile, SourceDoc } from '@/host/types';

// --- minimal File System Access typings (not in the TS DOM lib) --------------
interface FsWritable {
  // Accepts a string (new file contents) or a Blob/File (a faithful byte copy of an existing file).
  write(data: string | Blob): Promise<void>;
  close(): Promise<void>;
}
interface FsFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<FsWritable>;
  // Chromium's atomic rename/move (FileSystemHandle.move). Preserves the whole entry — including
  // contents the explorer never lists — so it is preferred over a copy+delete that could drop bytes.
  move?(destOrName: FsDirHandle | string, name?: string): Promise<void>;
}
interface FsDirHandle {
  kind: 'directory';
  name: string;
  values(): AsyncIterableIterator<FsFileHandle | FsDirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsFileHandle>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FsDirHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  // Atomic rename/move of the directory and everything under it (see FsFileHandle.move).
  move?(destOrName: FsDirHandle | string, name?: string): Promise<void>;
  queryPermission?(opts: { mode: string }): Promise<PermissionState>;
  requestPermission?(opts: { mode: string }): Promise<PermissionState>;
}
type FsWindow = Window & {
  showDirectoryPicker?: (opts?: { mode?: string }) => Promise<FsDirHandle>;
  showSaveFilePicker?: (opts?: unknown) => Promise<FsFileHandle>;
};
const fsWin = window as FsWindow;

/** Whether folder-open is available in this browser. */
export function supported(): boolean {
  return typeof fsWin.showDirectoryPicker === 'function';
}

// --- in-memory workspace backend (no-OPFS fallback) --------------------------
// Browsers without OPFS (Safari / Firefox in Private mode, very old engines) can't persist a workspace
// to disk, but the editor + WASM compiler + diagnostics already run entirely in memory — only the
// persistence layer is missing. Rather than dead-end the IDE, the default workspace, the starter
// examples and shared-link imports fall back to this tiny in-memory directory tree: a faithful subset
// of the File System Access handle surface fs.ts drives. Every downstream op (listEntries,
// create/rename/move/delete, read/write) works against any handle that implements FsDirHandle, so none
// needs special-casing. The trade-off — work lives only for the session — is surfaced via
// persistsWorkspace() so the shell can warn the user.
class MemFile implements FsFileHandle {
  readonly kind = 'file' as const;
  constructor(
    public name: string,
    private contents = '',
  ) {}
  async getFile(): Promise<File> {
    const text = this.contents;
    return { text: async () => text } as unknown as File;
  }
  async createWritable(): Promise<FsWritable> {
    return {
      write: async (data: string | Blob) => {
        this.contents = typeof data === 'string' ? data : await (data as unknown as { text(): Promise<string> }).text();
      },
      close: async () => {},
    };
  }
}

class MemDir implements FsDirHandle {
  readonly kind = 'directory' as const;
  private entries = new Map<string, MemFile | MemDir>();
  constructor(public name: string) {}
  async *values(): AsyncIterableIterator<FsFileHandle | FsDirHandle> {
    for (const entry of this.entries.values()) yield entry;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsFileHandle> {
    const existing = this.entries.get(name);
    if (existing) {
      if (existing.kind !== 'file') throw new Error('not a file: ' + name);
      return existing;
    }
    if (!opts?.create) throw new Error('NotFoundError: ' + name);
    const file = new MemFile(name);
    this.entries.set(name, file);
    return file;
  }
  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FsDirHandle> {
    const existing = this.entries.get(name);
    if (existing) {
      if (existing.kind !== 'directory') throw new Error('not a directory: ' + name);
      return existing;
    }
    if (!opts?.create) throw new Error('NotFoundError: ' + name);
    const dir = new MemDir(name);
    this.entries.set(name, dir);
    return dir;
  }
  async removeEntry(name: string, _opts?: { recursive?: boolean }): Promise<void> {
    if (!this.entries.has(name)) throw new Error('NotFoundError: ' + name);
    this.entries.delete(name);
  }
}

// The session's in-memory root, created lazily the first time OPFS is found to be unavailable.
let memRoot: MemDir | null = null;

/** The workspace backing store: real OPFS when available, else the in-memory fallback (always present). */
function backingRoot(): Promise<FsDirHandle> {
  return opfsRoot() ?? Promise.resolve((memRoot ??= new MemDir('memory-root')));
}

/** Whether an opened workspace PERSISTS across reloads (real OPFS). False on the in-memory fallback. */
export function persistsWorkspace(): boolean {
  return opfsRoot() !== null;
}

// --- in-memory registries ----------------------------------------------------
const folders = new Map<string, FsDirHandle>();
const folderNames = new Map<string, string>();
const fileHandles = new Map<string, FsFileHandle>();
// Directory handles keyed by token (the opened-folder token for the root, `<folderToken>/<relPath>`
// for subdirs), populated in pickFolder and the listEntries walk so any folder token resolves to a
// live handle for create/rename/move/delete without re-walking from the root.
const dirHandles = new Map<string, FsDirHandle>();

/**
 * Mint a folder token from the directory name, suffixed `~n` only when needed so it never collides
 * with an in-memory OR a persisted token. Consulting IndexedDB keeps tokens unique across reloads,
 * so a later pick of a same-named folder can't overwrite an earlier recent's stored handle.
 */
async function uniqueToken(base: string): Promise<string> {
  const name = base || 'workspace';
  const taken = new Set<string>([...folders.keys(), ...(await idbKeys())]);
  if (!taken.has(name)) return name;
  let n = 1;
  while (taken.has(`${name}~${n}`)) n++;
  return `${name}~${n}`;
}

export function folderName(token: string): string {
  return folderNames.get(token) ?? token.split('/').filter(Boolean).pop() ?? token;
}

// --- folder open / file listing ----------------------------------------------

export async function pickFolder(_title: string): Promise<string | null> {
  if (!fsWin.showDirectoryPicker) return null;
  let dir: FsDirHandle;
  try {
    dir = await fsWin.showDirectoryPicker({ mode: 'readwrite' });
  } catch {
    return null; // user dismissed the picker
  }
  const token = await uniqueToken(dir.name);
  folders.set(token, dir);
  folderNames.set(token, dir.name || token);
  dirHandles.set(token, dir);
  await idbPut(token, dir);
  return token;
}

/** Resolve a folder token to a live handle, re-acquiring it from IndexedDB (with permission). */
async function resolveFolder(token: string): Promise<FsDirHandle> {
  let dir = folders.get(token);
  if (!dir) {
    const stored = await idbGet(token);
    if (!stored) throw new Error('this folder is no longer available — open it again');
    // Query first; only prompt when not already granted. requestPermission needs transient user
    // activation, so we keep the async work before it minimal (a cached IndexedDB read) to preserve
    // the click gesture that led here.
    const granted = stored.queryPermission
      ? (await stored.queryPermission({ mode: 'readwrite' })) === 'granted'
      : false;
    if (!granted && stored.requestPermission) {
      const perm = await stored.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') throw new Error('permission to read the folder was denied');
    }
    dir = stored;
    folders.set(token, dir);
    folderNames.set(token, dir.name || token);
    dirHandles.set(token, dir);
  }
  return dir;
}

// Skip build-output and VCS dirs while scanning: the desktop filter (Rust list_koi_files / server
// ScanWorkspace) skips bin/obj/.git; the browser additionally skips node_modules (a web project may
// nest models near one).
const SKIP_DIRS = new Set(['bin', 'obj', '.git', 'node_modules']);

async function walk(dir: FsDirHandle, prefix: string, token: string, out: KoiFile[]): Promise<void> {
  for await (const entry of dir.values()) {
    if (entry.kind === 'directory') {
      if (!SKIP_DIRS.has(entry.name)) {
        await walk(entry, prefix ? `${prefix}/${entry.name}` : entry.name, token, out);
      }
    } else if (entry.name.toLowerCase().endsWith('.koi')) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = `${token}/${relPath}`;
      fileHandles.set(path, entry);
      out.push({ path, name: entry.name, relPath });
    }
  }
}

export async function listKoiFiles(token: string): Promise<KoiFile[]> {
  const dir = await resolveFolder(token);
  const out: KoiFile[] = [];
  await walk(dir, '', token, out);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

// --- synthetic in-memory workspaces (multi-file examples) --------------------
// Starter examples are materialized into the Origin Private File System (OPFS) — a real
// File-System-Access directory that needs no picker and no permission prompt — then registered like
// any opened folder. Opening one therefore reuses the ENTIRE folder-mode path (explorer tree +
// create/rename/delete/move) with no special-casing downstream.

interface StorageWithOpfs {
  getDirectory?(): Promise<FsDirHandle>;
}

function opfsRoot(): Promise<FsDirHandle> | null {
  const storage = (navigator as Navigator & { storage?: StorageWithOpfs }).storage;
  return typeof storage?.getDirectory === 'function' ? storage.getDirectory() : null;
}

/**
 * Whether a synthetic example workspace can be materialized in this browser. Always true now: it uses
 * real OPFS when present and the in-memory fallback otherwise — so examples open everywhere (they just
 * don't survive a reload without OPFS; see {@link persistsWorkspace}).
 */
export function canMaterializeWorkspace(): boolean {
  return true;
}

async function writeFilesInto(dir: FsDirHandle, files: { relPath: string; contents: string }[]): Promise<void> {
  for (const file of files) {
    const segments = file.relPath.split('/');
    const leaf = segments.pop()!;
    let cur = dir;
    for (const seg of segments) cur = await cur.getDirectoryHandle(seg, { create: true });
    const handle = await cur.getFileHandle(leaf, { create: true });
    const writable = await handle.createWritable();
    await writable.write(file.contents);
    await writable.close();
  }
}

export async function materializeWorkspace(
  name: string,
  files: { relPath: string; contents: string }[],
  persist = false,
): Promise<string | null> {
  const root = await backingRoot(); // OPFS when available, else the in-memory fallback
  const dirName = `example-${name}`;

  if (persist) {
    // Persistent workspace (the starter examples): addressed by a STABLE token (the dir name) so
    // re-opening the same example reuses one persisted handle, seeded only the FIRST time (when it
    // holds no `.koi`) like the default workspace, and registered in IndexedDB. So a user's edits to
    // an opened example survive a re-open AND a page reload instead of being silently wiped.
    const token = dirName;
    const dir = await root.getDirectoryHandle(dirName, { create: true });
    if (!(await hasAnyKoi(dir))) await writeFilesInto(dir, files);
    folders.set(token, dir);
    folderNames.set(token, name);
    dirHandles.set(token, dir);
    // Only persist the handle when storage actually survives a reload — an in-memory MemDir isn't
    // structured-cloneable, and a memory workspace is session-only anyway.
    if (persistsWorkspace()) await idbPut(token, dir);
    return token;
  }

  // Ephemeral workspace (e.g. a shared-link import): recreated fresh on every open so each import
  // reflects exactly its own payload, under a session-only token (not persisted to IndexedDB).
  await root.removeEntry(dirName, { recursive: true }).catch(() => {});
  const dir = await root.getDirectoryHandle(dirName, { create: true });
  await writeFilesInto(dir, files);
  const token = await uniqueToken(name);
  folders.set(token, dir);
  folderNames.set(token, name);
  dirHandles.set(token, dir);
  return token;
}

// The persistent default workspace: a fixed OPFS directory, opened (not wiped) on every boot so the
// user's single model survives a reload. Replaces the old localStorage scratch buffer. The token is a
// reserved sentinel (parentheses can't appear in a real picked-folder name) so it never collides.
const DEFAULT_WS_DIR = 'default-workspace';
const DEFAULT_WS_TOKEN = '(default)';

// The picked-once workspace root: a single directory handle (e.g. ~/koine) under which "Save to disk"
// writes named projects. Persisted in IndexedDB under a reserved key (parens can't appear in a real
// picked-folder name, so it never collides with a folder-name token — same trick as DEFAULT_WS_TOKEN).
const WORKSPACE_ROOT_KEY = '(workspace-root)';
let workspaceRoot: FsDirHandle | null = null;

/**
 * Resolve the remembered workspace root: the in-memory handle, else the IndexedDB-persisted handle
 * (re-granting permission under the calling click), else a one-time `showDirectoryPicker`. Returns
 * null only when the user dismisses that picker (or the API is unavailable).
 */
async function resolveWorkspaceRoot(): Promise<FsDirHandle | null> {
  if (workspaceRoot) return workspaceRoot;
  const stored = await idbGet(WORKSPACE_ROOT_KEY);
  if (stored) {
    const granted = stored.queryPermission
      ? (await stored.queryPermission({ mode: 'readwrite' })) === 'granted'
      : false;
    if (granted || !stored.requestPermission || (await stored.requestPermission({ mode: 'readwrite' })) === 'granted') {
      workspaceRoot = stored;
      return stored;
    }
    // Permission on the stored root was denied — fall through to let the user pick again.
  }
  if (!fsWin.showDirectoryPicker) return null;
  let dir: FsDirHandle;
  try {
    dir = await fsWin.showDirectoryPicker({ mode: 'readwrite' });
  } catch {
    return null; // user dismissed the picker
  }
  workspaceRoot = dir;
  await idbPut(WORKSPACE_ROOT_KEY, dir);
  return dir;
}

/** The remembered workspace root's display name (for Settings), or null before one is picked. */
export async function workspaceRootName(): Promise<string | null> {
  const root = workspaceRoot ?? (await idbGet(WORKSPACE_ROOT_KEY));
  return root ? root.name || null : null;
}

/** Always prompt for a new workspace root, persist it, and return its name (null if dismissed). */
export async function pickWorkspaceRoot(): Promise<string | null> {
  if (!fsWin.showDirectoryPicker) return null;
  let dir: FsDirHandle;
  try {
    dir = await fsWin.showDirectoryPicker({ mode: 'readwrite' });
  } catch {
    return null;
  }
  workspaceRoot = dir;
  await idbPut(WORKSPACE_ROOT_KEY, dir);
  return dir.name || null;
}

/**
 * Create `<root>/<name>/`, write `files` into it, and register it exactly like a folder opened via
 * the picker (token minted, handle persisted to IndexedDB) so it reopens through the normal
 * resolveFolder path and shows up reopenable in Recent. Returns the new folder token, or null when
 * the user dismissed the root picker. Throws `already exists` (writing nothing) on a name collision.
 */
export async function saveProjectToRoot(
  name: string,
  files: { relPath: string; contents: string }[],
): Promise<string | null> {
  assertName(name);
  const root = await resolveWorkspaceRoot();
  if (!root) return null;
  if (await entryExists(root, name)) throw new Error('already exists: ' + name);
  const projectDir = await root.getDirectoryHandle(name, { create: true });
  const token = await uniqueToken(name);
  folders.set(token, projectDir);
  folderNames.set(token, name);
  dirHandles.set(token, projectDir);
  // Registries are populated before the writes; a mid-loop createFile failure leaves a partial
  // <root>/<name>/ dir on disk and a session-only token (no idbPut runs). By design there is no
  // rollback — the caller reports the error and the user retries with a different name (collision
  // then surfaces 'already exists'). See the spec's error-handling section.
  for (const f of files) await createFile(token, f.relPath, f.contents);
  await idbPut(token, projectDir);
  return token;
}

async function hasAnyKoi(dir: FsDirHandle): Promise<boolean> {
  for await (const entry of dir.values()) {
    if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.koi')) return true;
    if (entry.kind === 'directory' && !SKIP_DIRS.has(entry.name) && (await hasAnyKoi(entry))) return true;
  }
  return false;
}

/**
 * Open the persistent default workspace, creating + seeding `model.koi` with `seed` the first time
 * (i.e. when it holds no `.koi` yet). Registers it like any opened folder so the explorer + file
 * mutations reuse the folder-mode path. Backed by OPFS when available, else the in-memory fallback —
 * so it always returns a token in the browser ({@link persistsWorkspace} reports which backing is in
 * use). The `string | null` return is kept for the desktop host, which can still report no workspace.
 */
export async function openDefaultWorkspace(seed: string): Promise<string | null> {
  const root = await backingRoot(); // OPFS when available, else the in-memory fallback (never dead-ends)
  const dir = await root.getDirectoryHandle(DEFAULT_WS_DIR, { create: true });
  if (!(await hasAnyKoi(dir))) {
    const handle = await dir.getFileHandle('model.koi', { create: true });
    const writable = await handle.createWritable();
    await writable.write(seed);
    await writable.close();
  }
  folders.set(DEFAULT_WS_TOKEN, dir);
  folderNames.set(DEFAULT_WS_TOKEN, 'Untitled');
  dirHandles.set(DEFAULT_WS_TOKEN, dir);
  return DEFAULT_WS_TOKEN;
}

// --- read / write -------------------------------------------------------------

export async function readTextFile(path: string): Promise<string> {
  const handle = fileHandles.get(path);
  if (!handle) throw new Error('file is not open: ' + path);
  return (await handle.getFile()).text();
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
  const handle = fileHandles.get(path);
  if (!handle) {
    // No writable handle — a browser without showSaveFilePicker (the documented download fallback)
    // or a stale token. Download the bytes rather than failing silently.
    downloadFile(path.split('/').pop() ?? 'model.koi', contents);
    return;
  }
  const writable = await handle.createWritable();
  await writable.write(contents);
  await writable.close();
}

export async function readFolderSources(token: string): Promise<SourceDoc[]> {
  const files = await listKoiFiles(token);
  const out: SourceDoc[] = [];
  for (const f of files) {
    try {
      out.push({ uri: f.path, text: await readTextFile(f.path) });
    } catch {
      // skip unreadable files
    }
  }
  return out;
}

// --- workspace file management (explorer tree + mutations) -------------------
// All ops are addressed by tokens: the opened-folder token (no slash on the browser) for the root,
// `<folderToken>/<relPath>` for files and subdirs. relPath args are forward-slashed and relative to
// the OPENED FOLDER. The File System Access API has no atomic rename/move, so renameEntry and
// moveEntry are implemented as create-at-destination + copy + delete-source.

/** Split a `<folderToken>/<relPath>` token into its opened-folder token and forward-slashed relPath. */
function splitToken(token: string): { folderToken: string; relPath: string } {
  const slash = token.indexOf('/');
  if (slash < 0) return { folderToken: token, relPath: '' };
  return { folderToken: token.slice(0, slash), relPath: token.slice(slash + 1) };
}

/** Join a folder token and a relPath into a child token (the relPath may be empty → the root token). */
function childToken(folderToken: string, relPath: string): string {
  return relPath ? `${folderToken}/${relPath}` : folderToken;
}

/** Reject an empty, blank-segment, or `.`/`..` relPath so we never create a garbage or escaping entry. */
function assertRelPath(relPath: string): void {
  if (!relPath || relPath.split('/').some((seg) => seg.trim() === '' || seg === '.' || seg === '..')) {
    throw new Error('invalid path: ' + JSON.stringify(relPath));
  }
}

/** Reject a blank single name, a path separator, or a `.`/`..` traversal (a name is one segment). */
function assertName(name: string): void {
  if (!name.trim() || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error('invalid name: ' + JSON.stringify(name));
  }
}

/** Faithful byte copy of a file into `destDir` under `name` (writes the Blob, not re-encoded text). */
async function copyFileInto(srcFile: FsFileHandle, destDir: FsDirHandle, name: string): Promise<FsFileHandle> {
  const file = await srcFile.getFile();
  const dest = await destDir.getFileHandle(name, { create: true });
  const writable = await dest.createWritable();
  await writable.write(file);
  await writable.close();
  return dest;
}

/** Resolve a directory token to a live handle, walking from the opened folder when not yet cached. */
async function resolveDir(token: string): Promise<FsDirHandle> {
  const cached = dirHandles.get(token);
  if (cached) return cached;
  const { folderToken, relPath } = splitToken(token);
  let dir = await resolveFolder(folderToken);
  if (relPath) {
    for (const seg of relPath.split('/')) {
      dir = await dir.getDirectoryHandle(seg);
    }
    dirHandles.set(token, dir);
  }
  return dir;
}

/** Recursively collect FsEntry nodes for a directory, registering every dir and `.koi` file handle. */
async function walkEntries(
  dir: FsDirHandle,
  prefix: string,
  folderToken: string,
): Promise<FsEntry[]> {
  const out: FsEntry[] = [];
  for await (const entry of dir.values()) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const token = `${folderToken}/${relPath}`;
    if (entry.kind === 'directory') {
      if (SKIP_DIRS.has(entry.name)) continue;
      dirHandles.set(token, entry);
      out.push({ token, name: entry.name, relPath, kind: 'dir', children: await walkEntries(entry, relPath, folderToken) });
    } else if (entry.name.toLowerCase().endsWith('.koi')) {
      fileHandles.set(token, entry);
      out.push({ token, name: entry.name, relPath, kind: 'file' });
    }
  }
  // Folders first, then alphabetically by name within each kind.
  out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  return out;
}

export async function listEntries(folderToken: string): Promise<FsEntry[]> {
  const dir = await resolveFolder(folderToken);
  dirHandles.set(folderToken, dir);
  return walkEntries(dir, '', folderToken);
}

/**
 * List the immediate children (files AND directories, any extension) of `relPath` under an opened
 * folder — the flat, single-level docs listing (see Platform.listDir). Unlike walkEntries it does
 * not recurse and does not filter by extension, and it registers EVERY listed file handle (not just
 * `.koi`) so a later readTextFile/writeTextFile on a returned token resolves without re-walking.
 * Rejects when the directory does not exist (resolveDir throws), which the docs store treats as empty.
 */
export async function listDir(folderToken: string, relPath: string): Promise<FsEntry[]> {
  const dir = await resolveDir(childToken(folderToken, relPath));
  const out: FsEntry[] = [];
  for await (const entry of dir.values()) {
    const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
    const token = `${folderToken}/${childRel}`;
    if (entry.kind === 'directory') {
      if (SKIP_DIRS.has(entry.name)) continue;
      dirHandles.set(token, entry);
      out.push({ token, name: entry.name, relPath: childRel, kind: 'dir' });
    } else {
      fileHandles.set(token, entry);
      out.push({ token, name: entry.name, relPath: childRel, kind: 'file' });
    }
  }
  // Folders first, then alphabetically by name within each kind (mirrors walkEntries / the backend).
  out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  return out;
}

export async function createFile(folderToken: string, relPath: string, contents?: string): Promise<string> {
  assertRelPath(relPath);
  const segments = relPath.split('/');
  const leaf = segments.pop()!;
  let dir = await resolveFolder(folderToken);
  let prefix = '';
  for (const seg of segments) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
    prefix = prefix ? `${prefix}/${seg}` : seg;
    dirHandles.set(childToken(folderToken, prefix), dir);
  }
  // Probe without create so we fail loudly instead of silently truncating an existing file.
  let exists = true;
  try {
    await dir.getFileHandle(leaf);
  } catch {
    exists = false;
  }
  if (exists) throw new Error('already exists: ' + leaf);
  const handle = await dir.getFileHandle(leaf, { create: true });
  const writable = await handle.createWritable();
  await writable.write(contents ?? '');
  await writable.close();
  const token = `${folderToken}/${relPath}`;
  fileHandles.set(token, handle);
  return token;
}

export async function createFolder(folderToken: string, relPath: string): Promise<string> {
  assertRelPath(relPath);
  let dir = await resolveFolder(folderToken);
  let prefix = '';
  for (const seg of relPath.split('/')) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
    prefix = prefix ? `${prefix}/${seg}` : seg;
    dirHandles.set(childToken(folderToken, prefix), dir);
  }
  return `${folderToken}/${relPath}`;
}

export async function deleteEntry(token: string): Promise<void> {
  const { folderToken, relPath } = splitToken(token);
  if (!relPath) throw new Error('cannot delete the opened folder: ' + token);
  const segments = relPath.split('/');
  const name = segments.pop()!;
  const parentRel = segments.join('/');
  const parent = await resolveDir(childToken(folderToken, parentRel));
  await parent.removeEntry(name, { recursive: true });
  purgeRegistries(token);
}

/** Drop a token and all of its descendant tokens from the file/dir registries. */
function purgeRegistries(token: string): void {
  const sub = token + '/';
  for (const key of [...fileHandles.keys()]) {
    if (key === token || key.startsWith(sub)) fileHandles.delete(key);
  }
  for (const key of [...dirHandles.keys()]) {
    if (key === token || key.startsWith(sub)) dirHandles.delete(key);
  }
}

export async function renameEntry(token: string, newName: string): Promise<string> {
  assertName(newName);
  const { folderToken, relPath } = splitToken(token);
  if (!relPath) throw new Error('cannot rename the opened folder: ' + token);
  const segments = relPath.split('/');
  const oldName = segments.pop()!;
  const parentRel = segments.join('/');
  const parentToken = childToken(folderToken, parentRel);
  const parent = await resolveDir(parentToken);
  const newRelPath = parentRel ? `${parentRel}/${newName}` : newName;

  // Reject if the target name is already taken in the parent (file or directory).
  if (await entryExists(parent, newName)) throw new Error('already exists: ' + newName);

  // Classify from the registries first, else a POSITIVE directory probe — so a transient IO error
  // from a file probe can't misclassify a file as a directory.
  const isDir = dirHandles.has(token)
    ? true
    : fileHandles.has(token)
      ? false
      : await dirExists(parent, oldName);
  // Prefer the atomic FileSystemHandle.move() (keeps the whole entry); otherwise fall back to a
  // full create+copy+delete that copies every file/subdir, so nothing the explorer doesn't list
  // is lost when the source is removed.
  if (isDir) {
    const src = await parent.getDirectoryHandle(oldName);
    if (typeof src.move === 'function') {
      await src.move(newName);
    } else {
      const dest = await parent.getDirectoryHandle(newName, { create: true });
      await copyDirInto(src, dest, folderToken, newRelPath);
      await parent.removeEntry(oldName, { recursive: true });
    }
  } else {
    const src = await parent.getFileHandle(oldName);
    if (typeof src.move === 'function') {
      await src.move(newName);
    } else {
      await copyFileInto(src, parent, newName);
      await parent.removeEntry(oldName);
    }
  }
  purgeRegistries(token);
  return reRegister(parent, newName, isDir, `${folderToken}/${newRelPath}`);
}

export async function moveEntry(
  token: string,
  destFolderToken: string,
  newRelPath: string,
  copy?: boolean,
): Promise<string> {
  assertRelPath(newRelPath);
  const destToken = `${destFolderToken}/${newRelPath}`;
  const destSegments = newRelPath.split('/');
  const destLeaf = destSegments.pop()!;
  let destParent = await resolveFolder(destFolderToken);
  let prefix = '';
  for (const seg of destSegments) {
    destParent = await destParent.getDirectoryHandle(seg, { create: true });
    prefix = prefix ? `${prefix}/${seg}` : seg;
    dirHandles.set(childToken(destFolderToken, prefix), destParent);
  }

  // A move/duplicate must never clobber an existing destination (mirrors renameEntry and the
  // desktop backend); reject up front rather than silently overwriting/merging.
  if (await entryExists(destParent, destLeaf)) throw new Error('already exists: ' + destLeaf);

  const isDir = dirHandles.has(token) || (await isDirToken(token));

  // Duplicate (copy === true), or a move. A move prefers the atomic FileSystemHandle.move(); both
  // fall back to copying the ENTIRE tree (every file, not just `.koi`) so nothing is dropped.
  if (isDir) {
    const src = await resolveDir(token);
    if (copy !== true && typeof src.move === 'function') {
      await src.move(destParent, destLeaf);
      purgeRegistries(token);
      return reRegister(destParent, destLeaf, true, destToken);
    }
    const dest = await destParent.getDirectoryHandle(destLeaf, { create: true });
    await copyDirInto(src, dest, destFolderToken, newRelPath);
    dirHandles.set(destToken, dest);
  } else {
    const src = await resolveFile(token);
    if (copy !== true && typeof src.move === 'function') {
      await src.move(destParent, destLeaf);
      purgeRegistries(token);
      return reRegister(destParent, destLeaf, false, destToken);
    }
    fileHandles.set(destToken, await copyFileInto(src, destParent, destLeaf));
  }
  if (copy !== true) await deleteEntry(token);
  return destToken;
}

// --- move/rename helpers -----------------------------------------------------

/** Re-resolve a just-moved/renamed entry under its new parent and cache its handle by `newToken`. */
async function reRegister(parent: FsDirHandle, name: string, isDir: boolean, newToken: string): Promise<string> {
  if (isDir) dirHandles.set(newToken, await parent.getDirectoryHandle(name));
  else fileHandles.set(newToken, await parent.getFileHandle(name));
  return newToken;
}

/**
 * Copy EVERY child of `src` into `dest` — all files (not only `.koi`) and all subdirectories
 * (including build/VCS dirs) — so a copy-based rename/move/duplicate never drops data the explorer
 * doesn't surface. Mirrors the desktop backend's copy_recursive / fs::rename whole-tree semantics.
 * Only `.koi` files and non-skipped dirs are cached in the registries (that is all the explorer
 * lists); the bytes of everything else are still copied. Files are copied byte-for-byte (the Blob),
 * so binary content survives a rename/move/duplicate intact.
 */
async function copyDirInto(
  src: FsDirHandle,
  dest: FsDirHandle,
  folderToken: string,
  relPrefix: string,
): Promise<void> {
  for await (const entry of src.values()) {
    const childRel = `${relPrefix}/${entry.name}`;
    const childTok = `${folderToken}/${childRel}`;
    if (entry.kind === 'directory') {
      const subDest = await dest.getDirectoryHandle(entry.name, { create: true });
      if (!SKIP_DIRS.has(entry.name)) dirHandles.set(childTok, subDest);
      await copyDirInto(entry, subDest, folderToken, childRel);
    } else {
      const fileDest = await copyFileInto(entry, dest, entry.name);
      if (entry.name.toLowerCase().endsWith('.koi')) fileHandles.set(childTok, fileDest);
    }
  }
}

async function entryExists(parent: FsDirHandle, name: string): Promise<boolean> {
  return (await fileExists(parent, name)) || (await dirExists(parent, name));
}

async function fileExists(parent: FsDirHandle, name: string): Promise<boolean> {
  try {
    await parent.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

async function dirExists(parent: FsDirHandle, name: string): Promise<boolean> {
  try {
    await parent.getDirectoryHandle(name);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a file token to a live handle, walking from the opened folder when not yet cached. */
async function resolveFile(token: string): Promise<FsFileHandle> {
  const cached = fileHandles.get(token);
  if (cached) return cached;
  const { folderToken, relPath } = splitToken(token);
  const segments = relPath.split('/');
  const name = segments.pop()!;
  const parent = await resolveDir(childToken(folderToken, segments.join('/')));
  const handle = await parent.getFileHandle(name);
  fileHandles.set(token, handle);
  return handle;
}

/** Whether a token points at a directory (consults the registries, then probes the parent). */
async function isDirToken(token: string): Promise<boolean> {
  if (dirHandles.has(token)) return true;
  if (fileHandles.has(token)) return false;
  const { folderToken, relPath } = splitToken(token);
  if (!relPath) return true; // the opened-folder token is always a directory
  const segments = relPath.split('/');
  const name = segments.pop()!;
  const parent = await resolveDir(childToken(folderToken, segments.join('/')));
  return dirExists(parent, name);
}

/** Save a Blob to disk via a transient object-URL anchor (the download fallback for both helpers). */
function triggerDownload(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadFile(name: string, contents: string): void {
  triggerDownload(name, new Blob([contents], { type: 'text/plain' }));
}

/** Download arbitrary bytes (e.g. a generated-project zip). */
export function downloadBytes(name: string, data: Uint8Array, mime = 'application/octet-stream'): void {
  triggerDownload(name, new Blob([data as BlobPart], { type: mime }));
}

// --- IndexedDB handle store (recent folders across reloads) ------------------
const DB_NAME = 'koine-studio';
const STORE = 'handles';

// Cache the connection so a recent-folder click doesn't reopen the DB before the activation-gated
// requestPermission (see resolveFolder).
let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbPut(key: string, value: FsDirHandle): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // persistence is best-effort; recents simply won't survive a reload
  }
}

async function idbGet(key: string): Promise<FsDirHandle | null> {
  try {
    const db = await openDb();
    return await new Promise<FsDirHandle | null>((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as FsDirHandle) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/** All persisted folder-token keys, so uniqueToken can avoid collisions across reloads. */
async function idbKeys(): Promise<string[]> {
  try {
    const db = await openDb();
    return await new Promise<string[]>((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAllKeys();
      req.onsuccess = () => resolve((req.result as IDBValidKey[]).map(String));
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

// --- test-only hooks ---------------------------------------------------------
// These exist solely so the vitest suite can seed/reset the in-memory registries against mocked
// FS-Access handles without going through the (unavailable in jsdom) showDirectoryPicker flow.
// They are not part of the Platform surface and must not be called from production code.

/** TEST ONLY: register a mock directory handle as an opened folder under `token`. */
export function __setFolderForTest(token: string, handle: FsDirHandle): void {
  folders.set(token, handle);
  folderNames.set(token, handle.name || token);
  dirHandles.set(token, handle);
}

/** TEST ONLY: clear every in-memory registry so each test starts from a clean slate. */
export function __resetFsForTest(): void {
  folders.clear();
  folderNames.clear();
  fileHandles.clear();
  dirHandles.clear();
  workspaceRoot = null;
  memRoot = null;
}

/** TEST ONLY: clear the IndexedDB store so persisted handles don't leak between tests. */
export async function __clearDbForTest(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // DB not available or error clearing
  }
}
