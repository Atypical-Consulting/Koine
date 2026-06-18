// Command palette for Koine Studio: a Cmd/Ctrl-K style overlay that self-mounts to
// document.body once. The app supplies commands via a getCommands() provider snapshotted
// on every open(); typing filters by case-insensitive subsequence/substring match on title;
// Up/Down move (wrapping), Enter runs the selected command then closes. Esc is handled
// centrally by the shared overlay stack (./overlay). The palette does NOT bind Cmd-K itself —
// the app wires the global shortcut.
import { registerOverlay } from './overlay';

export interface Command {
  id: string;
  title: string;
  hint?: string;
  group?: string;
  run(): void;
}

export interface PaletteHandle {
  open(): void;
  close(): void;
  toggle(): void;
  readonly isOpen: boolean;
}

/**
 * Case-insensitive match: true when every char of `query` appears in `title` in order
 * (subsequence), which also covers plain substring matches. Empty query matches everything.
 */
function matches(title: string, query: string): boolean {
  if (!query) return true;
  const t = title.toLowerCase();
  const q = query.toLowerCase();
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) i++;
  }
  return i === q.length;
}

export function createCommandPalette(getCommands: () => Command[]): PaletteHandle {
  let open = false;
  let opener: HTMLElement | null = null; // element focused before the palette opened
  let unregister: (() => void) | null = null;
  let commands: Command[] = []; // snapshot taken on open()
  let filtered: Command[] = [];
  let selected = 0;
  let rowEls: HTMLElement[] = []; // current row elements, parallel to `filtered`

  const backdrop = document.createElement('div');
  backdrop.className = 'koi-palette-backdrop';
  backdrop.hidden = true;

  const panel = document.createElement('div');
  panel.className = 'koi-palette';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');

  const input = document.createElement('input');
  input.className = 'koi-palette-input';
  input.type = 'text';
  input.placeholder = 'Type a command…';
  input.setAttribute('aria-label', 'Command palette');
  input.autocomplete = 'off';
  input.spellcheck = false;

  const list = document.createElement('div');
  list.className = 'koi-palette-list';
  list.setAttribute('role', 'listbox');

  panel.append(input, list);
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);

  function scrollSelectedIntoView(): void {
    rowEls[selected]?.scrollIntoView({ block: 'nearest' });
  }

  // Flip aria-selected on the affected rows and scroll — no DOM rebuild (hot path on hover).
  function applySelection(): void {
    rowEls.forEach((row, i) => row.setAttribute('aria-selected', i === selected ? 'true' : 'false'));
    scrollSelectedIntoView();
  }

  function setSelected(i: number): void {
    if (i === selected) return;
    selected = i;
    applySelection();
  }

  // Rebuild the list rows from `filtered` — only called when the filtered SET changes, not on
  // selection moves (those mutate aria-selected via applySelection).
  function renderList(): void {
    list.replaceChildren();
    rowEls = [];
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'koi-palette-empty';
      empty.textContent = 'No matching commands';
      list.appendChild(empty);
      return;
    }
    filtered.forEach((cmd, i) => {
      const row = document.createElement('div');
      row.className = 'koi-palette-item';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', i === selected ? 'true' : 'false');

      const title = document.createElement('span');
      title.className = 'koi-palette-item-title';
      title.textContent = cmd.title;
      row.appendChild(title);

      if (cmd.hint) {
        const hint = document.createElement('span');
        hint.className = 'koi-palette-item-hint';
        hint.textContent = cmd.hint;
        row.appendChild(hint);
      }

      // Pointer hover previews selection (cheap flag flip); click runs immediately.
      row.addEventListener('mousemove', () => setSelected(i));
      row.addEventListener('click', () => runAt(i));

      list.appendChild(row);
      rowEls.push(row);
    });
    scrollSelectedIntoView();
  }

  // Recompute `filtered` from the current input, clamp selection, and re-render.
  function applyFilter(): void {
    const query = input.value.trim();
    filtered = commands.filter((c) => matches(c.title, query));
    selected = filtered.length ? Math.min(selected, filtered.length - 1) : 0;
    renderList();
  }

  // Move selection by `delta`, wrapping around the filtered list.
  function move(delta: number): void {
    if (!filtered.length) return;
    selected = (selected + delta + filtered.length) % filtered.length;
    applySelection();
  }

  // Run the command at index `i` (if any), then close.
  function runAt(i: number): void {
    const cmd = filtered[i];
    if (!cmd) return;
    close();
    cmd.run();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(selected);
    }
    // Escape is handled centrally by the overlay stack.
  }

  function onBackdropClick(e: MouseEvent): void {
    if (e.target === backdrop) close();
  }

  function doOpen(): void {
    if (open) return;
    opener = document.activeElement as HTMLElement | null;
    commands = getCommands();
    filtered = commands;
    selected = 0;
    input.value = '';
    open = true;
    backdrop.hidden = false;
    unregister = registerOverlay(close);
    renderList();
    // Focus after the overlay is visible so the caret lands in the input.
    input.focus();
  }

  function close(): void {
    if (!open) return;
    open = false;
    backdrop.hidden = true;
    unregister?.();
    unregister = null;
    commands = [];
    filtered = [];
    rowEls = [];
    opener?.focus?.(); // restore focus (e.g. back to the editor) on close
    opener = null;
  }

  input.addEventListener('input', applyFilter);
  input.addEventListener('keydown', onKeydown);
  backdrop.addEventListener('mousedown', onBackdropClick);

  return {
    open: doOpen,
    close,
    toggle() {
      if (open) close();
      else doOpen();
    },
    get isOpen() {
      return open;
    },
  };
}
