// @vitest-environment jsdom
// The explorer is a focus/keyboard-heavy role=tree widget; these tests rely on jsdom's focus and
// blur semantics (and its window.prompt/confirm) — the repo default is happy-dom, so this file pins
// jsdom per-file. (The browser fs tests stay on the happy-dom default.)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FsEntry } from '@/host';
import { createExplorer, type ExplorerCallbacks } from '@/shell/explorer';

// A small two-context tree: one folder with a nested .koi file plus a top-level .koi file.
function sampleTree(): FsEntry[] {
  return [
    {
      token: 'ROOT/orders',
      name: 'orders',
      relPath: 'orders',
      kind: 'dir',
      children: [
        { token: 'ROOT/orders/order.koi', name: 'order.koi', relPath: 'orders/order.koi', kind: 'file' },
      ],
    },
    { token: 'ROOT/shared.koi', name: 'shared.koi', relPath: 'shared.koi', kind: 'file' },
  ];
}

// Fresh spy-backed callbacks; tweak the predicate returns per test as needed.
function makeCallbacks(): ExplorerCallbacks {
  return {
    onOpenFile: vi.fn(),
    onNewFile: vi.fn(),
    onNewFolder: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onDuplicate: vi.fn(),
    onMove: vi.fn(),
    isActive: vi.fn(() => false),
    isDirty: vi.fn(() => false),
    diagCounts: vi.fn(() => ({ errors: 0, warnings: 0 })),
  };
}

