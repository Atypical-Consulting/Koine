// Registry + keymap builder for Koine Studio's rebindable shortcuts. Originally the five editor LSP
// actions (inline literals in editor.ts's `extraKeys`); #432 extends it with a `scope` discriminator and
// three more rows that used to be literals — callHierarchy (editor scope, folded into the keymap
// compartment) plus the two app-GLOBAL chords, commandPalette (Mod-k) and saveAll (Mod-Alt-s), which are
// matched by ide.tsx's window keydown listeners rather than the CodeMirror keymap. Kept DOM-free (no
// EditorView; the pure global helpers take a plain keydown shape) so it unit-tests directly — the
// `keymap.of(...)` wrapper is the only CodeMirror-facing seam.

import { keymap, type KeyBinding } from '@codemirror/view';
import { type Extension } from '@codemirror/state';

export type BindingId =
  | 'goToDefinition'
  | 'format'
  | 'rename'
  | 'findReferences'
  | 'codeActions'
  | 'callHierarchy'
  | 'commandPalette'
  | 'saveAll';

/**
 * Where a chord is consumed. `editor` rows flow through the CodeMirror keymap compartment
 * (toKeyBindings / buildExtraKeys); `global` rows work with no editor focused, so they are matched by the
 * app-level `window` keydown listeners in ide.tsx (palette + save-all) and dispatch a registered command
 * by {@link KeyBindingRow.commandId}.
 */
export type BindingScope = 'editor' | 'global';

// One rebindable chord row. Editor rows resolve to an editor LSP handler (keyed by `id`); a `global` row
// carries the command-registry id it dispatches via commandWiring.run(commandId) (#758's command layer),
// so adding a global shortcut is "add a row pointing at an existing command id" rather than authoring a
// literal `keydown` branch.
export interface KeyBindingRow {
  id: BindingId;
  label: string;
  defaultKey: string;
  scope: BindingScope;
  /** For a `global` row: the command-registry id this chord dispatches via run() (see #758 / PALETTE_COMMAND_ID). */
  commandId?: string;
}

// Single source of truth: the registry rows the Settings UI renders. `defaultKey` mirrors the literal
// each command carried (editor.ts's extraKeys / callHierarchyKeys, ide.tsx's onSaveKey, commandWiring's
// palette chord); DEFAULT_BINDINGS is derived from this list so the two can't drift.
export const KEYBINDINGS: KeyBindingRow[] = [
  { id: 'goToDefinition', label: 'Go to definition', defaultKey: 'F12', scope: 'editor' },
  { id: 'format', label: 'Format document', defaultKey: 'Mod-s', scope: 'editor' },
  { id: 'rename', label: 'Rename symbol', defaultKey: 'F2', scope: 'editor' },
  { id: 'findReferences', label: 'Find references', defaultKey: 'Shift-F12', scope: 'editor' },
  { id: 'codeActions', label: 'Code actions', defaultKey: 'Mod-.', scope: 'editor' },
  { id: 'callHierarchy', label: 'Call hierarchy', defaultKey: 'Mod-Alt-h', scope: 'editor' },
  { id: 'commandPalette', label: 'Command palette', defaultKey: 'Mod-k', scope: 'global', commandId: 'command-palette' },
  { id: 'saveAll', label: 'Save all', defaultKey: 'Mod-Alt-s', scope: 'global', commandId: 'save-all' },
];

export const DEFAULT_BINDINGS: Record<BindingId, string> = Object.fromEntries(
  KEYBINDINGS.map((b) => [b.id, b.defaultKey]),
) as Record<BindingId, string>;

// Array-construction seam, exported so tests can assert on the KeyBinding[] (the keymap.of() facet is
// opaque). One entry per BOUND, EDITOR-scope command; global rows are matched by ide.tsx's window
// listeners (never the keymap), a command resolved to '' is unbound and skipped, and a row with no
// handler wired (handlers is a Partial) is likewise skipped. Every binding sets preventDefault (matches
// the former literals).
export function toKeyBindings(
  resolved: Record<BindingId, string>,
  handlers: Partial<Record<BindingId, () => boolean>>,
): KeyBinding[] {
  const out: KeyBinding[] = [];
  for (const b of KEYBINDINGS) {
    if (b.scope !== 'editor') continue; // global chords live on ide.tsx's window listeners, not the keymap
    const run = handlers[b.id];
    if (!run || resolved[b.id] === '') continue; // no handler wired, or unbound
    out.push({ key: resolved[b.id], run, preventDefault: true });
  }
  return out;
}

// Thin wrapper: wraps the verifiable array in CodeMirror's keymap facet for the editor to load.
export function buildExtraKeys(
  resolved: Record<BindingId, string>,
  handlers: Partial<Record<BindingId, () => boolean>>,
): Extension {
  return keymap.of(toKeyBindings(resolved, handlers));
}

// --- global-scope helpers ----------------------------------------------------

/**
 * Project a resolved keybinding map down to the GLOBAL-scope chords (commandPalette, saveAll) — the map
 * the app-level window keydown listeners match against. Pure over the passed-in resolved map (defaults +
 * overrides), so it stays DOM-free and can't create an import cycle with the persistence store.
 */
export function resolveGlobalKeybindings(
  resolved: Record<BindingId, string>,
): Partial<Record<BindingId, string>> {
  const out: Partial<Record<BindingId, string>> = {};
  for (const b of KEYBINDINGS) if (b.scope === 'global') out[b.id] = resolved[b.id];
  return out;
}

/** The minimal keydown shape a global chord is matched against — a subset of {@link KeyboardEvent} so
 *  {@link globalChordFromEvent} unit-tests without a DOM event. */
export interface ChordKeyEvent {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Build a CodeMirror chord string ('Mod-Alt-s', 'Mod-k') from a keydown, preferring `e.code` for the
 * letter keys KeyA–KeyZ so a macOS Option-composed glyph (Alt+S → 'ß') still resolves to its base letter.
 * The editor keymap can lean on `e.key` (platform.chordFromEvent), but the global `window` listeners
 * match Alt+letter chords, which macOS mangles in `e.key` — hence the code-aware base. The prefix order
 * (Mod → Shift → Alt) mirrors chordFromEvent so a recorded chord round-trips through resolveKeybindings().
 * Returns null for a bare modifier (wait for a real key).
 */
export function globalChordFromEvent(e: ChordKeyEvent): string | null {
  if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return null;
  let prefix = '';
  if (e.ctrlKey || e.metaKey) prefix += 'Mod-'; // portable primary modifier (⌘ on mac, Ctrl elsewhere)
  if (e.shiftKey) prefix += 'Shift-';
  if (e.altKey) prefix += 'Alt-';
  const letter = /^Key([A-Z])$/.exec(e.code);
  // A physical letter key uses its code-derived base (macOS-glyph-proof); otherwise fall back to e.key —
  // a single printable char lowercased ('.'), a named key kept as-is ('F12', 'ArrowUp').
  const base = letter ? letter[1].toLowerCase() : e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return prefix + base;
}
