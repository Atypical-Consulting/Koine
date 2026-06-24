// Multi-cursor support for the .koi editor. The substantive enablement is the
// `EditorState.allowMultipleSelections` facet: without it CodeMirror reduces any multi-range
// selection to its main range via `.asSingle()`, so the add-cursor commands (already bound by the
// loaded defaultKeymap / searchKeymap — Mod-Alt-↑↓ → addCursorAbove/Below, Mod-D →
// selectNextOccurrence, Escape → simplifySelection) silently collapse to one caret. These tests
// drive those StateCommands directly against a REAL KoineEditor (the @codemirror/* packages
// construct fine under happy-dom; the commands here are layout-free, unlike the vertical
// addCursorAbove/Below). They also confirm the custom Mod-S binding still fires — i.e. enabling
// multi-cursor did not shadow the editor's own keymap.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorSelection } from '@codemirror/state';
import { selectNextOccurrence } from '@codemirror/search';
import { simplifySelection } from '@codemirror/commands';
import { createKoineEditor, type KoineEditor, type KoineEditorOptions } from '@/editor/editor';

const editors: KoineEditor[] = [];

function makeEditor(doc: string, opts: Partial<KoineEditorOptions> = {}): KoineEditor {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const ed = createKoineEditor({ parent, doc, ...opts });
  editors.push(ed);
  return ed;
}

// Run a StateCommand against the editor's live state, dispatching the resulting transaction.
function run(ed: KoineEditor, cmd: (cfg: { state: typeof ed.view.state; dispatch: (tr: never) => void }) => boolean): void {
  cmd({ state: ed.view.state, dispatch: (tr) => ed.view.dispatch(tr) } as never);
}

afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('multi-cursor', () => {
  it('preserves multiple selection ranges (allowMultipleSelections enabled)', () => {
    const ed = makeEditor('foo\nfoo\nfoo');
    // A caret at the start of line 1 and line 2.
    ed.view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(4)]) });
    expect(ed.view.state.selection.ranges.length).toBe(2);
  });

  it('Mod-D (selectNextOccurrence) adds the next match as a second selection range', () => {
    const ed = makeEditor('foo bar\nfoo baz');
    // Select the first "foo", then add the next occurrence.
    ed.view.dispatch({ selection: EditorSelection.single(0, 3) });
    run(ed, selectNextOccurrence);
    expect(ed.view.state.selection.ranges.length).toBe(2);
  });

  it('Escape (simplifySelection) collapses several carets back to one', () => {
    const ed = makeEditor('foo\nfoo');
    ed.view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(4)]) });
    expect(ed.view.state.selection.ranges.length).toBe(2); // requires allowMultipleSelections
    run(ed, simplifySelection);
    expect(ed.view.state.selection.ranges.length).toBe(1);
  });

  it('keeps the custom Mod-S (format) binding wired — multi-cursor does not shadow it', () => {
    let formatted = 0;
    makeEditor('value Money {}', { onFormat: async () => ((formatted++), []) });
    const content = document.querySelector('.cm-content')!;
    // happy-dom reports a non-mac platform, so CodeMirror resolves "Mod" to Ctrl.
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(formatted).toBe(1);
  });
});
