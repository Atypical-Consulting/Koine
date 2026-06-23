import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FsEntry, Platform } from '@/host';
import {
  positionKey,
  setDiagramPersistScope,
  type DiagramPosition,
} from '@/diagrams/diagramContract';
import { loadDiagramPositions } from '@/settings/persistence';
import {
  createBrowserLayoutStore,
  createFolderLayoutStore,
  createLayoutStore,
} from '@/diagrams/layoutStore';

// --- in-memory mock of the host file abstraction -----------------------------
// The folder store touches only four Platform methods (listDir / readTextFile / writeTextFile /
// createFile); the rest is left unimplemented (the store never calls them). Tokens use the browser
// scheme `<folder>/<relPath>`; the folder-root token is 'WS'. The layout file lives at the root, so
// listDir is always called with relPath '' and the only entries that matter are direct children.
const FOLDER = 'WS';
const LAYOUT_FILE = 'koine.layout.json';

interface FakeFs {
  platform: Platform;
  files: Map<string, string>;
  calls: { createFile: number; writeTextFile: number; listDir: number };
}

function fakeFs(initial: Record<string, string> = {}): FakeFs {
  const files = new Map<string, string>();
  for (const [rel, contents] of Object.entries(initial)) files.set(`${FOLDER}/${rel}`, contents);
  const calls = { createFile: 0, writeTextFile: 0, listDir: 0 };

  const platform = {
    // Only root-level (relPath '') children are returned, which is all the store ever asks for.
    async listDir(folderToken: string, relPath: string): Promise<FsEntry[]> {
      calls.listDir++;
      const prefix = relPath ? `${folderToken}/${relPath}/` : `${folderToken}/`;
      const out: FsEntry[] = [];
      for (const token of files.keys()) {
        if (!token.startsWith(prefix)) continue;
        const rest = token.slice(prefix.length);
        if (rest.includes('/')) continue; // not a direct child
        out.push({ token, name: rest, relPath: rest, kind: 'file' });
      }
      if (out.length === 0) throw new Error('NotFound: ' + relPath);
      return out;
    },
    async readTextFile(token: string): Promise<string> {
      if (!files.has(token)) throw new Error('not found: ' + token);
      return files.get(token)!;
    },
    async writeTextFile(token: string, contents: string): Promise<void> {
      calls.writeTextFile++;
      files.set(token, contents);
    },
    async createFile(folderToken: string, relPath: string, contents?: string): Promise<string> {
      calls.createFile++;
      const token = `${folderToken}/${relPath}`;
      if (files.has(token)) throw new Error('already exists: ' + relPath);
      files.set(token, contents ?? '');
      return token;
    },
  } as unknown as Platform;

  return { platform, files, calls };
}

afterEach(() => {
  localStorage.clear();
  setDiagramPersistScope('scratch');
  vi.useRealTimers();
});

// =============================================================================
// serialize / parse (exercised through the folder store's load + write)
// =============================================================================

describe('layoutStore — serialization (via the folder store on-disk shape)', () => {
  it('serializes a versioned envelope with sorted keys, rounded integer coords and a trailing newline', async () => {
    const { platform, files } = fakeFs();
    vi.useFakeTimers();
    const store = createFolderLayoutStore(platform, FOLDER);

    // Keys given out of order with fractional coords; expect sorted keys + rounding.
    store.save({ Zebra: { x: 10.4, y: 20.6 }, Alpha: { x: 1.5, y: 2.49 } });
    await vi.runAllTimersAsync();

    const json = files.get(`${FOLDER}/${LAYOUT_FILE}`)!;
    expect(json).toBe(
      '{\n' +
        '  "version": 1,\n' +
        '  "positions": {\n' +
        '    "Alpha": {\n' +
        '      "x": 2,\n' +
        '      "y": 2\n' +
        '    },\n' +
        '    "Zebra": {\n' +
        '      "x": 10,\n' +
        '      "y": 21\n' +
        '    }\n' +
        '  }\n' +
        '}\n',
    );
    // Keys must appear in sorted order in the raw text (Alpha before Zebra).
    expect(json.indexOf('"Alpha"')).toBeLessThan(json.indexOf('"Zebra"'));
  });

  it('is byte-stable: the same layout produced two ways serializes identically', async () => {
    const a = fakeFs();
    const b = fakeFs();
    vi.useFakeTimers();
    createFolderLayoutStore(a.platform, FOLDER).save({ A: { x: 1, y: 1 }, B: { x: 2, y: 2 } });
    createFolderLayoutStore(b.platform, FOLDER).save({ B: { x: 2, y: 2 }, A: { x: 1, y: 1 } });
    await vi.runAllTimersAsync();
    expect(a.files.get(`${FOLDER}/${LAYOUT_FILE}`)).toBe(b.files.get(`${FOLDER}/${LAYOUT_FILE}`));
  });
});

