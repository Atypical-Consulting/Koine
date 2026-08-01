// The PRESENCE layer for real-time collaboration (issue #481 Task 2, Phase 2 of #259): remote
// participants' carets and selections, painted into the local CodeMirror buffer.
//
// Presence is deliberately the FIRST half of co-editing to ship, because it carries no document
// authority: a frame describes where someone's cursor is, nothing more. Losing one costs nothing (the
// next supersedes it) and a stale one can only mis-paint a decoration, never corrupt the buffer. That is
// what lets it land ahead of the CRDT document binding (#481 Task 3).
//
// Shape, mirroring `review/reviewDecorations.ts`: a {@link StateField} of {@link DecorationSet} that
// tests can read straight off an `EditorState`, fed by a {@link StateEffect} rather than by observing an
// external store. The decoration BUILDER is exported separately so the position/colour mapping can be
// pinned against a bare `Text` with no live view.
//
// Like the review marks this is a Studio-only VIEW concern: it paints over the buffer and NEVER
// round-trips into the `.koi` semantic model or the emitted output.
import { Decoration, type DecorationSet, EditorView, WidgetType, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { type EditorState, type Extension, type Range, StateEffect, StateField, type Text } from '@codemirror/state';
import type { CollabPresence, CollabRange } from '@/host/types';

/** This participant's own caret/selection, as handed to {@link PresenceSource.publish} for broadcast. */
export interface LocalPresence {
  /** Document offset of the local caret (the head of the primary selection range). */
  readonly cursor: number;
  /** Every selected range; empty for a bare caret. */
  readonly selection: readonly CollabRange[];
}

/** Where outbound presence goes. Omitted entirely when presence is receive-only (e.g. a read-only peer). */
export interface PresenceSource {
  /** Called on every local selection change; the session broadcasts it on the presence channel. */
  publish(local: LocalPresence): void;
}

/**
 * Replace the whole remote-presence set. Presence is a SNAPSHOT, not a log: each dispatch supersedes the
 * previous set, so a participant who goes quiet or leaves simply stops appearing in it — there is no
 * separate "remove this caret" path to get wrong.
 */
export const setPresenceEffect = StateEffect.define<readonly CollabPresence[]>();

/** Dispatch {@link setPresenceEffect} so the editor repaints the remote carets and selections. */
export function setRemotePresence(view: EditorView, entries: readonly CollabPresence[]): void {
  view.dispatch({ effects: setPresenceEffect.of(entries) });
}

/**
 * The remote caret: a zero-width widget drawing a coloured bar plus the participant's name label. A
 * widget rather than a mark because a caret sits BETWEEN characters — there is no range to mark, and
 * painting the adjacent character would misreport where the peer actually is.
 */
class PresenceCaretWidget extends WidgetType {
  constructor(
    private readonly participantId: string,
    private readonly displayName: string,
    private readonly color: string,
  ) {
    super();
  }

  /** Re-use the existing DOM whenever the peer, name and colour are unchanged (only the position moved). */
  eq(other: PresenceCaretWidget): boolean {
    return (
      other.participantId === this.participantId &&
      other.displayName === this.displayName &&
      other.color === this.color
    );
  }

  toDOM(): HTMLElement {
    const caret = document.createElement('span');
    caret.className = 'cm-presence-caret';
    caret.style.setProperty('--koi-presence-color', this.color);
    const label = document.createElement('span');
    label.className = 'cm-presence-label';
    label.textContent = this.displayName;
    caret.appendChild(label);
    // Presence is decoration, not content: keep it out of the accessibility tree and out of any text
    // the user copies out of the buffer.
    caret.setAttribute('aria-hidden', 'true');
    return caret;
  }

  // `ignoreEvent` is deliberately NOT overridden: WidgetType's default already ignores every event, so
  // nothing that happens inside a remote caret reaches the editor. (`pointer-events: none` in
  // _collab.scss stops clicks landing on it at all — this is the belt to that's braces.)
}

/**
 * Build the sorted decoration set for `entries` over `doc`: a `cm-presence-selection` mark per remote
 * range and a caret widget per remote cursor, each carrying its participant's colour inline (as the
 * `--koi-presence-color` custom property) so one CSS rule serves N participants.
 *
 * Defensive throughout, because a presence frame is ephemeral and can describe a document revision that
 * has already moved on: an out-of-range position is DROPPED, an over-long range is CLAMPED to the
 * document, and a collapsed or inverted range is skipped — `Decoration.mark` throws on an empty range,
 * which would take the whole editor down over a frame that will be superseded milliseconds later.
 *
 * The SHAPE of a frame is validated for the same reason its numbers are: a frame is untrusted wire data
 * from a peer or a user-configured relay, authenticated only by a shared token, and this runs inside
 * `presenceField.update` — so a `selection` that isn't an array would throw straight out of
 * `view.dispatch` and wedge the editor.
 */
export function buildPresenceDecorations(entries: readonly CollabPresence[], doc: Text): DecorationSet {
  const decos: Range<Decoration>[] = [];

  for (const entry of entries) {
    // A colour reaches the DOM as a style value, so a non-string is dropped rather than interpolated.
    const color = typeof entry.color === 'string' ? entry.color : '';
    const style = `--koi-presence-color: ${color}`;

    // Annotated because `Array.isArray` widens the narrowed branch to `any[]`, which would make every
    // `range.from`/`range.to` below an unchecked `any` (the repo's no-unsafe-argument rule, #998).
    const ranges: readonly CollabRange[] = Array.isArray(entry.selection) ? entry.selection : [];

    for (const range of ranges) {
      const from = range.from;
      if (!Number.isFinite(from) || from < 0 || from >= doc.length) continue;
      const to = Math.min(range.to, doc.length);
      if (!Number.isFinite(to) || from >= to) continue; // collapsed or inverted: nothing to paint
      decos.push(
        Decoration.mark({ class: 'cm-presence-selection', attributes: { style } }).range(from, to),
      );
    }

    const cursor = entry.cursor;
    if (!Number.isFinite(cursor) || cursor < 0 || cursor > doc.length) continue;
    decos.push(
      Decoration.widget({
        widget: new PresenceCaretWidget(entry.participantId, entry.displayName, color),
        // Order this caret AFTER any selection mark starting at the same offset, so a remote caret sits
        // on top of the highlight rather than inside its leading edge. (`side` orders point decorations
        // against other DECORATIONS only; the local caret is drawn by `drawSelection` in its own layer,
        // so it is unaffected either way.)
        side: 1,
      }).range(cursor),
    );
  }

  if (decos.length === 0) return Decoration.none;
  return Decoration.set(decos, true);
}

/**
 * The presence {@link StateField}, exported so tests can read the decorations off a state directly. It
 * holds the raw entries alongside their decorations so a local edit can MAP the remote positions through
 * the change set: without that a peer's caret would visibly drift on every keystroke until their next
 * frame arrived. Mapping is a stopgap for those milliseconds, not a substitute for the frame.
 */
export const presenceField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setPresenceEffect)) return buildPresenceDecorations(effect.value, tr.state.doc);
    }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Project an editor selection into the wire shape peers paint. */
