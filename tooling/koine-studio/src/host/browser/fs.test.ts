import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  __setFolderForTest,
  __resetFsForTest,
  __clearDbForTest,
  listEntries,
  listDir,
  listKoiFiles,
  createFile,
  createFolder,
  deleteEntry,
  renameEntry,
  moveEntry,
  openDefaultWorkspace,
  materializeWorkspace,
  persistsWorkspace,
  readTextFile,
  writeTextFile,
  saveProjectToRoot,
  workspaceRootName,
  pickWorkspaceRoot,
} from '@/host/browser/fs';

// --- in-memory mock of the File System Access handle surface -----------------
// Mirrors only what fs.ts touches: values(), getFileHandle/getDirectoryHandle({create}),
// removeEntry(name,{recursive}) on directories, and getFile().text()/createWritable() on files.

class MockFile {
  kind = 'file' as const;
  constructor(
    public name: string,
    public contents = '',
  ) {}
  async getFile() {
    const text = this.contents;
    return { text: async () => text } as unknown as File;
  }
  async createWritable() {
    return {
      // Production writes a string for new content and a Blob/File (with .text()) for a byte copy;
      // mirror both so the byte-copy paths (copyFileInto) are exercised by the suite.
      write: async (data: string | { text(): Promise<string> }) => {
        this.contents = typeof data === 'string' ? data : await data.text();
      },
      close: async () => {},
    };
  }
}

class MockDir {
  kind = 'directory' as const;
  entries = new Map<string, MockFile | MockDir>();
  constructor(public name: string) {}

  async *values() {
    for (const entry of this.entries.values()) yield entry as never;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }) {
    const existing = this.entries.get(name);
    if (existing) {
      if (existing.kind !== 'file') throw new Error('not a file: ' + name);
      return existing as never;
    }
    if (!opts?.create) throw new Error('NotFound: ' + name);
    const file = new MockFile(name);
    this.entries.set(name, file);
    return file as never;
  }

  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    const existing = this.entries.get(name);
    if (existing) {
      if (existing.kind !== 'directory') throw new Error('not a dir: ' + name);
      return existing as never;
    }
    if (!opts?.create) throw new Error('NotFound: ' + name);
    const dir = new MockDir(name);
    this.entries.set(name, dir);
    return dir as never;
  }

  async removeEntry(name: string, _opts?: { recursive?: boolean }) {
    if (!this.entries.has(name)) throw new Error('NotFound: ' + name);
    this.entries.delete(name);
  }
}

/** Build a sample tree under a root dir: two contexts, an empty folder, a skipped obj/ dir. */
function sampleRoot(): MockDir {
  const root = new MockDir('workspace');

  const billing = new MockDir('billing');
  billing.entries.set('order.koi', new MockFile('order.koi', 'context Billing {}'));
  billing.entries.set('invoice.koi', new MockFile('invoice.koi', 'context Invoice {}'));
  root.entries.set('billing', billing);

  // A nested package that should still surface as a folder with its .koi child.
  const shipping = new MockDir('shipping');
  const domain = new MockDir('domain');
  domain.entries.set('shipment.koi', new MockFile('shipment.koi', 'context Shipping {}'));
  shipping.entries.set('domain', domain);
  root.entries.set('shipping', shipping);

  // An empty folder — must still appear in the tree.
  root.entries.set('empty', new MockDir('empty'));

  // Non-.koi file at the root — must be filtered out.
  root.entries.set('readme.md', new MockFile('readme.md', '# hi'));

  // Build-output dir — must be skipped entirely.
  const obj = new MockDir('obj');
  obj.entries.set('cache.koi', new MockFile('cache.koi', 'junk'));
  root.entries.set('obj', obj);

  return root;
}

