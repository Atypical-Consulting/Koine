import { describe, it, expect, vi } from 'vitest';
import type { FsEntry, Platform } from '@/host';
import type { SourceSpan } from '@/lsp/lsp';
import { REVIEWS_FILE, createReviewStore, type ReviewStore } from '@/review/reviewStore';

// --- in-memory mock of the host file abstraction -----------------------------
// Only the four methods reviewStore touches are implemented (listDir / readTextFile / writeTextFile /
// createFile), mirroring src/docs/docsStore.test.ts's fake. Tokens use the browser scheme
// `<folder>/<relPath>`; the folder token is 'WS'.
const FOLDER = 'WS';

interface FakeFs {
  platform: Platform;
  files: Map<string, string>;
}

function fakeFs(initial: Record<string, string> = {}): FakeFs {
  const files = new Map<string, string>();
  for (const [rel, contents] of Object.entries(initial)) files.set(`${FOLDER}/${rel}`, contents);

  const platform = {
    async listDir(folderToken: string, relPath: string): Promise<FsEntry[]> {
      const prefix = `${folderToken}/${relPath}/`;
      const childNames = new Map<string, 'file' | 'dir'>();
      for (const token of files.keys()) {
        if (!token.startsWith(prefix)) continue;
        const rest = token.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) childNames.set(rest, 'file');
        else childNames.set(rest.slice(0, slash), 'dir');
      }
      if (childNames.size === 0) throw new Error('NotFound: ' + relPath);
      return [...childNames].map(([name, kind]) => ({
        token: `${prefix}${name}`,
        name,
        relPath: `${relPath}/${name}`,
        kind,
      }));
    },
    async readTextFile(token: string): Promise<string> {
      if (!files.has(token)) throw new Error('not found: ' + token);
      return files.get(token)!;
    },
    async writeTextFile(token: string, contents: string): Promise<void> {
      files.set(token, contents);
    },
    async createFile(folderToken: string, relPath: string, contents?: string): Promise<string> {
      const token = `${folderToken}/${relPath}`;
      if (files.has(token)) throw new Error('already exists: ' + relPath);
      files.set(token, contents ?? '');
      return token;
    },
  } as unknown as Platform;

  return { platform, files };
}

/** A throwaway 1-based span over a few characters of a file (only the shape matters here). */
function span(file: string, line = 1): SourceSpan {
  return { file, line, column: 1, endLine: line, endColumn: 5, offset: 0, length: 4 };
}