describe('explorer', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.useRealTimers(); // filter tests opt into fake timers to flush the input debounce
  });

  it('renders a ul[role=tree] with a collapsible folder and a nested file row', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    const treeEl = ex.el.querySelector('ul[role="tree"]');
    expect(treeEl).not.toBeNull();

    const folder = treeEl!.querySelector('li[role="treeitem"][data-kind="dir"]');
    expect(folder).not.toBeNull();
    expect(folder!.getAttribute('aria-expanded')).toBe('true');

    // The nested file lives under the folder's child group.
    const nestedFile = folder!.querySelector(
      ':scope > ul[role="group"] > li[role="treeitem"][data-kind="file"] .explorer-name',
    );
    expect(nestedFile?.textContent).toBe('order.koi');
  });

  it('opens a file when its row is clicked', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    const topFile = Array.from(ex.el.querySelectorAll<HTMLElement>('li[data-kind="file"] > .explorer-row')).find(
      (r) => r.querySelector('.explorer-name')?.textContent === 'shared.koi',
    );
    topFile!.click();

    expect(cb.onOpenFile).toHaveBeenCalledWith('ROOT/shared.koi');
  });

  it('toggles aria-expanded when a folder treeitem is clicked', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    const folder = ex.el.querySelector<HTMLElement>('li[data-kind="dir"]')!;
    const row = folder.querySelector<HTMLElement>(':scope > .explorer-row')!;
    expect(folder.getAttribute('aria-expanded')).toBe('true');

    row.click();
    expect(folder.getAttribute('aria-expanded')).toBe('false');

    row.click();
    expect(folder.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows a dirty dot for a dirty file', () => {
    const cb = makeCallbacks();
    (cb.isDirty as ReturnType<typeof vi.fn>).mockImplementation((token: string) => token === 'ROOT/shared.koi');
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    const dirtyRow = Array.from(ex.el.querySelectorAll<HTMLElement>('li[data-kind="file"] > .explorer-row')).find(
      (r) => r.querySelector('.explorer-name')?.textContent?.startsWith('shared.koi'),
    );
    expect(dirtyRow!.querySelector('.tree-dirty')).not.toBeNull();
  });

  it('shows an error badge for a file with diagnostics errors', () => {
    const cb = makeCallbacks();
    (cb.diagCounts as ReturnType<typeof vi.fn>).mockImplementation((token: string) =>
      token === 'ROOT/orders/order.koi' ? { errors: 2, warnings: 0 } : { errors: 0, warnings: 0 },
    );
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    const errRow = Array.from(ex.el.querySelectorAll<HTMLElement>('li[data-kind="file"] > .explorer-row')).find(
      (r) => r.querySelector('.explorer-name')?.textContent === 'order.koi',
    );
    const badge = errRow!.querySelector('.tree-badge');
    expect(badge).not.toBeNull();
    expect(badge!.classList.contains('tree-badge-err')).toBe(true);
    expect(badge!.textContent).toBe('2');
  });

  it('marks the active file with aria-current', () => {
    const cb = makeCallbacks();
    (cb.isActive as ReturnType<typeof vi.fn>).mockImplementation((token: string) => token === 'ROOT/shared.koi');
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    const activeRow = Array.from(ex.el.querySelectorAll<HTMLElement>('li[data-kind="file"] > .explorer-row')).find(
      (r) => r.querySelector('.explorer-name')?.textContent === 'shared.koi',
    );
    expect(activeRow!.getAttribute('aria-current')).toBe('true');
  });

  it('creates a top-level file via the toolbar, passing the root token and typed name', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    // The first .explorer-tool is "New file" — clicking it opens an inline new-row input.
    ex.el.querySelector<HTMLElement>('.explorer-toolbar .explorer-tool')!.click();
    commitCreate(ex, 'catalog.koi');
    expect(cb.onNewFile).toHaveBeenCalledWith('ROOT', 'catalog.koi');
  });

  it('starts inline rename on F2 and commits the new name on Enter', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    const fileRow = Array.from(ex.el.querySelectorAll<HTMLElement>('li[data-kind="file"] > .explorer-row')).find(
      (r) => r.querySelector('.explorer-name')?.textContent === 'shared.koi',
    )!;
    fileRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));

    const input = fileRow.querySelector<HTMLInputElement>('.explorer-rename')!;
    expect(input).not.toBeNull();
    input.value = 'common.koi';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    const renamed = (cb.onRename as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(renamed[0].token).toBe('ROOT/shared.koi');
    expect(renamed[1]).toBe('common.koi');
  });

  it('shows an in-pane confirm before deleting on the Delete key, then deletes on confirm', async () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    const fileRow = Array.from(ex.el.querySelectorAll<HTMLElement>('li[data-kind="file"] > .explorer-row')).find(
      (r) => r.querySelector('.explorer-name')?.textContent === 'shared.koi',
    )!;
    fileRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));

    expect(confirmShown()).toBe(true);
    expect(cb.onDelete).not.toHaveBeenCalled(); // not until confirmed

    document.querySelector<HTMLElement>('.explorer-confirm-btn-danger')!.click();
    await flush();
    expect((cb.onDelete as ReturnType<typeof vi.fn>).mock.calls[0][0].token).toBe('ROOT/shared.koi');
    expect(confirmShown()).toBe(false); // dialog dismissed
  });

  it('cancels the in-pane delete confirm without deleting', async () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    fileRow(ex, 'shared.koi').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    const cancel = Array.from(document.querySelectorAll<HTMLElement>('.explorer-confirm-btn')).find(
      (b) => b.textContent === 'Cancel',
    )!;
    cancel.click();
    await flush();
    expect(cb.onDelete).not.toHaveBeenCalled();
    expect(confirmShown()).toBe(false);
  });

  it('opens a context menu on right-click with the expected actions', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    const folderRow = ex.el.querySelector<HTMLElement>('li[data-kind="dir"] > .explorer-row')!;
    folderRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));

    const menu = document.querySelector('.explorer-menu[role="menu"]');
    expect(menu).not.toBeNull();
    const labels = Array.from(menu!.querySelectorAll('.explorer-menu-item')).map((b) => b.textContent);
    expect(labels).toEqual(['New File', 'New Folder', 'Rename', 'Duplicate', 'Delete']);
  });

  // --- helpers for the added cases ------------------------------------------
  function fileRow(ex: { el: HTMLElement }, name: string): HTMLElement {
    return Array.from(ex.el.querySelectorAll<HTMLElement>('li[data-kind="file"] > .explorer-row')).find(
      (r) => r.querySelector('.explorer-name')?.textContent === name,
    )!;
  }
  function dirRow(ex: { el: HTMLElement }): HTMLElement {
    return ex.el.querySelector<HTMLElement>('li[data-kind="dir"] > .explorer-row')!;
  }
  function clickMenuItem(label: string): void {
    const item = Array.from(document.querySelectorAll<HTMLElement>('.explorer-menu-item')).find(
      (b) => b.textContent === label,
    )!;
    item.click();
  }
  // Drive the inline new-file/new-folder input that beginCreate inserts: type `value` and press Enter.
  function commitCreate(ex: { el: HTMLElement }, value: string): void {
    const input = ex.el.querySelector<HTMLInputElement>('.explorer-create .explorer-rename')!;
    expect(input).not.toBeNull();
    input.value = value;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
  // Let a pending microtask (e.g. the confirm dialog's Promise → onDelete) settle.
  function flush(): Promise<void> {
    return new Promise((r) => setTimeout(r, 0));
  }
  // The confirm dialog is the shared createModal chrome: a .koi-modal-backdrop that is hidden when
  // closed. It's shown iff the backdrop is present and not hidden.
  function confirmShown(): boolean {
    const bd = document.querySelector<HTMLElement>('.koi-modal-backdrop');
    return !!bd && !bd.hidden;
  }

  it('sets aria-selected on the active treeitem', () => {
    const cb = makeCallbacks();
    (cb.isActive as ReturnType<typeof vi.fn>).mockImplementation((t: string) => t === 'ROOT/shared.koi');
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    const li = fileRow(ex, 'shared.koi').closest('li[role="treeitem"]')!;
    expect(li.getAttribute('aria-selected')).toBe('true');
  });

  it('New File from a nested file row targets its containing directory', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    fileRow(ex, 'order.koi').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
    clickMenuItem('New File');
    commitCreate(ex, 'extra.koi');
    expect(cb.onNewFile).toHaveBeenCalledWith('ROOT/orders', 'extra.koi');
  });

  it('New File from a top-level file row falls back to the root token', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    fileRow(ex, 'shared.koi').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
    clickMenuItem('New File');
    commitCreate(ex, 'extra.koi');
    expect(cb.onNewFile).toHaveBeenCalledWith('ROOT', 'extra.koi');
  });

  it('New Folder from a directory row targets that directory', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    dirRow(ex).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
    clickMenuItem('New Folder');
    commitCreate(ex, 'sub');
    expect(cb.onNewFolder).toHaveBeenCalledWith('ROOT/orders', 'sub');
  });

  it('menu Duplicate and Delete invoke their callbacks', async () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    fileRow(ex, 'shared.koi').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
    clickMenuItem('Duplicate');
    expect((cb.onDuplicate as ReturnType<typeof vi.fn>).mock.calls[0][0].token).toBe('ROOT/shared.koi');

    fileRow(ex, 'shared.koi').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
    clickMenuItem('Delete');
    document.querySelector<HTMLElement>('.explorer-confirm-btn-danger')!.click();
    await flush();
    expect((cb.onDelete as ReturnType<typeof vi.fn>).mock.calls[0][0].token).toBe('ROOT/shared.koi');
  });

  it('ArrowDown moves focus to the next visible row and Enter opens a file', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    const folder = dirRow(ex);
    folder.tabIndex = 0;
    folder.focus();
    folder.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    // Next visible row is the nested order.koi (folder is expanded).
    const focused = document.activeElement as HTMLElement;
    expect(focused.querySelector('.explorer-name')?.textContent).toBe('order.koi');

    focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(cb.onOpenFile).toHaveBeenCalledWith('ROOT/orders/order.koi');
  });

  it('Escape cancels inline rename without calling onRename', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    const row = fileRow(ex, 'shared.koi');
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
    const input = row.querySelector<HTMLInputElement>('.explorer-rename')!;
    input.value = 'whatever.koi';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(cb.onRename).not.toHaveBeenCalled();
    expect(row.querySelector('.explorer-rename')).toBeNull(); // label restored
  });

  it('right-clicking empty tree space opens the root New File / New Folder menu', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    const tree = ex.el.querySelector<HTMLElement>('ul[role="tree"]')!;
    tree.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 1, clientY: 1 }));
    const labels = Array.from(document.querySelectorAll('.explorer-menu-item')).map((b) => b.textContent);
    expect(labels).toEqual(['New File', 'New Folder']);
  });

  it('keeps a collapsed folder collapsed across a re-render', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    const li = ex.el.querySelector<HTMLElement>('li[data-kind="dir"]')!;
    expect(li.getAttribute('aria-expanded')).toBe('true');
    dirRow(ex).click(); // collapse
    expect(li.getAttribute('aria-expanded')).toBe('false');

    // A diagnostics push re-renders the whole tree; the folder must stay collapsed.
    ex.render(sampleTree(), 'ROOT');
    expect(ex.el.querySelector('li[data-kind="dir"]')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('focuses the treeitem <li> (not a bare row) on keyboard navigation', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    const folderLi = dirRow(ex).closest('li')!;
    folderLi.tabIndex = 0;
    folderLi.focus();
    dirRow(ex).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const active = document.activeElement as HTMLElement;
    expect(active.getAttribute('role')).toBe('treeitem');
    expect(active.querySelector('.explorer-name')?.textContent).toBe('order.koi');
  });

  it('does not delete on Backspace', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    fileRow(ex, 'shared.koi').dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    expect(cb.onDelete).not.toHaveBeenCalled();
  });

  it('defers a re-render while an inline rename is in progress (no teardown / no spurious commit)', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    const row = fileRow(ex, 'shared.koi');
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
    const input = row.querySelector<HTMLInputElement>('.explorer-rename')!;
    input.value = 'ren'; // half-typed, not yet committed

    // A diagnostics push re-renders mid-edit; it must be deferred, not tear the input down.
    ex.render(sampleTree(), 'ROOT');
    expect(document.querySelector('.explorer-rename')).not.toBeNull();
    expect(cb.onRename).not.toHaveBeenCalled();

    // Committing the rename replays the deferred render with the fresh tree.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect((cb.onRename as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('ren');
    expect(document.querySelector('.explorer-rename')).toBeNull();
  });

  it('does not double-fire keydown through nested treeitem ancestors', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    const nested: FsEntry[] = [
      {
        token: 'R/a',
        name: 'a',
        relPath: 'a',
        kind: 'dir',
        children: [
          { token: 'R/a/a1.koi', name: 'a1.koi', relPath: 'a/a1.koi', kind: 'file' },
          { token: 'R/a/a2.koi', name: 'a2.koi', relPath: 'a/a2.koi', kind: 'file' },
        ],
      },
      { token: 'R/b.koi', name: 'b.koi', relPath: 'b.koi', kind: 'file' },
    ];
    ex.render(nested, 'R');

    const a1 = Array.from(ex.el.querySelectorAll<HTMLElement>('li[data-kind="file"]')).find(
      (li) => li.dataset.token === 'R/a/a1.koi',
    )!;
    a1.tabIndex = 0;
    a1.focus();
    // ArrowDown on the nested a1 must land on a2 — not be overridden by the ancestor dir's handler
    // re-running and snapping focus back up.
    a1.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect((document.activeElement as HTMLElement).dataset.token).toBe('R/a/a2.koi');
  });

  // --- icons -----------------------------------------------------------------

  it('marks .koi files with the koi context icon and folders with a folder icon', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    const fileIcon = fileRow(ex, 'shared.koi').querySelector('.explorer-icon');
    expect(fileIcon?.classList.contains('explorer-icon--koi')).toBe(true);
    expect(fileIcon?.querySelector('svg')).not.toBeNull();

    const dirIcon = dirRow(ex).querySelector('.explorer-icon');
    expect(dirIcon?.classList.contains('explorer-icon--dir')).toBe(true);
    expect(dirIcon?.querySelector('svg')).not.toBeNull();
  });

  // --- filter ----------------------------------------------------------------

  // The filter input is debounced, so each filter test enables fake timers and this flushes them.
  function setFilter(ex: { el: HTMLElement }, value: string): void {
    const input = ex.el.querySelector<HTMLInputElement>('.explorer-filter')!;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(150);
  }
  function visibleNames(ex: { el: HTMLElement }): string[] {
    return Array.from(ex.el.querySelectorAll<HTMLElement>('.explorer-tree .explorer-name')).map(
      (n) => n.textContent ?? '',
    );
  }

  it('filters to matching entries, revealing ancestor folders, and counts files + folders', () => {
    vi.useFakeTimers();
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    setFilter(ex, 'order');
    const names = visibleNames(ex);
    expect(names).toContain('orders'); // folder 'orders' matches by name
    expect(names).toContain('order.koi'); // file 'order.koi' matches
    expect(names).not.toContain('shared.koi'); // non-match hidden
    // Both the folder 'orders' and the file 'order.koi' match → 2.
    expect(ex.el.querySelector('.explorer-filter-count')?.textContent).toBe('2 matches');
  });

  it('reveals a name-matched folder’s contents and counts the folder (never "0 matches" beside it)', () => {
    vi.useFakeTimers();
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    // 'orders' matches the folder name but no file name (order.koi does not contain "orders").
    setFilter(ex, 'orders');
    const names = visibleNames(ex);
    expect(names).toContain('orders'); // the matched folder
    expect(names).toContain('order.koi'); // its child revealed (folder isn't shown empty)
    expect(ex.el.querySelector('.explorer-filter-count')?.textContent).toBe('1 match');
  });

  it('shows a no-match empty state and clears the filter on Escape', () => {
    vi.useFakeTimers();
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    setFilter(ex, 'zzz-nothing');
    expect(ex.el.querySelector('.explorer-empty')).not.toBeNull();
    expect(visibleNames(ex)).toEqual([]);

    const input = ex.el.querySelector<HTMLInputElement>('.explorer-filter')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(visibleNames(ex)).toContain('shared.koi'); // tree restored
  });

  // --- collapse all ----------------------------------------------------------

  it('collapse-all collapses every directory, expand-all re-opens them', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    const dir = () => ex.el.querySelector('li[data-kind="dir"]')!;
    expect(dir().getAttribute('aria-expanded')).toBe('true');

    ex.el.querySelector<HTMLElement>('.explorer-tool[aria-label="Collapse all"]')!.click();
    expect(dir().getAttribute('aria-expanded')).toBe('false');

    ex.el.querySelector<HTMLElement>('.explorer-tool[aria-label="Expand all"]')!.click();
    expect(dir().getAttribute('aria-expanded')).toBe('true');
  });

  it('prunes stale collapsed-state so a folder reusing an old token is not wrongly collapsed', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    dirRow(ex).click(); // collapse orders/
    expect(ex.el.querySelector('li[data-kind="dir"]')!.getAttribute('aria-expanded')).toBe('false');

    // orders/ disappears (deleted) — its token must be pruned from the collapsed set...
    ex.render([{ token: 'ROOT/shared.koi', name: 'shared.koi', relPath: 'shared.koi', kind: 'file' }], 'ROOT');
    // ...so a new folder reusing the same token renders EXPANDED, not stuck-collapsed.
    ex.render(sampleTree(), 'ROOT');
    expect(ex.el.querySelector('li[data-kind="dir"]')!.getAttribute('aria-expanded')).toBe('true');
  });

  // --- empty state -----------------------------------------------------------

  it('renders an empty state whose New file action creates at the root', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render([], 'ROOT');

    const action = ex.el.querySelector<HTMLElement>('.explorer-empty-action');
    expect(action).not.toBeNull();
    action!.click();
    commitCreate(ex, 'first.koi');
    expect(cb.onNewFile).toHaveBeenCalledWith('ROOT', 'first.koi');
  });

  // --- inline create ---------------------------------------------------------

  it('cancels an inline create on Escape without creating', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    ex.el.querySelector<HTMLElement>('.explorer-toolbar .explorer-tool')!.click(); // New file
    const input = ex.el.querySelector<HTMLInputElement>('.explorer-create .explorer-rename')!;
    input.value = 'scrap.koi';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(cb.onNewFile).not.toHaveBeenCalled();
    expect(ex.el.querySelector('.explorer-create')).toBeNull();
  });

  it('discards an invalid rename on blur and unblocks re-renders (no stuck `renaming`)', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    const row = fileRow(ex, 'shared.koi');
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
    const input = row.querySelector<HTMLInputElement>('.explorer-rename')!;
    input.value = 'bad/name';
    input.dispatchEvent(new Event('blur')); // Tab/click away with an invalid name

    expect(cb.onRename).not.toHaveBeenCalled();
    expect(ex.el.querySelector('.explorer-rename')).toBeNull(); // input discarded, label restored

    // `renaming` must have cleared: a subsequent render is NOT deferred, so a freshly-dirtied file
    // picks up its dirty dot. (If renaming were stuck, this render would be queued and never applied.)
    (cb.isDirty as ReturnType<typeof vi.fn>).mockImplementation((t: string) => t === 'ROOT/shared.koi');
    ex.render(sampleTree(), 'ROOT');
    expect(fileRow(ex, 'shared.koi').querySelector('.tree-dirty')).not.toBeNull();
  });

  it('keeps an inline create open and flags an invalid name instead of creating', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    ex.el.querySelector<HTMLElement>('.explorer-toolbar .explorer-tool')!.click(); // New file
    const input = ex.el.querySelector<HTMLInputElement>('.explorer-create .explorer-rename')!;
    input.value = 'bad/name';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(cb.onNewFile).not.toHaveBeenCalled();
    expect(input.classList.contains('is-invalid')).toBe(true);
    expect(ex.el.querySelector('.explorer-create')).not.toBeNull(); // still open to fix
  });

  // --- drag-and-drop move ----------------------------------------------------

  function fireDrag(el: HTMLElement, type: string): void {
    el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  }

  it('moves an entry into a directory via drag-and-drop', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    fireDrag(fileRow(ex, 'shared.koi'), 'dragstart');
    fireDrag(dirRow(ex), 'dragover');
    fireDrag(dirRow(ex), 'drop');

    const call = (cb.onMove as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0].token).toBe('ROOT/shared.koi');
    expect(call[1]).toBe('ROOT/orders');
  });

  it('defers a re-render while a drag is in progress so drop-validity checks stay valid', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    const shared = fileRow(ex, 'shared.koi');
    const draggedLi = shared.closest('li');
    fireDrag(shared, 'dragstart');

    // A diagnostics push mid-drag must be deferred — NOT rebuild the tree (which would detach dragLi
    // and bypass the DOM-containment drop guards).
    ex.render(sampleTree(), 'ROOT');
    expect(fileRow(ex, 'shared.koi').closest('li')).toBe(draggedLi); // same node, not rebuilt

    // Drop still validates against the live dragLi and fires the move.
    fireDrag(dirRow(ex), 'dragover');
    fireDrag(dirRow(ex), 'drop');
    expect((cb.onMove as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('ROOT/orders');

    fireDrag(shared, 'dragend'); // replays the deferred render
  });

  it('rejects a drag-drop back into the same parent directory (no-op)', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    fireDrag(fileRow(ex, 'order.koi'), 'dragstart'); // already inside orders/
    fireDrag(dirRow(ex), 'drop');
    expect(cb.onMove).not.toHaveBeenCalled();
  });

  it('dropping onto a FILE row moves into that file’s containing directory (no dead zone)', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    fireDrag(fileRow(ex, 'shared.koi'), 'dragstart'); // top-level file
    fireDrag(fileRow(ex, 'order.koi'), 'drop'); // onto a file inside orders/

    const call = (cb.onMove as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0].token).toBe('ROOT/shared.koi');
    expect(call[1]).toBe('ROOT/orders'); // routed to the file's parent directory, not a no-op
  });

  // --- reveal active ---------------------------------------------------------

  it('expands a collapsed ancestor to reveal a newly-active file, but respects a later manual collapse', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    dirRow(ex).click(); // collapse orders/
    expect(ex.el.querySelector('li[data-kind="dir"]')!.getAttribute('aria-expanded')).toBe('false');

    // order.koi becomes active; a re-render auto-reveals it by re-expanding orders/.
    (cb.isActive as ReturnType<typeof vi.fn>).mockImplementation((t: string) => t === 'ROOT/orders/order.koi');
    ex.render(sampleTree(), 'ROOT');
    expect(ex.el.querySelector('li[data-kind="dir"]')!.getAttribute('aria-expanded')).toBe('true');

    // The user collapses again; a diagnostics re-render with the SAME active file must not fight them.
    dirRow(ex).click();
    ex.render(sampleTree(), 'ROOT');
    expect(ex.el.querySelector('li[data-kind="dir"]')!.getAttribute('aria-expanded')).toBe('false');
  });

  // --- reveal by context (cross-axis "Reveal in Files", #453) ----------------

  it('revealByContext expands the ancestor folder and highlights the matching .koi file', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    dirRow(ex).click(); // collapse orders/ so the target is hidden
    expect(ex.el.querySelector('li[data-kind="dir"]')!.getAttribute('aria-expanded')).toBe('false');

    // The 'Order' bounded context lives in orders/order.koi — reveal it by context name (case-insensitive
    // stem match): the ancestor folder re-expands and the file row is marked revealed.
    ex.revealByContext('Order');
    expect(ex.el.querySelector('li[data-kind="dir"]')!.getAttribute('aria-expanded')).toBe('true');
    expect(fileRow(ex, 'order.koi').classList.contains('is-revealed')).toBe(true);
  });

  it('revealByContext is a no-op for a context with no matching .koi file', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    expect(() => ex.revealByContext('Nonexistent')).not.toThrow();
    expect(ex.el.querySelector('.explorer-row.is-revealed')).toBeNull();
  });

  // --- multi-root groups (Task 3) -------------------------------------------

  // A second workspace root, structurally like sampleTree() but under a different folder token.
  function secondTree(): FsEntry[] {
    return [
      {
        token: 'OTHER/catalog',
        name: 'catalog',
        relPath: 'catalog',
        kind: 'dir',
        children: [
          { token: 'OTHER/catalog/item.koi', name: 'item.koi', relPath: 'catalog/item.koi', kind: 'file' },
        ],
      },
      { token: 'OTHER/billing.koi', name: 'billing.koi', relPath: 'billing.koi', kind: 'file' },
    ];
  }

  it('single-root render produces NO group header (entries stay direct tree children)', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.renderRoots([{ root: 'ROOT', entries: sampleTree() }]);

    // No group-header chrome for a single root.
    expect(ex.el.querySelector('.explorer-group-header')).toBeNull();
    // The top-level rows are STILL direct <li role=treeitem> children of <ul role=tree>.
    const tree = ex.el.querySelector('ul[role="tree"]')!;
    const topItems = Array.from(tree.children).filter((c) => c.getAttribute('role') === 'treeitem');
    expect(topItems.length).toBe(2);
    expect(tree.querySelector(':scope > li[role="treeitem"][data-kind="dir"]')).not.toBeNull();
  });

  it('renders one group header per root, labeled by the folder name, for 2+ roots', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.renderRoots([
      { root: '/home/me/sales', entries: sampleTree() },
      { root: '/home/me/billing', entries: secondTree() },
    ]);

    const headers = Array.from(ex.el.querySelectorAll<HTMLElement>('.explorer-group-header'));
    expect(headers.length).toBe(2);
    const names = headers.map((h) => h.querySelector('.explorer-group-name')?.textContent);
    expect(names).toEqual(['sales', 'billing']);

    // Each group still shows its own file rows.
    const allNames = Array.from(ex.el.querySelectorAll<HTMLElement>('.explorer-name')).map((n) => n.textContent);
    expect(allNames).toContain('order.koi');
    expect(allNames).toContain('item.koi');
  });

  it('clicking the "Add folder" affordance invokes onAddRoot', () => {
    const cb = makeCallbacks();
    const onAddRoot = vi.fn();
    const ex = createExplorer({ ...cb, onAddRoot });
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    const addBtn = ex.el.querySelector<HTMLElement>('.explorer-add-root');
    expect(addBtn).not.toBeNull();
    addBtn!.click();
    expect(onAddRoot).toHaveBeenCalledTimes(1);
  });

  it("clicking a group's Remove affordance invokes onRemoveRoot with that group's root", () => {
    const cb = makeCallbacks();
    const onRemoveRoot = vi.fn();
    const ex = createExplorer({ ...cb, onRemoveRoot });
    document.body.appendChild(ex.el);
    ex.renderRoots([
      { root: '/home/me/sales', entries: sampleTree() },
      { root: '/home/me/billing', entries: secondTree() },
    ]);

    const removeBtns = Array.from(ex.el.querySelectorAll<HTMLElement>('.explorer-group-remove'));
    expect(removeBtns.length).toBe(2);
    // The second group's Remove targets the second root.
    removeBtns[1].click();
    expect(onRemoveRoot).toHaveBeenCalledTimes(1);
    expect(onRemoveRoot).toHaveBeenCalledWith('/home/me/billing');
  });

  it("a group's New File targets THAT group's root (multi-root create routing)", () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.renderRoots([
      { root: '/home/me/sales', entries: sampleTree() },
      { root: '/home/me/billing', entries: secondTree() },
    ]);

    // Right-click a top-level FILE in the SECOND group → New File falls back to that group's root.
    const billingRow = Array.from(ex.el.querySelectorAll<HTMLElement>('li[data-kind="file"] > .explorer-row')).find(
      (r) => r.querySelector('.explorer-name')?.textContent === 'billing.koi',
    )!;
    billingRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
    const item = Array.from(document.querySelectorAll<HTMLElement>('.explorer-menu-item')).find(
      (b) => b.textContent === 'New File',
    )!;
    item.click();
    const input = ex.el.querySelector<HTMLInputElement>('.explorer-create .explorer-rename')!;
    input.value = 'extra.koi';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(cb.onNewFile).toHaveBeenCalledWith('/home/me/billing', 'extra.koi');
  });

  it("toolbar New File on the primary root mounts the inline-create row INSIDE that root's group (multi-root)", () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.renderRoots([
      { root: '/home/me/sales', entries: sampleTree() },
      { root: '/home/me/billing', entries: secondTree() },
    ]);

    // The toolbar "New file" button targets the PRIMARY (first) root.
    ex.el.querySelector<HTMLElement>('.explorer-toolbar .explorer-tool')!.click();

    const createRow = ex.el.querySelector<HTMLElement>('.explorer-create');
    expect(createRow).not.toBeNull();
    const createLi = createRow!.closest('li.explorer-create-li')!;

    // The transient row must live inside the PRIMARY group's items list — not detached above it as a
    // direct child of <ul.explorer-tree> (the multi-root mis-mount this fixes).
    const primaryItems = ex.el.querySelector<HTMLElement>(
      '.explorer-group[data-root="/home/me/sales"] > .explorer-group-items',
    );
    expect(primaryItems).not.toBeNull();
    expect(createLi.parentElement).toBe(primaryItems);

    const tree = ex.el.querySelector('ul[role="tree"]')!;
    expect(Array.from(tree.children)).not.toContain(createLi);

    // The created file still lands under the primary root token.
    commitCreate(ex, 'catalog.koi');
    expect(cb.onNewFile).toHaveBeenCalledWith('/home/me/sales', 'catalog.koi');
  });

  it('toolbar New File in single-root mode mounts the create row directly in the tree (no group)', () => {
    const cb = makeCallbacks();
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.renderRoots([{ root: 'ROOT', entries: sampleTree() }]);

    ex.el.querySelector<HTMLElement>('.explorer-toolbar .explorer-tool')!.click();

    // Single-root render is headerless (no group wrapper), so the create row stays a direct tree child.
    expect(ex.el.querySelector('.explorer-group')).toBeNull();
    const createLi = ex.el.querySelector<HTMLElement>('.explorer-create')!.closest('li.explorer-create-li')!;
    const tree = ex.el.querySelector('ul[role="tree"]')!;
    expect(createLi.parentElement).toBe(tree);
  });
});