describe('browser fs file management', () => {
  beforeEach(() => {
    __resetFsForTest();
  });

  it('listEntries returns the nested folders-then-files tree and skips obj/', async () => {
    __setFolderForTest('workspace', sampleRoot() as never);
    const tree = await listEntries('workspace');

    // Top level: folders first (alpha), then files. readme.md and obj/ are gone.
    expect(tree.map((e) => e.name)).toEqual(['billing', 'empty', 'shipping']);
    expect(tree.every((e) => e.kind === 'dir')).toBe(true);

    const billing = tree[0];
    expect(billing.token).toBe('workspace/billing');
    expect(billing.relPath).toBe('billing');
    // Files sorted alphabetically; tokens are <folderToken>/<relPath>.
    expect(billing.children!.map((c) => c.name)).toEqual(['invoice.koi', 'order.koi']);
    expect(billing.children![0]).toMatchObject({
      token: 'workspace/billing/invoice.koi',
      relPath: 'billing/invoice.koi',
      kind: 'file',
    });

    // Empty folder still present, with no children.
    const empty = tree[1];
    expect(empty).toMatchObject({ name: 'empty', kind: 'dir' });
    expect(empty.children).toEqual([]);

    // Nested dir surfaces with its grandchild .koi file.
    const shipping = tree[2];
    const nested = shipping.children![0];
    expect(nested).toMatchObject({ name: 'domain', token: 'workspace/shipping/domain', kind: 'dir' });
    expect(nested.children![0]).toMatchObject({
      token: 'workspace/shipping/domain/shipment.koi',
      relPath: 'shipping/domain/shipment.koi',
    });
  });

  it('createFile writes contents and returns the right token', async () => {
    const root = sampleRoot();
    __setFolderForTest('workspace', root as never);

    const token = await createFile('workspace', 'billing/new.koi', 'context New {}');
    expect(token).toBe('workspace/billing/new.koi');

    const billing = root.entries.get('billing') as MockDir;
    const file = billing.entries.get('new.koi') as MockFile;
    expect(file.contents).toBe('context New {}');
  });

  it('createFile creates intermediate dirs for a nested new path', async () => {
    const root = sampleRoot();
    __setFolderForTest('workspace', root as never);

    const token = await createFile('workspace', 'fresh/deep/model.koi', 'x');
    expect(token).toBe('workspace/fresh/deep/model.koi');

    const fresh = root.entries.get('fresh') as MockDir;
    const deep = fresh.entries.get('deep') as MockDir;
    const file = deep.entries.get('model.koi') as MockFile;
    expect(file.contents).toBe('x');
  });

  it('createFile defaults to empty contents and rejects an existing leaf', async () => {
    const root = sampleRoot();
    __setFolderForTest('workspace', root as never);

    const token = await createFile('workspace', 'blank.koi');
    const file = root.entries.get('blank.koi') as MockFile;
    expect(token).toBe('workspace/blank.koi');
    expect(file.contents).toBe('');

    await expect(createFile('workspace', 'billing/order.koi')).rejects.toThrow('already exists: order.koi');
  });

  it('createFolder makes a nested directory and returns its token', async () => {
    const root = sampleRoot();
    __setFolderForTest('workspace', root as never);

    const token = await createFolder('workspace', 'a/b/c');
    expect(token).toBe('workspace/a/b/c');

    const a = root.entries.get('a') as MockDir;
    const b = a.entries.get('b') as MockDir;
    expect(b.entries.has('c')).toBe(true);
  });

  it('deleteEntry removes the handle from its parent', async () => {
    const root = sampleRoot();
    __setFolderForTest('workspace', root as never);
    await listEntries('workspace'); // populate registries

    await deleteEntry('workspace/billing/order.koi');
    const billing = root.entries.get('billing') as MockDir;
    expect(billing.entries.has('order.koi')).toBe(false);
    expect(billing.entries.has('invoice.koi')).toBe(true);

    // Deleting a directory takes the whole subtree.
    await deleteEntry('workspace/shipping');
    expect(root.entries.has('shipping')).toBe(false);
  });

  it('renameEntry on a file copies+deletes and returns the new token', async () => {
    const root = sampleRoot();
    __setFolderForTest('workspace', root as never);
    await listEntries('workspace');

    const newToken = await renameEntry('workspace/billing/order.koi', 'purchase.koi');
    expect(newToken).toBe('workspace/billing/purchase.koi');

    const billing = root.entries.get('billing') as MockDir;
    expect(billing.entries.has('order.koi')).toBe(false);
    const renamed = billing.entries.get('purchase.koi') as MockFile;
    expect(renamed.contents).toBe('context Billing {}');

    // Rejects a name already taken in the parent.
    await expect(renameEntry('workspace/billing/purchase.koi', 'invoice.koi')).rejects.toThrow(
      'already exists: invoice.koi',
    );
  });

  it('renameEntry on a directory recreates the subtree under the new name', async () => {
    const root = sampleRoot();
    __setFolderForTest('workspace', root as never);
    await listEntries('workspace');

    const newToken = await renameEntry('workspace/shipping', 'logistics');
    expect(newToken).toBe('workspace/logistics');
    expect(root.entries.has('shipping')).toBe(false);

    const logistics = root.entries.get('logistics') as MockDir;
    const domain = logistics.entries.get('domain') as MockDir;
    const file = domain.entries.get('shipment.koi') as MockFile;
    expect(file.contents).toBe('context Shipping {}');
  });

  it('moveEntry with copy:true keeps the source (duplicate)', async () => {
    const root = sampleRoot();
    __setFolderForTest('workspace', root as never);
    await listEntries('workspace');

    const newToken = await moveEntry('workspace/billing/order.koi', 'workspace', 'empty/order.koi', true);
    expect(newToken).toBe('workspace/empty/order.koi');

    // Source still there...
    const billing = root.entries.get('billing') as MockDir;
    expect(billing.entries.has('order.koi')).toBe(true);
    // ...and a copy lives at the destination with the same bytes.
    const empty = root.entries.get('empty') as MockDir;
    const moved = empty.entries.get('order.koi') as MockFile;
    expect(moved.contents).toBe('context Billing {}');
  });

  it('moveEntry without copy deletes the source', async () => {
    const root = sampleRoot();
    __setFolderForTest('workspace', root as never);
    await listEntries('workspace');

    const newToken = await moveEntry('workspace/billing/invoice.koi', 'workspace', 'empty/invoice.koi');
    expect(newToken).toBe('workspace/empty/invoice.koi');

    const billing = root.entries.get('billing') as MockDir;
    expect(billing.entries.has('invoice.koi')).toBe(false);
    const empty = root.entries.get('empty') as MockDir;
    expect(empty.entries.has('invoice.koi')).toBe(true);
  });

  it('renameEntry on a directory preserves non-.koi files and build dirs (no data loss)', async () => {
    // A folder rename must keep EVERY child — including files the explorer never lists (glossary.md,
    // generated .cs) and skipped dirs (obj/) — because the source is deleted afterward.
    const root = new MockDir('workspace');
    const orders = new MockDir('orders');
    orders.entries.set('order.koi', new MockFile('order.koi', 'context Orders {}'));
    orders.entries.set('glossary.md', new MockFile('glossary.md', '# Orders glossary'));
    const objDir = new MockDir('obj');
    objDir.entries.set('Order.cs', new MockFile('Order.cs', '// generated'));
    orders.entries.set('obj', objDir);
    root.entries.set('orders', orders);
    __setFolderForTest('workspace', root as never);
    await listEntries('workspace');

    const newToken = await renameEntry('workspace/orders', 'purchasing');
    expect(newToken).toBe('workspace/purchasing');
    expect(root.entries.has('orders')).toBe(false);

    const purchasing = root.entries.get('purchasing') as MockDir;
    expect((purchasing.entries.get('order.koi') as MockFile).contents).toBe('context Orders {}');
    // The non-.koi sibling and the skipped build dir + its file must survive.
    expect((purchasing.entries.get('glossary.md') as MockFile).contents).toBe('# Orders glossary');
    const movedObj = purchasing.entries.get('obj') as MockDir;
    expect((movedObj.entries.get('Order.cs') as MockFile).contents).toBe('// generated');
  });

  it('moveEntry rejects an existing destination name instead of overwriting', async () => {
    const root = sampleRoot();
    __setFolderForTest('workspace', root as never);
    await listEntries('workspace');

    // billing already has invoice.koi; moving order.koi onto it must not clobber it.
    await expect(
      moveEntry('workspace/billing/order.koi', 'workspace', 'billing/invoice.koi'),
    ).rejects.toThrow('already exists: invoice.koi');
    const billing = root.entries.get('billing') as MockDir;
    expect((billing.entries.get('invoice.koi') as MockFile).contents).toBe('context Invoice {}');
    expect(billing.entries.has('order.koi')).toBe(true); // source untouched
  });

  it('moveEntry moves a whole directory without copy', async () => {
    const root = sampleRoot();
    __setFolderForTest('workspace', root as never);
    await listEntries('workspace');

    const newToken = await moveEntry('workspace/shipping', 'workspace', 'empty/shipping');
    expect(newToken).toBe('workspace/empty/shipping');
    expect(root.entries.has('shipping')).toBe(false);

    const empty = root.entries.get('empty') as MockDir;
    const moved = empty.entries.get('shipping') as MockDir;
    const domain = moved.entries.get('domain') as MockDir;
    expect((domain.entries.get('shipment.koi') as MockFile).contents).toBe('context Shipping {}');
  });

  it('rejects malformed names and paths', async () => {
    const root = sampleRoot();
    __setFolderForTest('workspace', root as never);
    await listEntries('workspace');

    await expect(createFolder('workspace', '')).rejects.toThrow('invalid path');
    await expect(createFile('workspace', 'a//b.koi')).rejects.toThrow('invalid path');
    await expect(renameEntry('workspace/billing/order.koi', 'a/b.koi')).rejects.toThrow('invalid name');
  });
});

