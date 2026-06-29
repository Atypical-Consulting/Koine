import { describe, it, expect } from 'vitest';
import type { FsEntry, Platform } from '@/host';
import { createFolderSidecar } from '@/host/sidecar';

// --- in-memory mock of the host file abstraction -----------------------------
// Only the four methods the sidecar touches are implemented (listDir / readTextFile / writeTextFile /
// createFile), mirroring the store tests' fakes. Map keys are FULL tokens of the form `<root>/<relPath>`;
// `listDir(root, dir)` returns the direct children of `<root>/<dir>` (dir '' is the root). Each method
// bumps a call counter so the token-caching contract can be asserted.
interface FakeFs {
  platform: Platform;
  files: Map<string, string>;
  calls: { listDir: number; readTextFile: number; writeTextFile: number; createFile: number };
}

function fakeFs(initial: Record<string, string> = {}): FakeFs {
  const files = new Map<string, string>(Object.entries(initial));
  const calls = { listDir: 0, readTextFile: 0, writeTextFile: 0, createFile: 0 };

  const platform = {
    async listDir(folderToken: string, relPath: string): Promise<FsEntry[]> {
      calls.listDir++;
      const prefix = relPath ? `${folderToken}/${relPath}/` : `${folderToken}/`;
      const children = new Map<string, 'file' | 'dir'>();
      for (const token of files.keys()) {
        if (!token.startsWith(prefix)) continue;
        const rest = token.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) children.set(rest, 'file');
        else children.set(rest.slice(0, slash), 'dir');
      }
      if (children.size === 0) throw new Error('NotFound: ' + relPath);
      return [...children].map(([name, kind]) => ({
        token: `${prefix}${name}`,
        name,
        relPath: relPath ? `${relPath}/${name}` : name,
        kind,
      }));
    },
    async readTextFile(token: string): Promise<string> {
      calls.readTextFile++;
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

// A nested sidecar path (mirrors reviewStore's `.koine/reviews.json`): listDir is asked for the `.koine`
// directory, the file name is `reviews.json`.
const RELPATH = '.koine/reviews.json';

describe('createFolderSidecar', () => {
  it('locate discovers the file token via listDir and caches it (no re-list on the second call)', async () => {
    const { platform, calls } = fakeFs({ 'R/.koine/reviews.json': '{}' });
    const sc = createFolderSidecar(platform, () => 'R', RELPATH);

    expect(await sc.locate()).toBe('R/.koine/reviews.json');
    expect(await sc.locate()).toBe('R/.koine/reviews.json');
    expect(calls.listDir).toBe(1); // discovered once, then served from cache
  });

  it('locate returns null when the directory/file is missing (listDir throws)', async () => {
    const { platform } = fakeFs(); // empty folder ⇒ listDir throws
    const sc = createFolderSidecar(platform, () => 'R', RELPATH);
    expect(await sc.locate()).toBeNull();
  });

  it('read returns the file text, or null when the file is missing or unreadable', async () => {
    const { platform, files } = fakeFs({ 'R/.koine/reviews.json': 'hello' });
    const sc = createFolderSidecar(platform, () => 'R', RELPATH);
    expect(await sc.read()).toBe('hello');

    const missing = createFolderSidecar(fakeFs().platform, () => 'R', RELPATH);
    expect(await missing.read()).toBeNull();

    // A located-but-unreadable file reads as null (read swallows the error).
    void files;
    platform.readTextFile = (() => Promise.reject(new Error('io'))) as Platform['readTextFile'];
    expect(await sc.read()).toBeNull();
  });

  it('write createFiles on the first call, then overwrites by the cached token on later calls', async () => {
    const { platform, files, calls } = fakeFs(); // empty folder: no file yet
    const sc = createFolderSidecar(platform, () => 'R', RELPATH);

    await sc.write('first');
    expect(files.get('R/.koine/reviews.json')).toBe('first');
    expect(calls.createFile).toBe(1);
    expect(calls.writeTextFile).toBe(0);

    await sc.write('second');
    expect(files.get('R/.koine/reviews.json')).toBe('second');
    expect(calls.createFile).toBe(1); // not created again
    expect(calls.writeTextFile).toBe(1); // overwritten by the cached token
  });

  it('overwrites a pre-existing file (located via listDir) rather than re-creating it', async () => {
    const { platform, files, calls } = fakeFs({ 'R/.koine/reviews.json': 'old' });
    const sc = createFolderSidecar(platform, () => 'R', RELPATH);

    await sc.write('new');
    expect(files.get('R/.koine/reviews.json')).toBe('new');
    expect(calls.createFile).toBe(0); // located the existing file ⇒ writeTextFile path
    expect(calls.writeTextFile).toBe(1);
  });

  it('recovers from a lost create race: createFile rejects but the file appeared — re-locate and overwrite', async () => {
    const { platform, files } = fakeFs();
    const sc = createFolderSidecar(platform, () => 'R', RELPATH);

    platform.createFile = ((folderToken: string, relPath: string) => {
      files.set(`${folderToken}/${relPath}`, 'raced'); // a racer planted the file…
      return Promise.reject(new Error('already exists (raced)')); // …then our create lost
    }) as Platform['createFile'];

    await sc.write('ours');
    expect(files.get('R/.koine/reviews.json')).toBe('ours'); // re-located and overwrote the racer's file
  });

  it('a genuine create failure with no file to fall back to is swallowed (no throw, no file)', async () => {
    const { platform, files } = fakeFs();
    const sc = createFolderSidecar(platform, () => 'R', RELPATH);
    platform.createFile = (() => Promise.reject(new Error('EACCES'))) as Platform['createFile'];

    await expect(sc.write('x')).resolves.toBeUndefined();
    expect(files.has('R/.koine/reviews.json')).toBe(false);
  });

  it('a null root makes locate/read resolve null and write a no-op (no fs calls)', async () => {
    const { platform, files, calls } = fakeFs();
    const sc = createFolderSidecar(platform, () => null, RELPATH);

    expect(await sc.locate()).toBeNull();
    expect(await sc.read()).toBeNull();
    await sc.write('ignored');
    expect(files.size).toBe(0);
    expect(calls.createFile).toBe(0);
    expect(calls.writeTextFile).toBe(0);
  });

  it('re-discovers under the new root when root() changes (token is keyed by the current root)', async () => {
    const { platform } = fakeFs({ 'A/.koine/reviews.json': 'in-A', 'B/.koine/reviews.json': 'in-B' });
    let root = 'A';
    const sc = createFolderSidecar(platform, () => root, RELPATH);

    expect(await sc.locate()).toBe('A/.koine/reviews.json');
    expect(await sc.read()).toBe('in-A');

    root = 'B'; // the folder changed under the same sidecar
    expect(await sc.locate()).toBe('B/.koine/reviews.json'); // re-discovered, not the stale A token
    expect(await sc.read()).toBe('in-B');
  });

  it('uses the relPath directory: a root-level file (no slash) lists the root', async () => {
    const { platform } = fakeFs({ 'R/koine.layout.json': 'layout' });
    const sc = createFolderSidecar(platform, () => 'R', 'koine.layout.json');

    expect(await sc.locate()).toBe('R/koine.layout.json');
    expect(await sc.read()).toBe('layout');
  });
});
