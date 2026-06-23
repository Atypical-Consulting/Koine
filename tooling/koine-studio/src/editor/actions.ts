// Lightweight in-editor floating widgets shared by the refactor/quick-fix surfaces:
//   • showActionMenu  — a keyboard-navigable popup list (code actions, references)
//   • showRenameInput — an inline single-field editor (rename symbol)
// Both anchor to a CodeMirror document offset via view.coordsAtPos and live as fixed-position
// DOM on document.body. Only one floating widget is open at a time; opening one (or an outside
// click, Esc, scroll, or editor blur) dismisses any previous one. Styling lives in styles.css
// (.koi-action-menu / .koi-rename) and themes via the same CSS variables as the rest of the UI.
import type { EditorView } from '@codemirror/view';

/** One row of an action menu: a label, an optional muted detail, and what running it does. */
export interface MenuItem {
  label: string;
  detail?: string;
  run: () => void;
}

let activeEl: HTMLElement | null = null;
let activeCleanup: (() => void) | null = null;

/** Dismiss whatever floating widget is currently open (no-op when none). */
export function dismissFloating(): void {
  if (activeCleanup) activeCleanup();
  activeCleanup = null;
  if (activeEl && activeEl.parentNode) activeEl.parentNode.removeChild(activeEl);
  activeEl = null;
}

/** Anchor a fixed-position element just below the editor coordinate of `pos`, clamped on screen. */
function placeAt(view: EditorView, pos: number, el: HTMLElement, width = 320): void {
  const coords = view.coordsAtPos(pos);
  const left = coords ? coords.left : 120;
  const top = coords ? coords.bottom + 4 : 120;
  el.style.position = 'fixed';
  el.style.left = Math.max(8, Math.min(left, window.innerWidth - width - 8)) + 'px';
  el.style.top = Math.min(top, window.innerHeight - 80) + 'px';
}

/**
 * Wire the shared dismissal triggers (outside mousedown, Esc, editor scroll/blur) for a freshly
 * opened widget and register it as the active one. The mousedown listener is attached on the next
 * frame so the click that opened the widget does not immediately close it.
 */
function registerActive(view: EditorView, el: HTMLElement, onEsc?: () => void): void {
  dismissFloating();
  document.body.appendChild(el);
  activeEl = el;

  const onDocMouseDown = (e: MouseEvent) => {
    if (activeEl && !activeEl.contains(e.target as Node)) dismissFloating();
  };
  const onScroll = () => dismissFloating();
  const scroller = view.scrollDOM;
  const id = setTimeout(() => document.addEventListener('mousedown', onDocMouseDown, true), 0);
  scroller.addEventListener('scroll', onScroll, { passive: true });

  activeCleanup = () => {
    clearTimeout(id);
    document.removeEventListener('mousedown', onDocMouseDown, true);
    scroller.removeEventListener('scroll', onScroll);
  };

  void onEsc; // Esc handled per-widget below (menus vs input differ); kept for symmetry.
}

/**
 * Show a popup menu of `items` anchored at document offset `pos`. Arrow keys move the selection,
 * Enter runs it, Esc/outside-click dismisses. Running an item dismisses the menu first. When
 * `items` is empty an `emptyText` note is shown briefly instead.
 */
export function showActionMenu(
  view: EditorView,
  pos: number,
  items: MenuItem[],
  opts: { emptyText?: string } = {},
): void {
  const menu = document.createElement('div');
  menu.className = 'koi-action-menu';
  menu.setAttribute('role', 'menu');
  menu.tabIndex = -1;

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'koi-action-empty';
    empty.textContent = opts.emptyText ?? 'No actions available.';
    menu.appendChild(empty);
    placeAt(view, pos, menu);
    registerActive(view, menu);
    // Auto-dismiss the empty note after a moment.
    const t = setTimeout(dismissFloating, 1400);
    const prev = activeCleanup;
    activeCleanup = () => {
      clearTimeout(t);
      prev?.();
    };
    return;
  }

  let selected = 0;
  const rows: HTMLButtonElement[] = [];

  const select = (i: number) => {
    selected = (i + items.length) % items.length;
    rows.forEach((r, idx) => r.setAttribute('aria-selected', String(idx === selected)));
    rows[selected]?.scrollIntoView({ block: 'nearest' });
  };

  const runAt = (i: number) => {
    const item = items[i];
    dismissFloating();
    item.run();
  };

  items.forEach((item, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'koi-action-row';
    row.setAttribute('role', 'menuitem');

    const label = document.createElement('span');
    label.className = 'koi-action-label';
    label.textContent = item.label;
    row.appendChild(label);

    if (item.detail) {
      const detail = document.createElement('span');
      detail.className = 'koi-action-detail';
      detail.textContent = item.detail;
      row.appendChild(detail);
    }

    row.addEventListener('mouseenter', () => select(i));
    row.addEventListener('click', () => runAt(i));
    rows.push(row);
    menu.appendChild(row);
  });

  menu.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      select(selected + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      select(selected - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(selected);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      dismissFloating();
      view.focus();
    }
  });

  placeAt(view, pos, menu);
  registerActive(view, menu);
  select(0);
  menu.focus();
}

/**
 * Show an inline rename field anchored at document offset `anchorPos`, pre-filled with
 * `placeholder` (selected). Enter submits a non-empty, changed name via `onSubmit`; Esc/outside
 * click cancels. The field dismisses itself before invoking `onSubmit`.
 */
export function showRenameInput(
  view: EditorView,
  anchorPos: number,
  placeholder: string,
  onSubmit: (newName: string) => void,
): void {
  const box = document.createElement('div');
  box.className = 'koi-rename';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'koi-rename-input';
  input.value = placeholder;
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Rename symbol');
  box.appendChild(input);

  const hint = document.createElement('span');
  hint.className = 'koi-rename-hint';
  hint.textContent = '↵ rename · esc cancel';
  box.appendChild(hint);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const value = input.value.trim();
      dismissFloating();
      view.focus();
      if (value && value !== placeholder) onSubmit(value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      dismissFloating();
      view.focus();
    }
  });

  placeAt(view, anchorPos, box, 260);
  registerActive(view, box);
  input.focus();
  input.select();
}