describe('listDir (flat, any-extension docs listing)', () => {
  beforeEach(() => {
    __resetFsForTest();
  });

  /** A root holding a docs/adr folder with two markdown ADRs, a non-md file, and a subfolder. */
  function docsRoot(): MockDir {
    const root = new MockDir('workspace');
    const docs = new MockDir('docs');
    const adr = new MockDir('adr');
    adr.entries.set('0002-second.md', new MockFile('0002-second.md', '# 2. Second'));
    adr.entries.set('0001-first.md', new MockFile('0001-first.md', '# 1. First'));
    adr.entries.set('README.txt', new MockFile('README.txt', 'not markdown, still listed'));
    adr.entries.set('archive', new MockDir('archive'));
    docs.entries.set('adr', adr);
    root.entries.set('docs', docs);
    return root;
  }

  it('lists immediate children of any extension, folders first then alpha', async () => {
    __setFolderForTest('workspace', docsRoot() as never);
    const entries = await listDir('workspace', 'docs/adr');

    expect(entries.map((e) => e.name)).toEqual(['archive', '0001-first.md', '0002-second.md', 'README.txt']);
    // Flat: no recursion, so no nested children arrays.
    expect(entries.every((e) => e.children === undefined)).toBe(true);
    expect(entries[0].kind).toBe('dir');
    expect(entries[1].kind).toBe('file');
    // rel_path is forward-slashed and rooted at the opened folder; token is `<folder>/<relPath>`.
    expect(entries[1].relPath).toBe('docs/adr/0001-first.md');
    expect(entries[1].token).toBe('workspace/docs/adr/0001-first.md');
  });

  it('registers listed files so a later readTextFile resolves them (the .koi walk would not)', async () => {
    __setFolderForTest('workspace', docsRoot() as never);
    await listDir('workspace', 'docs/adr');
    // The markdown ADR is readable purely because listDir registered its handle.
    expect(await readTextFile('workspace/docs/adr/0001-first.md')).toBe('# 1. First');
  });

  it('rejects when the directory does not exist (callers treat it as empty)', async () => {
    __setFolderForTest('workspace', docsRoot() as never);
    await expect(listDir('workspace', 'docs/nope')).rejects.toThrow();
  });
});

