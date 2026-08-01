// @vitest-environment happy-dom
// Task 2 of issue #481: presence wired into the REAL editor. `presence.test.ts` pins the decoration
// mapping in isolation; this pins the seam `createKoineEditor` exposes — that a collaboration session
// can attach and detach the presence layer mid-edit through its compartment, without rebuilding the
// `EditorView` and without losing the document, selection, or undo history. That property is what makes
// "start a session while I'm typing" a non-event rather than a disruption.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKoineEditor, type KoineEditor } from '@/editor/editor';
import { presenceField, setRemotePresence } from '@/editor/presence';
import { EditorSelection } from '@codemirror/state';
import type { CollabPresence } from '@/host/types';

const DOC = 'context Sales {}\n';
const editors: KoineEditor[] = [];

function editor(): KoineEditor {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const ed = createKoineEditor({ parent, doc: DOC });
  editors.push(ed);
  return ed;
}

afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
  document.body.innerHTML = '';
});

const ada: CollabPresence = {
  participantId: 'ada',
  displayName: 'Ada',
  color: '#e8637c',
  cursor: 8,
  selection: [{ from: 0, to: 7 }],
};

describe('createKoineEditor + presence', () => {
  it('installs no presence layer for a solo editor (a session must opt in)', () => {
    expect(editor().view.state.field(presenceField, false)).toBeUndefined();
  });

  it('setPresenceEnabled(true) attaches the layer on the SAME view', () => {
    const ed = editor();
    const view = ed.view;

    ed.setPresenceEnabled(true);

    expect(view.state.field(presenceField, false)).toBeDefined();
    expect(ed.view).toBe(view); // reconfigured, not rebuilt
  });

  it('renders remote presence once attached', () => {
    const ed = editor();
    ed.setPresenceEnabled(true);
    setRemotePresence(ed.view, [ada]);

    let count = 0;
    ed.view.state.field(presenceField).between(0, Number.MAX_SAFE_INTEGER, () => {
      count++;
    });
    expect(count).toBe(2); // the selection mark + the caret widget
  });

  it('publishes the local selection to the session when a source is supplied', () => {
    const ed = editor();
    const publish = vi.fn();
    ed.setPresenceEnabled(true, { publish });

    ed.view.dispatch({ selection: EditorSelection.single(0, 7) });

    expect(publish).toHaveBeenCalledWith({ cursor: 7, selection: [{ from: 0, to: 7 }] });
  });

  it('setPresenceEnabled(false) detaches the layer and stops publishing', () => {
    const ed = editor();
    const publish = vi.fn();
    ed.setPresenceEnabled(true, { publish });
    setRemotePresence(ed.view, [ada]);

    ed.setPresenceEnabled(false);
    publish.mockClear();
    ed.view.dispatch({ selection: EditorSelection.cursor(3) });

    expect(ed.view.state.field(presenceField, false)).toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
  });

  it('keeps the document and cursor intact across attach and detach', () => {
    const ed = editor();
    ed.view.dispatch({ selection: EditorSelection.cursor(9) });

    ed.setPresenceEnabled(true);
    ed.setPresenceEnabled(false);

    expect(ed.getDoc()).toBe(DOC);
    expect(ed.view.state.selection.main.head).toBe(9);
  });

  it('is idempotent — re-enabling or re-disabling changes nothing', () => {
    const ed = editor();
    ed.setPresenceEnabled(true);
    ed.setPresenceEnabled(true);
    expect(ed.view.state.field(presenceField, false)).toBeDefined();

    ed.setPresenceEnabled(false);
    ed.setPresenceEnabled(false);
    expect(ed.view.state.field(presenceField, false)).toBeUndefined();
    expect(ed.getDoc()).toBe(DOC);
  });

  it('survives a session that attaches, leaves, and re-attaches (a reconnect)', () => {
    const ed = editor();
    ed.setPresenceEnabled(true);
    setRemotePresence(ed.view, [ada]);
    ed.setPresenceEnabled(false);
    ed.setPresenceEnabled(true);

    // The remote set does NOT survive the detach — presence is ephemeral, so peers re-announce.
    let count = 0;
    ed.view.state.field(presenceField).between(0, Number.MAX_SAFE_INTEGER, () => {
      count++;
    });
    expect(count).toBe(0);

    setRemotePresence(ed.view, [ada]);
    ed.view.state.field(presenceField).between(0, Number.MAX_SAFE_INTEGER, () => {
      count++;
    });
    expect(count).toBe(2);
  });
});