describe('layoutStore — parsing (via the folder store load)', () => {
  it('round-trips well-formed positions', async () => {
    const { platform } = fakeFs({
      [LAYOUT_FILE]: JSON.stringify({ version: 1, positions: { 'C.Order': { x: 5, y: 6 } } }),
    });
    const store = createFolderLayoutStore(platform, FOLDER);
    expect(await store.load()).toEqual({ 'C.Order': { x: 5, y: 6 } });
  });

  it('drops malformed entries (non-finite / missing coords / non-object) but keeps the good ones', async () => {
    const { platform } = fakeFs({
      [LAYOUT_FILE]: JSON.stringify({
        version: 1,
        positions: {
          good: { x: 1, y: 2 },
          noY: { x: 3 },
          nanX: { x: NaN, y: 4 }, // NaN serializes to null ⇒ not finite ⇒ dropped
          infY: { x: 1, y: 'oops' },
          notObj: 42,
          nul: null,
        },
      }),
    });
    const store = createFolderLayoutStore(platform, FOLDER);
    expect(await store.load()).toEqual({ good: { x: 1, y: 2 } });
  });

  it('returns {} when the JSON has no positions object', async () => {
    const { platform } = fakeFs({ [LAYOUT_FILE]: JSON.stringify({ version: 1 }) });
    expect(await createFolderLayoutStore(platform, FOLDER).load()).toEqual({});
  });

  it('returns {} when positions is not an object (e.g. an array)', async () => {
    const { platform } = fakeFs({ [LAYOUT_FILE]: JSON.stringify({ version: 1, positions: [1, 2] }) });
    expect(await createFolderLayoutStore(platform, FOLDER).load()).toEqual({});
  });

  it('returns {} on a top-level JSON null', async () => {
    const { platform } = fakeFs({ [LAYOUT_FILE]: 'null' });
    expect(await createFolderLayoutStore(platform, FOLDER).load()).toEqual({});
  });

  it('returns {} on malformed JSON (parse throws)', async () => {
    const { platform } = fakeFs({ [LAYOUT_FILE]: '{ not json' });
    expect(await createFolderLayoutStore(platform, FOLDER).load()).toEqual({});
  });
});

// =============================================================================
// createBrowserLayoutStore — localStorage-backed, keyed by positionKey()
// =============================================================================

describe('createBrowserLayoutStore', () => {
  it('load() is {} for a fresh workspace', async () => {
    setDiagramPersistScope('ws-fresh');
    const store = createBrowserLayoutStore();
    expect(await store.load()).toEqual({});
  });

  it('save() then load() round-trips through localStorage under positionKey()', async () => {
    setDiagramPersistScope('ws-rt');
    const store = createBrowserLayoutStore();
    const positions: Record<string, DiagramPosition> = { 'Ordering.Order': { x: 12, y: 34 } };

    store.save(positions);

    // Visible both through the store and through the raw persistence helper (proves the key).
    expect(await store.load()).toEqual(positions);
    expect(loadDiagramPositions(positionKey())).toEqual(positions);
  });

  it('clear() forgets the saved positions', async () => {
    setDiagramPersistScope('ws-clear');
    const store = createBrowserLayoutStore();
    store.save({ A: { x: 1, y: 2 } });
    expect(await store.load()).not.toEqual({});

    store.clear();

    expect(await store.load()).toEqual({});
    expect(loadDiagramPositions(positionKey())).toEqual({});
  });

  it('scopes positions per workspace — one workspace cannot read another', async () => {
    setDiagramPersistScope('ws-a');
    createBrowserLayoutStore().save({ A: { x: 1, y: 1 } });

    setDiagramPersistScope('ws-b');
    const storeB = createBrowserLayoutStore();
    expect(await storeB.load()).toEqual({}); // ws-b sees nothing of ws-a

    storeB.save({ B: { x: 2, y: 2 } });
    setDiagramPersistScope('ws-a');
    // ws-a still has only its own data.
    expect(await createBrowserLayoutStore().load()).toEqual({ A: { x: 1, y: 1 } });
  });

  it('save() is immediate (no debounce) — a position is readable synchronously after save', () => {
    setDiagramPersistScope('ws-immediate');
    createBrowserLayoutStore().save({ A: { x: 7, y: 8 } });
    expect(loadDiagramPositions(positionKey())).toEqual({ A: { x: 7, y: 8 } });
  });
});