describe('default workspace (OPFS)', () => {
  function mockOpfs(root: MockDir): void {
    (navigator as unknown as { storage: { getDirectory(): Promise<unknown> } }).storage = {
      getDirectory: async () => root as never,
    };
  }

  // Restore navigator.storage after each test so the no-OPFS case (which deletes it) can't leak
  // into later tests sharing this JS environment.
  const originalStorage = (navigator as unknown as { storage?: unknown }).storage;
  afterEach(() => {
    (navigator as unknown as { storage?: unknown }).storage = originalStorage;
  });

  it('seeds model.koi on first open and preserves edits on reopen', async () => {
    __resetFsForTest();
    mockOpfs(new MockDir('opfs-root'));

    const token = await openDefaultWorkspace('context Seed {}');
    expect(token).not.toBeNull();

    const entries = await listEntries(token as string);
    expect(entries.map((e) => e.name)).toEqual(['model.koi']);
    expect(await readTextFile(`${token as string}/model.koi`)).toBe('context Seed {}');

    // Edit, then reopen with a different seed: the existing file must win (no clobber).
    await writeTextFile(`${token as string}/model.koi`, 'context Edited {}');
    const token2 = await openDefaultWorkspace('context Other {}');
    expect(await readTextFile(`${token2 as string}/model.koi`)).toBe('context Edited {}');
  });

  it('falls back to an in-memory workspace when OPFS is unavailable', async () => {
    __resetFsForTest();
    delete (navigator as unknown as { storage?: unknown }).storage;
    // No OPFS (Safari/Firefox Private): the IDE must still open a usable workspace, just not a
    // persistent one — so the editor + compiler work in memory instead of dead-ending.
    const token = await openDefaultWorkspace('context Seed {}');
    expect(token).not.toBeNull();
    await listEntries(token as string);
    expect(await readTextFile(`${token as string}/model.koi`)).toBe('context Seed {}');
    expect(persistsWorkspace()).toBe(false); // memory-only — work does not survive a reload
  });
});

