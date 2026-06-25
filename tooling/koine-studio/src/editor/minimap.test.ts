// The editor minimap lives behind a runtime Compartment (mirroring the lineWrap compartment), so
// Settings → Editor → Minimap can flip it live without rebuilding the editor. `@replit/codemirror-minimap`
// drives the rail through its `showMinimap` facet: when the compartment holds the extension the facet
// resolves to a config (and the plugin mounts a `.cm-minimap-gutter` rail); when it holds `[]` the facet
// is null and the rail is gone. These tests assert that observable facet/DOM state through `setMinimap`
// and the initial `minimap` option. (@codemirror/* construct under happy-dom; the minimap plugin's
// canvas render bails when getContext returns null, so there's no layout needed here.)
import { afterEach, describe, expect, it } from 'vitest';
import { showMinimap } from '@replit/codemirror-minimap';
import { createKoineEditor, type KoineEditor, type KoineEditorOptions } from '@/editor/editor';

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
});

describe('editor minimap', () => {
  it('is off by default — no showMinimap config, no rail', () => {
    const ed = makeEditor();
    expect(ed.view.state.facet(showMinimap)).toBeNull();
    expect(ed.view.dom.querySelector('.cm-minimap-gutter')).toBeNull();
  });

  it('setMinimap(true) installs the minimap, setMinimap(false) removes it', () => {
    const ed = makeEditor();
    ed.setMinimap(true);
    expect(ed.view.state.facet(showMinimap)).not.toBeNull();
    expect(ed.view.dom.querySelector('.cm-minimap-gutter')).not.toBeNull();

    ed.setMinimap(false);
    expect(ed.view.state.facet(showMinimap)).toBeNull();
    expect(ed.view.dom.querySelector('.cm-minimap-gutter')).toBeNull();
  });

  it('honors an initial minimap:true option on first paint', () => {
    const ed = makeEditor({ minimap: true });
    expect(ed.view.state.facet(showMinimap)).not.toBeNull();
  });

  it('toggling off leaves no residual minimap gutter', () => {
    const ed = makeEditor({ minimap: true });
    ed.setMinimap(false);
    expect(ed.view.dom.querySelectorAll('.cm-minimap-gutter').length).toBe(0);
  });
});
