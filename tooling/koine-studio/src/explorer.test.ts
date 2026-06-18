import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FsEntry } from './host';
import { createExplorer, type ExplorerCallbacks } from './explorer';

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
    isActive: vi.fn(() => false),
    isDirty: vi.fn(() => false),
    diagCounts: vi.fn(() => ({ errors: 0, warnings: 0 })),
  };
}

describe('explorer', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
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

  it('creates a top-level file via the toolbar, passing the root token and prompted name', () => {
    const cb = makeCallbacks();
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('catalog.koi');
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    ex.el.querySelector<HTMLElement>('.explorer-toolbar .explorer-tool')!.click();
    expect(cb.onNewFile).toHaveBeenCalledWith('ROOT', 'catalog.koi');
    promptSpy.mockRestore();
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

  it('confirms before deleting on the Delete key', () => {
    const cb = makeCallbacks();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    const fileRow = Array.from(ex.el.querySelectorAll<HTMLElement>('li[data-kind="file"] > .explorer-row')).find(
      (r) => r.querySelector('.explorer-name')?.textContent === 'shared.koi',
    )!;
    fileRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));

    expect(confirmSpy).toHaveBeenCalled();
    expect((cb.onDelete as ReturnType<typeof vi.fn>).mock.calls[0][0].token).toBe('ROOT/shared.koi');
    confirmSpy.mockRestore();
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
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('extra.koi');
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    fileRow(ex, 'order.koi').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
    clickMenuItem('New File');
    expect(cb.onNewFile).toHaveBeenCalledWith('ROOT/orders', 'extra.koi');
    promptSpy.mockRestore();
  });

  it('New File from a top-level file row falls back to the root token', () => {
    const cb = makeCallbacks();
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('extra.koi');
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    fileRow(ex, 'shared.koi').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
    clickMenuItem('New File');
    expect(cb.onNewFile).toHaveBeenCalledWith('ROOT', 'extra.koi');
    promptSpy.mockRestore();
  });

  it('New Folder from a directory row targets that directory', () => {
    const cb = makeCallbacks();
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('sub');
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    dirRow(ex).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
    clickMenuItem('New Folder');
    expect(cb.onNewFolder).toHaveBeenCalledWith('ROOT/orders', 'sub');
    promptSpy.mockRestore();
  });

  it('menu Duplicate and Delete invoke their callbacks', () => {
    const cb = makeCallbacks();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const ex = createExplorer(cb);
    document.body.appendChild(ex.el);
    ex.render(sampleTree(), 'ROOT');

    fileRow(ex, 'shared.koi').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
    clickMenuItem('Duplicate');
    expect((cb.onDuplicate as ReturnType<typeof vi.fn>).mock.calls[0][0].token).toBe('ROOT/shared.koi');

    fileRow(ex, 'shared.koi').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
    clickMenuItem('Delete');
    expect((cb.onDelete as ReturnType<typeof vi.fn>).mock.calls[0][0].token).toBe('ROOT/shared.koi');
    confirmSpy.mockRestore();
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
});
