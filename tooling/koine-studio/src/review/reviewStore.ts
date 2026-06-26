// The persistence backend for in-editor review threads (issue #259, Phase 1 collaboration). A review
// thread pins a comment conversation to a source span in a `.koi` file; this store owns the set of
// threads for the active workspace and writes them to a committable `.koine/reviews.json` sidecar so a
// review travels with the repo (and diffs minimally: versioned envelope, ids sorted, trailing newline).
//
// It mirrors `src/diagrams/layoutStore.ts`'s `createFolderLayoutStore`: a tolerant JSON envelope,
// `listDir`-based token discovery + caching, and create-race-safe writes. Two differences:
//   • the folder token is a GETTER `() => string | null`, re-read on every persist — null means
//     no-folder/scratch mode, where the store stays purely in-memory (no disk persistence, no throw); and
//   • the store is MUTATED by add/reply/setStatus/remove, each of which persists and notifies subscribers.
//
// Like the diagram layout, review/comment state is a Studio-only VIEW concern: it NEVER round-trips into
// the `.koi` semantic model or the emitter output. All filesystem access goes through {@link Platform}.
import { MapMode, type ChangeSet, type Text } from '@codemirror/state';
import type { Platform } from '@/host';
import type { SourceSpan } from '@/lsp/lsp';

/** The committable reviews sidecar, written under the opened folder's `.koine/` directory. */
export const REVIEWS_DIR = '.koine';
/** The reviews file's relative path under the opened folder. */
export const REVIEWS_FILE = '.koine/reviews.json';
/** Envelope version; readers tolerate older/empty/garbage files by loading an empty set. */
const REVIEWS_VERSION = 1;

/** One comment in a thread: who said it, what they said, and when (epoch ms). */
export interface ReviewComment {
  author: string;
  body: string;
  ts: number;
}

/**
 * A review thread pinned to a source span. `status` is `'open'` (live), `'resolved'` (closed by a
 * reviewer), or `'orphaned'` (the span could no longer be re-anchored after an edit — set by Task 2).
 */
export interface ReviewThread {
  id: string;
  file: string;
  span: SourceSpan;
  status: 'open' | 'resolved' | 'orphaned';
  comments: ReviewComment[];
}

/**
 * The review-thread store for the active workspace. `load()` hydrates from disk (a no-op without a
 * folder); the mutators (`add`/`reply`/`setStatus`/`remove`) update the in-memory set, persist it (when a
 * folder is open), and notify subscribers. `subscribe` returns an unsubscribe function.
 */
export interface ReviewStore {
  /** Hydrate threads from `.koine/reviews.json`; empty set on a missing/corrupt file or no folder. */
  load(): Promise<void>;
  /** The current threads (a fresh array; safe for the caller to keep). */
  list(): ReviewThread[];
  /** Open a new thread on `span` in `file` with an initial comment; returns the created thread. */
  add(file: string, span: SourceSpan, body: string, author: string): ReviewThread;
  /** Append a comment to an existing thread (no-op when the id is unknown). */
  reply(id: string, body: string, author: string): void;
  /** Change a thread's status, e.g. resolve or re-open it (no-op when the id is unknown). */
  setStatus(id: string, status: ReviewThread['status']): void;
  /** Delete a thread (no-op when the id is unknown). */
  remove(id: string): void;
  /**
   * Re-anchor the threads pinned to `file` through a CodeMirror {@link ChangeSet} after that file's
   * document was edited, so a comment keeps pointing at the text it was filed against (and orphans when
   * that text was deleted). Threads in OTHER files are left untouched — `change`/`doc` describe one
   * buffer only. Persists + notifies only when something actually moved. See {@link remapSpans}.
   */
  remap(file: string, change: ChangeSet, doc: Text): void;
  /** Register a callback fired after every mutation; returns a function that unsubscribes it. */
  subscribe(cb: () => void): () => void;
}

/** The on-disk envelope. */
interface ReviewsFile {
  version: number;
  threads: ReviewThread[];
}

/** Stable id comparison (locale-independent) so two runs serialize threads identically. */
function byId(a: ReviewThread, b: ReviewThread): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A monotonic fallback so a thread gets a stable, unique id even where crypto.randomUUID is absent. */
let threadIdSeq = 0;

/** A unique id for a freshly-opened thread. */
function newThreadId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `review-${uuid ?? `${Date.now().toString(36)}-${++threadIdSeq}`}`;
}

/** Coerce a candidate span back to a fully-formed {@link SourceSpan}, defaulting missing numbers. */
function sanitizeSpan(raw: unknown): SourceSpan {
  const s = (raw ?? {}) as Partial<SourceSpan>;
  const num = (v: unknown, fallback: number): number => (Number.isFinite(v) ? (v as number) : fallback);
  return {
    file: typeof s.file === 'string' ? s.file : null,
    line: num(s.line, 1),
    column: num(s.column, 1),
    endLine: num(s.endLine, num(s.line, 1)),
    endColumn: num(s.endColumn, 1),
    offset: num(s.offset, 0),
    length: num(s.length, 0),
  };
}

