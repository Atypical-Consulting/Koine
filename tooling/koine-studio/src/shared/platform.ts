// Platform helpers for Koine Studio. The primary modifier renders as ⌘ on macOS and
// "Ctrl" elsewhere; shortcut strings are authored with a literal "mod" segment and
// substituted at render time so the toolbar hint, command palette, and help overlay
// all agree on what key the user must actually press.
const isMac =
  typeof navigator !== 'undefined' &&
  /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '');

/** Display string for the primary modifier: '⌘' on macOS, 'Ctrl' elsewhere. */
export const MOD = isMac ? '⌘' : 'Ctrl';

/** Replace a literal "mod" key segment (case-insensitive) with the platform modifier. */
export function modKey(segment: string): string {
  return segment.toLowerCase() === 'mod' ? MOD : segment;
}

/** Substitute "mod" in a full chord string like "mod+Shift+O" for display. */
export function formatChord(keys: string): string {
  return keys
    .split('+')
    .map((s) => modKey(s.trim()))
    .join('+');
}

// Normalize a keydown into a CodeMirror key string ('Mod-s', 'Shift-F12', 'F2', 'Mod-.', 'Mod-d'), or
// null when the event is a bare modifier (wait for a real key). Callers treat Escape as cancel
// separately. The modifier prefix order (Mod → Shift → Alt) and portable 'Mod' (ctrl/meta) match the
// style of the keybinding defaults, so a recorded chord round-trips through resolveKeybindings().
export function chordFromEvent(e: KeyboardEvent): string | null {
  const k = e.key;
  if (k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta') return null; // bare modifier — keep waiting
  let prefix = '';
  if (e.ctrlKey || e.metaKey) prefix += 'Mod-'; // portable primary modifier (⌘ on mac, Ctrl elsewhere)
  if (e.shiftKey) prefix += 'Shift-';
  if (e.altKey) prefix += 'Alt-';
  // A single printable character is lowercased ('d', '.'); a named key keeps its name ('F12', 'ArrowUp').
  const base = k.length === 1 ? k.toLowerCase() : k;
  return prefix + base;
}

// Render a stored CodeMirror key ('Mod-s') as a platform display string ('⌘+S' / 'Ctrl+S'). Strips the
// known modifier prefixes off the FRONT (in chordFromEvent's emit order) rather than splitting on '-',
// so a chord whose base key is itself '-' (e.g. 'Mod--', Ctrl+minus) renders as 'Ctrl+-' instead of a
// garbled 'Ctrl++'. The remaining base is uppercased when it's a single char, then formatChord does the
// platform substitution. '' (a deliberate "unbound" override) reads as 'Unbound'.
export function prettyChord(cmKey: string): string {
  if (cmKey === '') return 'Unbound';
  let rest = cmKey;
  const mods: string[] = [];
  for (const [prefix, segment] of [['Mod-', 'mod'], ['Shift-', 'Shift'], ['Alt-', 'Alt']] as const) {
    if (rest.startsWith(prefix)) {
      mods.push(segment);
      rest = rest.slice(prefix.length);
    }
  }
  const base = rest.length === 1 ? rest.toUpperCase() : rest;
  return formatChord([...mods, base].join('+'));
}
