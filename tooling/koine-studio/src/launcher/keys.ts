// The Spotlight launcher's full keyboard model (issue #1143, task 7): a PURE reducer — no DOM, no
// side effects — ported from the "Keyboard" section of
// design/design_handoff_git_spotlight_logos/README.md §2 and the prototype's
// `document.addEventListener("keydown", ...)` handler in `Koine Launcher - Spotlight.html`. `handleKey`
// takes the current state and a key event and returns an intent for `LauncherPanel.tsx` to apply —
// this module never touches `preventDefault()`, `scrollIntoView`, or any store; it just decides WHAT
// should happen so it stays trivially unit-testable (`keys.test.ts`).
//
// The prototype captures ↑/↓/↵/Esc at the document level and branches on whether its action menu
// (`actOpen`) is open, letting every other key (plain typing) fall through unhandled so the input still
// receives it. This reducer mirrors that for ↑/↓/↵/Tab/⌘K: `menuOpen` gates a separate switch, and any
// key neither switch recognizes returns `{ kind: 'none', preventDefault: false }` — including while the
// menu is open, so typing a query underneath an open action menu is never swallowed. Escape is the one
// key the reducer deliberately DOESN'T own (issue #1164): the launcher joins koine-ui's shared
// Esc-stack, so Escape falls through to `none` here and bubbles to that stack's document-level handler,
// which dismisses the topmost layer (menu → clear-query → close).

/** The slice of launcher state `handleKey` needs to decide the next intent — everything the reducer
 * reads, and nothing it doesn't (no catalog, no entries, just the shape of "where things stand"). */
export interface LauncherKeyState {
  /** The current (mode-prefix-stripped) query text. (Escape's clear-then-close is owned by the shared
   * Esc-stack's launcher layer now, not this reducer — issue #1164.) */
  query: string;
  /** 0-based index into the flat `visible` results list (`deriveResults`'s `visible[]`). */
  selectedIndex: number;
  /** `visible.length` — `0` disables ↑/↓ movement rather than dividing by zero. */
  resultCount: number;
  /** Whether the `.lx-actmenu` quick-action popover is open. */
  menuOpen: boolean;
  /** 0-based index into the open menu's action list. */
  menuIndex: number;
  /** The open menu's action count — `0` never happens in practice (`openMenu` guards `!selected`). */
  menuCount: number;
  /** The selected result's title, or `null` when nothing is selected (empty results) — gates Tab-fill. */
  selectedTitle: string | null;
  /** The active mode's prefix char (`''` for All, else one of `>` `@` `#` `/` `:`) — prepended on Tab-fill. */
  modePrefix: string;
}

/**
 * The launcher's keyboard intents. Every variant carries `preventDefault` so `LauncherPanel.tsx` knows
 * whether to call `e.preventDefault()` without re-deriving that decision itself — `'none'` always
 * carries `false` so an unhandled key (plain typing) is never suppressed.
 */
export type LauncherKeyResult =
  // `preventDefault` is usually `false` for `none` (plain typing must never be suppressed), but Tab with
  // no selection returns `none` + `true` to TRAP focus inside the modal (issue #1145 review a11y fix).
  | { kind: 'none'; preventDefault: boolean }
  | { kind: 'move'; selectedIndex: number; preventDefault: true }
  | { kind: 'runDefault'; preventDefault: true }
  | { kind: 'fill'; query: string; preventDefault: true }
  | { kind: 'toggleMenu'; preventDefault: true }
  | { kind: 'menuMove'; menuIndex: number; preventDefault: true }
  | { kind: 'runMenu'; preventDefault: true };

const NONE: LauncherKeyResult = { kind: 'none', preventDefault: false };

/** Wraps `index` by one step in `direction` (`1` or `-1`) over a list of `count` items. */
function wrap(index: number, direction: 1 | -1, count: number): number {
  return (index + direction + count) % count;
}

/**
 * Decide the next intent for a keydown, given the launcher's current `state`. `e` only needs the
 * handful of `KeyboardEvent` fields the model reads, so callers (and tests) can pass a plain object
 * instead of a real DOM event.
 */
export function handleKey(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  state: LauncherKeyState,
): LauncherKeyResult {
  // ⌘K/Ctrl+K toggles the action menu regardless of whether it's open or closed.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    return { kind: 'toggleMenu', preventDefault: true };
  }

  if (state.menuOpen) {
    switch (e.key) {
      case 'ArrowDown':
        return { kind: 'menuMove', menuIndex: wrap(state.menuIndex, 1, state.menuCount), preventDefault: true };
      case 'ArrowUp':
        return { kind: 'menuMove', menuIndex: wrap(state.menuIndex, -1, state.menuCount), preventDefault: true };
      case 'Enter':
        return { kind: 'runMenu', preventDefault: true };
      default:
        // Escape is intentionally NOT handled here (issue #1164): the launcher joins koine-ui's shared
        // Esc-stack, whose action-menu layer closes the menu, so the reducer lets Escape fall through
        // (and bubble). Any other key (plain typing) is likewise left alone so the query keeps editing
        // underneath the menu.
        return NONE;
    }
  }

  switch (e.key) {
    case 'ArrowDown':
      if (state.resultCount === 0) return NONE;
      return { kind: 'move', selectedIndex: wrap(state.selectedIndex, 1, state.resultCount), preventDefault: true };
    case 'ArrowUp':
      if (state.resultCount === 0) return NONE;
      return { kind: 'move', selectedIndex: wrap(state.selectedIndex, -1, state.resultCount), preventDefault: true };
    case 'Enter':
      return { kind: 'runDefault', preventDefault: true };
    case 'Tab':
      // No selection to fill, but Tab must still be trapped: letting the browser's default Tab run would
      // move focus OUT of the modal overlay (issue #1145 review). Prevent default without an action.
      if (state.selectedTitle === null) return { kind: 'none', preventDefault: true };
      return { kind: 'fill', query: state.modePrefix + state.selectedTitle, preventDefault: true };
    default:
      // Escape falls through here (issue #1164): koine-ui's shared Esc-stack owns the launcher's
      // Escape now (its launcher layer clears a non-empty query, else closes), so the reducer no
      // longer decides clear-vs-close — it lets Escape bubble to the shared document handler.
      return NONE;
  }
}
