// Browser workspace filesystem backed by the File System Access API. Opened folders and saved
// files are addressed by opaque tokens; directory handles are persisted in IndexedDB so the
// recent-folders list survives reloads (re-acquiring permission on demand). Where the API is
// unavailable (e.g. Firefox), folder-open reports unsupported and save falls back to a download.
//
// Tokens: a folder token is its directory name, suffixed `~n` only when needed to stay unique
// against both in-memory and PERSISTED tokens (so it survives reloads without colliding); a file
// token under a folder is `<folderToken>/<relPath>`; a saved scratch file's token is its file name.
import type { FsEntry, KoiFile, SourceDoc } from '../types';

// --- minimal File System Access typings (not in the TS DOM lib) --------------
interface FsWritable {
  write(data: string): Promise<void>;
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

export async function pickSavePath(defaultName: string): Promise<string | null> {
  if (!fsWin.showSaveFilePicker) {
    // No save picker (e.g. Firefox/Safari): return the name as a download-only token. There is no
    // handle for it, so writeTextFile will download the file — the File-System-Access fallback.
    return defaultName;
  }
  let handle: FsFileHandle;
  try {
    handle = await fsWin.showSaveFilePicker({
      suggestedName: defaultName,
      types: [{ description: 'Koine model', accept: { 'text/plain': ['.koi'] } }],
    });
  } catch {
    return null; // user dismissed the picker
  }
  const token = handle.name || defaultName;
  fileHandles.set(token, handle);
  return token;
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

/** Reject an empty or blank-segment relPath so we never create a garbage entry named `''`. */
function assertRelPath(relPath: string): void {
  if (!relPath || relPath.split('/').some((seg) => seg.trim() === '')) {
    throw new Error('invalid path: ' + JSON.stringify(relPath));
  }
}

/** Reject a blank single name or one containing a path separator (a name is one path segment). */
function assertName(name: string): void {
  if (!name.trim() || name.includes('/') || name.includes('\\')) {
    throw new Error('invalid name: ' + JSON.stringify(name));
  }
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

  const isDir = dirHandles.has(token) || !(await fileExists(parent, oldName));
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
      const text = await (await src.getFile()).text();
      const dest = await parent.getFileHandle(newName, { create: true });
      const writable = await dest.createWritable();
      await writable.write(text);
      await writable.close();
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
    const text = await (await src.getFile()).text();
    const dest = await destParent.getFileHandle(destLeaf, { create: true });
    const writable = await dest.createWritable();
    await writable.write(text);
    await writable.close();
    fileHandles.set(destToken, dest);
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
 * lists); the bytes of everything else are still copied. Files are copied as UTF-8 text — adequate
 * for a model workspace (`.koi`/`.md`/`.cs` source); a binary file would be re-encoded.
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
      const text = await (await entry.getFile()).text();
      const fileDest = await dest.getFileHandle(entry.name, { create: true });
      const writable = await fileDest.createWritable();
      await writable.write(text);
      await writable.close();
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

function downloadFile(name: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
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
}
