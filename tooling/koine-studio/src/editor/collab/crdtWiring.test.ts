// @vitest-environment happy-dom
// Task 3 of issue #481: the CRDT binding wired into the REAL editor. `crdtBinding.test.ts` pins the
// translation and convergence rules in isolation; this pins the seam `createKoineEditor` exposes — that
// a session can bind and unbind the shared document mid-edit through its compartment, without rebuilding
// the `EditorView` and without losing the document, selection, or undo history.
//
// It matters for the same reason the presence equivalent does: starting or ending a co-editing session
// while someone is typing must be a non-event.
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createKoineEditor, type KoineEditor } from '@/editor/editor';
import { sharedText } from '@/editor/collab/crdtBinding';
import { EditorSelection } from '@codemirror/state';

const DOC = 'context Sales {}\n';
const editors: KoineEditor[] = [];
const docs: Y.Doc[] = [];

function editor(doc = DOC): KoineEditor {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const ed = createKoineEditor({ parent, doc });
  editors.push(ed);
  return ed;
}

function ydoc(): Y.Doc {
  const doc = new Y.Doc();
  docs.push(doc);
  return doc;
}

afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
  while (docs.length) docs.pop()?.destroy();
  document.body.innerHTML = '';
});

describe('createKoineEditor + setCrdtEnabled', () => {
  it('binds nothing for a solo editor (a session must opt in)', () => {
    const text = sharedText(ydoc());
    const ed = editor();

    ed.view.dispatch({ changes: { from: 0, to: 0, insert: 'x' } });

    expect(text.toJSON()).toBe('');
  });

  it('attaches on the SAME view and seeds the CRDT from the buffer (the authority)', () => {
    const text = sharedText(ydoc());
    const ed = editor();
    const view = ed.view;

    ed.setCrdtEnabled(true, { text, hydrate: 'editor' });

    expect(text.toJSON()).toBe(DOC);
    expect(ed.view).toBe(view); // reconfigured, not rebuilt
  });

  it('mirrors edits both ways once attached', () => {
    const text = sharedText(ydoc());
    const ed = editor();
    ed.setCrdtEnabled(true, { text, hydrate: 'editor' });

    ed.view.dispatch({ changes: { from: DOC.length, to: DOC.length, insert: 'entity Order {}\n' } });
    expect(text.toJSON()).toBe('context Sales {}\nentity Order {}\n');

    text.insert(0, '// live\n');
    expect(ed.view.state.doc.toString()).toBe('// live\ncontext Sales {}\nentity Order {}\n');
  });

  it('detaches cleanly: neither direction mirrors after setCrdtEnabled(false)', () => {
    const text = sharedText(ydoc());
    const ed = editor();
    ed.setCrdtEnabled(true, { text, hydrate: 'editor' });

    ed.setCrdtEnabled(false);

    ed.view.dispatch({ changes: { from: 0, to: 0, insert: 'local ' } });
    expect(text.toJSON()).toBe(DOC); // local edits stay local

    text.insert(0, 'remote ');
    expect(ed.view.state.doc.toString()).toBe(`local ${DOC}`); // remote edits stay remote
  });

  it('keeps the document, selection and view identity across attach and detach', () => {
    const text = sharedText(ydoc());
    const ed = editor();
    const view = ed.view;
    ed.view.dispatch({ selection: EditorSelection.single(8, 13) });

    ed.setCrdtEnabled(true, { text, hydrate: 'editor' });
    ed.setCrdtEnabled(false);

    expect(ed.view).toBe(view);
    expect(ed.view.state.doc.toString()).toBe(DOC);
    expect(ed.view.state.selection.main.from).toBe(8);
    expect(ed.view.state.selection.main.to).toBe(13);
  });

  it('re-attaching to a second session rebinds to the NEW document only', () => {
    const first = sharedText(ydoc());
    const second = sharedText(ydoc());
    const ed = editor();

    ed.setCrdtEnabled(true, { text: first, hydrate: 'editor' });
    ed.setCrdtEnabled(true, { text: second, hydrate: 'editor' });

    ed.view.dispatch({ changes: { from: 0, to: 0, insert: 'x' } });

    expect(second.toJSON()).toBe(`x${DOC}`);
    expect(first.toJSON()).toBe(DOC); // the abandoned session stops receiving
  });

  it('hydrates the buffer from an existing session document when joining', async () => {
    const text = sharedText(ydoc());
    text.insert(0, 'context Billing {}\n');
    const ed = editor();

    ed.setCrdtEnabled(true, { text, hydrate: 'crdt' });
    await Promise.resolve();

    expect(ed.view.state.doc.toString()).toBe('context Billing {}\n');
  });

  it('is idempotent when turned off twice', () => {
    const ed = editor();
    ed.setCrdtEnabled(false);
    ed.setCrdtEnabled(false);
    expect(ed.view.state.doc.toString()).toBe(DOC);
  });
});
