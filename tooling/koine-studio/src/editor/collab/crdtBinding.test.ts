// @vitest-environment happy-dom
// Task 3 of issue #481: the CRDT shared-document binding. These specs pin the property the whole
// co-editing feature rests on — two replicas that took concurrent edits CONVERGE to the same buffer —
// plus the two failure modes that would quietly destroy a session: an echo loop (a remote update
// bouncing back onto the wire, doubling text) and a binding that can't be detached cleanly.
//
// Everything here runs against real `Y.Doc`s and real `EditorView`s; there is no transport, because the
// binding deliberately knows nothing about one (that seam is Task 4's session).
import { describe, expect, it, afterEach } from 'vitest';
import * as Y from 'yjs';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { crdtExtension, sharedText, SHARED_TEXT_KEY } from '@/editor/collab/crdtBinding';

const views: EditorView[] = [];
const docs: Y.Doc[] = [];

afterEach(() => {
  while (views.length) views.pop()?.destroy();
  while (docs.length) docs.pop()?.destroy();
  document.body.innerHTML = '';
});

function ydoc(): Y.Doc {
  const doc = new Y.Doc();
  docs.push(doc);
  return doc;
}

/** A live editor bound to `text`; `hydrate` picks which side wins if the two already differ. */
function boundEditor(text: Y.Text, doc = '', hydrate: 'editor' | 'crdt' = 'editor'): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [crdtExtension(text, { hydrate })] }),
    parent,
  });
  views.push(view);
  return view;
}

/** Relay every update between two docs, tagging relayed applies so they are not relayed back. */
const RELAY = 'test-relay';
function connect(a: Y.Doc, b: Y.Doc): () => void {
  const forward = (target: Y.Doc) => (update: Uint8Array, origin: unknown) => {
    if (origin === RELAY) return;
    Y.applyUpdate(target, update, RELAY);
  };
  const aToB = forward(b);
  const bToA = forward(a);
  a.on('update', aToB);
  b.on('update', bToA);
  // Exchange what each side already has, so connecting is also a re-sync.
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a), RELAY);
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b), RELAY);
  return () => {
    a.off('update', aToB);
    b.off('update', bToA);
  };
}

describe('sharedText', () => {
  it('resolves the same Y.Text on every replica (one agreed key, or replicas never converge)', () => {
    const doc = ydoc();
    expect(sharedText(doc)).toBe(doc.getText(SHARED_TEXT_KEY));
  });
});

describe('crdtExtension — local edits reach the CRDT', () => {
  it('mirrors an insertion into the shared Y.Text', () => {
    const text = sharedText(ydoc());
    const view = boundEditor(text, 'context Sales {}');

    view.dispatch({ changes: { from: 16, to: 16, insert: '\n' } });

    expect(text.toJSON()).toBe('context Sales {}\n');
  });

  it('mirrors a replacement (delete + insert in one transaction)', () => {
    const text = sharedText(ydoc());
    const view = boundEditor(text, 'context Sales {}');

    view.dispatch({ changes: { from: 8, to: 13, insert: 'Billing' } });

    expect(text.toJSON()).toBe('context Billing {}');
  });

  it('mirrors MULTIPLE ranges changed in one transaction (offsets must not drift)', () => {
    const text = sharedText(ydoc());
    const view = boundEditor(text, 'aaa bbb ccc');

    // Two edits of different lengths: the second one's CRDT offset has to account for the first.
    view.dispatch({ changes: [{ from: 0, to: 3, insert: 'X' }, { from: 8, to: 11, insert: 'YYYYY' }] });

    expect(text.toJSON()).toBe(view.state.doc.toString());
    expect(text.toJSON()).toBe('X bbb YYYYY');
  });

  it('seeds the CRDT from the buffer on attach when hydrating from the editor (the authority)', () => {
    const text = sharedText(ydoc());
    boundEditor(text, 'context Sales {}');

    expect(text.toJSON()).toBe('context Sales {}');
  });
});

