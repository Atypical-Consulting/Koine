// Browser workspace filesystem backed by the File System Access API. Opened folders and saved
// files are addressed by opaque tokens; directory handles are persisted in IndexedDB so the
// recent-folders list survives reloads (re-acquiring permission on demand). Where the API is
// unavailable (e.g. Firefox), folder-open reports unsupported and save falls back to a download.
//
// Tokens: a folder token is its directory name, suffixed `~n` only when needed to stay unique
// against both in-memory and PERSISTED tokens (so it survives reloads without colliding); a file
// token under a folder is `<folderToken>/<relPath>`; a saved scratch file's token is its file name.
import type { KoiFile, SourceDoc } from '../types';

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
}
interface FsDirHandle {
  kind: 'directory';
  name: string;
  values(): AsyncIterableIterator<FsFileHandle | FsDirHandle>;
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
