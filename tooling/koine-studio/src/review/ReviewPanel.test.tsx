import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import { createReviewPanel } from '@/review/ReviewPanel';
import type { ReviewStore, ReviewThread } from '@/review/reviewStore';
import type { SourceSpan } from '@/lsp/lsp';

const span = (file: string, line: number): SourceSpan => ({
  file,
  line,
  column: 1,
  endLine: line,
  endColumn: 5,
  offset: line * 10,
  length: 4,
});

/**
 * A minimal in-memory {@link ReviewStore} for the panel tests: real `subscribe`/`list`/`setStatus`/
 * `reply`/`remove` (each producing fresh thread objects + notifying), the rest stubbed. No platform.
 */
function fakeStore(initial: ReviewThread[]): ReviewStore {
  let threads = initial;
  const listeners = new Set<() => void>();
  const notify = (): void => listeners.forEach((cb) => cb());
  return {
    async load() {},
    list: () => [...threads],
    add(file, sp, body, author) {
      const t: ReviewThread = { id: `r${threads.length + 1}`, file, span: sp, status: 'open', comments: [{ author, body, ts: 1 }] };
      threads = [...threads, t];
      notify();
      return t;
    },
    reply(id, body, author) {
      threads = threads.map((t) => (t.id === id ? { ...t, comments: [...t.comments, { author, body, ts: Date.now() }] } : t));
      notify();
    },
    setStatus(id, status) {
      threads = threads.map((t) => (t.id === id ? { ...t, status } : t));
      notify();
    },
    remove(id) {
      threads = threads.filter((t) => t.id !== id);
      notify();
    },
    remap() {},
    subscribe(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
}

function mount(store: ReviewStore, onNavigate: (file: string, span: SourceSpan) => void = () => {}) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  // Wrap the mount in act so the subscription effect flushes — otherwise a later store mutation has no
  // subscriber and the panel never re-renders.
  let panel!: ReturnType<typeof createReviewPanel>;
  act(() => {
    panel = createReviewPanel({ parent, store, onNavigate });
  });
  return { parent, panel, cleanup: () => { panel.dispose(); parent.remove(); } };
}

describe('ReviewPanel', () => {
  test('renders threads grouped by file, each with its status and comment chain (oldest first)', () => {
    const store = fakeStore([
      { id: 'r1', file: 'file:///a.koi', span: span('file:///a.koi', 3), status: 'open', comments: [{ author: 'Ada', body: 'needs a rule', ts: 1 }] },
      { id: 'r2', file: 'file:///b.koi', span: span('file:///b.koi', 7), status: 'resolved', comments: [{ author: 'Bo', body: 'fixed now', ts: 2 }, { author: 'Ada', body: 'thanks', ts: 3 }] },
    ]);
    const { parent, cleanup } = mount(store);

    const text = parent.textContent ?? '';
    // Both files appear (grouped by basename) and both statuses render.
    expect(text).toContain('a.koi');
    expect(text).toContain('b.koi');
    expect(text).toContain('Open');
    expect(text).toContain('Resolved');
    // Comment chains render their bodies, oldest first.
    expect(text).toContain('needs a rule');
    expect(text).toContain('fixed now');
    expect(text).toContain('thanks');
    expect(text.indexOf('fixed now')).toBeLessThan(text.indexOf('thanks'));

    cleanup();
  });

  test('resolving a thread updates its rendered status', () => {
    const store = fakeStore([
      { id: 'r1', file: 'file:///a.koi', span: span('file:///a.koi', 3), status: 'open', comments: [{ author: 'Ada', body: 'look here', ts: 1 }] },
    ]);
    const { parent, cleanup } = mount(store);

    expect(parent.querySelector('.koi-review-status')!.textContent).toBe('Open');
    act(() => {
      fireEvent.click(parent.querySelector<HTMLButtonElement>('.koi-review-toggle')!);
    });
    expect(parent.querySelector('.koi-review-status')!.textContent).toBe('Resolved');
    // The toggle now offers to re-open.
    expect(parent.querySelector('.koi-review-toggle')!.textContent).toContain('Re-open');

    cleanup();
  });

  test('appending a reply renders the new comment', () => {
    const store = fakeStore([
      { id: 'r1', file: 'file:///a.koi', span: span('file:///a.koi', 3), status: 'open', comments: [{ author: 'Ada', body: 'first', ts: 1 }] },
    ]);
    const { parent, cleanup } = mount(store);

    const input = parent.querySelector<HTMLInputElement>('.koi-review-reply-input')!;
    input.value = 'second';
    act(() => {
      fireEvent.submit(parent.querySelector('.koi-review-reply')!);
    });
    expect(parent.textContent).toContain('second');

    cleanup();
  });

  test('clicking a thread invokes onNavigate with its file and span', () => {
    const sp = span('file:///a.koi', 3);
    const store = fakeStore([{ id: 'r1', file: 'file:///a.koi', span: sp, status: 'open', comments: [{ author: 'Ada', body: 'x', ts: 1 }] }]);
    const onNavigate = vi.fn();
    const { parent, cleanup } = mount(store, onNavigate);

    fireEvent.click(parent.querySelector<HTMLButtonElement>('.koi-review-thread-head')!);
    expect(onNavigate).toHaveBeenCalledWith('file:///a.koi', sp);

    cleanup();
  });

  test('shows a friendly empty state when there are no threads', () => {
    const { parent, cleanup } = mount(fakeStore([]));
    expect(parent.textContent).toContain('No review comments yet');
    cleanup();
  });

  test('has no accessibility violations', async () => {
    const store = fakeStore([
      { id: 'r1', file: 'file:///a.koi', span: span('file:///a.koi', 3), status: 'open', comments: [{ author: 'Ada', body: 'needs a rule', ts: 1 }] },
    ]);
    const { parent, cleanup } = mount(store);
    expect(await axe(parent)).toHaveNoViolations();
    cleanup();
  });
});