describe('crdtExtension — CRDT updates reach the editor', () => {
  it('applies a remote insertion into the buffer', () => {
    const text = sharedText(ydoc());
    const view = boundEditor(text, 'context Sales {}');

    text.insert(16, '\n');

    expect(view.state.doc.toString()).toBe('context Sales {}\n');
  });

  it('applies a remote deletion into the buffer', () => {
    const text = sharedText(ydoc());
    const view = boundEditor(text, 'context Sales {}');

    text.delete(0, 8);

    expect(view.state.doc.toString()).toBe('Sales {}');
  });

  it('hydrates the buffer FROM the CRDT when joining an existing document', async () => {
    const doc = ydoc();
    const text = sharedText(doc);
    text.insert(0, 'context Billing {}');

    // A joiner's own buffer is not authoritative: it is replaced by the session's document.
    const view = boundEditor(text, 'whatever was open locally', 'crdt');
    await Promise.resolve();

    expect(view.state.doc.toString()).toBe('context Billing {}');
  });
});

describe('crdtExtension — no echo loop', () => {
  it('does not re-emit a CRDT update that it applied to the editor', () => {
    const doc = ydoc();
    const text = sharedText(doc);
    const view = boundEditor(text, 'context Sales {}');

    const origins: unknown[] = [];
    doc.on('update', (_u: Uint8Array, origin: unknown) => origins.push(origin));

    // Simulate an inbound update from a peer, exactly as the session's transport handler would.
    const peer = ydoc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    sharedText(peer).insert(16, '\n');
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), 'remote');

    expect(view.state.doc.toString()).toBe('context Sales {}\n');
    // Exactly one update — the inbound one. A second, locally-originated update would be the editor
    // bouncing the change straight back onto the wire, which doubles text on every peer.
    expect(origins).toEqual(['remote']);
  });
});

describe('crdtExtension — convergence', () => {
  it('converges two editors that inserted concurrently at the SAME offset', () => {
    const docA = ydoc();
    const docB = ydoc();
    const textA = sharedText(docA);
    const viewA = boundEditor(textA, 'context Sales {}');

    // B joins A's document, then both go live.
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const textB = sharedText(docB);
    const viewB = boundEditor(textB, textB.toJSON(), 'crdt');
    const disconnect = connect(docA, docB);

    // Concurrent, offline-style edits at the same offset — the classic CRDT conflict.
    disconnect();
    viewA.dispatch({ changes: { from: 14, to: 14, insert: 'A' } });
    viewB.dispatch({ changes: { from: 14, to: 14, insert: 'B' } });
    expect(viewA.state.doc.toString()).not.toBe(viewB.state.doc.toString());

    connect(docA, docB);

    expect(viewA.state.doc.toString()).toBe(viewB.state.doc.toString());
    expect(textA.toJSON()).toBe(viewA.state.doc.toString());
    expect(textB.toJSON()).toBe(viewB.state.doc.toString());
    // Neither edit is lost — convergence is not "one side wins".
    expect(viewA.state.doc.toString()).toContain('A');
    expect(viewA.state.doc.toString()).toContain('B');
  });

  it('keeps converging through a burst of interleaved edits on both sides', () => {
    const docA = ydoc();
    const docB = ydoc();
    const textA = sharedText(docA);
    const viewA = boundEditor(textA, 'start');
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const textB = sharedText(docB);
    const viewB = boundEditor(textB, textB.toJSON(), 'crdt');
    connect(docA, docB);

    for (let i = 0; i < 10; i++) {
      viewA.dispatch({ changes: { from: 0, to: 0, insert: `a${i}` } });
      viewB.dispatch({ changes: { from: viewB.state.doc.length, to: viewB.state.doc.length, insert: `b${i}` } });
    }

    expect(viewA.state.doc.toString()).toBe(viewB.state.doc.toString());
    expect(viewA.state.doc.toString()).toContain('a9');
    expect(viewA.state.doc.toString()).toContain('b9');
  });
});

describe('crdtExtension — detach', () => {
  it('stops mirroring in BOTH directions once the view is destroyed', () => {
    const text = sharedText(ydoc());
    const view = boundEditor(text, 'context Sales {}');

    view.destroy();
    views.pop();

    text.insert(0, 'zzz');
    expect(view.state.doc.toString()).toBe('context Sales {}'); // no inbound apply after teardown

    // And the observer is gone, so the CRDT is not holding the destroyed view alive.
    expect(text.toJSON()).toBe('zzzcontext Sales {}');
  });

  it('does not hydrate a view that was destroyed before the queued hydration ran', async () => {
    const text = sharedText(ydoc());
    text.insert(0, 'remote content');
    const view = boundEditor(text, 'local content', 'crdt');

    view.destroy();
    views.pop();
    await Promise.resolve();

    expect(view.state.doc.toString()).toBe('local content');
  });
});