/** Drain the microtask queue so the store's fire-and-forget persist has reached the fake fs. */
function flushPersist(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('reviewStore — model', () => {
  it('add creates an OPEN thread with one comment and a unique id; list returns it', () => {
    const { platform } = fakeFs();
    const store: ReviewStore = createReviewStore(platform, () => FOLDER); // pins the public contract

    const t = store.add('model.koi', span('model.koi'), 'Should this be a value object?', 'alice');
    expect(t.status).toBe('open');
    expect(t.file).toBe('model.koi');
    expect(t.comments).toHaveLength(1);
    expect(t.comments[0].author).toBe('alice');
    expect(t.comments[0].body).toBe('Should this be a value object?');
    expect(typeof t.comments[0].ts).toBe('number');
    expect(t.id).toBeTruthy();
    expect(store.list()).toContainEqual(t);

    const t2 = store.add('model.koi', span('model.koi'), 'Another note', 'bob');
    expect(t2.id).not.toBe(t.id);
    expect(store.list()).toHaveLength(2);
  });

  it('reply appends a comment to the thread', () => {
    const { platform } = fakeFs();
    const store = createReviewStore(platform, () => FOLDER);
    const t = store.add('model.koi', span('model.koi'), 'q', 'alice');

    store.reply(t.id, 'answer', 'bob');

    const updated = store.list().find((x) => x.id === t.id)!;
    expect(updated.comments).toHaveLength(2);
    expect(updated.comments[1]).toMatchObject({ author: 'bob', body: 'answer' });
    expect(typeof updated.comments[1].ts).toBe('number');
  });

  it('setStatus resolves and re-opens a thread', () => {
    const { platform } = fakeFs();
    const store = createReviewStore(platform, () => FOLDER);
    const t = store.add('model.koi', span('model.koi'), 'q', 'alice');

    store.setStatus(t.id, 'resolved');
    expect(store.list().find((x) => x.id === t.id)!.status).toBe('resolved');

    store.setStatus(t.id, 'open');
    expect(store.list().find((x) => x.id === t.id)!.status).toBe('open');
  });

  it('remove deletes the thread from list', () => {
    const { platform } = fakeFs();
    const store = createReviewStore(platform, () => FOLDER);
    const t = store.add('model.koi', span('model.koi'), 'q', 'alice');

    store.remove(t.id);
    expect(store.list()).toHaveLength(0);
  });

  it('subscribe fires on every mutation and the returned fn unsubscribes', () => {
    const { platform } = fakeFs();
    const store = createReviewStore(platform, () => FOLDER);
    const cb = vi.fn();
    const off = store.subscribe(cb);

    const t = store.add('model.koi', span('model.koi'), 'q', 'alice');
    store.reply(t.id, 'a', 'bob');
    store.setStatus(t.id, 'resolved');
    store.remove(t.id);
    expect(cb).toHaveBeenCalledTimes(4);

    off();
    store.add('model.koi', span('model.koi'), 'q2', 'alice');
    expect(cb).toHaveBeenCalledTimes(4);
  });
});

describe('reviewStore — persistence', () => {
  it('writes .koine/reviews.json and a fresh store loads it back', async () => {
    const { platform, files } = fakeFs();
    const store = createReviewStore(platform, () => FOLDER);

    const t = store.add('model.koi', span('model.koi'), 'persist me', 'alice');
    store.reply(t.id, 'sure', 'bob');
    await flushPersist();

    expect(files.has(`${FOLDER}/${REVIEWS_FILE}`)).toBe(true);

    const fresh = createReviewStore(platform, () => FOLDER);
    await fresh.load();
    const loaded = fresh.list();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(t.id);
    expect(loaded[0].file).toBe('model.koi');
    expect(loaded[0].comments.map((c) => c.body)).toEqual(['persist me', 'sure']);
    expect(loaded[0].span.line).toBe(1);
  });

  it('overwrites the existing file on later mutations (no create-race throw)', async () => {
    const { platform, files } = fakeFs();
    const store = createReviewStore(platform, () => FOLDER);

    const t = store.add('model.koi', span('model.koi'), 'one', 'alice');
    await flushPersist();
    store.setStatus(t.id, 'resolved');
    await flushPersist();

    const fresh = createReviewStore(platform, () => FOLDER);
    await fresh.load();
    expect(fresh.list()[0].status).toBe('resolved');
    // exactly one reviews.json was kept, not duplicated
    expect([...files.keys()].filter((k) => k.endsWith(REVIEWS_FILE))).toHaveLength(1);
  });

  it('loads as empty when the file is missing (no .koine yet) without throwing', async () => {
    const { platform } = fakeFs();
    const store = createReviewStore(platform, () => FOLDER);
    await store.load();
    expect(store.list()).toEqual([]);
  });

  it('loads as empty when the file is corrupt/garbage without throwing', async () => {
    const { platform } = fakeFs({ '.koine/reviews.json': 'this is not json {{{' });
    const store = createReviewStore(platform, () => FOLDER);
    await store.load();
    expect(store.list()).toEqual([]);
  });

  it('works in-memory and never persists when folderToken() is null (scratch mode)', async () => {
    const { platform, files } = fakeFs();
    const store = createReviewStore(platform, () => null);

    const t = store.add('model.koi', span('model.koi'), 'no folder', 'alice');
    store.reply(t.id, 'still fine', 'bob');
    store.setStatus(t.id, 'resolved');
    await flushPersist();

    expect(store.list()).toHaveLength(1);
    expect(files.size).toBe(0); // nothing written to disk
    await expect(store.load()).resolves.toBeUndefined(); // load is a no-op, never throws
  });
});
