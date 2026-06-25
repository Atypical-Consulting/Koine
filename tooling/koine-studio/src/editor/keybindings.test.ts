import { describe, expect, test, vi, type Mock } from 'vitest';
import { DEFAULT_BINDINGS, KEYBINDINGS, toKeyBindings, type BindingId } from '@/editor/keybindings';

// The five LSP-action shortcuts were inline literals in editor.ts's extraKeys block. This pins the
// registry/builder seam: defaults must match those literals, the array builder must emit one entry
// per BOUND command (skipping unbound '' keys), and the registry rows must stay in sync with defaults.

// All five handlers as fresh spies so we can assert run-identity per id and that invoking each
// entry's run() fires the matching handler.
function mockHandlers(): Record<BindingId, Mock<() => boolean>> {
  return {
    goToDefinition: vi.fn<() => boolean>(() => true),
    format: vi.fn<() => boolean>(() => true),
    rename: vi.fn<() => boolean>(() => true),
    findReferences: vi.fn<() => boolean>(() => true),
    codeActions: vi.fn<() => boolean>(() => true),
  };
}

describe('DEFAULT_BINDINGS', () => {
  test('matches the five literals from editor.ts extraKeys', () => {
    expect(DEFAULT_BINDINGS).toEqual({
      goToDefinition: 'F12',
      format: 'Mod-s',
      rename: 'F2',
      findReferences: 'Shift-F12',
      codeActions: 'Mod-.',
    });
  });
});

describe('toKeyBindings', () => {
  test('emits one entry per bound command, with the resolved key and the matching handler', () => {
    const handlers = mockHandlers();
    const bindings = toKeyBindings({ ...DEFAULT_BINDINGS }, handlers);

    expect(bindings).toHaveLength(5);

    const byKey = Object.fromEntries(bindings.map((b) => [b.key, b]));
    expect(byKey['F12'].run).toBe(handlers.goToDefinition);
    expect(byKey['Mod-s'].run).toBe(handlers.format);
    expect(byKey['F2'].run).toBe(handlers.rename);
    expect(byKey['Shift-F12'].run).toBe(handlers.findReferences);
    expect(byKey['Mod-.'].run).toBe(handlers.codeActions);

    // Every binding suppresses the browser/editor default (matches the existing literals).
    expect(bindings.every((b) => b.preventDefault === true)).toBe(true);

    // Calling each run fires exactly its own handler.
    for (const b of bindings) b.run?.({} as never);
    expect(handlers.goToDefinition).toHaveBeenCalledTimes(1);
    expect(handlers.format).toHaveBeenCalledTimes(1);
    expect(handlers.rename).toHaveBeenCalledTimes(1);
    expect(handlers.findReferences).toHaveBeenCalledTimes(1);
    expect(handlers.codeActions).toHaveBeenCalledTimes(1);
  });

  test('skips a command whose resolved key is empty (unbound)', () => {
    const handlers = mockHandlers();
    const bindings = toKeyBindings({ ...DEFAULT_BINDINGS, format: '' }, handlers);

    expect(bindings).toHaveLength(4);
    expect(bindings.some((b) => b.run === handlers.format)).toBe(false);
  });
});

describe('KEYBINDINGS', () => {
  test('has five rows, unique ids, non-empty labels, defaultKey in sync with DEFAULT_BINDINGS', () => {
    expect(KEYBINDINGS).toHaveLength(5);

    const ids = KEYBINDINGS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const row of KEYBINDINGS) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(row.defaultKey).toBe(DEFAULT_BINDINGS[row.id]);
    }
  });
});
