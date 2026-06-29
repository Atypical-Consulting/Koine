// The editor's indentation is driven by Settings → Editor → Tab size (#750), through an `indent`
// compartment holding CodeMirror's `indentUnit` (the inserted whitespace) + `EditorState.tabSize`
// (the rendered tab width). The editor reads `loadSettings().tabSize` on first paint and `setTabSize`
// reconfigures it live (same compartment pattern as the minimap/soft-wrap), so a Settings change
// applies without rebuilding the editor or losing the document.
import { afterEach, describe, expect, it } from 'vitest';
import { indentUnit } from '@codemirror/language';
import { createKoineEditor, type KoineEditor, type KoineEditorOptions } from '@/editor/editor';
import { saveSettings, DEFAULT_SETTINGS } from '@/settings/persistence';

const editors: KoineEditor[] = [];

function makeEditor(opts: Partial<KoineEditorOptions> = {}): KoineEditor {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const ed = createKoineEditor({ parent, doc: 'context Sales {}\n', ...opts });
  editors.push(ed);
  return ed;
}

afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('editor tab size (#750)', () => {
  it('defaults to a 2-space indent unit / tab size from DEFAULT_SETTINGS', () => {
    localStorage.clear(); // loadSettings → defaults (tabSize 2)
    const ed = makeEditor();
    expect(ed.view.state.facet(indentUnit)).toBe('  ');
    expect(ed.view.state.tabSize).toBe(2);
  });

  it('reads tabSize from settings on first paint (4 spaces)', () => {
    saveSettings({ ...DEFAULT_SETTINGS, tabSize: 4 });
    const ed = makeEditor();
    expect(ed.view.state.facet(indentUnit)).toBe('    ');
    expect(ed.view.state.tabSize).toBe(4);
  });

  it('setTabSize reconfigures the indent unit live without losing the document', () => {
    const ed = makeEditor();
    ed.setDoc('context Billing {}\n');
    ed.setTabSize(8);
    expect(ed.view.state.facet(indentUnit)).toBe('        ');
    expect(ed.view.state.tabSize).toBe(8);
    expect(ed.getDoc()).toBe('context Billing {}\n');
  });

  it('rounds + floors a non-integer / zero tab size so live indent matches a reload (#734)', () => {
    const ed = makeEditor();
    // A fractional value (e.g. typed into the step-1 Settings number input) rounds, matching coerceTabSize.
    ed.setTabSize(3.5);
    expect(ed.view.state.facet(indentUnit)).toBe('    '); // round(3.5) → 4 spaces
    expect(ed.view.state.tabSize).toBe(4);
    // 0/negative floors to a sane single space rather than emitting an empty indent unit.
    ed.setTabSize(0);
    expect(ed.view.state.facet(indentUnit)).toBe(' ');
    expect(ed.view.state.tabSize).toBe(1);
  });
});
