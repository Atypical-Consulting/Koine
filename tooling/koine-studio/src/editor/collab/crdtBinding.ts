// The CRDT SHARED-DOCUMENT binding for Koine Studio's real-time collaboration (issue #481 Task 3,
// Phase 2 of #259) — the other half of the presence layer (`src/editor/presence.ts`).
//
// Presence is ephemeral and carries no document authority, which is why it shipped first. This module
// is the part that owns the text: it keeps one CodeMirror buffer and one CRDT replica in lock-step, so
// that N participants editing the same `.koi` at once CONVERGE without a lock, a central transform
// server, or a manual merge. Per [ADR 0013](../../../../adr/0013-crdt-over-host-brokered-transport-for-studio-collaboration.md)
// the CRDT is Yjs and the transport is brokered by the host — which is why nothing in here knows a
// transport exists. It binds an editor to a `Y.Text`; moving that `Y.Text`'s updates between machines is
// the session's job (#481 Task 4) over the `Platform` seam (#481 Task 1).
//
// Two failure modes shape the whole design, because both corrupt a session silently rather than loudly:
//
//   * **The echo loop.** A remote update applied to the editor must not be pushed back to the CRDT, and
//     a local edit pushed to the CRDT must not be re-applied to the editor. Each direction is tagged —
//     CodeMirror transactions with the {@link fromCrdt} annotation, Yjs transactions with the
//     {@link crdtLocalOrigin} origin — and each side ignores its own tag. Without this, one keystroke
//     ping-pongs and every peer's buffer doubles.
//   * **Coordinate drift.** A CodeMirror `ChangeSet` describes every change in ORIGINAL-document
//     coordinates, while `Y.Text` mutates as you go; a Yjs delta is the mirror image. Both directions
//     translate explicitly (see `pushToCrdt` / `applyRemote`) rather than assuming the offsets line up.
//
// Like presence, this is a Studio RUNTIME concern: it never reaches the `.koi` semantic model or the
// emitted output, and the compiler never learns that sessions exist.
import * as Y from 'yjs';
import { Annotation, type ChangeSet, type ChangeSpec, type Extension } from '@codemirror/state';
import { ViewPlugin, type PluginValue, type ViewUpdate, type EditorView } from '@codemirror/view';

/**
 * The `Y.Doc` key the shared `.koi` buffer lives under. Every replica must agree on it — two
 * participants reading different keys off the same doc would never see each other's text and would
 * "converge" on two empty documents. Always reach it through {@link sharedText}.
 */
export const SHARED_TEXT_KEY = 'koi';

/** The shared `.koi` buffer of a collaboration replica. */
export function sharedText(doc: Y.Doc): Y.Text {
  return doc.getText(SHARED_TEXT_KEY);
}

/**
 * Marks a CodeMirror transaction this binding dispatched from an inbound CRDT update. The local →CRDT
 * direction skips these, which is one half of the echo guard.
 */
export const fromCrdt = Annotation.define<boolean>();

/**
 * The Yjs transaction origin this binding stamps on changes it pushed from the local buffer. The
 * CRDT →local direction skips these, which is the other half of the echo guard.
 *
 * Exported so a session can tell its own editor's edits apart from everything else on the doc — notably
 * so it re-broadcasts them and doesn't re-broadcast what it just received (#481 Task 4).
 */
export const crdtLocalOrigin = Symbol('koine.crdt.local');

export interface CrdtAttachOptions {
  /**
   * Which side wins when the buffer and the CRDT already differ at attach time. There is no safe
   * "merge them" answer here — concatenating two independent documents is never what anyone meant — so
   * the caller states who is authoritative:
   *
   * - `'editor'` — the session CREATOR / document authority. The buffer on screen IS the document, so
   *   the CRDT is seeded from it. **Destructive to any content already in the `Y.Text`.**
   * - `'crdt'` — a JOINER. They are joining someone else's document, so their own buffer is discarded
   *   and replaced by the session's. (Applied on a microtask: a doc change cannot be dispatched from
   *   inside the view update that attaches the extension. Call {@link hydrateEditorFromCrdt} first to
   *   do it eagerly and make this a no-op.)
   */
  readonly hydrate: 'editor' | 'crdt';
}

/** Everything `createKoineEditor`'s `setCrdtEnabled(true, …)` needs: the shared buffer, and who wins. */
export interface CrdtBinding extends CrdtAttachOptions {
  /** The session's shared `.koi` buffer — always reached through {@link sharedText}. */
  readonly text: Y.Text;
}

/**
 * Replace the buffer with the CRDT's content. The joiner's hydration step, exported so a session can run
 * it BEFORE attaching the extension — synchronously, with the buffer visibly swapped in one transaction
 * rather than a frame later.
 *
 * No-op when they already match, so it is safe to call defensively.
 */
export function hydrateEditorFromCrdt(view: EditorView, text: Y.Text): void {
  const content = text.toJSON();
  const doc = view.state.doc;
  if (doc.toString() === content) return;
  view.dispatch({ changes: { from: 0, to: doc.length, insert: content }, annotations: fromCrdt.of(true) });
}

