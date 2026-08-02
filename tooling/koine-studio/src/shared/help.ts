// Keyboard-shortcuts help overlay for Koine Studio. Uses the shared createModal() chrome and renders
// a ShortcutsTable (src/shared/HelpTable.tsx) — a list of ShortcutRow rendered as a .koi-help-table,
// splitting each chord on '+' into individual .koi-kbd keycaps (with 'mod' rendered as ⌘ / Ctrl per
// platform). The app supplies the rows and wires the F1 shortcut. This file is now a thin facade
// (#991, task 5): the table body is real Preact JSX. Two of the rows (commandPalette, saveAll) are
// rebindable (Settings → Keyboard, #432), so `getRows` is re-invoked and the body re-rendered on every
// `open()` (#1627) rather than once at construction — the modal is a long-lived singleton (built once in
// createOverlays()), so a one-time render would keep showing whatever was resolved at boot.
import { createElement, render } from 'preact';
import { createModal } from '@atypical/koine-ui';
import { ShortcutsTable } from '@/shared/HelpTable';

export interface ShortcutRow {
  keys: string;
  description: string;
}

export interface HelpHandle {
  open: () => void;
  close: () => void;
  toggle: () => void;
}

/** Build the help overlay (once) and return a handle. `getRows` is called fresh on every open so a
 *  rebound chord (commandPalette/saveAll) shows live without needing a reload or a change-event hook. */
export function createHelpOverlay(getRows: () => ShortcutRow[]): HelpHandle {
  const modal = createModal({ title: 'Keyboard shortcuts' });
  modal.onOpen(() => render(createElement(ShortcutsTable, { rows: getRows() }), modal.body));
  return { open: modal.open, close: modal.close, toggle: modal.toggle };
}
