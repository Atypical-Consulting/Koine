// The Review bottom-panel tab (issue #259, Phase 1 collaboration): a live list of every in-editor
// review thread, grouped by file, each showing its status + comment chain with reply / resolve /
// delete controls. It is the panel counterpart to the in-editor marks (reviewDecorations.ts) and the
// persistence sidecar (reviewStore.ts) — a Studio-only VIEW concern that NEVER round-trips into the
// `.koi` semantic model or the emitter output. All state lives in the injected {@link ReviewStore};
// this module only renders it (Preact) and forwards the user's edits back to the store's mutators.
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ReviewStore, ReviewThread } from '@/review/reviewStore';
import type { SourceSpan } from '@/lsp/lsp';

/**
 * The author attributed to comments authored from Studio when no display name is configured. The
 * Settings "Display name" field (#479) feeds a real name in here (and into ide.tsx's add-comment
 * handler); until one is set, attribution falls back to this friendly default. Exported so the two
 * call sites agree.
 */
export const REVIEW_AUTHOR_FALLBACK = 'You';

/**
 * Resolve a configured display name into the author attributed to a review comment: a non-blank name is
 * trimmed and used; a blank or whitespace-only name falls back to {@link REVIEW_AUTHOR_FALLBACK}, so
 * attribution is unchanged until the user sets a name in Settings (#479).
 */
export function resolveReviewAuthor(name: string): string {
  return name.trim() || REVIEW_AUTHOR_FALLBACK;
}

/** Human-readable label for each thread status (the panel never shows the raw enum). */
const STATUS_LABEL: Record<ReviewThread['status'], string> = {
  open: 'Open',
  resolved: 'Resolved',
  orphaned: 'Orphaned',
};

export interface ReviewPanelOptions {
  /** The element the panel mounts into (the bottom panel's `#panel-review`). */
  parent: HTMLElement;
  /** The review-thread store for the active workspace (owns the data + persistence). */
  store: ReviewStore;
  /** Jump the editor to a thread's span (ide.tsx opens the file then moves the caret). */
  onNavigate: (file: string, span: SourceSpan) => void;
  /**
   * The author to attribute replies to — the configured Settings display name (#479). Optional and
   * defensively resolved through {@link resolveReviewAuthor}, so a missing callback or a blank name
   * falls back to {@link REVIEW_AUTHOR_FALLBACK}.
   */
  author?: () => string;
}

export interface ReviewPanel {
  /** Unmount the Preact tree (its store subscription is released by the unmount effect cleanup). */
  dispose(): void;
}

/** A short, human label for a file uri — the trailing path segment (e.g. `billing.koi`). */
function basename(uri: string): string {
  const seg = uri.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  return seg && seg.length > 0 ? seg : uri;
}

/** Group threads by their file uri, files sorted stably, threads kept in store order within a file. */
function groupByFile(threads: ReviewThread[]): { file: string; threads: ReviewThread[] }[] {
  const groups = new Map<string, ReviewThread[]>();
  for (const t of threads) {
    const bucket = groups.get(t.file);
    if (bucket) bucket.push(t);
    else groups.set(t.file, [t]);
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([file, ts]) => ({ file, threads: ts }));
}

/** One review thread: its navigable header (status + location), comment chain, and per-thread controls. */
function ThreadCard({
  thread,
  file,
  store,
  onNavigate,
  author,
}: {
  thread: ReviewThread;
  file: string;
  store: ReviewStore;
  onNavigate: (file: string, span: SourceSpan) => void;
  author: () => string;
}) {
  const label = basename(file);
  const isOpen = thread.status === 'open';
  const onReply = (e: Event): void => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const input = form.querySelector<HTMLInputElement>('.koi-review-reply-input');
    const body = input?.value.trim() ?? '';
    if (!body) return; // empty reply: nothing to add
    store.reply(thread.id, body, author());
    if (input) input.value = '';
  };
  return (
    <li class="koi-review-thread">
      <button
        type="button"
        class="koi-review-thread-head"
        onClick={() => onNavigate(thread.file, thread.span)}
        aria-label={`Go to ${label} line ${thread.span.line}`}
      >
        <span class="koi-review-status" data-status={thread.status}>{STATUS_LABEL[thread.status]}</span>
        <span class="koi-review-loc">{label}:{thread.span.line}</span>
      </button>
      <ol class="koi-review-comments">
        {thread.comments.map((c, i) => (
          <li class="koi-review-comment" key={i}>
            <span class="koi-review-author">{c.author}</span>
            <span class="koi-review-body">{c.body}</span>
          </li>
        ))}
      </ol>
      <div class="koi-review-actions">
        <button
          type="button"
          class="koi-review-toggle"
          onClick={() => store.setStatus(thread.id, isOpen ? 'resolved' : 'open')}
        >
          {isOpen ? 'Resolve' : 'Re-open'}
        </button>
        <button type="button" class="koi-review-delete" onClick={() => store.remove(thread.id)}>
          Delete
        </button>
      </div>
      <form class="koi-review-reply" onSubmit={onReply}>
        <input
          type="text"
          class="koi-review-reply-input"
          aria-label={`Reply to the thread on ${label} line ${thread.span.line}`}
          placeholder="Reply…"
        />
        <button type="submit" class="koi-review-reply-submit">Reply</button>
      </form>
    </li>
  );
}

/** The panel body: subscribes to the store and re-renders the file-grouped thread list on every change. */
function ReviewPanelView({
  store,
  onNavigate,
  author,
}: {
  store: ReviewStore;
  onNavigate: (file: string, span: SourceSpan) => void;
  author: () => string;
}) {
  // The store can't be observed by Preact directly; bump a counter on every mutation to re-render. The
  // effect's cleanup is the store's unsubscribe, so an unmount (dispose) releases the subscription.
  const [, setTick] = useState(0);
  useEffect(() => store.subscribe(() => setTick((t) => t + 1)), [store]);

  const groups = groupByFile(store.list());
  if (groups.length === 0) {
    return (
      <div class="koi-review">
        <p class="koi-review-empty">No review comments yet. Select code in the editor and add a comment to start a review.</p>
      </div>
    );
  }
  return (
    <div class="koi-review">
      <ul class="koi-review-files">
        {groups.map((g) => (
          <li class="koi-review-file" key={g.file}>
            <p class="koi-review-file-name" title={g.file}>{basename(g.file)}</p>
            <ul class="koi-review-threads">
              {g.threads.map((t) => (
                <ThreadCard key={t.id} thread={t} file={g.file} store={store} onNavigate={onNavigate} author={author} />
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Create the Review panel inside `parent`. Mounts a Preact tree that subscribes to `store` and repaints
 * the file-grouped thread list on every mutation; clicking a thread's header calls `onNavigate`, and the
 * per-thread controls drive the store's `reply`/`setStatus`/`remove`. Returns a handle whose `dispose()`
 * unmounts the tree (releasing the store subscription via the unmount effect cleanup).
 */
export function createReviewPanel(opts: ReviewPanelOptions): ReviewPanel {
  // Defensively resolve the configured author at reply time: a missing callback or a blank display
  // name falls back to REVIEW_AUTHOR_FALLBACK, so attribution is unchanged until a name is set (#479).
  const author = (): string => resolveReviewAuthor(opts.author?.() ?? '');
  render(<ReviewPanelView store={opts.store} onNavigate={opts.onNavigate} author={author} />, opts.parent);
  return {
    dispose() {
      render(null, opts.parent);
    },
  };
}
