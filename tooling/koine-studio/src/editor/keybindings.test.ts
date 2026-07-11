import { describe, expect, test, vi, type Mock } from 'vitest';
import {
  DEFAULT_BINDINGS,
  KEYBINDINGS,
  toKeyBindings,
  resolveGlobalKeybindings,
  globalChordFromEvent,
  type BindingId,
  type ChordKeyEvent,
} from '@/editor/keybindings';

// The registry seams #432 builds on: the five editor LSP shortcuts PLUS three commands that used to be
// literals — callHierarchy (editor scope), commandPalette + saveAll (global scope). This pins that
// defaults match the old literals, the array builder emits one entry per BOUND *editor-scope* command
// (global rows are matched by ide.tsx's window listeners, not the keymap), and the global helpers
// (resolveGlobalKeybindings / globalChordFromEvent) behave.

// The six EDITOR-scope handlers as fresh spies so we can assert run-identity per id and that invoking
// each entry's run() fires the matching handler. Global rows (commandPalette / saveAll) have no editor
// handler — the window listeners dispatch them by commandId — so they are absent here.
function mockHandlers(): Partial<Record<BindingId, Mock<() => boolean>>> {
  return {
    goToDefinition: vi.fn<() => boolean>(() => true),
    format: vi.fn<() => boolean>(() => true),
    rename: vi.fn<() => boolean>(() => true),
    findReferences: vi.fn<() => boolean>(() => true),
    codeActions: vi.fn<() => boolean>(() => true),
    callHierarchy: vi.fn<() => boolean>(() => true),
  };
}

describe('DEFAULT_BINDINGS', () => {
  test('matches the literals from editor.ts + the folded-in global chords', () => {
    expect(DEFAULT_BINDINGS).toEqual({
      goToDefinition: 'F12',
      format: 'Mod-s',
      rename: 'F2',
      findReferences: 'Shift-F12',
      codeActions: 'Mod-.',
      callHierarchy: 'Mod-Alt-h',
      commandPalette: 'Mod-k',
      saveAll: 'Mod-Alt-s',
    });
  });
});

describe('toKeyBindings', () => {
  test('emits one entry per bound editor-scope command, with the resolved key and matching handler', () => {
    const handlers = mockHandlers();
    const bindings = toKeyBindings({ ...DEFAULT_BINDINGS }, handlers);

    // Six EDITOR-scope rows; the two global rows (commandPalette / saveAll) are excluded.
    expect(bindings).toHaveLength(6);

    const byKey = Object.fromEntries(bindings.map((b) => [b.key, b]));
    expect(byKey['F12'].run).toBe(handlers.goToDefinition);
    expect(byKey['Mod-s'].run).toBe(handlers.format);
    expect(byKey['F2'].run).toBe(handlers.rename);
    expect(byKey['Shift-F12'].run).toBe(handlers.findReferences);
    expect(byKey['Mod-.'].run).toBe(handlers.codeActions);
    expect(byKey['Mod-Alt-h'].run).toBe(handlers.callHierarchy);

    // The global chords never reach the keymap.
    expect(byKey['Mod-k']).toBeUndefined();
    expect(byKey['Mod-Alt-s']).toBeUndefined();

    // Every binding suppresses the browser/editor default (matches the existing literals).
    expect(bindings.every((b) => b.preventDefault === true)).toBe(true);

    // Calling each run fires exactly its own handler.
    for (const b of bindings) b.run?.({} as never);
    expect(handlers.goToDefinition).toHaveBeenCalledTimes(1);
    expect(handlers.callHierarchy).toHaveBeenCalledTimes(1);
  });

  test('skips an editor command whose resolved key is empty (unbound)', () => {
    const handlers = mockHandlers();
    const bindings = toKeyBindings({ ...DEFAULT_BINDINGS, format: '' }, handlers);

    expect(bindings).toHaveLength(5);
    expect(bindings.some((b) => b.run === handlers.format)).toBe(false);
  });

  test('skips an editor command with no handler wired (Partial handlers)', () => {
    const { callHierarchy, ...withoutCallHierarchy } = mockHandlers();
    void callHierarchy;
    const bindings = toKeyBindings({ ...DEFAULT_BINDINGS }, withoutCallHierarchy);
    expect(bindings.some((b) => b.key === 'Mod-Alt-h')).toBe(false);
  });
});