describe('materializeWorkspace (examples vs shared imports)', () => {
  function mockOpfs(root: MockDir): void {
    (navigator as unknown as { storage: { getDirectory(): Promise<unknown> } }).storage = {
      getDirectory: async () => root as never,
    };
  }
  const originalStorage = (navigator as unknown as { storage?: unknown }).storage;
  afterEach(async () => {
    (navigator as unknown as { storage?: unknown }).storage = originalStorage;
    __resetFsForTest();
    await __clearDbForTest();
  });

  it('persist=true: stable token, seeds once, and preserves edits on reopen', async () => {
    __resetFsForTest();
    await __clearDbForTest();
    mockOpfs(new MockDir('opfs-root'));

    const files = [{ relPath: 'model.koi', contents: 'context Billing {}' }];
    const token = await materializeWorkspace('billing', files, true);
    expect(token).toBe('example-billing'); // stable token, not a session-unique one
    await listEntries(token as string); // registers the file handles (the open path does this)
    expect(await readTextFile(`${token as string}/model.koi`)).toBe('context Billing {}');

    // Edit, then reopen the SAME example with different seed files: edits must win (no wipe).
    await writeTextFile(`${token as string}/model.koi`, 'context Edited {}');
    const token2 = await materializeWorkspace('billing', [{ relPath: 'model.koi', contents: 'context Fresh {}' }], true);
    expect(token2).toBe('example-billing');
    await listEntries(token2 as string);
    expect(await readTextFile(`${token2 as string}/model.koi`)).toBe('context Edited {}');
  });

  it('persist=false (default): recreated fresh on every call (shared-import semantics)', async () => {
    __resetFsForTest();
    await __clearDbForTest();
    mockOpfs(new MockDir('opfs-root'));

    const token = await materializeWorkspace('shared-workspace', [{ relPath: 'a.koi', contents: 'context A {}' }]);
    const first = await listEntries(token as string);
    expect(first.map((e) => e.name)).toEqual(['a.koi']);
    expect(await readTextFile(`${token as string}/a.koi`)).toBe('context A {}');

    // A second import with different files reflects ITS OWN payload, not the prior one (fresh wipe).
    const token2 = await materializeWorkspace('shared-workspace', [{ relPath: 'b.koi', contents: 'context B {}' }]);
    const entries = await listEntries(token2 as string);
    expect(entries.map((e) => e.name).sort()).toEqual(['b.koi']);
    expect(await readTextFile(`${token2 as string}/b.koi`)).toBe('context B {}');
  });

  it('falls back to an in-memory workspace when OPFS is unavailable', async () => {
    __resetFsForTest();
    delete (navigator as unknown as { storage?: unknown }).storage;
    // Examples must open on non-OPFS browsers too — backed in memory (session-only).
    const token = await materializeWorkspace('x', [{ relPath: 'a.koi', contents: 'context A {}' }], true);
    expect(token).not.toBeNull();
    await listEntries(token as string);
    expect(await readTextFile(`${token as string}/a.koi`)).toBe('context A {}');
    expect(persistsWorkspace()).toBe(false);
  });
});

