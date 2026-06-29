// A small filesystem helper shared by the two committable "sidecar" stores — the review threads
// (`src/review/reviewStore.ts`, `.koine/reviews.json`) and the diagram layout
// (`src/diagrams/layoutStore.ts`, `koine.layout.json`). Both persist a single JSON file under an opened
// folder through {@link Platform}, and both face the same wrinkle: there is no `exists()` on the platform,
// so the file's opaque token has to be DISCOVERED via `listDir` and cached; the first write `createFile`s
// it (materializing any intermediate dir), later writes overwrite by the cached token, and a lost
// create-race re-locates and overwrites. This module owns exactly that locate/read/write choreography so
// each store keeps only its own serialize/parse, debounce-or-write-chain serialization, and notification.
//
// `root` is a GETTER re-read on every call: a non-null token means a folder is open and the file lives at
// `<root>/<relPath>`; null (no-folder/scratch mode) makes `read` resolve null and `write` a no-op. The
// discovered token is cached and KEYED by the current `root()` value, so it is re-discovered the moment
// the root changes — this reproduces the review store's "reset the cached token on every folder open"
// without an explicit reset call, and is a no-op for the layout store (a fresh store per folder).
import type { Platform } from '@/host';

/** The locate/read/write seam over one committable JSON file under an opened folder. */
export interface FolderSidecar {
  /** The file's opaque token — discovered via `listDir` and cached, or null (missing file / no folder). */
  locate(): Promise<string | null>;
  /** The file's UTF-8 text, or null when it is missing/unreadable or no folder is open. */
  read(): Promise<string | null>;
  /**
   * Persist `contents`: `createFile` on the first write (materializing any intermediate dir), then
   * overwrite by the cached token; a lost create-race re-locates and overwrites. A no-op when no folder
   * is open.
   */
  write(contents: string): Promise<void>;
}

/**
 * Create a {@link FolderSidecar} over `<root()>/<relPath>`. `relPath` is forward-slashed; its last segment
 * is the file name and any leading directory is what `listDir` discovers under (and what `createFile`
 * materializes). See the module header for the cache/no-folder semantics.
 */
export function createFolderSidecar(
  platform: Platform,
  root: () => string | null,
  relPath: string,
): FolderSidecar {
  const slash = relPath.lastIndexOf('/');
  const dir = slash >= 0 ? relPath.slice(0, slash) : ''; // the directory to listDir under (root-relative)
  const name = slash >= 0 ? relPath.slice(slash + 1) : relPath; // the file name to discover/overwrite

  let cachedRoot: string | null = null; // the root the token below was discovered under
  let fileToken: string | null = null; // cached once discovered or created (valid under cachedRoot)

  /** Find (and register, so writeTextFile resolves) the file's token under `dir`, if it exists. */
  async function locate(): Promise<string | null> {
    const r = root();
    if (!r) return null; // no-folder/scratch mode: nothing to discover
    if (r !== cachedRoot) {
      // The folder changed since the last discovery — drop the stale token and re-discover under `r`.
      cachedRoot = r;
      fileToken = null;
    }
    if (fileToken) return fileToken;
    try {
      const entries = await platform.listDir(r, dir);
      const hit = entries.find((e) => e.kind === 'file' && e.name === name);
      if (hit) fileToken = hit.token;
    } catch {
      // The directory does not exist (or is unreadable) — treat as "no file yet".
    }
    return fileToken;
  }

  return {
    locate,
    async read() {
      const t = await locate();
      if (!t) return null;
      try {
        return await platform.readTextFile(t);
      } catch {
        return null;
      }
    },
    async write(contents) {
      const r = root();
      if (!r) return; // no-folder/scratch mode: nothing to persist
      const existing = await locate();
      if (existing) {
        await platform.writeTextFile(existing, contents);
        return;
      }
      try {
        // createFile creates intermediate dirs, so `<dir>/<name>` materializes `<dir>` too.
        fileToken = await platform.createFile(r, relPath, contents);
      } catch {
        // Lost a create race (the file appeared meanwhile) — re-locate and overwrite.
        const t = await locate();
        if (t) await platform.writeTextFile(t, contents);
      }
    },
  };
}
