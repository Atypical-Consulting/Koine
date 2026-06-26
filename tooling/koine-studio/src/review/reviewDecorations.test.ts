import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { reviewDecorationsField, refreshReviewDecorations } from './reviewDecorations';
import type { ReviewThread } from './reviewStore';
import type { SourceSpan } from '@/lsp/lsp';

// The review-decoration StateField (issue #259, Task 3) is read straight off an EditorState — no
// EditorView needed (StateField, unlike the inlay/semantic-token ViewPlugins, is state-resident). These
// tests pin the core mapping: an OPEN thread → a `cm-review-underline` mark, a RESOLVED one → a dimmed
// `cm-review-resolved` mark, an ORPHANED one → nothing, with the defensive zero-length/out-of-range
// drops that keep `Decoration.mark` from throwing.
//
//   offsets: 'value' 0..5, 'Money' 6..11, '\n' 11, line 1 starts at 12 ('  amount Int'), …
const DOC = 'value Money\n  amount Int\nenum Status\n';

/** Only offset/length (and status) drive the decorations; line/column are filler here. */
function span(offset: number, length: number): SourceSpan {
  return { file: null, line: 1, column: 1, endLine: 1, endColumn: 1, offset, length };
}

function thread(id: string, status: ReviewThread['status'], offset: number, length: number): ReviewThread {
  return { id, file: 'a.koi', span: span(offset, length), status, comments: [] };
}

/** Flatten a DecorationSet to {from, to, cls} rows sorted by `from` (between()'s order is unspecified). */
function rows(set: DecorationSet): { from: number; to: number; cls: string | undefined }[] {
  const out: { from: number; to: number; cls: string | undefined }[] = [];
  set.between(0, Number.MAX_SAFE_INTEGER, (from, to, value) => {
    out.push({ from, to, cls: value.spec.class as string | undefined });
  });
  return out.sort((a, b) => a.from - b.from);
}

function fieldFor(threads: ReviewThread[]) {
  const field = reviewDecorationsField(() => threads);
  const state = EditorState.create({ doc: DOC, extensions: [field] });
  return { field, set: state.field(field) };
}

describe('reviewDecorationsField', () => {
  it('yields an underline mark per OPEN thread and a dimmed mark for RESOLVED ones (orphaned: nothing)', () => {
    const { set } = fieldFor([
      thread('open', 'open', 0, 5), // 'value'
      thread('resolved', 'resolved', 6, 5), // 'Money'
      thread('orphaned', 'orphaned', 12, 6), // 'amount' — must NOT appear
    ]);
    expect(set.size).toBe(2);
    expect(rows(set)).toEqual([
      { from: 0, to: 5, cls: 'cm-review-underline' },
      { from: 6, to: 11, cls: 'cm-review-resolved' },
    ]);
  });

  it('yields no decorations for an empty thread list', () => {
    const { set } = fieldFor([]);
    expect(set.size).toBe(0);
  });

  it('skips zero-length and out-of-range spans without throwing', () => {
    const { set } = fieldFor([
      thread('zero', 'open', 6, 0), // zero-length — skipped
      thread('past', 'open', 9999, 4), // start past the document — skipped
      thread('neg', 'open', -3, 2), // negative offset — skipped
      thread('ok', 'open', 0, 5), // the only survivor
    ]);
    expect(rows(set)).toEqual([{ from: 0, to: 5, cls: 'cm-review-underline' }]);
  });

  it('clamps a span that runs past the document to the buffer end', () => {
    const { set } = fieldFor([thread('overrun', 'open', 6, 9999)]);
    expect(rows(set)).toEqual([{ from: 6, to: DOC.length, cls: 'cm-review-underline' }]);
  });

  it('recomputes from getThreads() when a transaction carries the refresh effect', () => {
    let threads: ReviewThread[] = [];
    const field = reviewDecorationsField(() => threads);
    let state = EditorState.create({ doc: DOC, extensions: [field] });
    expect(state.field(field).size).toBe(0);

    threads = [thread('t1', 'open', 0, 5)];
    state = state.update({ effects: refreshReviewDecorations.of(null) }).state;
    expect(state.field(field).size).toBe(1);
  });
});