describe('KEYBINDINGS', () => {
  test('has eight rows, unique ids, non-empty labels, a scope, defaultKey in sync with DEFAULT_BINDINGS', () => {
    expect(KEYBINDINGS).toHaveLength(8);

    const ids = KEYBINDINGS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const row of KEYBINDINGS) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(row.defaultKey).toBe(DEFAULT_BINDINGS[row.id]);
      expect(row.scope === 'editor' || row.scope === 'global').toBe(true);
    }
  });

  test('scope partition: six editor rows, two global rows (commandPalette + saveAll)', () => {
    const editor = KEYBINDINGS.filter((r) => r.scope === 'editor').map((r) => r.id);
    const global = KEYBINDINGS.filter((r) => r.scope === 'global').map((r) => r.id);
    expect(editor).toEqual(['goToDefinition', 'format', 'rename', 'findReferences', 'codeActions', 'callHierarchy']);
    expect(global).toEqual(['commandPalette', 'saveAll']);
  });

  test('global rows carry the command-registry id they dispatch (#758 seam); editor rows do not', () => {
    for (const row of KEYBINDINGS) {
      if (row.scope === 'global') expect(row.commandId).toBeTruthy();
      else expect(row.commandId).toBeUndefined();
    }
    expect(KEYBINDINGS.find((r) => r.id === 'commandPalette')?.commandId).toBe('command-palette');
    expect(KEYBINDINGS.find((r) => r.id === 'saveAll')?.commandId).toBe('save-all');
  });
});

describe('resolveGlobalKeybindings', () => {
  test('projects a resolved map down to the global-scope chords only', () => {
    expect(resolveGlobalKeybindings({ ...DEFAULT_BINDINGS })).toEqual({
      commandPalette: 'Mod-k',
      saveAll: 'Mod-Alt-s',
    });
  });

  test('reflects an override (a rebound saveAll surfaces here)', () => {
    const resolved = { ...DEFAULT_BINDINGS, saveAll: 'Mod-Shift-s' };
    expect(resolveGlobalKeybindings(resolved).saveAll).toBe('Mod-Shift-s');
  });
});

describe('globalChordFromEvent', () => {
  const ev = (e: Partial<ChordKeyEvent>): ChordKeyEvent => ({
    key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...e,
  });

  test('builds the default save-all chord from a Ctrl+Alt+S keydown', () => {
    expect(globalChordFromEvent(ev({ key: 's', code: 'KeyS', ctrlKey: true, altKey: true }))).toBe('Mod-Alt-s');
  });

  test('prefers e.code for letters so a macOS Option-composed glyph still resolves (Alt+S → ß)', () => {
    // On macOS, Option composes e.key into a glyph ('ß'); the physical code stays 'KeyS'.
    expect(globalChordFromEvent(ev({ key: 'ß', code: 'KeyS', metaKey: true, altKey: true }))).toBe('Mod-Alt-s');
  });

  test('builds the palette chord from a Cmd+K keydown', () => {
    expect(globalChordFromEvent(ev({ key: 'k', code: 'KeyK', metaKey: true }))).toBe('Mod-k');
  });

  test('keeps named keys as-is and orders prefixes Mod → Shift → Alt', () => {
    expect(globalChordFromEvent(ev({ key: 'F12', code: 'F12', shiftKey: true }))).toBe('Shift-F12');
    expect(globalChordFromEvent(ev({ key: 'p', code: 'KeyP', ctrlKey: true, shiftKey: true, altKey: true }))).toBe('Mod-Shift-Alt-p');
  });

  test('returns null for a bare modifier (keep waiting for a real key)', () => {
    expect(globalChordFromEvent(ev({ key: 'Meta', metaKey: true }))).toBeNull();
    expect(globalChordFromEvent(ev({ key: 'Alt', altKey: true }))).toBeNull();
  });
});
