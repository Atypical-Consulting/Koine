// The layout-persistence backends for the authoring canvas's layout — node positions PLUS the canvas-only
// annotations (notes, groups; #255). Two implementations:
//
//  - a COMMITTABLE one that writes `koine.layout.json` at the models-folder root via the platform
//    filesystem, so a hand-arranged diagram (and its annotations) travel with the repo (and diff minimally:
//    versioned envelope, keys/ids sorted, debounced so a drag coalesces into one write); and
//  - a BROWSER-STORAGE one keyed by the per-workspace `positionKey()` for web/scratch mode where there is
//    no folder root to write into (positions and annotations live under sibling localStorage keys).
//
// `createLayoutStore` picks between them by whether a folder root token is open. The renderer reads the
// store the IDE injected via `setDiagramLayoutStore`; when none is injected (tests, first boot) it falls
// back to the browser store on its own. Everything here is a VIEW concern — it never round-trips into `.koi`.
import type { Platform } from '@/host';
import {
  emptyDiagramLayout,
  positionKey,
  sanitizeGroups,
  sanitizeNotes,
  type DiagramGroup,
  type DiagramLayout,
  type DiagramLayoutStore,
  type DiagramNote,
  type DiagramPosition,
} from '@/diagrams/diagramContract';
import {
  clearDiagramPositions,
  loadDiagramAnnotations,
  loadDiagramPositions,
  saveDiagramAnnotations,
  saveDiagramPositions,
} from '@/settings/persistence';

/** The committable layout file, written at the opened folder's root. */
const LAYOUT_FILE = 'koine.layout.json';
/** Bumped to 2 when notes/groups joined positions (#255); readers tolerate older/empty files. */
const LAYOUT_VERSION = 2;
/** Coalesce the many CELLS_MOVED a single drag fires into one disk write. */
const SAVE_DEBOUNCE_MS = 500;

interface LayoutFile {
  version: number;
  positions: Record<string, DiagramPosition>;
  notes: DiagramNote[];
  groups: DiagramGroup[];
}

/** Stable id comparison (locale-independent) so two runs sort notes/groups identically. */
function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Serialize the layout as a stable, minimal-diff `koine.layout.json`: versioned, integer coords, SORTED
 *  position keys and note/group ids (so two runs that produce the same layout produce byte-identical
 *  files), trailing newline. */
function serialize(layout: DiagramLayout): string {
  const positions: Record<string, DiagramPosition> = {};
  for (const qn of Object.keys(layout.positions).sort()) {
    positions[qn] = { x: Math.round(layout.positions[qn].x), y: Math.round(layout.positions[qn].y) };
  }
  const notes: DiagramNote[] = [...layout.notes].sort(byId).map((n) => ({
    id: n.id,
    text: n.text,
    x: Math.round(n.x),
    y: Math.round(n.y),
    width: Math.round(n.width),
    height: Math.round(n.height),
  }));
  const groups: DiagramGroup[] = [...layout.groups].sort(byId).map((g) => {
    const base: DiagramGroup = { id: g.id, label: g.label, members: [...g.members].sort() };
    return g.color ? { ...base, color: g.color } : base;
  });
  const file: LayoutFile = { version: LAYOUT_VERSION, positions, notes, groups };
  return JSON.stringify(file, null, 2) + '\n';
}

/** Parse a `koine.layout.json`, dropping malformed entries; an empty layout on any failure. Tolerates a
 *  v1 file (positions only) by defaulting notes/groups to empty. */
function parse(text: string): DiagramLayout {
  try {
    const data = JSON.parse(text) as Partial<LayoutFile> | null;
    const positions: Record<string, DiagramPosition> = {};
    const raw = data?.positions;
    if (raw && typeof raw === 'object') {
      for (const [qn, p] of Object.entries(raw)) {
        const x = (p as DiagramPosition | undefined)?.x;
        const y = (p as DiagramPosition | undefined)?.y;
        if (Number.isFinite(x) && Number.isFinite(y)) positions[qn] = { x: x as number, y: y as number };
      }
    }
    return { positions, notes: sanitizeNotes(data?.notes), groups: sanitizeGroups(data?.groups) };
  } catch {
    return emptyDiagramLayout();
  }
}

/**
 * Browser-storage-backed store (web/scratch mode, no folder root). Keyed by the per-workspace
 * `positionKey()` so a layout never bleeds across projects. Positions and annotations live under sibling
 * keys. Writes are immediate — there is no on-disk file to coalesce, and an edit should survive an instant
 * reload.
 */
export function createBrowserLayoutStore(): DiagramLayoutStore {
  return {
    load: () => {
      const key = positionKey();
      const { notes, groups } = loadDiagramAnnotations(key);
      return Promise.resolve({ positions: loadDiagramPositions(key), notes, groups });
    },
    save: (layout) => {
      const key = positionKey();
      saveDiagramPositions(key, layout.positions);
      saveDiagramAnnotations(key, { notes: layout.notes, groups: layout.groups });
    },
    clear: () => {
      // Auto-arrange resets node POSITIONS only; canvas annotations are preserved (they aren't layout).
      clearDiagramPositions(positionKey());
    },
  };
}

/**
 * Committable store: persists the layout to `<folderRoot>/koine.layout.json` through the platform
 * filesystem. There is no `exists()` on the platform, so we discover/register the file via `listDir` and
 * cache its token; the first save `createFile`s it, later saves overwrite by token. Saves are debounced
 * so dragging a node (many CELLS_MOVED) results in a single write.
 */
export function createFolderLayoutStore(platform: Platform, folderRootToken: string): DiagramLayoutStore {
  let fileToken: string | null = null; // cached once discovered or created
  let pending: DiagramLayout | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The most recently seen annotations (from a load or save), so clear() (auto-arrange) can reset positions
  // while preserving notes/groups without an extra disk read — and without losing a not-yet-flushed edit.
  let lastNotes: DiagramNote[] = [];
  let lastGroups: DiagramGroup[] = [];

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

  async function write(layout: DiagramLayout): Promise<void> {
    const json = serialize(layout);
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
      if (!t) return emptyDiagramLayout();
      try {
        const layout = parse(await platform.readTextFile(t));
        lastNotes = layout.notes;
        lastGroups = layout.groups;
        return layout;
      } catch {
        return emptyDiagramLayout();
      }
    },
    save(layout) {
      lastNotes = layout.notes;
      lastGroups = layout.groups;
      pending = layout;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
    clear() {
      // Auto-arrange resets node POSITIONS only — canvas annotations are preserved. Reuse the last-seen
      // annotations (from the most recent load/save, so a not-yet-flushed edit isn't lost) and write
      // {positions:{}, …annotations} immediately (not debounced, matching the old reset).
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
      void write({ positions: {}, notes: lastNotes, groups: lastGroups });
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
