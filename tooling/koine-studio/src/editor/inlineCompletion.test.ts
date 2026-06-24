import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { inlineCompletionExtension, type EditorInlineContext } from './inlineCompletion';
import type { InlineState } from './inlineCompletionState';

// The state machine and AI client are unit-tested on their own; here we drive the CodeMirror glue
// against a REAL EditorView (the @codemirror/* packages construct fine under happy-dom — see
// actions.test.ts) with a controllable FAKE state, so we can assert: the ghost widget renders what the
// state shows, Tab inserts it, Esc dismisses, and both keys fall through when nothing is showing.

interface FakeState extends InlineState<EditorInlineContext> {
  status: 'idle' | 'pending' | 'showing';
  suggestion: string | null;
}

function fakeState(): FakeState {
  const s = {
    status: 'idle',
    suggestion: null,
    context: null,
    onChange: null,
    onType: vi.fn(),
    accept: vi.fn(function accept(this: void) {
      const text = s.suggestion;
      s.status = 'idle';
      s.suggestion = null;
      return text;
    }),
    dismiss: vi.fn(() => {
      s.status = 'idle';
      s.suggestion = null;
    }),
  } as unknown as FakeState;
  return s;
}

function makeView(
  state: FakeState,
  over: Partial<{ isEnabled: () => boolean; lspPopupOpen: () => boolean }> = {},
): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: 'value M',
      extensions: [
        inlineCompletionExtension({
          state,
          isEnabled: over.isEnabled ?? (() => true),
          lspPopupOpen: over.lspPopupOpen ?? (() => false),
        }),
      ],
    }),
  });
}

/** Show a suggestion the way an async fetch would: flip the fake state, then fire its onChange. */
function show(state: FakeState, text: string): void {
  state.status = 'showing';
  state.suggestion = text;
  state.onChange?.();
}

function tabKey(view: EditorView): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(e);
  return e;
}

function escKey(view: EditorView): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(e);
  return e;
}

const ghost = (view: EditorView) => view.dom.querySelector('.cm-inline-suggestion');

describe('inline-completion editor extension', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the shown suggestion as dimmed ghost text', () => {
    const state = fakeState();
    const view = makeView(state);
    expect(ghost(view)).toBeNull(); // nothing before a suggestion exists
    show(state, 'oney {');
    expect(ghost(view)?.textContent).toBe('oney {');
    view.destroy();
  });

  it('Tab accepts the suggestion, inserting it at the caret', () => {
    const state = fakeState();
    const view = makeView(state);
    view.dispatch({ selection: { anchor: view.state.doc.length } }); // caret at end ("value M|")
    show(state, 'oney {}');
    const e = tabKey(view);
    expect(state.accept).toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe('value Money {}');
    expect(e.defaultPrevented).toBe(true);
    expect(ghost(view)).toBeNull(); // cleared after acceptance
    view.destroy();
  });

  it('Esc dismisses the suggestion without mutating the document', () => {
    const state = fakeState();
    const view = makeView(state);
    show(state, 'oney {');
    const e = escKey(view);
    expect(state.dismiss).toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe('value M');
    expect(e.defaultPrevented).toBe(true);
    expect(ghost(view)).toBeNull();
    view.destroy();
  });

  it('lets Tab and Esc fall through when nothing is showing', () => {
    const state = fakeState();
    const view = makeView(state);
    const tab = tabKey(view);
    const esc = escKey(view);
    expect(state.accept).not.toHaveBeenCalled();
    expect(tab.defaultPrevented).toBe(false);
    expect(esc.defaultPrevented).toBe(false);
    view.destroy();
  });

  it('suppresses ghost text when the feature is disabled', () => {
    const state = fakeState();
    const view = makeView(state, { isEnabled: () => false });
    show(state, 'oney {');
    expect(ghost(view)).toBeNull();
    view.destroy();
  });

  it('suppresses ghost text while the LSP completion popup is open', () => {
    const state = fakeState();
    const view = makeView(state, { lspPopupOpen: () => true });
    show(state, 'oney {');
    expect(ghost(view)).toBeNull();
    view.destroy();
  });

  it('drives the state machine on edits and detaches its onChange on destroy', () => {
    const state = fakeState();
    const view = makeView(state);
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'o' } });
    expect(state.onType).toHaveBeenCalled(); // a real edit (re)starts a suggestion
    view.destroy();
    expect(state.onChange).toBeNull(); // cleaned up so a late fetch can't dispatch into a dead view
  });
});
