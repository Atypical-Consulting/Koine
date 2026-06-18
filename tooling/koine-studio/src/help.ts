// Keyboard-shortcuts help overlay for Koine Studio. A generic modal (.koi-modal*)
// that renders a list of ShortcutRow into a .koi-help-table, splitting each chord on
// '+' into individual .koi-kbd keycaps. Self-mounts to document.body once; Esc and a
// backdrop click close it. The app supplies the rows and wires the F1 shortcut.

import { modKey } from './platform';

export interface ShortcutRow {
  keys: string;
  description: string;
}

export interface HelpHandle {
  open(): void;
  close(): void;
  toggle(): void;
}

/** Build the help overlay, mount it (hidden) on document.body, and return a handle. */
export function createHelpOverlay(rows: ShortcutRow[]): HelpHandle {
  const backdrop = document.createElement('div');
  backdrop.className = 'koi-modal-backdrop';
  backdrop.hidden = true;
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', 'Keyboard shortcuts');

  const modal = document.createElement('div');
  modal.className = 'koi-modal';

  const header = document.createElement('div');
  header.className = 'koi-modal-header';
  const title = document.createElement('h2');
  title.className = 'koi-modal-title';
  title.textContent = 'Keyboard shortcuts';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'koi-modal-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '✕';
  header.append(title, closeBtn);

  const body = document.createElement('div');
  body.className = 'koi-modal-body';
  body.appendChild(buildTable(rows));

  modal.append(header, body);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  let isOpen = false;
  let opener: HTMLElement | null = null;

  function open(): void {
    if (isOpen) return;
    isOpen = true;
    opener = document.activeElement as HTMLElement | null;
    backdrop.hidden = false;
    closeBtn.focus();
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    backdrop.hidden = true;
    opener?.focus?.(); // restore focus to whatever opened the overlay
    opener = null;
  }

  function toggle(): void {
    if (isOpen) close();
    else open();
  }

  // Backdrop click (outside the panel) closes; clicks inside the modal don't bubble out.
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  closeBtn.addEventListener('click', close);

  // Esc closes while open. Captured at document level so it works regardless of focus.
  document.addEventListener('keydown', (e) => {
    if (isOpen && e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });

  return { open, close, toggle };
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
