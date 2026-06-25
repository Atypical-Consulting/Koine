// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { langExt } from '@/editor/editor';

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
