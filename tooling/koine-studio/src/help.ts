// Keyboard-shortcuts help overlay for Koine Studio. Uses the shared createModal() chrome and
// renders a list of ShortcutRow into a .koi-help-table, splitting each chord on '+' into
// individual .koi-kbd keycaps (with 'mod' rendered as ⌘ / Ctrl per platform). The app supplies
// the rows and wires the F1 shortcut.
import { createModal } from '@/overlay';
import { modKey } from '@/platform';

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
  modal.body.appendChild(buildTable(rows));
  return { open: modal.open, close: modal.close, toggle: modal.toggle };
}

/** Render the rows into a .koi-help-table; each row is a keycaps cell + a description cell. */
function buildTable(rows: ShortcutRow[]): HTMLElement {
  const table = document.createElement('table');
  table.className = 'koi-help-table';
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');

    const keysCell = document.createElement('td');
    appendKeycaps(keysCell, row.keys);

    const descCell = document.createElement('td');
    descCell.textContent = row.description;

    tr.append(keysCell, descCell);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

/** Split a chord like 'mod+Shift+O' on '+' and emit a .koi-kbd keycap per segment. */
function appendKeycaps(cell: HTMLElement, keys: string): void {
  const parts = keys.split('+').map((s) => s.trim()).filter((s) => s.length > 0);
  parts.forEach((part, i) => {
    if (i > 0) cell.appendChild(document.createTextNode(' '));
    const kbd = document.createElement('span');
    kbd.className = 'koi-kbd';
    kbd.textContent = modKey(part); // render 'mod' as ⌘ / Ctrl per platform
    cell.appendChild(kbd);
  });
}