/** Drop malformed comments; keep only well-typed {author, body, ts}. */
function sanitizeComments(raw: unknown): ReviewComment[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewComment[] = [];
  for (const c of raw) {
    const author = (c as Partial<ReviewComment> | null)?.author;
    const body = (c as Partial<ReviewComment> | null)?.body;
    const ts = (c as Partial<ReviewComment> | null)?.ts;
    if (typeof author === 'string' && typeof body === 'string' && Number.isFinite(ts)) {
      out.push({ author, body, ts: ts as number });
    }
  }
  return out;
}

/** Coerce one persisted entry to a {@link ReviewThread}, or null when it is unusable (no id/file). */
function sanitizeThread(raw: unknown): ReviewThread | null {
  const t = (raw ?? {}) as Partial<ReviewThread>;
  if (typeof t.id !== 'string' || typeof t.file !== 'string') return null;
  const status: ReviewThread['status'] =
    t.status === 'resolved' || t.status === 'orphaned' ? t.status : 'open';
  return { id: t.id, file: t.file, span: sanitizeSpan(t.span), status, comments: sanitizeComments(t.comments) };
}

/** Serialize the threads as a stable, minimal-diff `.koine/reviews.json`: versioned, ids sorted, trailing newline. */
function serialize(threads: ReviewThread[]): string {
  const sorted = [...threads].sort(byId);
  const file: ReviewsFile = { version: REVIEWS_VERSION, threads: sorted };
  return JSON.stringify(file, null, 2) + '\n';
}

/** Parse a `.koine/reviews.json`, dropping malformed threads; an empty set on any failure. */
function parse(text: string): ReviewThread[] {
  try {
    const data = JSON.parse(text) as Partial<ReviewsFile> | null;
    const raw = data?.threads;
    if (!Array.isArray(raw)) return [];
    return raw.map(sanitizeThread).filter((t): t is ReviewThread => t !== null);
  } catch {
    return [];
  }
}

/** Structural span equality (every numeric field + file) so a no-op remap can skip persist/notify. */
function sameSpan(a: SourceSpan, b: SourceSpan): boolean {
  return (
    a.file === b.file &&
    a.line === b.line &&
    a.column === b.column &&
    a.endLine === b.endLine &&
    a.endColumn === b.endColumn &&
    a.offset === b.offset &&
    a.length === b.length
  );
}

/**
 * Re-anchor each thread's span through a CodeMirror {@link ChangeSet} so comments follow the text they
 * were filed against. A PURE function: it never mutates its arguments and always returns a new array of
 * new threads/spans.
 *
 * `file` scopes the remap: `change`/`doc` belong to exactly one editor buffer, so only threads pinned to
 * that `file` are re-anchored — every other file's thread is returned untouched. Without this guard an
 * edit in one file would map unrelated files' offsets through the wrong ChangeSet and recompute their
 * line/column against the wrong document, silently corrupting (and orphaning) them.
 *
 * For an in-`file` thread, each span's start offset is mapped with `assoc = 1` and its end with
 * `assoc = -1`, both in {@link MapMode.TrackDel} mode. `TrackDel` yields `null` (older CodeMirror docs say
 * `-1`) when a deletion straddled that position — and a span whose endpoints survive but collapse to zero
 * width has had every character deleted. Either signal means "the whole span is gone": the thread is KEPT
 * but orphaned (re-anchored to where the text used to be, via a plain — never-`null` — `mapPos`, with a
 * zero-width span). Only an `'open'` thread flips to `'orphaned'`; `'resolved'`/`'orphaned'` status is
 * preserved (a surviving orphaned thread is re-anchored, never resurrected to open). For a surviving
 * span the new line/column (and end-exclusive endLine/endColumn) are recomputed from the NEW `doc`.
 */
export function remapSpans(threads: ReviewThread[], change: ChangeSet, doc: Text, file: string): ReviewThread[] {
  const clamp = (offset: number): number => Math.max(0, Math.min(offset, doc.length));
  const lineColOf = (offset: number): { line: number; column: number } => {
    const line = doc.lineAt(offset);
    return { line: line.number, column: offset - line.from + 1 }; // 1-based column
  };
  return threads.map((thread) => {
    if (thread.file !== file) return thread; // a different buffer's change can't move this thread
    const start = change.mapPos(thread.span.offset, 1, MapMode.TrackDel);
    const end = change.mapPos(thread.span.offset + thread.span.length, -1, MapMode.TrackDel);
    const deleted =
      start == null || start < 0 || end == null || end < 0 || (thread.span.length > 0 && end <= start);

    let offset: number;
    let length: number;
    if (deleted) {
      offset = clamp(change.mapPos(thread.span.offset, 1)); // plain map: a valid in-range anchor
      length = 0;
    } else {
      offset = clamp(start);
      length = Math.max(0, clamp(end) - offset);
    }

    const startPos = lineColOf(offset);
    const endPos = lineColOf(clamp(offset + length));
    const span: SourceSpan = {
      file: thread.span.file,
      line: startPos.line,
      column: startPos.column,
      endLine: endPos.line,
      endColumn: endPos.column,
      offset,
      length,
    };
    const status: ReviewThread['status'] = deleted && thread.status === 'open' ? 'orphaned' : thread.status;
    return { ...thread, span, status };
  });
}