function frameOf(state: EditorState): LocalPresence {
  const sel = state.selection;
  return {
    cursor: sel.main.head,
    // A bare caret contributes no range: peers paint a caret for it, not a zero-width highlight.
    selection: sel.ranges.filter((r) => !r.empty).map((r) => ({ from: r.from, to: r.to })),
  };
}

/**
 * Publish the local caret/selection: once on attach, then on every selection change. The frame on attach
 * matters because presence is a SNAPSHOT — without it a participant who joins and doesn't touch the
 * keyboard has no caret on anyone's screen until they happen to move, which reads as "they aren't here".
 *
 * Only selection transactions trigger the update path, so an inbound presence frame (a pure effect
 * transaction) never bounces back out — the presence-layer form of the echo loop the CRDT binding must
 * also avoid.
 */
function localPresencePublisher(source: PresenceSource): Extension {
  return ViewPlugin.define((view) => {
    source.publish(frameOf(view.state));
    return {
      update(update: ViewUpdate) {
        if (!update.selectionSet) return;
        source.publish(frameOf(update.state));
      },
    };
  });
}

/**
 * The editor extension that renders remote presence — and, when a {@link PresenceSource} is supplied,
 * publishes the local participant's own. Install it through a `Compartment` so a session can attach and
 * detach it live without rebuilding the `EditorView` (see `createKoineEditor`'s `setPresenceEnabled`).
 * The caret/label/selection colours come from the participants themselves; only the geometry is themed
 * (styles/components/_collab.scss).
 */
export function presenceExtension(source?: PresenceSource): Extension {
  return source ? [presenceField, localPresencePublisher(source)] : [presenceField];
}
