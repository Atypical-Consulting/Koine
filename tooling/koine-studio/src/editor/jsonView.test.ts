// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { langExt, createJsonView, type ConfigView } from '@/editor/editor';

// The MCP configuration recipe is highlighted as JSON via the editor module's mode registry.
// `langExt('json')` must resolve to a real CodeMirror mode (a non-empty Extension), while unknown
// ids keep degrading to the `[]` plain-text fallback (#282 graceful-fallback contract).
describe('langExt json mode', () => {
  it('returns a real (non-empty) highlighting extension for json', () => {
    const ext = langExt('json');
    expect(Array.isArray(ext) && ext.length === 0).toBe(false);
  });

  it('still degrades unknown languages to the plain-text fallback', () => {
    expect(langExt('plain')).toEqual([]);
  });
});

// The compact read-only viewer that renders the MCP recipe: it mounts a CodeMirror editor
// (so `.cm-editor` is present and the JSON is highlighted) and round-trips its document text
// verbatim via the view API — which is what the Copy button reads, so it must match exactly.
describe('createJsonView', () => {
  let view: ConfigView | undefined;

  afterEach(() => {
    view?.destroy();
    view = undefined;
  });

  it('mounts a highlighted, read-only viewer and round-trips its text verbatim', () => {
    const parent = document.createElement('div');
    const snippet = '{\n  "mcpServers": { "koine": { "url": "http://x/mcp" } }\n}';
    view = createJsonView(parent);
    view.setContent(snippet);
    expect(view.getText()).toBe(snippet);
    expect(parent.querySelector('.cm-editor')).not.toBeNull();
  });
});