describe('saveProjectToRoot / workspace root', () => {
  afterEach(async () => {
    __resetFsForTest();
    await __clearDbForTest();
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });

  it('picks a root once, writes files under <root>/<name>/, and reuses the root', async () => {
    const root = new MockDir('koine');
    let pickCount = 0;
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => {
      pickCount++;
      return root as unknown;
    };

    const files = [
      { relPath: 'a.koi', contents: 'context A {}' },
      { relPath: 'sub/b.koi', contents: 'context B {}' },
    ];
    const token = await saveProjectToRoot('my-pizzeria', files);

    expect(token).toBe('my-pizzeria');
    const proj = root.entries.get('my-pizzeria') as MockDir;
    expect((proj.entries.get('a.koi') as MockFile).contents).toBe('context A {}');
    const sub = proj.entries.get('sub') as MockDir;
    expect((sub.entries.get('b.koi') as MockFile).contents).toBe('context B {}');

    await saveProjectToRoot('second', [{ relPath: 'c.koi', contents: '' }]);
    expect(pickCount).toBe(1); // root remembered, not re-picked
  });

  it('rejects a name that already exists under the root and writes nothing new', async () => {
    const root = new MockDir('koine');
    root.entries.set('dup', new MockDir('dup'));
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => root as unknown;

    await expect(saveProjectToRoot('dup', [{ relPath: 'a.koi', contents: 'x' }])).rejects.toThrow(/already exists/);
    expect((root.entries.get('dup') as MockDir).entries.size).toBe(0);
  });

  it('returns null when the root picker is dismissed', async () => {
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => {
      throw new DOMException('aborted', 'AbortError');
    };
    expect(await saveProjectToRoot('x', [{ relPath: 'a.koi', contents: '' }])).toBeNull();
  });

  it('reports the workspace root name once picked, null before', async () => {
    expect(await workspaceRootName()).toBeNull();
    const root = new MockDir('koine');
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => root as unknown;
    await saveProjectToRoot('p', [{ relPath: 'a.koi', contents: '' }]);
    expect(await workspaceRootName()).toBe('koine');
  });

  it('pickWorkspaceRoot re-prompts and updates the remembered root', async () => {
    const first = new MockDir('koine');
    const second = new MockDir('work');
    let pick = 0;
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => {
      pick++;
      return (pick === 1 ? first : second) as unknown;
    };
    await saveProjectToRoot('p', [{ relPath: 'a.koi', contents: '' }]); // picks `first`
    const name = await pickWorkspaceRoot(); // forces a re-pick → `second`
    expect(name).toBe('work');
    expect(await workspaceRootName()).toBe('work');
  });
});

