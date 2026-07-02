import { describe, expect, it, vi } from 'vitest';
import { createFormatActive } from './formatActive';
import { type TextEdit } from '@/lsp/lsp';

const EDIT: TextEdit = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
  newText: 'formatted',
};

// A controllable format request: the test decides when the server response lands, so it can change
// the active uri / doc text inside the in-flight window before resolving.
function harness(state: { uri: string; doc: string }) {
  let resolveFormat!: (edits: TextEdit[]) => void;
  let rejectFormat!: (err: unknown) => void;
  const applyEdits = vi.fn();
  const formatActive = createFormatActive({
    format: () =>
      new Promise<TextEdit[]>((resolve, reject) => {
        resolveFormat = resolve;
        rejectFormat = reject;
      }),
    getDoc: () => state.doc,
    applyEdits,
    activeUri: () => state.uri,
  });
  return { formatActive, applyEdits, resolveFormat: (e: TextEdit[]) => resolveFormat(e), rejectFormat: (err: unknown) => rejectFormat(err) };
}

describe('createFormatActive — stale-response guard', () => {
  it('applies the edits when the active buffer and doc are unchanged', async () => {
    const state = { uri: 'file:///a.koi', doc: 'aggregate A {}' };
    const h = harness(state);
    const run = h.formatActive();
    h.resolveFormat([EDIT]);
    await run;
    expect(h.applyEdits).toHaveBeenCalledWith([EDIT]);
  });

  it('discards a response landing after a file switch (edits computed for the other file)', async () => {
    const state = { uri: 'file:///a.koi', doc: 'aggregate A {}' };
    const h = harness(state);
    const run = h.formatActive();
    state.uri = 'file:///b.koi'; // user clicked b.koi while the format was in flight
    state.doc = 'aggregate B {}';
    h.resolveFormat([EDIT]);
    await run;
    expect(h.applyEdits).not.toHaveBeenCalled();
  });

  it('discards a response landing after fresh keystrokes in the same file', async () => {
    const state = { uri: 'file:///a.koi', doc: 'aggregate A {}' };
    const h = harness(state);
    const run = h.formatActive();
    state.doc = 'aggregate A { x }'; // user kept typing while the format was in flight
    h.resolveFormat([EDIT]);
    await run;
    expect(h.applyEdits).not.toHaveBeenCalled();
  });

  it('degrades silently when the format request fails', async () => {
    const state = { uri: 'file:///a.koi', doc: 'aggregate A {}' };
    const h = harness(state);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const run = h.formatActive();
      h.rejectFormat(new Error('server gone'));
      await expect(run).resolves.toBeUndefined();
      expect(h.applyEdits).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