/** Translate a Yjs text delta into CodeMirror changes, or `null` if it doesn't fit the current buffer. */
function deltaToChanges(delta: readonly Y.YTextEvent['delta'][number][], docLength: number): ChangeSpec[] | null {
  const changes: ChangeSpec[] = [];
  // Deltas are expressed against the PRE-change text: `retain` and `delete` advance through it, but
  // `insert` does not consume any of it. CodeMirror wants exactly those original-document offsets, so
  // `pos` advances on the first two only.
  let pos = 0;
  for (const op of delta) {
    if (typeof op.insert === 'string') {
      if (pos > docLength) return null;
      changes.push({ from: pos, to: pos, insert: op.insert });
    } else if (op.insert != null) {
      // An embedded Yjs type. `.koi` documents are plain text, so this can only be a peer (or a relay)
      // sending something this binding does not model — skipping it keeps the offsets honest, since an
      // embed occupies one position in the delta but no characters in our buffer.
      continue;
    } else if (typeof op.delete === 'number') {
      if (pos + op.delete > docLength) return null;
      changes.push({ from: pos, to: pos + op.delete });
      pos += op.delete;
    } else if (typeof op.retain === 'number') {
      pos += op.retain;
    }
  }
  return changes;
}

/**
 * Keeps one `EditorView` and one `Y.Text` in lock-step. Install it through {@link crdtExtension} rather
 * than constructing it: CodeMirror owns the lifecycle, so `destroy` (and therefore un-observing the
 * CRDT) happens on view teardown and on compartment detach alike.
 */
class CrdtSync implements PluginValue {
  private detached = false;
  private readonly observer: (event: Y.YTextEvent, transaction: Y.Transaction) => void;

  constructor(
    private readonly view: EditorView,
    private readonly text: Y.Text,
    hydrate: CrdtAttachOptions['hydrate'],
  ) {
    this.observer = (event, transaction) => {
      // Our own push, coming back around: dropping it here is what stops the echo loop.
      if (transaction.origin === crdtLocalOrigin) return;
      this.applyRemote(event);
    };
    this.text.observe(this.observer);
    if (hydrate === 'editor') this.seedCrdtFromEditor();
    else this.queueHydrateFromCrdt();
  }

  /** Local buffer → CRDT, for every transaction that did not come FROM the CRDT. */
  update(update: ViewUpdate): void {
    for (const tr of update.transactions) {
      if (!tr.docChanged) continue;
      if (tr.annotation(fromCrdt)) continue;
      this.pushToCrdt(tr.changes);
    }
  }

  destroy(): void {
    this.detached = true;
    this.text.unobserve(this.observer);
  }

  /** Make the CRDT match the buffer — the document authority's attach path. */
  private seedCrdtFromEditor(): void {
    const doc = this.view.state.doc.toString();
    if (this.text.toJSON() === doc) return;
    this.transact(() => {
      this.text.delete(0, this.text.length);
      if (doc.length > 0) this.text.insert(0, doc);
    });
  }

  /**
   * Make the buffer match the CRDT — the joiner's attach path, deferred because this constructor runs
   * inside the view update that installs the extension, and CodeMirror forbids dispatching from there.
   */
  private queueHydrateFromCrdt(): void {
    if (this.view.state.doc.toString() === this.text.toJSON()) return;
    queueMicrotask(() => {
      if (this.detached) return;
      hydrateEditorFromCrdt(this.view, this.text);
    });
  }

  private transact(fn: () => void): void {
    const doc = this.text.doc;
    // A `Y.Text` reached through `sharedText` always has a doc; guard rather than throw into the editor's
    // update cycle if a caller ever hands over a detached one.
    if (doc) doc.transact(fn, crdtLocalOrigin);
    else fn();
  }

  private pushToCrdt(changes: ChangeSet): void {
    this.transact(() => {
      // `iterChanges` reports every range in the ORIGINAL document's coordinates, but each `Y.Text` op
      // shifts everything after it. `adjust` carries the net length change of the ops applied so far,
      // which is exactly the offset correction the next range needs.
      let adjust = 0;
      changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        const insert = inserted.toString();
        const removed = toA - fromA;
        if (removed > 0) this.text.delete(fromA + adjust, removed);
        if (insert.length > 0) this.text.insert(fromA + adjust, insert);
        adjust += insert.length - removed;
      });
    });
  }

  private applyRemote(event: Y.YTextEvent): void {
    if (this.detached) return;
    const changes = deltaToChanges(event.delta, this.view.state.doc.length);
    if (changes === null) {
      // The delta doesn't fit the buffer, so the two drifted apart — a bug here, or a peer/relay sending
      // a delta for a document we don't have. Dispatching it would throw out of the observer and leave
      // the editor wedged, so resynchronise wholesale instead: the CRDT is the shared truth, and after
      // this the buffer matches it again.
      hydrateEditorFromCrdt(this.view, this.text);
      return;
    }
    if (changes.length === 0) return;
    this.view.dispatch({ changes, annotations: fromCrdt.of(true) });
  }
}

/**
 * The editor extension binding this buffer to `text`. Install it through a `Compartment` so a session
 * can attach and detach it live without rebuilding the `EditorView` — see `createKoineEditor`'s
 * `setCrdtEnabled`, and the same discipline `setPresenceEnabled` follows for presence.
 */
export function crdtExtension(text: Y.Text, opts: CrdtAttachOptions): Extension {
  return ViewPlugin.define((view) => new CrdtSync(view, text, opts.hydrate));
}
