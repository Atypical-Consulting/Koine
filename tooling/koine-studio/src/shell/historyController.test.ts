import { describe, expect, test, vi } from 'vitest';
import { createHistoryController, type HistoryController } from '@/shell/historyController';
import type { Buffer } from '@/shell/workspaceController';

const last = <T>(arr: T[]): T | undefined => arr[arr.length - 1];

function setup(opts: { maxDepth?: number; debounceMs?: number } = {}) {
  const buffers = new Map<string, Buffer>();
  const mk = (uri: string, text: string, dirty = false): Buffer =>
    ({ uri, path: uri, relPath: uri, name: uri, text, dirty, rootToken: '' });
  buffers.set('a', mk('a', 'A0'));
  let active = 'a';
  // Mutable hooks let individual tests simulate the real onChange re-entrancy.
  const hooks: { onSetDoc?: (doc: string) => void; onRestored?: () => void } = {};
  const setDoc = vi.fn((doc: string) => hooks.onSetDoc?.(doc));
  const syncDoc = vi.fn();
  const activateFile = vi.fn((uri: string) => { active = uri; });
  const onRestored = vi.fn(() => hooks.onRestored?.());
  // Mirrors the real appStore.upsertBuffers wiring in ide.tsx: an immutable, ONE-shot replace of
  // several buffers into the map, never an in-place write onto an existing Buffer object.
  const writeBuffers = vi.fn((patches: Array<{ uri: string; text: string; dirty: boolean }>) => {
    for (const p of patches) {
      const b = buffers.get(p.uri);
      if (b) buffers.set(p.uri, { ...b, text: p.text, dirty: p.dirty });
    }
  });
  const published: Array<{ canUndo: boolean; canRedo: boolean }> = [];
  const ctrl: HistoryController = createHistoryController({
    buffers: () => buffers,
    activeUri: () => active,
    editor: { getDoc: () => buffers.get(active)!.text, setDoc },
    lsp: { syncDoc },
    writeBuffers,
    activateFile,
    onRestored,
    publish: (s) => published.push({ ...s }),
    debounceMs: opts.debounceMs ?? 5,
    maxDepth: opts.maxDepth ?? 100,
  });
  const edit = (uri: string, text: string, dirty = true) => {
    const b = buffers.get(uri)!;
    b.text = text;
    b.dirty = dirty;
  };
  return { ctrl, buffers, mk, edit, setDoc, syncDoc, writeBuffers, activateFile, onRestored, published, hooks,
           setActive: (u: string) => { active = u; } };
}

