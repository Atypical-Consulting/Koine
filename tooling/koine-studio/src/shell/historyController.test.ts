import { describe, expect, test, vi } from 'vitest';
import { createHistoryController, type HistoryController } from '@/shell/historyController';
import type { Buffer } from '@/shell/workspaceController';

const last = <T>(arr: T[]): T | undefined => arr[arr.length - 1];

function setup(opts: { maxDepth?: number; debounceMs?: number } = {}) {
  const buffers = new Map<string, Buffer>();
  const mk = (uri: string, text: string, dirty = false): Buffer =>
    ({ uri, path: uri, relPath: uri, name: uri, text, dirty });
  buffers.set('a', mk('a', 'A0'));
  let active = 'a';
  // Mutable hooks let individual tests simulate the real onChange re-entrancy.
  const hooks: { onSetDoc?: (doc: string) => void; onRestored?: () => void } = {};
  const setDoc = vi.fn((doc: string) => hooks.onSetDoc?.(doc));
  const syncDoc = vi.fn();
  const activateFile = vi.fn((uri: string) => { active = uri; });
  const onRestored = vi.fn(() => hooks.onRestored?.());
  const published: Array<{ canUndo: boolean; canRedo: boolean }> = [];
  const ctrl: HistoryController = createHistoryController({
    buffers: () => buffers,
    activeUri: () => active,
    editor: { getDoc: () => buffers.get(active)!.text, setDoc },
    lsp: { syncDoc },
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
  return { ctrl, buffers, mk, edit, setDoc, syncDoc, activateFile, onRestored, published, hooks,
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
});