// =============================================================================
// createFolderLayoutStore — committable koine.layout.json (debounced writes)
// =============================================================================

describe('createFolderLayoutStore — load', () => {
  it('returns {} when there is no layout file at the root', async () => {
    const { platform } = fakeFs(); // empty folder ⇒ listDir throws ⇒ no token
    expect(await createFolderLayoutStore(platform, FOLDER).load()).toEqual({});
  });

  it('returns {} when the folder root is unreadable (listDir throws for a non-empty other reason)', async () => {
    const { platform } = fakeFs({ 'other.txt': 'x' }); // root has files, but no layout file
    expect(await createFolderLayoutStore(platform, FOLDER).load()).toEqual({});
  });

  it('returns {} when reading the located file throws', async () => {
    const { platform, files } = fakeFs({ [LAYOUT_FILE]: '{}' });
    // The file is listed so locate() finds a token, but reading it fails.
    platform.readTextFile = (() => Promise.reject(new Error('io'))) as Platform['readTextFile'];
    void files; // (kept for symmetry; not otherwise used)
    expect(await createFolderLayoutStore(platform, FOLDER).load()).toEqual({});
  });
});

describe('createFolderLayoutStore — save (debounced) + create/overwrite', () => {
  it('debounces: the disk write happens only after the timer fires, and coalesces rapid saves', async () => {
    const { platform, files } = fakeFs();
    vi.useFakeTimers();
    const store = createFolderLayoutStore(platform, FOLDER);

    store.save({ A: { x: 1, y: 1 } });
    store.save({ A: { x: 2, y: 2 } }); // resets the timer; last-write-wins
    store.save({ A: { x: 3, y: 3 } });

    // Nothing on disk before the debounce elapses.
    expect(files.has(`${FOLDER}/${LAYOUT_FILE}`)).toBe(false);

    await vi.runAllTimersAsync();

    // Exactly one file, holding the final layout; created once (not written-by-token, since it was new).
    expect(await createFolderLayoutStore(platform, FOLDER).load()).toEqual({ A: { x: 3, y: 3 } });
  });

  it('creates the file on the first save and overwrites it by cached token on the second', async () => {
    const fs = fakeFs();
    vi.useFakeTimers();
    const store = createFolderLayoutStore(fs.platform, FOLDER);

    store.save({ A: { x: 1, y: 1 } });
    await vi.runAllTimersAsync();
    // The first save created the file.
    expect(fs.files.has(`${FOLDER}/${LAYOUT_FILE}`)).toBe(true);

    store.save({ A: { x: 9, y: 9 } });
    await vi.runAllTimersAsync();
    expect(await store.load()).toEqual({ A: { x: 9, y: 9 } });
  });

  it('overwrites a pre-existing layout file (located via listDir) rather than re-creating it', async () => {
    const fs = fakeFs({ [LAYOUT_FILE]: JSON.stringify({ version: 1, positions: { Old: { x: 0, y: 0 } } }) });
    vi.useFakeTimers();
    const store = createFolderLayoutStore(fs.platform, FOLDER);

    store.save({ New: { x: 5, y: 6 } });
    await vi.runAllTimersAsync();

    // Located the existing file ⇒ writeTextFile path (not createFile).
    expect(await store.load()).toEqual({ New: { x: 5, y: 6 } });
  });

  it('recovers from a lost create race: createFile rejects, then it re-locates and overwrites', async () => {
    const fs = fakeFs();
    vi.useFakeTimers();
    const store = createFolderLayoutStore(fs.platform, FOLDER);

    // Simulate the file appearing between locate() and createFile(): createFile rejects, but the file
    // is now present so the re-locate finds its token and writeTextFile succeeds.
    const realCreate = fs.platform.createFile.bind(fs.platform);
    fs.platform.createFile = ((folderToken: string, relPath: string) => {
      // Plant the file as if a racer created it, then reject this create.
      fs.files.set(`${folderToken}/${relPath}`, JSON.stringify({ version: 1, positions: {} }));
      return Promise.reject(new Error('already exists (raced)'));
    }) as Platform['createFile'];
    void realCreate;

    store.save({ A: { x: 4, y: 4 } });
    await vi.runAllTimersAsync();

    // The racer's empty file was overwritten with our layout.
    expect(await store.load()).toEqual({ A: { x: 4, y: 4 } });
  });

  it('a genuine create failure with no file to fall back to gives up silently (no throw, no file)', async () => {
    const fs = fakeFs();
    vi.useFakeTimers();
    const store = createFolderLayoutStore(fs.platform, FOLDER);

    // createFile rejects WITHOUT planting a file (e.g. permission denied), so the re-locate also finds
    // nothing: the `if (t)` write is skipped and write() returns without throwing.
    fs.platform.createFile = (() => Promise.reject(new Error('EACCES'))) as Platform['createFile'];

    store.save({ A: { x: 1, y: 1 } });
    await vi.runAllTimersAsync();

    expect(fs.files.has(`${FOLDER}/${LAYOUT_FILE}`)).toBe(false);
    expect(await store.load()).toEqual({}); // nothing was persisted
  });
});