// --- persisted-example IndexedDB reload round-trip (#535 follow-up, #544) -----
// #535 makes Studio Web auto-restore an opened example after a reload: materializeWorkspace(persist:true)
// writes the example into OPFS and idbPut()s its directory handle, and at cold boot the shell re-acquires
// it by token. The #535 boot tests mock `@/host` (FakePlatform.listKoiFiles ignores its token), so the
// fs-layer promise the fix actually relies on — that a persisted `example-*` handle genuinely re-acquires
// from IndexedDB, WITHOUT a permission prompt, once the in-memory handle caches are gone — is untested.
// This suite drives the REAL materialize → reload → listKoiFiles path against the in-memory IndexedDB
// (fake-indexeddb, installed in src/test-setup.ts), closing that gap.
//
// A real FileSystemDirectoryHandle is [Serializable]: the browser persists it to IndexedDB and restores a
// live, usable handle on read. happy-dom ships no such handle, and a plain mock class loses its methods
// through structured clone (prototype methods don't survive — verified empirically), so a re-acquired
// plain mock would not be walkable. We therefore back the OPFS handle with a `Map` subclass: a Map
// round-trips structured clone into a real Map whose `.values()` still iterates its children, so the
// re-acquired handle walks exactly like a restored OPFS handle. And — like a real OPFS handle, unlike a
// picked folder — the restored Map carries NO queryPermission/requestPermission, so resolveFolder
// re-acquires it silently. That asymmetry is the whole premise of #535: boot may auto-restore `example-*`
// but never a picked folder.
describe('materializeWorkspace persisted-example IndexedDB reload round-trip (#544)', () => {
  // Spy proving the re-acquire path never prompts. It lives on the LIVE handle's prototype; structured
  // clone drops it (a restored OPFS handle exposes no permission API), so a green re-acquire that leaves
  // this uncalled is the silent-restore guarantee.
  const requestPermissionSpy = vi.fn(async (_opts?: { mode: string }) => 'granted' as PermissionState);

  /** A file handle seeded into the OPFS tree (materialize only exercises createWritable; walk reads name). */
  class CloneFile {
    readonly kind = 'file' as const;
    constructor(
      public name: string,
      public contents = '',
    ) {}
    async getFile() {
      const text = this.contents;
      return { text: async () => text } as unknown as File;
    }
    async createWritable() {
      return {
        write: async (data: string | { text(): Promise<string> }) => {
          this.contents = typeof data === 'string' ? data : await data.text();
        },
        close: async () => {},
      };
    }
  }

  // A directory handle that survives fake-indexeddb's structured clone with a working values(): children
  // live as Map entries, so the clone (a plain Map) still iterates them via Map.prototype.values — the
  // same surface fs.ts's walk drives. Models a [Serializable] OPFS handle restored from IndexedDB.
  class CloneDir extends Map<string, CloneFile | CloneDir> {
    readonly kind = 'directory' as const;
    constructor(public name: string) {
      super();
    }
    async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<CloneDir> {
      const existing = this.get(name);
      if (existing) {
        if (existing.kind !== 'directory') throw new Error('not a directory: ' + name);
        return existing;
      }
      if (!opts?.create) throw new Error('NotFound: ' + name);
      const dir = new CloneDir(name);
      this.set(name, dir);
      return dir;
    }
    async getFileHandle(name: string, opts?: { create?: boolean }): Promise<CloneFile> {
      const existing = this.get(name);
      if (existing) {
        if (existing.kind !== 'file') throw new Error('not a file: ' + name);
        return existing;
      }
      if (!opts?.create) throw new Error('NotFound: ' + name);
      const file = new CloneFile(name);
      this.set(name, file);
      return file;
    }
    async removeEntry(name: string): Promise<void> {
      this.delete(name);
    }
    // Present on the LIVE handle; dropped by structured clone (an OPFS handle restores without a
    // permission gate). queryPermission would report 'granted' even if it survived, so resolveFolder never
    // prompts on re-acquire.
    async queryPermission(): Promise<PermissionState> {
      return 'granted';
    }
    async requestPermission(opts?: { mode: string }): Promise<PermissionState> {
      return requestPermissionSpy(opts);
    }
  }

  function mockOpfs(root: CloneDir): void {
    (navigator as unknown as { storage: { getDirectory(): Promise<unknown> } }).storage = {
      getDirectory: async () => root as never,
    };
  }

  const originalStorage = (navigator as unknown as { storage?: unknown }).storage;
  beforeEach(async () => {
    __resetFsForTest();
    await __clearDbForTest();
    requestPermissionSpy.mockClear();
    mockOpfs(new CloneDir('opfs-root'));
  });
  afterEach(async () => {
    (navigator as unknown as { storage?: unknown }).storage = originalStorage;
    __resetFsForTest();
    await __clearDbForTest();
  });

  it('re-acquires a persisted example from IndexedDB after a reload, with no permission prompt', async () => {
    const files = [{ relPath: 'subscription.koi', contents: 'context Sub {}\n' }];

    // Materialize a persistent example. persistsWorkspace() is true under the mocked OPFS, so the handle
    // is idbPut() into IndexedDB; the token is the STABLE example token (not a session-unique one).
    const token = await materializeWorkspace('saas-subscription', files, true);
    expect(token).toBe('example-saas-subscription');
    expect(persistsWorkspace()).toBe(true);

    // Simulate a page reload: drop every in-memory handle cache so the next resolve MUST hit IndexedDB.
    __resetFsForTest();

    // Re-acquire by token alone. A successful walk proves idbPut ran AND the handle round-tripped through
    // IndexedDB — a non-cloneable mock would lose its methods here and the walk would throw.
    const files2 = await listKoiFiles(token as string);
    expect(files2.map((f) => f.relPath)).toContain('subscription.koi');

    // The OPFS silent-restore invariant: re-acquiring the example prompted for nothing.
    expect(requestPermissionSpy).not.toHaveBeenCalled();
  });
});
