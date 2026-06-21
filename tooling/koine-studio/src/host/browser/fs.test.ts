import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  __setFolderForTest,
  __resetFsForTest,
  listEntries,
  listDir,
  createFile,
  createFolder,
  deleteEntry,
  renameEntry,
  moveEntry,
  openDefaultWorkspace,
  readTextFile,
  writeTextFile,
} from './fs';

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

  it('returns null when OPFS is unavailable', async () => {
    __resetFsForTest();
    delete (navigator as unknown as { storage?: unknown }).storage;
    expect(await openDefaultWorkspace('x')).toBeNull();
  });
});
