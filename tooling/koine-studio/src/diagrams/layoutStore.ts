// The layout-persistence backends for the authoring canvas's node positions (the `DiagramLayoutStore`
// contract in diagramContract.ts). Two implementations:
//
//  - a COMMITTABLE one that writes `koine.layout.json` at the models-folder root via the platform
//    filesystem, so a hand-arranged diagram travels with the repo (and diffs minimally: versioned
//    envelope, keys sorted, debounced so a drag coalesces into one write); and
//  - a BROWSER-STORAGE one keyed by the per-workspace `positionKey()` for web/scratch mode where there is
//    no folder root to write into.
//
// `createLayoutStore` picks between them by whether a folder root token is open. The renderer reads the
// store the IDE injected via `setDiagramLayoutStore`; when none is injected (tests, first boot) it falls
// back to the browser store on its own.
import type { Platform } from '@/host';
import { positionKey, type DiagramLayoutStore, type DiagramPosition } from '@/diagrams/diagramContract';
import { clearDiagramPositions, loadDiagramPositions, saveDiagramPositions } from '@/settings/persistence';

/** The committable layout file, written at the opened folder's root. */
const LAYOUT_FILE = 'koine.layout.json';
/** Bumped if the on-disk shape ever changes; readers tolerate older/empty files. */
const LAYOUT_VERSION = 1;
/** Coalesce the many CELLS_MOVED a single drag fires into one disk write. */
const SAVE_DEBOUNCE_MS = 500;

interface LayoutFile {
  version: number;
  positions: Record<string, DiagramPosition>;
}

/** Serialize positions as a stable, minimal-diff `koine.layout.json`: versioned, integer coords, SORTED
 *  keys (so two runs that produce the same layout produce byte-identical files), trailing newline. */
function serialize(positions: Record<string, DiagramPosition>): string {
  const sorted: Record<string, DiagramPosition> = {};
  for (const qn of Object.keys(positions).sort()) {
    sorted[qn] = { x: Math.round(positions[qn].x), y: Math.round(positions[qn].y) };
  }
  const file: LayoutFile = { version: LAYOUT_VERSION, positions: sorted };
  return JSON.stringify(file, null, 2) + '\n';
}

/** Parse a `koine.layout.json`, dropping malformed entries; `{}` on any failure. */
function parse(text: string): Record<string, DiagramPosition> {
  try {
    const data = JSON.parse(text) as Partial<LayoutFile> | null;
    const positions = data?.positions;
    if (!positions || typeof positions !== 'object') return {};
    const out: Record<string, DiagramPosition> = {};
    for (const [qn, p] of Object.entries(positions)) {
      const x = (p as DiagramPosition | undefined)?.x;
      const y = (p as DiagramPosition | undefined)?.y;
      if (Number.isFinite(x) && Number.isFinite(y)) out[qn] = { x: x as number, y: y as number };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Browser-storage-backed store (web/scratch mode, no folder root). Keyed by the per-workspace
 * `positionKey()` so positions never bleed across projects. Writes are immediate — there is no on-disk
 * file to coalesce, and a drag should survive an instant reload.
 */
export function createBrowserLayoutStore(): DiagramLayoutStore {
  return {
    load: () => Promise.resolve(loadDiagramPositions(positionKey())),
    save: (positions) => saveDiagramPositions(positionKey(), positions),
    clear: () => clearDiagramPositions(positionKey()),
  };
}

/**
 * Committable store: persists positions to `<folderRoot>/koine.layout.json` through the platform
 * filesystem. There is no `exists()` on the platform, so we discover/register the file via `listDir` and
 * cache its token; the first save `createFile`s it, later saves overwrite by token. Saves are debounced
 * so dragging a node (many CELLS_MOVED) results in a single write.
 */
export function createFolderLayoutStore(platform: Platform, folderRootToken: string): DiagramLayoutStore {
  let fileToken: string | null = null; // cached once discovered or created
  let pending: Record<string, DiagramPosition> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** Find (and register, so writeTextFile resolves) the root-level layout file's token, if it exists. */
  async function locate(): Promise<string | null> {
    if (fileToken) return fileToken;
    try {
      const entries = await platform.listDir(folderRootToken, '');
      const hit = entries.find((e) => e.kind === 'file' && e.name === LAYOUT_FILE);
      if (hit) fileToken = hit.token;
    } catch {
      // Root unreadable (or no such folder) — treat as "no file yet".
    }
    return fileToken;
  }

  async function write(positions: Record<string, DiagramPosition>): Promise<void> {
    const json = serialize(positions);
    const existing = await locate();
    if (existing) {
      await platform.writeTextFile(existing, json);
      return;
    }
    try {
      fileToken = await platform.createFile(folderRootToken, LAYOUT_FILE, json);
    } catch {
      // Lost a create race (the file appeared meanwhile) — re-locate and overwrite.
      const t = await locate();
      if (t) await platform.writeTextFile(t, json);
    }
  }

  function flush(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending) {
      const p = pending;
      pending = null;
      void write(p);
    }
  }

  return {
    async load() {
      const t = await locate();
      if (!t) return {};
      try {
        return parse(await platform.readTextFile(t));
      } catch {
        return {};
      }
    },
    save(positions) {
      pending = positions;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
    clear() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
      // Write an empty envelope so the committed file reflects the reset (rather than leaving stale coords).
      void write({});
    },
  };
}

/**
 * The layout store for the active workspace: a committable `koine.layout.json` at the folder root when a
 * folder is open, else browser storage (web/scratch mode). The folder-root token and the browser persist
 * scope come from the same identity source (`contextWorkspaceKey()` derives the scope from the folder
 * token or 'scratch'), so the two stay consistent.
 */
export function createLayoutStore(platform: Platform, folderRootToken: string): DiagramLayoutStore {
  return folderRootToken ? createFolderLayoutStore(platform, folderRootToken) : createBrowserLayoutStore();
}
