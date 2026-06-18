// Workspace explorer tree for Koine Studio: a pure-DOM (no framework) `role=tree` widget that
// renders the nested FsEntry hierarchy of an opened folder. The data is already sorted
// (folders-first then alpha) and pre-tokenized by the platform; the explorer never parses a token.
//
// It mounts a <div class="explorer"> (the `el` field) — a toolbar (root New File / New Folder) plus
// a <ul role="tree"> — into #filetree, and re-renders on demand. Directories are collapsible; file
// rows open on click. Mutations are surfaced through the ExplorerCallbacks the integrator supplies —
// the explorer does the prompting (name input) and confirmation, but the actual fs work happens in
// the host. Dirty dot, active state and the error/warning badge mirror ide.ts/renderTree so the
// visual language stays consistent.
import type { FsEntry } from './host';

export interface ExplorerCallbacks {
  onOpenFile(fileToken: string): void;
  /** Create a file named `name` into `parentDirToken` (root folder token for the top level). */
  onNewFile(parentDirToken: string, name: string): void;
  /** Create a folder named `name` into `parentDirToken` (root folder token for the top level). */
  onNewFolder(parentDirToken: string, name: string): void;
  onRename(entry: FsEntry, newName: string): void;
  onDelete(entry: FsEntry): void;
  onDuplicate(entry: FsEntry): void;
  isActive(fileToken: string): boolean;
  isDirty(fileToken: string): boolean;
  diagCounts(fileToken: string): { errors: number; warnings: number };
}

export interface Explorer {
  /** The root <div class="explorer"> (toolbar + <ul role="tree">) to mount into #filetree. */
  el: HTMLElement;
  /** (Re)render the whole tree. `rootToken` is the opened-folder token used as the New File/Folder parent at the top level. */
  render(entries: FsEntry[], rootToken: string): void;
}

/** One context-menu action, shown in the right-click / "…" / empty-space menu. */
interface MenuAction {
  label: string;
  run(): void;
}

