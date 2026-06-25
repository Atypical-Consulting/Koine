// Registry + keymap builder for the editor's five LSP-action shortcuts. These were inline literals in
// editor.ts's `extraKeys` block; lifting them here lets the Settings UI render/override them and lets
// the editor rebuild its keymap from a resolved map. Kept DOM-free (no EditorView) so it unit-tests
// directly — the `keymap.of(...)` wrapper is the only CodeMirror-facing seam.

import { keymap, type KeyBinding } from '@codemirror/view';
import { type Extension } from '@codemirror/state';

export type BindingId = 'goToDefinition' | 'format' | 'rename' | 'findReferences' | 'codeActions';

// Single source of truth: the registry rows the Settings UI renders. `defaultKey` mirrors the literal
// each command carried in editor.ts; DEFAULT_BINDINGS is derived from this list so the two can't drift.
export const KEYBINDINGS: { id: BindingId; label: string; defaultKey: string }[] = [
  { id: 'goToDefinition', label: 'Go to definition', defaultKey: 'F12' },
  { id: 'format', label: 'Format document', defaultKey: 'Mod-s' },
  { id: 'rename', label: 'Rename symbol', defaultKey: 'F2' },
  { id: 'findReferences', label: 'Find references', defaultKey: 'Shift-F12' },
  { id: 'codeActions', label: 'Code actions', defaultKey: 'Mod-.' },
];

export const DEFAULT_BINDINGS: Record<BindingId, string> = Object.fromEntries(
  KEYBINDINGS.map((b) => [b.id, b.defaultKey]),
) as Record<BindingId, string>;

// Array-construction seam, exported so tests can assert on the KeyBinding[] (the keymap.of() facet is
// opaque). One entry per BOUND command; a command resolved to '' is unbound and skipped. Every binding
// sets preventDefault (matches the format/rename/find-references/code-actions literals — the prior F12
// exception was immaterial since go-to-definition is always registered).
export function toKeyBindings(
  resolved: Record<BindingId, string>,
  handlers: Record<BindingId, () => boolean>,
): KeyBinding[] {
  return KEYBINDINGS.filter((b) => resolved[b.id] !== '').map((b) => ({
    key: resolved[b.id],
    run: handlers[b.id],
    preventDefault: true,
  }));
}

// Thin wrapper: wraps the verifiable array in CodeMirror's keymap facet for the editor to load.
export function buildExtraKeys(
  resolved: Record<BindingId, string>,
  handlers: Record<BindingId, () => boolean>,
): Extension {
  return keymap.of(toKeyBindings(resolved, handlers));
}
