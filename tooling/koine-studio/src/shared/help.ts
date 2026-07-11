// Keyboard-shortcuts help overlay for Koine Studio. Uses the shared createModal() chrome and renders
// a ShortcutsTable (src/shared/HelpTable.tsx) — a list of ShortcutRow rendered as a .koi-help-table,
// splitting each chord on '+' into individual .koi-kbd keycaps (with 'mod' rendered as ⌘ / Ctrl per
// platform). The app supplies the rows and wires the F1 shortcut. This file is now a thin facade
// (#991, task 5): the table body is real Preact JSX, rendered once into modal.body — the rows never
// change after the modal is built, so there's nothing to re-render on open.
import { createElement, render } from 'preact';
import { createModal } from '@atypical/koine-ui';
import { ShortcutsTable } from '@/shared/HelpTable';

export interface ShortcutRow {
  keys: string;
  description: string;
}

export interface HelpHandle {
  open(): void;
  close(): void;
  toggle(): void;
}

/** Build the help overlay (once) and return a handle. */
export function createHelpOverlay(rows: ShortcutRow[]): HelpHandle {
  const modal = createModal({ title: 'Keyboard shortcuts' });
  render(createElement(ShortcutsTable, { rows }), modal.body);
  return { open: modal.open, close: modal.close, toggle: modal.toggle };
}
