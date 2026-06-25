// @vitest-environment happy-dom
// Proves the editor's five LSP-action shortcuts are driven by the persisted keybinding map (via a
// Compartment) rather than the old inline literals: a remap saved BEFORE the editor is built must take
// effect, the old default must stop firing, and reconfigureKeybindings() must pick up a later change
// without rebuilding the editor. Synthetic keydowns reach CodeMirror's keymap handler under happy-dom
// (see multiCursor.test.ts, which drives the same path), so these assert the real dispatch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKoineEditor, type KoineEditor } from '@/editor/editor';
import { saveKeybindingOverride, clearKeybindingOverrides } from '@/settings/persistence';

const editors: KoineEditor[] = [];

function makeEditor(onFormat: () => Promise<unknown[]>): KoineEditor {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const ed = createKoineEditor({ parent, doc: 'value Money {}', onFormat: onFormat as never });
  editors.push(ed);
  return ed;
}

// happy-dom reports a non-mac platform, so CodeMirror resolves "Mod" to Ctrl.
function press(ed: KoineEditor, init: KeyboardEventInit): void {
  ed.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

const flush = () => Promise.resolve();

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('editor keybinding wiring', () => {
  it('honors a remap saved before the editor is built (Ctrl-d formats, Ctrl-s no longer does)', async () => {
    saveKeybindingOverride('format', 'Ctrl-d');
    const onFormat = vi.fn(async () => []);
    const ed = makeEditor(onFormat);
    ed.view.focus();

    press(ed, { key: 'd', code: 'KeyD', ctrlKey: true });
    await flush();
    expect(onFormat).toHaveBeenCalledTimes(1);

    // The default Ctrl-S has been remapped away — it must not re-trigger format.
    press(ed, { key: 's', code: 'KeyS', ctrlKey: true });
    await flush();
    expect(onFormat).toHaveBeenCalledTimes(1);
  });

  it('reconfigureKeybindings() picks up a cleared override (Ctrl-s formats again)', async () => {
    saveKeybindingOverride('format', 'Ctrl-d');
    const onFormat = vi.fn(async () => []);
    const ed = makeEditor(onFormat);
    ed.view.focus();

    clearKeybindingOverrides();
    ed.reconfigureKeybindings();

    press(ed, { key: 's', code: 'KeyS', ctrlKey: true });
    await flush();
    expect(onFormat).toHaveBeenCalledTimes(1);
  });
});