/**
 * Create the review-thread store. `folderToken` is a getter re-read on every persist: a non-null token
 * means a folder is open and threads persist to `<folder>/.koine/reviews.json`; null (no-folder/scratch
 * mode) keeps the store purely in-memory. There is no `exists()` on the platform, so the file's token is
 * discovered via `listDir('.koine')` and cached; the first write `createFile`s it (creating `.koine/`),
 * later writes overwrite by token (with a create-race fallback). Writes are serialized through one chain
 * so rapid mutations can't double-create the file.
 */
export function createReviewStore(platform: Platform, folderToken: () => string | null): ReviewStore {
  let threads: ReviewThread[] = [];
  const listeners = new Set<() => void>();
  let fileToken: string | null = null; // cached once discovered or created
  let writeChain: Promise<void> = Promise.resolve(); // serialize persists; avoids a create-race

  function notify(): void {
    for (const cb of listeners) cb();
  }

  /** Find (and register, so writeTextFile resolves) the reviews file's token under `.koine`, if it exists. */
  async function locate(root: string): Promise<string | null> {
    if (fileToken) return fileToken;
    try {
      const entries = await platform.listDir(root, REVIEWS_DIR);
      const hit = entries.find((e) => e.kind === 'file' && e.name === 'reviews.json');
      if (hit) fileToken = hit.token;
    } catch {
      // `.koine` does not exist (or is unreadable) — treat as "no file yet".
    }
    return fileToken;
  }

  async function write(root: string): Promise<void> {
    const json = serialize(threads);
    const existing = await locate(root);
    if (existing) {
      await platform.writeTextFile(existing, json);
      return;
    }
    try {
      // createFile creates intermediate dirs, so `.koine/reviews.json` materializes `.koine/` too.
      fileToken = await platform.createFile(root, REVIEWS_FILE, json);
    } catch {
      // Lost a create race (the file appeared meanwhile) — re-locate and overwrite.
      const t = await locate(root);
      if (t) await platform.writeTextFile(t, json);
    }
  }

  /** Persist the current threads when a folder is open; a no-op (in-memory only) in scratch mode. */
  function persist(): void {
    const root = folderToken();
    if (!root) return;
    writeChain = writeChain.then(() => write(root)).catch(() => {
      // Swallow write failures: the in-memory set stays the source of truth and the next mutation retries.
    });
  }

  /** Apply a mutation, then persist + notify (the common tail of every mutator). */
  function mutated(): void {
    persist();
    notify();
  }

  return {
    async load() {
      // Drop any token cached for a previously-opened folder: load() runs on every folder open, and the
      // cache must be re-discovered under the CURRENT root or persistence would read/write the old folder.
      fileToken = null;
      const root = folderToken();
      if (!root) return; // scratch mode: nothing on disk to hydrate from
      const t = await locate(root);
      if (!t) {
        threads = [];
        return;
      }
      try {
        threads = parse(await platform.readTextFile(t));
      } catch {
        threads = [];
      }
    },
    list() {
      return [...threads];
    },
    add(file, span, body, author) {
      const thread: ReviewThread = {
        id: newThreadId(),
        file,
        span,
        status: 'open',
        comments: [{ author, body, ts: Date.now() }],
      };
      threads = [...threads, thread];
      mutated();
      return thread;
    },
    reply(id, body, author) {
      const thread = threads.find((t) => t.id === id);
      if (!thread) return;
      thread.comments = [...thread.comments, { author, body, ts: Date.now() }];
      mutated();
    },
    setStatus(id, status) {
      const thread = threads.find((t) => t.id === id);
      if (!thread) return;
      thread.status = status;
      mutated();
    },
    remove(id) {
      const next = threads.filter((t) => t.id !== id);
      if (next.length === threads.length) return; // unknown id: no change, no churn
      threads = next;
      mutated();
    },
    remap(file, change, doc) {
      const next = remapSpans(threads, change, doc, file); // index-aligned: same count, same order/ids
      const changed = next.some((t, i) => t.status !== threads[i].status || !sameSpan(t.span, threads[i].span));
      if (!changed) return; // nothing moved (or no threads in `file`): avoid a needless write + render
      threads = next;
      mutated();
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
