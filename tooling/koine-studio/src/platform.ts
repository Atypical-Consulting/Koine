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