export function createExplorer(cb: ExplorerCallbacks): Explorer {
  // The mounted root list. Its first child is a toolbar <li> (New File / New Folder for the root);
  // the rest are treeitem rows. `role=tree` is on the <ul> so the toolbar lives outside it.
  const root = document.createElement('div');
  root.className = 'explorer';

  const toolbar = document.createElement('div');
  toolbar.className = 'explorer-toolbar';
  const newFileBtn = toolbarButton('New file', '＋', () => promptNewFile(rootToken));
  const newFolderBtn = toolbarButton('New folder', '🗀', () => promptNewFolder(rootToken));
  toolbar.append(newFileBtn, newFolderBtn);

  const tree = document.createElement('ul');
  tree.className = 'explorer-tree';
  tree.setAttribute('role', 'tree');
  tree.setAttribute('aria-label', 'Workspace files');

  root.append(toolbar, tree);

  let rootToken = '';
  // The single floating context menu, lazily mounted to document.body and reused.
  let menuEl: HTMLElement | null = null;

  // --- name prompts (v1 uses window.prompt) -----------------------------------

  // A name is one path segment: reject blanks and path separators so the host can't be tricked into
  // creating a nested path (or, for rename, a cross-directory move) from a single-name prompt.
  function cleanName(name: string | null): string | null {
    if (name == null) return null;
    const trimmed = name.trim();
    if (!trimmed) return null;
    if (trimmed.includes('/') || trimmed.includes('\\')) {
      window.alert('Name cannot contain a path separator.');
      return null;
    }
    return trimmed;
  }

  function promptNewFile(parentDirToken: string): void {
    const name = cleanName(window.prompt('New file name (e.g. orders.koi):', ''));
    if (name) cb.onNewFile(parentDirToken, name);
  }

  function promptNewFolder(parentDirToken: string): void {
    const name = cleanName(window.prompt('New folder name:', ''));
    if (name) cb.onNewFolder(parentDirToken, name);
  }

  // The directory a New File/Folder should land in for a given row: the entry itself when it is a
  // directory, otherwise its containing directory. The container is captured from the tree structure
  // at build time (`parentDir`) — never parsed out of the opaque token, which keeps the explorer
  // token-agnostic and correct regardless of the host's path separator.
  function parentDirOf(entry: FsEntry, parentDir: string): string {
    return entry.kind === 'dir' ? entry.token : parentDir;
  }

  // --- rows -------------------------------------------------------------------

  // Build one treeitem <li> for an entry, recursing into directory children. `level` drives the
  // ARIA aria-level and the visual indent; `parentDir` is the token of the containing directory
  // (the opened-folder token at the top level) so New File/Folder targets the right place.
  function buildItem(entry: FsEntry, level: number, parentDir: string): HTMLLIElement {
    const li = document.createElement('li');
    li.setAttribute('role', 'treeitem');
    li.setAttribute('aria-level', String(level));
    li.dataset.kind = entry.kind;

    const row = document.createElement('div');
    row.className = 'explorer-row';
    row.style.setProperty('--depth', String(level - 1));
    // A treeitem is the focusable unit; roving tabindex is managed by the keyboard handler.
    row.tabIndex = -1;

    const isDir = entry.kind === 'dir';

    // Twisty: an expand/collapse toggle for directories, a spacer for files (keeps names aligned).
    const twisty = document.createElement('span');
    twisty.className = 'explorer-twisty';
    twisty.setAttribute('aria-hidden', 'true');
    if (isDir) twisty.textContent = '▸';
    row.appendChild(twisty);

    const label = document.createElement('span');
    label.className = 'explorer-name';
    label.textContent = entry.name;
    row.appendChild(label);

    if (!isDir) {
      // Dirty dot — mirrors .tree-dirty in ide.ts/renderTree. Kept as a sibling of the name span
      // (not inside it) so `.explorer-name` textContent stays the bare filename.
      if (cb.isDirty(entry.token)) {
        const dot = document.createElement('span');
        dot.className = 'tree-dirty';
        dot.title = 'Unsaved changes';
        dot.textContent = '•';
        row.appendChild(dot);
      }
      if (cb.isActive(entry.token)) {
        // aria-selected expresses the active treeitem per the WAI-ARIA tree pattern; aria-current
        // on the row drives the visual highlight (mirrors ide.ts/renderTree).
        row.setAttribute('aria-current', 'true');
        li.setAttribute('aria-selected', 'true');
      }

      const { errors, warnings } = cb.diagCounts(entry.token);
      if (errors || warnings) {
        const badge = document.createElement('span');
        badge.className = errors ? 'tree-badge tree-badge-err' : 'tree-badge tree-badge-warn';
        badge.textContent = String(errors || warnings);
        badge.title = `${errors} error(s), ${warnings} warning(s)`;
        row.appendChild(badge);
      }
    }

    // Per-row "…" action button (keyboard/AT-friendly alternative to right-click).
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'explorer-more';
    more.textContent = '⋯';
    more.tabIndex = -1;
    more.setAttribute('aria-label', `Actions for ${entry.name}`);
    more.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const rect = more.getBoundingClientRect();
      openMenu(entry, parentDir, rect.left, rect.bottom);
    });
    row.appendChild(more);

    li.appendChild(row);

    if (isDir) {
      li.setAttribute('aria-expanded', 'true');
      const childList = document.createElement('ul');
      childList.className = 'explorer-children';
      childList.setAttribute('role', 'group');
      for (const child of entry.children ?? []) {
        childList.appendChild(buildItem(child, level + 1, entry.token));
      }
      li.appendChild(childList);

      twisty.addEventListener('click', (ev) => {
        ev.stopPropagation();
        toggleDir(li);
      });
      row.addEventListener('click', () => toggleDir(li));
    } else {
      row.addEventListener('click', () => cb.onOpenFile(entry.token));
    }

    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      openMenu(entry, parentDir, ev.clientX, ev.clientY);
    });
    row.addEventListener('keydown', (ev) => onRowKeydown(ev, li, entry, parentDir));
    // Store the entry + containing-dir token so keyboard nav and inline rename can recover them.
    (row as RowEl)._entry = entry;
    (row as RowEl)._li = li;
    (row as RowEl)._parentDir = parentDir;
    return li;
  }

  // Expand/collapse a directory <li> (toggles aria-expanded; CSS hides .explorer-children).
  function toggleDir(li: HTMLLIElement): void {
    const expanded = li.getAttribute('aria-expanded') === 'true';
    setExpanded(li, !expanded);
  }

  function setExpanded(li: HTMLLIElement, expanded: boolean): void {
    li.setAttribute('aria-expanded', String(expanded));
    const twisty = li.querySelector<HTMLElement>(':scope > .explorer-row > .explorer-twisty');
    if (twisty) twisty.textContent = expanded ? '▾' : '▸';
  }

  // --- keyboard navigation (WAI-ARIA tree pattern) ----------------------------

  // Every visible (not inside a collapsed ancestor) treeitem row, in DOM/visual order.
  function visibleRows(): RowEl[] {
    const out: RowEl[] = [];
    const walk = (list: HTMLElement): void => {
      for (const li of Array.from(list.children) as HTMLLIElement[]) {
        if (li.getAttribute('role') !== 'treeitem') continue;
        const row = li.querySelector<RowEl>(':scope > .explorer-row');
        if (row) out.push(row);
        if (li.dataset.kind === 'dir' && li.getAttribute('aria-expanded') === 'true') {
          const group = li.querySelector<HTMLElement>(':scope > .explorer-children');
          if (group) walk(group);
        }
      }
    };
    walk(tree);
    return out;
  }

  // Move roving focus to `row` (single tabbable row at a time, per the tree pattern).
  function focusRow(row: RowEl): void {
    for (const r of tree.querySelectorAll<HTMLElement>('.explorer-row')) r.tabIndex = -1;
    row.tabIndex = 0;
    row.focus();
  }

  function onRowKeydown(ev: KeyboardEvent, li: HTMLLIElement, entry: FsEntry, parentDir: string): void {
    const rows = visibleRows();
    const current = li.querySelector<RowEl>(':scope > .explorer-row');
    const idx = current ? rows.indexOf(current) : -1;
    const isDir = entry.kind === 'dir';

    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault();
        if (idx >= 0 && idx < rows.length - 1) focusRow(rows[idx + 1]);
        break;
      case 'ArrowUp':
        ev.preventDefault();
        if (idx > 0) focusRow(rows[idx - 1]);
        break;
      case 'ArrowRight':
        ev.preventDefault();
        if (isDir) {
          if (li.getAttribute('aria-expanded') !== 'true') setExpanded(li, true);
          else if (idx >= 0 && idx < rows.length - 1) focusRow(rows[idx + 1]);
        }
        break;
      case 'ArrowLeft':
        ev.preventDefault();
        if (isDir && li.getAttribute('aria-expanded') === 'true') {
          setExpanded(li, false);
        } else {
          // Collapse to / focus the parent treeitem.
          const parentRow = parentRowOf(li);
          if (parentRow) focusRow(parentRow);
        }
        break;
      case 'Enter':
        ev.preventDefault();
        if (isDir) toggleDir(li);
        else cb.onOpenFile(entry.token);
        break;
      case 'F2':
        ev.preventDefault();
        startRename(li, entry);
        break;
      case 'Delete':
      case 'Backspace':
        ev.preventDefault();
        confirmDelete(entry);
        break;
      case 'ContextMenu': {
        ev.preventDefault();
        const r = current?.getBoundingClientRect();
        if (r) openMenu(entry, parentDir, r.left, r.bottom);
        break;
      }
    }
  }

  function parentRowOf(li: HTMLLIElement): RowEl | null {
    const group = li.parentElement; // .explorer-children or the root tree
    if (!group || !group.classList.contains('explorer-children')) return null;
    const parentLi = group.parentElement as HTMLLIElement | null;
    if (!parentLi || parentLi.getAttribute('role') !== 'treeitem') return null;
    return parentLi.querySelector<RowEl>(':scope > .explorer-row');
  }

  // --- inline rename ----------------------------------------------------------

  // Replace the row's label with an <input> preselecting the basename. Enter/blur commits via
  // cb.onRename(entry, newName); Escape cancels and restores the label.
  function startRename(li: HTMLLIElement, entry: FsEntry): void {
    const row = li.querySelector<RowEl>(':scope > .explorer-row');
    const label = row?.querySelector<HTMLElement>('.explorer-name');
    if (!row || !label) return;
    if (row.querySelector('.explorer-rename')) return; // already renaming

    const input = document.createElement('input');
    input.className = 'explorer-rename';
    input.type = 'text';
    input.value = entry.name;
    input.setAttribute('aria-label', `Rename ${entry.name}`);
    input.spellcheck = false;
    label.replaceWith(input);

    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      const next = cleanName(input.value);
      input.replaceWith(label);
      if (commit && next && next !== entry.name) cb.onRename(entry, next);
      row.tabIndex = 0;
      row.focus();
    };

    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        ev.preventDefault();
        finish(true);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));

    input.focus();
    // Preselect the basename (the stem before the final dot) for files, the whole name for dirs.
    const dot = entry.kind === 'file' ? entry.name.lastIndexOf('.') : -1;
    input.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
  }

  // --- delete -----------------------------------------------------------------

  function confirmDelete(entry: FsEntry): void {
    const what = entry.kind === 'dir' ? 'folder (and its contents)' : 'file';
    if (window.confirm(`Delete ${what} "${entry.name}"? This cannot be undone.`)) {
      cb.onDelete(entry);
    }
  }

  // --- context menu -----------------------------------------------------------

  function closeMenu(): void {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onMenuKeydown, true);
  }

  function onDocPointerDown(ev: PointerEvent): void {
    if (menuEl && !menuEl.contains(ev.target as Node)) closeMenu();
  }

  function onMenuKeydown(ev: KeyboardEvent): void {
    if (!menuEl) return;
    const items = Array.from(menuEl.querySelectorAll<HTMLElement>('.explorer-menu-item'));
    const active = document.activeElement as HTMLElement | null;
    const i = active ? items.indexOf(active) : -1;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closeMenu();
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      items[Math.min(items.length - 1, i + 1)]?.focus();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      items[Math.max(0, i - 1)]?.focus();
    }
  }

  // Open the floating menu of actions for `entry` at viewport coords (x, y). `parentDir` is the
  // entry's containing-directory token (captured at build time), the New File/Folder target.
  function openMenu(entry: FsEntry, parentDir: string, x: number, y: number): void {
    closeMenu();
    const parent = parentDirOf(entry, parentDir);
    const actions: MenuAction[] = [
      { label: 'New File', run: () => promptNewFile(parent) },
      { label: 'New Folder', run: () => promptNewFolder(parent) },
      { label: 'Rename', run: () => renameEntryByToken(entry) },
      { label: 'Duplicate', run: () => cb.onDuplicate(entry) },
      { label: 'Delete', run: () => confirmDelete(entry) },
    ];
    spawnMenu(actions, x, y);
  }

  // Open the empty-space menu (right-click on the tree background) targeting the opened folder.
  function openRootMenu(x: number, y: number): void {
    closeMenu();
    const actions: MenuAction[] = [
      { label: 'New File', run: () => promptNewFile(rootToken) },
      { label: 'New Folder', run: () => promptNewFolder(rootToken) },
    ];
    spawnMenu(actions, x, y);
  }

  function spawnMenu(actions: MenuAction[], x: number, y: number): void {
    const menu = document.createElement('ul');
    menu.className = 'explorer-menu';
    menu.setAttribute('role', 'menu');
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    for (const action of actions) {
      const li = document.createElement('li');
      li.setAttribute('role', 'none');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'explorer-menu-item';
      btn.setAttribute('role', 'menuitem');
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        closeMenu();
        action.run();
      });
      li.appendChild(btn);
      menu.appendChild(li);
    }
    document.body.appendChild(menu);
    menuEl = menu;
    menu.querySelector<HTMLElement>('.explorer-menu-item')?.focus();
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onMenuKeydown, true);
  }

  // Locate the live <li> for an entry (by token) and start inline rename on it.
  function renameEntryByToken(entry: FsEntry): void {
    const rows = tree.querySelectorAll<RowEl>('.explorer-row');
    for (const row of rows) {
      if (row._entry?.token === entry.token && row._li) {
        startRename(row._li, entry);
        return;
      }
    }
  }

  // Right-click on the tree background (not a row) opens the root menu.
  tree.addEventListener('contextmenu', (ev) => {
    if ((ev.target as HTMLElement).closest('.explorer-row')) return;
    ev.preventDefault();
    openRootMenu(ev.clientX, ev.clientY);
  });

  // --- render -----------------------------------------------------------------

  function render(entries: FsEntry[], token: string): void {
    rootToken = token;
    closeMenu();
    tree.innerHTML = '';
    for (const entry of entries) tree.appendChild(buildItem(entry, 1, token));
    // Make the first row tabbable so the tree has a single tab stop.
    const first = tree.querySelector<HTMLElement>('.explorer-row');
    if (first) first.tabIndex = 0;
  }

  return { el: root, render };
}

// A .explorer-row carries its FsEntry and owning <li> so keyboard/menu code can recover them.
interface RowEl extends HTMLElement {
  _entry?: FsEntry;
  _li?: HTMLLIElement;
  _parentDir?: string;
}

function toolbarButton(label: string, glyph: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'explorer-tool';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.textContent = glyph;
  btn.addEventListener('click', onClick);
  return btn;
}