describe('historyController', () => {
  test('an edit enables undo; undo restores the prior text via setDoc', () => {
    const h = setup();
    h.edit('a', 'A1');
    h.ctrl.noteEdit({ immediate: true });
    expect(last(h.published)).toEqual({ canUndo: true, canRedo: false });

    h.ctrl.undo();
    expect(h.buffers.get('a')!.text).toBe('A0');
    expect(h.setDoc).toHaveBeenCalledWith('A0');
    expect(last(h.published)).toEqual({ canUndo: false, canRedo: true });
  });

  test('redo re-applies the undone edit', () => {
    const h = setup();
    h.edit('a', 'A1');
    h.ctrl.noteEdit({ immediate: true });
    h.ctrl.undo();
    h.ctrl.redo();
    expect(h.buffers.get('a')!.text).toBe('A1');
    expect(last(h.published)).toEqual({ canUndo: true, canRedo: false });
  });

  test('a new edit after undo clears the redo future', () => {
    const h = setup();
    h.edit('a', 'A1');
    h.ctrl.noteEdit({ immediate: true });
    h.ctrl.undo();
    h.edit('a', 'A2');
    h.ctrl.noteEdit({ immediate: true });
    expect(last(h.published)).toEqual({ canUndo: true, canRedo: false });
    h.ctrl.redo(); // no future → no-op
    expect(h.buffers.get('a')!.text).toBe('A2');
  });

  test('rapid typing coalesces into a single step (debounced)', () => {
    vi.useFakeTimers();
    try {
      const h = setup({ debounceMs: 5 });
      h.edit('a', 'A1'); h.ctrl.noteEdit();
      h.edit('a', 'A2'); h.ctrl.noteEdit();
      h.edit('a', 'A3'); h.ctrl.noteEdit();
      vi.advanceTimersByTime(5);
      expect(last(h.published)).toEqual({ canUndo: true, canRedo: false });
      h.ctrl.undo();
      expect(h.buffers.get('a')!.text).toBe('A0'); // one step back to baseline, not A2/A1
    } finally {
      vi.useRealTimers();
    }
  });

  test('undo flushes a pending debounced edit first, making it redoable', () => {
    vi.useFakeTimers();
    try {
      const h = setup({ debounceMs: 5 });
      h.edit('a', 'A1'); h.ctrl.noteEdit(); // pending, not yet committed
      h.ctrl.undo();
      expect(h.buffers.get('a')!.text).toBe('A0');
      h.ctrl.redo();
      expect(h.buffers.get('a')!.text).toBe('A1');
    } finally {
      vi.useRealTimers();
    }
  });

  test('a dirty-only change (a save) creates no step', () => {
    const h = setup();
    h.edit('a', 'A1', true);
    h.ctrl.noteEdit({ immediate: true });
    const before = h.published.length;
    h.buffers.get('a')!.dirty = false; // save: text unchanged, dirty flips
    h.ctrl.noteEdit({ immediate: true });
    expect(h.published.length).toBe(before);
  });

  test('a multi-file structured edit undoes every buffer in one step', () => {
    const h = setup();
    h.buffers.set('b', h.mk('b', 'B0'));
    h.ctrl.reset(); // baseline now includes 'b' (mirrors a folder open, which resets history over all open buffers)
    h.edit('a', 'A1');
    h.edit('b', 'B1');
    h.ctrl.noteEdit({ immediate: true });
    h.ctrl.undo();
    expect(h.buffers.get('a')!.text).toBe('A0');
    expect(h.buffers.get('b')!.text).toBe('B0');
    expect(h.setDoc).toHaveBeenCalledWith('A0');      // active buffer via the editor
    expect(h.syncDoc).toHaveBeenCalledWith('b', 'B0'); // non-active buffer via the LSP
  });

  // Regression for #1231: a multi-buffer restore must fire ONE batched writeBuffers call carrying
  // every changed buffer's patch, not N separate single-buffer writes.
  test('a multi-buffer undo batches every buffer into ONE writeBuffers call', () => {
    const h = setup();
    h.buffers.set('b', h.mk('b', 'B0'));
    h.ctrl.reset(); // baseline now includes 'b'
    h.edit('a', 'A1');
    h.edit('b', 'B1');
    h.ctrl.noteEdit({ immediate: true });
    h.ctrl.undo();
    expect(h.writeBuffers).toHaveBeenCalledTimes(1);
    expect(h.writeBuffers).toHaveBeenCalledWith([
      { uri: 'a', text: 'A0', dirty: false },
      { uri: 'b', text: 'B0', dirty: false },
    ]);
  });

  test('restore activates the snapshot’s file when the active file differs', () => {
    const h = setup();
    h.buffers.set('b', h.mk('b', 'B0'));
    h.edit('a', 'A1');
    h.ctrl.noteEdit({ immediate: true }); // baseline snapshot had active 'a'
    h.setActive('b');                      // user switched files
    h.ctrl.undo();
    expect(h.activateFile).toHaveBeenCalledWith('a');
  });

  test('isRestoring suppresses capture re-entered from a restore', () => {
    const h = setup();
    let reentered = 0;
    h.hooks.onRestored = () => { h.ctrl.noteEdit({ immediate: true }); reentered++; };
    h.edit('a', 'A1');
    h.ctrl.noteEdit({ immediate: true });
    h.ctrl.undo();                 // restore → onRestored → noteEdit must be ignored
    expect(reentered).toBe(1);
    h.ctrl.redo();                 // history not corrupted by the re-entrant edit
    expect(h.buffers.get('a')!.text).toBe('A1');
    expect(last(h.published)).toEqual({ canUndo: true, canRedo: false });
  });

  test('reset clears the stacks and re-baselines on current buffers', () => {
    const h = setup();
    h.edit('a', 'A1');
    h.ctrl.noteEdit({ immediate: true });
    h.ctrl.reset();
    expect(last(h.published)).toEqual({ canUndo: false, canRedo: false });
    h.ctrl.undo(); // no-op after reset
    expect(h.buffers.get('a')!.text).toBe('A1');
  });

  test('depth cap drops the oldest step', () => {
    const h = setup({ maxDepth: 2 });
    for (const t of ['A1', 'A2', 'A3']) { h.edit('a', t); h.ctrl.noteEdit({ immediate: true }); }
    h.ctrl.undo(); // A2
    h.ctrl.undo(); // A1 (A0 was dropped)
    expect(last(h.published)).toEqual({ canUndo: false, canRedo: true });
    expect(h.buffers.get('a')!.text).toBe('A1');
  });

  // Regression coverage for #1010: `restore` must write buffers back through the slice's immutable
  // `writeBuffers` dep, never by mutating a store-owned Buffer in place.
  test('undo replaces the restored buffer with a new object (no in-place mutation)', () => {
    const h = setup();
    h.edit('a', 'A1');
    h.ctrl.noteEdit({ immediate: true });
    const preRestore = h.buffers.get('a')!;
    h.ctrl.undo();
    const postRestore = h.buffers.get('a')!;
    expect(postRestore).not.toBe(preRestore); // immutable replace, not an in-place write
    expect(preRestore.text).toBe('A1'); // the pre-restore object itself must be left untouched
    expect(postRestore.text).toBe('A0');
  });

  test('restoring a non-active buffer writes through writeBuffers, not just lsp.syncDoc', () => {
    const h = setup();
    h.buffers.set('b', h.mk('b', 'B0'));
    h.ctrl.reset(); // baseline now includes 'b'
    h.edit('b', 'B1');
    h.ctrl.noteEdit({ immediate: true }); // active stays 'a'; 'b' is the non-active buffer
    h.ctrl.undo();
    expect(h.writeBuffers).toHaveBeenCalledWith([{ uri: 'b', text: 'B0', dirty: false }]);
    expect(h.syncDoc).toHaveBeenCalledWith('b', 'B0');
  });

  test('undo to a clean baseline restores dirty:false through the write path', () => {
    const h = setup();
    h.edit('a', 'A1', true); // dirty edit
    h.ctrl.noteEdit({ immediate: true });
    h.ctrl.undo(); // baseline was dirty:false
    expect(h.writeBuffers).toHaveBeenCalledWith([{ uri: 'a', text: 'A0', dirty: false }]);
    expect(h.buffers.get('a')!.dirty).toBe(false);
  });

  // Regression: `restore` must call `writeBuffers` BEFORE `editor.setDoc` for the active buffer, even
  // in the batched two-pass shape (#1231). `editor.setDoc` dispatches synchronously and reenters
  // onChange -> workspace.syncBuffer while `isRestoring` is still true (mirrored here via the
  // `onSetDoc` hook); that reentrant sync must see the buffer ALREADY at its restored text — exactly
  // like the old in-place `buf.text = …` write that ran before `setDoc` — or it mistakes the restore
  // for a real edit and churns an extra, wrongly dirty store transition before the real `writeBuffers`
  // call corrects it. Carried over from #1010's own code-review fix.
  test('writeBuffers runs before editor.setDoc, so a reentrant onChange never sees stale text', () => {
    const h = setup();
    h.edit('a', 'A1');
    h.ctrl.noteEdit({ immediate: true });
    let sawRestoredTextInReentrantOnChange = false;
    h.hooks.onSetDoc = () => {
      sawRestoredTextInReentrantOnChange = h.buffers.get('a')!.text === 'A0';
    };
    h.ctrl.undo();
    expect(h.setDoc).toHaveBeenCalledWith('A0'); // sanity: setDoc did fire
    expect(sawRestoredTextInReentrantOnChange).toBe(true);
  });

  // Regression for #1231: the write-before-effect ordering must also hold for a multi-buffer restore
  // — the batched writeBuffers call lands before ANY buffer's setDoc/syncDoc effect fires, not
  // interleaved per-buffer.
  test('writeBuffers runs before ANY editor/lsp effect in a multi-buffer restore', () => {
    const h = setup();
    h.buffers.set('b', h.mk('b', 'B0'));
    h.ctrl.reset(); // baseline now includes 'b'
    h.edit('a', 'A1');
    h.edit('b', 'B1');
    h.ctrl.noteEdit({ immediate: true });
    const callOrder: string[] = [];
    h.writeBuffers.mockImplementation((patches: Array<{ uri: string; text: string; dirty: boolean }>) => {
      callOrder.push('writeBuffers');
      for (const p of patches) {
        const b = h.buffers.get(p.uri);
        if (b) h.buffers.set(p.uri, { ...b, text: p.text, dirty: p.dirty });
      }
    });
    h.setDoc.mockImplementation(() => callOrder.push('setDoc'));
    h.syncDoc.mockImplementation(() => callOrder.push('syncDoc'));
    h.ctrl.undo();
    expect(callOrder).toEqual(['writeBuffers', 'setDoc', 'syncDoc']);
  });
});
