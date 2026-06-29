import { describe, it, expect, vi } from 'vitest';
import { ChangeSet, Text } from '@codemirror/state';
import type { FsEntry, Platform } from '@/host';
import type { SourceSpan } from '@/lsp/lsp';
import { REVIEWS_FILE, createReviewStore, remapSpans, type ReviewStore, type ReviewThread } from '@/review/reviewStore';

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

  it('recovers from a lost create race: createFile rejects, then re-locates and overwrites', async () => {
    const { platform, files } = fakeFs();
    const store = createReviewStore(platform, () => FOLDER);

    // Simulate the file appearing between locate() and createFile(): a racer plants `.koine/reviews.json`
    // and our createFile rejects, so the re-locate finds its token and writeTextFile lands our threads.
    platform.createFile = ((folderToken: string, relPath: string) => {
      files.set(`${folderToken}/${relPath}`, JSON.stringify({ version: 1, threads: [] }));
      return Promise.reject(new Error('already exists (raced)'));
    }) as Platform['createFile'];

    const t = store.add('model.koi', span('model.koi'), 'raced', 'alice');
    await flushPersist();

    // Exactly one reviews.json, holding our thread (the racer's empty file was overwritten).
    expect([...files.keys()].filter((k) => k.endsWith(REVIEWS_FILE))).toHaveLength(1);
    const fresh = createReviewStore(platform, () => FOLDER);
    await fresh.load();
    expect(fresh.list().map((x) => x.id)).toEqual([t.id]);
  });

  it('re-opening a DIFFERENT folder re-discovers the file under the new root (no stale token)', async () => {
    const { platform, files } = fakeFs();
    // Two folders, each with its own one-thread reviews.json, addressed by a switching folder getter.
    const seed = (id: string, file: string) =>
      JSON.stringify({ version: 1, threads: [{ id, file, span: span(file), status: 'open', comments: [] }] });
    files.set('A/.koine/reviews.json', seed('review-a', 'a.koi'));
    files.set('B/.koine/reviews.json', seed('review-b', 'b.koi'));

    let root = 'A';
    const store = createReviewStore(platform, () => root);

    await store.load();
    expect(store.list().map((t) => t.id)).toEqual(['review-a']);

    root = 'B'; // open a different folder
    await store.load();
    expect(store.list().map((t) => t.id)).toEqual(['review-b']); // re-discovered under B, not stuck on A
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

// --- Task 2: span re-anchoring on document edits -----------------------------
// The fixtures use the document "hello\nworld" (length 11): line 1 = [0,5], '\n' at 5,
// line 2 "world" = [6,11). The span under test pins "world": offset 6, length 5.
describe('reviewStore — remapSpans (pure re-anchoring)', () => {
  /** A throwaway open thread on `span` (only the span/status matter to remapSpans). */
  function thread(s: SourceSpan, status: ReviewThread['status'] = 'open'): ReviewThread {
    return { id: 'review-x', file: 'model.koi', span: s, status, comments: [{ author: 'a', body: 'b', ts: 1 }] };
  }
  /** The "world" span on line 2 of "hello\nworld". */
  function worldSpan(): SourceSpan {
    return { file: 'model.koi', line: 2, column: 1, endLine: 2, endColumn: 6, offset: 6, length: 5 };
  }

  it('an edit BEFORE the span shifts it (offset += inserted length; line/column recompute)', () => {
    const before = Text.of(['hello', 'world']);
    const change = ChangeSet.of({ from: 0, to: 0, insert: 'XY' }, before.length);
    const after = Text.of(['XYhello', 'world']); // "XYhello\nworld", length 13
    const input = thread(worldSpan());

    const out = remapSpans([input], change, after, 'model.koi');

    expect(out).not.toBe(input as unknown); // a fresh array
    expect(out[0]).not.toBe(input); // a fresh thread (purity)
    expect(out[0].span.offset).toBe(8); // 6 + 2 inserted
    expect(out[0].span.length).toBe(5); // unchanged
    expect(out[0].span.line).toBe(2);
    expect(out[0].span.column).toBe(1);
    expect(out[0].span.endLine).toBe(2);
    expect(out[0].span.endColumn).toBe(6);
    expect(out[0].status).toBe('open');
    // input is not mutated
    expect(input.span.offset).toBe(6);
  });

  it('an edit INSIDE the span grows/shrinks it (length changes; start offset unchanged)', () => {
    const before = Text.of(['hello', 'world']);

    // grow: insert 3 chars at offset 8 (inside "world")
    const grow = ChangeSet.of({ from: 8, to: 8, insert: '!!!' }, before.length);
    const grownDoc = Text.of(['hello', 'wo!!!rld']);
    const grown = remapSpans([thread(worldSpan())], grow, grownDoc, 'model.koi');
    expect(grown[0].span.offset).toBe(6); // start unchanged
    expect(grown[0].span.length).toBe(8); // 5 + 3 inserted
    expect(grown[0].status).toBe('open');

    // shrink: delete the 2 chars at [7,9) (inside "world")
    const shrink = ChangeSet.of({ from: 7, to: 9, insert: '' }, before.length);
    const shrunkDoc = Text.of(['hello', 'wrld']);
    const shrunk = remapSpans([thread(worldSpan())], shrink, shrunkDoc, 'model.koi');
    expect(shrunk[0].span.offset).toBe(6); // start unchanged
    expect(shrunk[0].span.length).toBe(3); // 5 - 2 deleted
    expect(shrunk[0].status).toBe('open');
  });

  it('deleting the WHOLE span orphans the thread but KEEPS it in the list (not dropped)', () => {
    const before = Text.of(['hello', 'world']);
    const change = ChangeSet.of({ from: 6, to: 11, insert: '' }, before.length); // delete "world"
    const after = Text.of(['hello', '']); // "hello\n", length 6
    const out = remapSpans([thread(worldSpan())], change, after, 'model.koi');

    expect(out).toHaveLength(1); // kept, not dropped
    expect(out[0].status).toBe('orphaned');
    expect(out[0].span.length).toBe(0);
    // re-anchored to a valid, in-range offset (recompute must not throw)
    expect(out[0].span.offset).toBeGreaterThanOrEqual(0);
    expect(out[0].span.offset).toBeLessThanOrEqual(after.length);
  });

  it('preserves resolved status and never resurrects an orphaned thread to open', () => {
    const before = Text.of(['hello', 'world']);

    // a RESOLVED thread whose span is deleted keeps 'resolved' (only open flips to orphaned)
    const del = ChangeSet.of({ from: 6, to: 11, insert: '' }, before.length);
    const after = Text.of(['hello', '']);
    expect(remapSpans([thread(worldSpan(), 'resolved')], del, after, 'model.koi')[0].status).toBe('resolved');

    // an ORPHANED thread that SURVIVES an edit stays orphaned, with its position re-anchored
    const ins = ChangeSet.of({ from: 0, to: 0, insert: 'XY' }, before.length);
    const grownDoc = Text.of(['XYhello', 'world']);
    const survived = remapSpans([thread(worldSpan(), 'orphaned')], ins, grownDoc, 'model.koi');
    expect(survived[0].status).toBe('orphaned');
    expect(survived[0].span.offset).toBe(8);
  });

  it('leaves threads in OTHER files untouched (the change belongs to one buffer only)', () => {
    const before = Text.of(['hello', 'world']);
    // a big delete in model.koi that WOULD orphan a thread anchored there…
    const change = ChangeSet.of({ from: 0, to: before.length, insert: '' }, before.length);
    const after = Text.of(['']);
    // …but the thread lives in other.koi, so remapping for 'model.koi' must return it byte-identical.
    const other = thread(worldSpan());
    other.file = 'other.koi';
    other.span = { ...other.span, file: 'other.koi' };

    const out = remapSpans([other], change, after, 'model.koi');

    expect(out[0]).toBe(other); // same reference: not re-anchored, not orphaned, not copied
    expect(out[0].status).toBe('open');
    expect(out[0].span.offset).toBe(6);
  });
});

describe('reviewStore — remap (store wiring)', () => {
  it('store.remap shifts spans, persists, and notifies; an identity change is a no-op', async () => {
    const { platform } = fakeFs();
    const store = createReviewStore(platform, () => FOLDER);
    const t = store.add(
      'model.koi',
      { file: 'model.koi', line: 2, column: 1, endLine: 2, endColumn: 6, offset: 6, length: 5 },
      'q',
      'alice',
    );
    await flushPersist();

    const cb = vi.fn();
    store.subscribe(cb);

    const before = Text.of(['hello', 'world']);
    const change = ChangeSet.of({ from: 0, to: 0, insert: 'XY' }, before.length);
    const after = Text.of(['XYhello', 'world']);
    store.remap('model.koi', change, after);

    const shifted = store.list().find((x) => x.id === t.id)!;
    expect(shifted.span.offset).toBe(8);
    expect(shifted.span.length).toBe(5);
    expect(shifted.span.line).toBe(2);
    expect(shifted.span.column).toBe(1);
    expect(cb).toHaveBeenCalledTimes(1); // a real move notifies once

    await flushPersist();
    const fresh = createReviewStore(platform, () => FOLDER);
    await fresh.load();
    expect(fresh.list()[0].span.offset).toBe(8); // the shifted span was persisted

    // an identity change moves nothing: no extra notify (and no needless write)
    const identity = ChangeSet.of([], after.length);
    store.remap('model.koi', identity, after);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
