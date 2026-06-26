// In-editor rendering of review threads (issue #259, Phase 1 collaboration): an `'open'` thread
// underlines the source span it pins a conversation to, a `'resolved'` one dims that span, and a small
// gutter marker flags every line that starts a thread. Like the rest of the review feature this is a
// Studio-only VIEW concern — it paints over the buffer but NEVER round-trips into the `.koi` semantic
// model or the emitter output.
//
// The core is a {@link StateField} of {@link DecorationSet} built from a `getThreads()` closure (the
// {@link ReviewStore}'s `list()`), so it stays target-agnostic and can be read straight off an
// `EditorState` in tests — no `EditorView` needed. Because the field can't observe store mutations on
// its own, callers repaint by dispatching {@link refreshReviewDecorations} (helper:
// {@link dispatchReviewRefresh}); the field also recomputes on `docChanged` so it tracks the buffer
// between the store's `remap` calls.
import { Decoration, type DecorationSet, EditorView, GutterMarker, gutter } from '@codemirror/view';
import {
  type Extension,
  type Range,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Text,
} from '@codemirror/state';
import type { ReviewThread } from '@/review/reviewStore';

/**
 * Dispatched to make the review decoration field (and gutter) recompute from `getThreads()` after a
 * store mutation — the field's closure can't see the store change on its own. Mirrors the redraw-effect
 * pattern used by the inlay-hint / semantic-token plugins in `editor.ts`.
 */
export const refreshReviewDecorations = StateEffect.define<null>();

/** Dispatch {@link refreshReviewDecorations} so the editor repaints its review marks after a store change. */
export function dispatchReviewRefresh(view: EditorView): void {
  view.dispatch({ effects: refreshReviewDecorations.of(null) });
}

/**
 * Build the sorted mark-decoration set for the current threads over `doc`. An `'open'` thread becomes a
 * `cm-review-underline` mark over its span, a `'resolved'` one a dimmed `cm-review-resolved` mark; an
 * `'orphaned'` thread renders nothing (its span no longer reliably points at text). Defensive against a
 * stale store: a zero-length or out-of-range span is skipped, and `to` is clamped to the document so a
 * mark never runs past the buffer — `Decoration.mark` throws on an empty/`from === to` range.
 */
function buildDecorations(threads: ReviewThread[], doc: Text): DecorationSet {
  const decos: Range<Decoration>[] = [];
  for (const thread of threads) {
    if (thread.status === 'orphaned') continue;
    const from = thread.span.offset;
    if (!Number.isFinite(from) || from < 0 || from > doc.length) continue;
    const to = Math.min(thread.span.offset + thread.span.length, doc.length);
    if (!Number.isFinite(to) || from >= to) continue; // zero-length / collapsed: nothing to mark
    const cls = thread.status === 'resolved' ? 'cm-review-resolved' : 'cm-review-underline';
    decos.push(Decoration.mark({ class: cls }).range(from, to));
  }
  if (decos.length === 0) return Decoration.none;
  decos.sort((a, b) => a.from - b.from);
  return Decoration.set(decos, true);
}

/**
 * The review-decoration {@link StateField}, exported so tests can read it directly via
 * `state.field(reviewDecorationsField(getThreads))` without constructing an `EditorView`. The field
 * recomputes from `getThreads()` whenever a transaction carries {@link refreshReviewDecorations} or
 * changes the document; `provide` exposes its decorations to the view.
 */
export function reviewDecorationsField(getThreads: () => ReviewThread[]): StateField<DecorationSet> {
  return StateField.define<DecorationSet>({
    create: (state) => buildDecorations(getThreads(), state.doc),
    update(value, tr) {
      const refresh = tr.effects.some((e) => e.is(refreshReviewDecorations));
      if (tr.docChanged || refresh) return buildDecorations(getThreads(), tr.state.doc);
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

/** The "this line carries a review thread" gutter marker — a small speech-bubble glyph. */
class ReviewThreadMarker extends GutterMarker {
  eq(other: GutterMarker): boolean {
    return other instanceof ReviewThreadMarker;
  }
  toDOM(): Node {
    const span = document.createElement('span');
    span.className = 'cm-review-gutter-marker';
    span.textContent = '\u{1F4AC}'; // 💬
    span.setAttribute('aria-label', 'Line has a review comment');
    span.title = 'Review comment';
    return span;
  }
}
const reviewThreadMarker = new ReviewThreadMarker();

/**
 * A line gutter that drops one {@link reviewThreadMarker} on every line that starts a non-orphaned
 * thread (deduped, one glyph per line). Recomputed on each editor update, so a {@link
 * refreshReviewDecorations} dispatch (or any doc change) repaints it in step with the decorations.
 */
function reviewGutter(getThreads: () => ReviewThread[]): Extension {
  return gutter({
    class: 'cm-review-gutter',
    markers(view) {
      const doc = view.state.doc;
      const lineStarts = new Set<number>();
      for (const thread of getThreads()) {
        if (thread.status === 'orphaned') continue;
        const off = thread.span.offset;
        if (!Number.isFinite(off) || off < 0 || off > doc.length) continue;
        lineStarts.add(doc.lineAt(off).from);
      }
      const builder = new RangeSetBuilder<GutterMarker>();
      for (const from of [...lineStarts].sort((a, b) => a - b)) builder.add(from, from, reviewThreadMarker);
      return builder.finish();
    },
  });
}

/**
 * The editor extension that renders review threads: the {@link reviewDecorationsField} (underline /
 * dimmed marks) plus the {@link reviewGutter} line marker. `getThreads` is the store's `list()`; wire it
 * only when reviews are active so the gutter column stays absent otherwise. The mark/gutter colours are
 * themed in `editor.ts` (with the other `.cm-*` decoration classes).
 */
export function reviewDecorationsExtension(getThreads: () => ReviewThread[]): Extension {
  return [reviewDecorationsField(getThreads), reviewGutter(getThreads)];
}