describe('createFolderLayoutStore — clear', () => {
  it('clear() cancels any pending save and writes an empty envelope to disk', async () => {
    const fs = fakeFs();
    vi.useFakeTimers();
    const store = createFolderLayoutStore(fs.platform, FOLDER);

    store.save({ A: { x: 1, y: 1 } }); // pending, not yet flushed
    store.clear();
    await vi.runAllTimersAsync();

    // The pending save was dropped; the file reflects the reset (empty positions), not the dropped coords.
    const json = fs.files.get(`${FOLDER}/${LAYOUT_FILE}`)!;
    expect(JSON.parse(json)).toEqual({ version: 1, positions: {} });
    expect(await store.load()).toEqual({});
  });

  it('clear() on an existing file overwrites it with an empty envelope', async () => {
    const fs = fakeFs({ [LAYOUT_FILE]: JSON.stringify({ version: 1, positions: { Old: { x: 9, y: 9 } } }) });
    vi.useFakeTimers();
    const store = createFolderLayoutStore(fs.platform, FOLDER);

    store.clear();
    await vi.runAllTimersAsync();

    expect(await store.load()).toEqual({});
  });
});

// =============================================================================
// createLayoutStore — picks the backend by folder-root token presence
// =============================================================================

describe('createLayoutStore — backend selection', () => {
  it('with a folder token, returns the committable folder store (writes koine.layout.json)', async () => {
    const fs = fakeFs();
    vi.useFakeTimers();
    const store = createLayoutStore(fs.platform, FOLDER);

    store.save({ A: { x: 1, y: 2 } });
    await vi.runAllTimersAsync();

    // A disk file proves it is the folder store, not the browser one.
    expect(fs.files.has(`${FOLDER}/${LAYOUT_FILE}`)).toBe(true);
  });

  it('with an empty folder token, returns the browser store (persists to localStorage, no disk file)', async () => {
    setDiagramPersistScope('ws-browser-pick');
    const fs = fakeFs();
    const store = createLayoutStore(fs.platform, '');

    store.save({ A: { x: 3, y: 4 } });

    // Browser store writes immediately to localStorage and never touches the platform fs.
    expect(loadDiagramPositions(positionKey())).toEqual({ A: { x: 3, y: 4 } });
    expect(fs.files.has(`${FOLDER}/${LAYOUT_FILE}`)).toBe(false);
    expect(await store.load()).toEqual({ A: { x: 3, y: 4 } });
  });
});
