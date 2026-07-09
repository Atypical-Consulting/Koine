import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import type { FsEntry } from '@/host';
import type { ExplorerCallbacks, ExplorerRootGroup } from '@/shell/explorer';
import { ExplorerPanel } from '@/shell/ExplorerPanel';

// A small two-context tree: one folder with a nested .koi file plus a top-level .koi file. Mirrors
// explorer.test.ts's sampleTree() shape so the two suites stay easy to cross-reference.
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

function group(root = 'ROOT'): ExplorerRootGroup {
  return { root, entries: sampleTree() };
}

// A second, disjoint workspace root for multi-root coverage.
function secondGroup(): ExplorerRootGroup {
  return {
    root: '/home/me/billing',
    entries: [
      { token: 'BILL/invoice.koi', name: 'invoice.koi', relPath: 'invoice.koi', kind: 'file' },
    ],
  };
}

// A folder-inside-a-folder tree (two directory levels deep) — proof the recursive render nests EVERY
// level's children inside their own directory's `<li>`, not just the first.
function nestedTree(): FsEntry[] {
  return [
    {
      token: 'ROOT/orders',
      name: 'orders',
      relPath: 'orders',
      kind: 'dir',
      children: [
        {
          token: 'ROOT/orders/2024',
          name: '2024',
          relPath: 'orders/2024',
          kind: 'dir',
          children: [
            { token: 'ROOT/orders/2024/order.koi', name: 'order.koi', relPath: 'orders/2024/order.koi', kind: 'file' },
          ],
        },
      ],
    },
  ];
}

function makeCallbacks(overrides: Partial<ExplorerCallbacks> = {}): ExplorerCallbacks {
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
    ...overrides,
  };
}

describe('ExplorerPanel', () => {
  it('renders a ul[role=tree] with a directory treeitem and a nested file treeitem', () => {
    const { container } = render(<ExplorerPanel cb={makeCallbacks()} groups={[group()]} />);

    const tree = container.querySelector('ul[role="tree"]');
    expect(tree).not.toBeNull();
    expect(tree!.getAttribute('aria-label')).toBe('Workspace files');

    const dirItem = container.querySelector('li[role="treeitem"][data-kind="dir"]');
    expect(dirItem).not.toBeNull();
    expect(dirItem!.getAttribute('aria-expanded')).toBe('true');
    expect(dirItem!.getAttribute('aria-level')).toBe('1');

    const fileItem = container.querySelector('li[role="treeitem"][data-kind="file"][data-token="ROOT/orders/order.koi"]');
    expect(fileItem).not.toBeNull();
    expect(fileItem!.getAttribute('aria-level')).toBe('2');
    expect(fileItem!.querySelector('.explorer-name')?.textContent).toBe('order.koi');
  });

  // The hard structural constraint the #989 migration's eventual parity gate (task 8, against the
  // EXISTING explorer.test.ts) depends on: a directory's children are a nested
  // `<ul class="explorer-children" role="group">` that is a DIRECT CHILD of the directory's own
  // `<li>` — not a flat sibling reachable only via `aria-level`. Mirrors explorer.test.ts's own
  // `:scope > ul[role="group"] > li[role="treeitem"]` assertion (~line 55-66) so the two suites agree
  // on the exact same shape, and goes one level further (folder-inside-folder) to prove the recursion
  // nests EVERY level, not just the first.
  it("nests a directory's children directly inside its own <li> via .explorer-children[role=group] (multi-level)", () => {
    const { container } = render(
      <ExplorerPanel cb={makeCallbacks()} groups={[{ root: 'ROOT', entries: nestedTree() }]} />,
    );

    const outerDir = container.querySelector<HTMLElement>('li[role="treeitem"][data-token="ROOT/orders"]')!;
    expect(outerDir).not.toBeNull();

    const innerDir = outerDir.querySelector<HTMLElement>(
      ':scope > ul.explorer-children[role="group"] > li[role="treeitem"][data-token="ROOT/orders/2024"]',
    );
    expect(innerDir).not.toBeNull();

    const nestedFile = innerDir!.querySelector(
      ':scope > ul.explorer-children[role="group"] > li[role="treeitem"][data-token="ROOT/orders/2024/order.koi"] .explorer-name',
    );
    expect(nestedFile?.textContent).toBe('order.koi');
  });

  // The other hard structural constraint: ALL roots share ONE `ul[role="tree"]` — a 2+-root workspace
  // does NOT get one tree per root. Each root's rows must land inside THAT root's own
  // `.explorer-group[data-root]` / `.explorer-group-items`, and never leak into a sibling root's items.
  it('keeps every root under ONE shared ul[role="tree"], each nested in its own .explorer-group', () => {
    const { container } = render(
      <ExplorerPanel cb={makeCallbacks()} groups={[group('/home/me/sales'), secondGroup()]} />,
    );

    const trees = container.querySelectorAll('ul[role="tree"]');
    expect(trees.length).toBe(1);
    const tree = trees[0]!;

    const salesGroup = tree.querySelector<HTMLElement>(':scope > .explorer-group[data-root="/home/me/sales"]');
    const billingGroup = tree.querySelector<HTMLElement>(':scope > .explorer-group[data-root="/home/me/billing"]');
    expect(salesGroup).not.toBeNull();
    expect(billingGroup).not.toBeNull();

    const salesItems = salesGroup!.querySelector(':scope > .explorer-group-items')!;
    const billingItems = billingGroup!.querySelector(':scope > .explorer-group-items')!;

    expect(salesItems.querySelector('[data-token="ROOT/shared.koi"]')).not.toBeNull();
    expect(billingItems.querySelector('[data-token="ROOT/shared.koi"]')).toBeNull();
    expect(billingItems.querySelector('[data-token="BILL/invoice.koi"]')).not.toBeNull();
    expect(salesItems.querySelector('[data-token="BILL/invoice.koi"]')).toBeNull();
  });

  it('opens a file when its row is clicked', () => {
    const cb = makeCallbacks();
    const { container } = render(<ExplorerPanel cb={cb} groups={[group()]} />);

    const row = Array.from(container.querySelectorAll<HTMLElement>('li[data-kind="file"] .explorer-row')).find(
      (r) => r.querySelector('.explorer-name')?.textContent === 'shared.koi',
    )!;
    row.click();

    expect(cb.onOpenFile).toHaveBeenCalledWith('ROOT/shared.koi');
  });

  it('toggles a directory open/closed on click, hiding/showing its nested file', () => {
    const { container } = render(<ExplorerPanel cb={makeCallbacks()} groups={[group()]} />);

    const dir = container.querySelector<HTMLElement>('li[data-kind="dir"]')!;
    expect(dir.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('li[data-token="ROOT/orders/order.koi"]')).not.toBeNull();

    const row = dir.querySelector<HTMLElement>(':scope > .explorer-row')!;
    act(() => row.click());
    expect(dir.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('li[data-token="ROOT/orders/order.koi"]')).toBeNull();

    act(() => row.click());
    expect(dir.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('li[data-token="ROOT/orders/order.koi"]')).not.toBeNull();
  });

  it('shows a dirty dot for a dirty file', () => {
    const cb = makeCallbacks({ isDirty: vi.fn((token: string) => token === 'ROOT/shared.koi') });
    const { container } = render(<ExplorerPanel cb={cb} groups={[group()]} />);

    const row = Array.from(container.querySelectorAll<HTMLElement>('li[data-kind="file"] .explorer-row')).find(
      (r) => r.querySelector('.explorer-name')?.textContent === 'shared.koi',
    )!;
    expect(row.querySelector('.tree-dirty')).not.toBeNull();
  });

  it('shows an error badge for a file with diagnostics errors', () => {
    const cb = makeCallbacks({
      diagCounts: vi.fn((token: string) =>
        token === 'ROOT/orders/order.koi' ? { errors: 2, warnings: 0 } : { errors: 0, warnings: 0 },
      ),
    });
    const { container } = render(<ExplorerPanel cb={cb} groups={[group()]} />);

    const row = container.querySelector<HTMLElement>('li[data-token="ROOT/orders/order.koi"] .explorer-row')!;
    const badge = row.querySelector('.tree-badge');
    expect(badge).not.toBeNull();
    expect(badge!.classList.contains('tree-badge-err')).toBe(true);
    expect(badge!.textContent).toBe('2');
  });

  it('marks the active file with aria-current and aria-selected', () => {
    const cb = makeCallbacks({ isActive: vi.fn((token: string) => token === 'ROOT/shared.koi') });
    const { container } = render(<ExplorerPanel cb={cb} groups={[group()]} />);

    const li = container.querySelector<HTMLElement>('li[data-token="ROOT/shared.koi"]')!;
    expect(li.getAttribute('aria-selected')).toBe('true');
    expect(li.querySelector('.explorer-row')!.getAttribute('aria-current')).toBe('true');
  });

  it('filters by name (debounced) and highlights the match, reporting a match count', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<ExplorerPanel cb={makeCallbacks()} groups={[group()]} />);
      const input = container.querySelector<HTMLInputElement>('#koi-explorer-filter')!;

      act(() => {
        input.value = 'shared';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      act(() => {
        vi.advanceTimersByTime(150);
      });

      expect(container.querySelector('li[data-token="ROOT/shared.koi"]')).not.toBeNull();
      expect(container.querySelector('li[data-token="ROOT/orders"]')).toBeNull();
      const mark = container.querySelector('.explorer-hl');
      expect(mark?.textContent?.toLowerCase()).toBe('shared');
      expect(container.querySelector('.explorer-filter-count')?.textContent).toBe('1 match');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders the empty-workspace state with no tree when there are no entries', () => {
    const { container } = render(<ExplorerPanel cb={makeCallbacks()} groups={[]} />);

    expect(container.querySelector('ul[role="tree"]')).toBeNull();
    expect(container.querySelector('.explorer-empty')).not.toBeNull();
    expect(container.querySelector('.explorer-empty-line')?.textContent).toBe('This folder is empty.');
  });

  it('renders a no-match state when the filter matches nothing, without a role=tree wrapper', () => {
    const { container } = render(
      <ExplorerPanel cb={makeCallbacks()} groups={[group()]} initialFilterText="zzz-nope" />,
    );

    expect(container.querySelector('ul[role="tree"]')).toBeNull();
    expect(container.querySelector('.explorer-empty')?.textContent).toContain('No files match');
  });

  it('renders one group header per root, labeled by the folder name, for 2+ roots', () => {
    const { container } = render(<ExplorerPanel cb={makeCallbacks()} groups={[group('/home/me/sales'), secondGroup()]} />);

    const headers = Array.from(container.querySelectorAll<HTMLElement>('.explorer-group-header'));
    expect(headers.length).toBe(2);
    expect(headers.map((h) => h.querySelector('.explorer-group-name')?.textContent)).toEqual(['sales', 'billing']);
  });

  it('single-root render produces no group header (entries stay direct tree children)', () => {
    const { container } = render(<ExplorerPanel cb={makeCallbacks()} groups={[group()]} />);
    expect(container.querySelector('.explorer-group-header')).toBeNull();
    expect(container.querySelector('.explorer-group')).toBeNull();
  });

  it("clicking a group's Remove affordance invokes onRemoveRoot with that group's root", () => {
    const onRemoveRoot = vi.fn();
    const cb = makeCallbacks({ onRemoveRoot });
    const { container } = render(<ExplorerPanel cb={cb} groups={[group('/home/me/sales'), secondGroup()]} />);

    const removeBtns = Array.from(container.querySelectorAll<HTMLElement>('.explorer-group-remove'));
    expect(removeBtns.length).toBe(2);
    removeBtns[1].click();
    expect(onRemoveRoot).toHaveBeenCalledWith('/home/me/billing');
  });

  it('clicking the "Add folder" affordance invokes onAddRoot', () => {
    const onAddRoot = vi.fn();
    const cb = makeCallbacks({ onAddRoot });
    const { container } = render(<ExplorerPanel cb={cb} groups={[group()]} />);

    container.querySelector<HTMLElement>('.explorer-add-root')!.click();
    expect(onAddRoot).toHaveBeenCalledTimes(1);
  });

  it('Collapse all / Expand all toggle every directory at once', () => {
    const { container } = render(<ExplorerPanel cb={makeCallbacks()} groups={[group()]} />);
    const tools = Array.from(container.querySelectorAll<HTMLElement>('.explorer-tool'));
    const collapseAll = tools.find((b) => b.getAttribute('aria-label') === 'Collapse all')!;
    const expandAll = tools.find((b) => b.getAttribute('aria-label') === 'Expand all')!;

    expect(container.querySelector('li[data-token="ROOT/orders/order.koi"]')).not.toBeNull();
    act(() => collapseAll.click());
    expect(container.querySelector('li[data-token="ROOT/orders/order.koi"]')).toBeNull();
    act(() => expandAll.click());
    expect(container.querySelector('li[data-token="ROOT/orders/order.koi"]')).not.toBeNull();
  });

  // The load-bearing assertion for the whole migration (#989): keyed reconciliation means a re-render
  // that changes ONE row's props (here, a newly-dirty file) must never tear down and rebuild an
  // UNRELATED row elsewhere in the tree — the exact bug class the innerHTML-wipe rebuild in explorer.ts
  // structurally can't avoid. Capture the untouched row's <li> BEFORE the re-render and assert the SAME
  // DOM node comes back after, not merely an equal-looking one. Also captures the PARENT directory's
  // <li> — now that children nest inside it (task-2a), the parent's own identity is equally load-bearing:
  // if the recursive render ever rebuilt a directory's wrapper on every render, the nested child would
  // lose its DOM identity too even while still being "the same row" by every other assertion here.
  it('keeps the same DOM node for an unrelated row (and its nesting parent) across a re-render (keyed identity)', () => {
    const cb = makeCallbacks();
    const { container, rerender } = render(<ExplorerPanel cb={cb} groups={[group()]} />);

    const untouchedParent = container.querySelector('li[data-token="ROOT/orders"]');
    const untouched = container.querySelector('li[data-token="ROOT/orders/order.koi"]');
    expect(untouchedParent).not.toBeNull();
    expect(untouched).not.toBeNull();

    const dirtyCb = makeCallbacks({ isDirty: vi.fn((token: string) => token === 'ROOT/shared.koi') });
    act(() => rerender(<ExplorerPanel cb={dirtyCb} groups={[group()]} />));

    const stillUntouchedParent = container.querySelector('li[data-token="ROOT/orders"]');
    const stillUntouched = container.querySelector('li[data-token="ROOT/orders/order.koi"]');
    expect(stillUntouchedParent).toBe(untouchedParent); // same node reference, not just deep-equal
    expect(stillUntouched).toBe(untouched); // same node reference, not just deep-equal

    // Sanity: the changed row DID pick up the new dirty dot.
    const sharedRow = container.querySelector('li[data-token="ROOT/shared.koi"] .explorer-row')!;
    expect(sharedRow.querySelector('.tree-dirty')).not.toBeNull();
  });

  it('has no accessibility violations (single-root tree)', async () => {
    const { container } = render(<ExplorerPanel cb={makeCallbacks()} groups={[group()]} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no accessibility violations (multi-root tree)', async () => {
    const { container } = render(<ExplorerPanel cb={makeCallbacks()} groups={[group('/home/me/sales'), secondGroup()]} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  // The specific scenario the axe fix targets: multi-root groups (the header/Remove-button leak that
  // originally tripped aria-required-children) TOGETHER with multi-level nested subdirectories in one
  // of those roots, so both structural fixes are exercised in the same accessibility tree at once.
  it('has no accessibility violations (multi-root, with a multi-level nested subdirectory)', async () => {
    const nestedGroup: ExplorerRootGroup = { root: '/home/me/sales', entries: nestedTree() };
    const { container } = render(<ExplorerPanel cb={makeCallbacks()} groups={[nestedGroup, secondGroup()]} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no accessibility violations (empty state)', async () => {
    const { container } = render(<ExplorerPanel cb={makeCallbacks()} groups={[]} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no accessibility violations (no-match / filtered-empty state)', async () => {
    const { container } = render(
      <ExplorerPanel cb={makeCallbacks()} groups={[group()]} initialFilterText="zzz-nope" />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  // --- keyboard navigation (#989 task 3): one delegated onKeyDown on ul[role=tree], routed through the
  // SHARED rovingTreeNav.ts router (handleTreeKeydown) — the same one explorer.ts, the domain navigator
  // and the syntax-tree panel already use (#1105). These tests pin behavioral parity with explorer.ts's
  // old per-row `rowNav`/`onRowKeydown` (explorer.test.ts's equivalents), not a reinvention of the model.
  describe('keyboard navigation', () => {
    it('ArrowDown/ArrowUp move the roving tab stop through every visible row in flattenVisible order, crossing group boundaries (clamped, no wrap)', () => {
      const { container } = render(
        <ExplorerPanel cb={makeCallbacks()} groups={[group('/home/me/sales'), secondGroup()]} />,
      );
      const first = container.querySelector<HTMLElement>('li[data-token="ROOT/orders"]')!;
      act(() => first.focus());
      expect(document.activeElement).toBe(first);

      act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
      expect((document.activeElement as HTMLElement).dataset.token).toBe('ROOT/orders/order.koi');

      act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
      expect((document.activeElement as HTMLElement).dataset.token).toBe('ROOT/shared.koi');

      act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
      expect((document.activeElement as HTMLElement).dataset.token).toBe('BILL/invoice.koi');

      // Clamped at the last row — no wrap back to the first.
      act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
      expect((document.activeElement as HTMLElement).dataset.token).toBe('BILL/invoice.koi');

      act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); });
      expect((document.activeElement as HTMLElement).dataset.token).toBe('ROOT/shared.koi');
    });

    it("ArrowDown skips a collapsed directory's hidden children (matches flattenVisible order)", () => {
      const { container } = render(
        <ExplorerPanel cb={makeCallbacks()} groups={[group()]} initialCollapsed={['ROOT/orders']} />,
      );
      const dir = container.querySelector<HTMLElement>('li[data-token="ROOT/orders"]')!;
      expect(dir.getAttribute('aria-expanded')).toBe('false');
      act(() => dir.focus());

      act(() => { dir.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
      // order.koi is hidden (its parent is collapsed) — focus lands directly on shared.koi.
      expect((document.activeElement as HTMLElement).dataset.token).toBe('ROOT/shared.koi');
    });

    it('ArrowRight opens a closed directory in place (focus stays), then descends into its child on the next press', () => {
      const { container } = render(
        <ExplorerPanel cb={makeCallbacks()} groups={[group()]} initialCollapsed={['ROOT/orders']} />,
      );
      const dir = container.querySelector<HTMLElement>('li[data-token="ROOT/orders"]')!;
      expect(dir.getAttribute('aria-expanded')).toBe('false');
      act(() => dir.focus());

      act(() => { dir.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
      const stillDir = container.querySelector<HTMLElement>('li[data-token="ROOT/orders"]')!;
      expect(stillDir.getAttribute('aria-expanded')).toBe('true');
      expect(document.activeElement).toBe(stillDir); // focus stays on the directory itself

      act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
      expect((document.activeElement as HTMLElement).dataset.token).toBe('ROOT/orders/order.koi');
    });

    it('ArrowLeft collapses an open directory in place, then ascends to the parent on the next press', () => {
      const { container } = render(
        <ExplorerPanel cb={makeCallbacks()} groups={[{ root: 'ROOT', entries: nestedTree() }]} />,
      );
      const inner = container.querySelector<HTMLElement>('li[data-token="ROOT/orders/2024"]')!;
      act(() => inner.focus());

      act(() => { inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
      const stillInner = container.querySelector<HTMLElement>('li[data-token="ROOT/orders/2024"]')!;
      expect(stillInner.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(stillInner); // focus stays on the now-closed directory

      act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
      expect((document.activeElement as HTMLElement).dataset.token).toBe('ROOT/orders'); // ascended to parent
    });

    it('ArrowLeft on a file (nothing to collapse) focuses its parent directory', () => {
      const { container } = render(<ExplorerPanel cb={makeCallbacks()} groups={[group()]} />);
      const file = container.querySelector<HTMLElement>('li[data-token="ROOT/orders/order.koi"]')!;
      act(() => file.focus());

      act(() => { file.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
      expect((document.activeElement as HTMLElement).dataset.token).toBe('ROOT/orders');
    });

    it('Enter opens a focused file and toggles a focused directory', () => {
      const cb = makeCallbacks();
      const { container } = render(<ExplorerPanel cb={cb} groups={[group()]} />);

      const file = container.querySelector<HTMLElement>('li[data-token="ROOT/shared.koi"]')!;
      act(() => file.focus());
      act(() => { file.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
      expect(cb.onOpenFile).toHaveBeenCalledWith('ROOT/shared.koi');

      const dir = container.querySelector<HTMLElement>('li[data-token="ROOT/orders"]')!;
      expect(dir.getAttribute('aria-expanded')).toBe('true');
      act(() => dir.focus());
      act(() => { dir.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
      expect(container.querySelector('li[data-token="ROOT/orders"]')!.getAttribute('aria-expanded')).toBe('false');
    });

    it('moves focus to the treeitem <li> itself, not the inner .explorer-row div', () => {
      const { container } = render(<ExplorerPanel cb={makeCallbacks()} groups={[group()]} />);
      const first = container.querySelector<HTMLElement>('li[role="treeitem"]')!;
      act(() => first.focus());

      act(() => { first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
      const active = document.activeElement as HTMLElement;
      expect(active.getAttribute('role')).toBe('treeitem');
      expect(active.classList.contains('explorer-row')).toBe(false);
      expect(active.tabIndex).toBe(0);
    });

    // The load-bearing parity test for the migration: explorer.ts's OLD per-row handler needed
    // `ev.stopPropagation()` to avoid re-running once per ancestor <li> as a nested row's keydown bubbled
    // up (explorer.test.ts's "does not double-fire keydown through nested treeitem ancestors"). Here there
    // is exactly ONE delegated handler (on ul[role=tree]) and no per-row listeners at all, so there is
    // nothing to double-fire BY CONSTRUCTION — proven by asserting the observable side effect (onOpenFile)
    // fires exactly once for a row nested three <li> deep, not once per ancestor.
    it('does not double-fire keydown through nested treeitem ancestors (one delegated handler ⇒ exactly one action per keypress)', () => {
      const cb = makeCallbacks();
      const nested: FsEntry[] = [
        {
          token: 'R/a',
          name: 'a',
          relPath: 'a',
          kind: 'dir',
          children: [
            {
              token: 'R/a/b',
              name: 'b',
              relPath: 'a/b',
              kind: 'dir',
              children: [{ token: 'R/a/b/c.koi', name: 'c.koi', relPath: 'a/b/c.koi', kind: 'file' }],
            },
          ],
        },
      ];
      const { container } = render(<ExplorerPanel cb={cb} groups={[{ root: 'R', entries: nested }]} />);

      const deep = container.querySelector<HTMLElement>('li[data-token="R/a/b/c.koi"]')!;
      act(() => deep.focus());
      act(() => { deep.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });

      expect(cb.onOpenFile).toHaveBeenCalledTimes(1);
      expect(cb.onOpenFile).toHaveBeenCalledWith('R/a/b/c.koi');
    });

    it('does not consume Backspace (no preventDefault, no callback, focus unchanged)', () => {
      const cb = makeCallbacks();
      const { container } = render(<ExplorerPanel cb={cb} groups={[group()]} />);
      const file = container.querySelector<HTMLElement>('li[data-token="ROOT/shared.koi"]')!;
      act(() => file.focus());

      const ev = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
      act(() => { file.dispatchEvent(ev); });

      expect(ev.defaultPrevented).toBe(false);
      expect(cb.onDelete).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(file);
    });

    // F2/Delete/ContextMenu are panel-specific keys the shared router doesn't own; the explorer opts them
    // out of default browser handling (matching explorer.ts) regardless of whether an action is wired up.
    // Delete/ContextMenu ARE fully wired as of #989 task 4 (see the "context menus + delete confirm"
    // describe block below for their actual behavior); F2 stays a stub pending #989 task 5.
    it('recognizes F2 / Delete / ContextMenu as consumed panel-specific keys', () => {
      const { container } = render(<ExplorerPanel cb={makeCallbacks()} groups={[group()]} />);
      const file = container.querySelector<HTMLElement>('li[data-token="ROOT/shared.koi"]')!;
      act(() => file.focus());

      for (const key of ['F2', 'Delete', 'ContextMenu']) {
        const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        act(() => { file.dispatchEvent(ev); });
        expect(ev.defaultPrevented).toBe(true);
      }
    });
  });

  // --- context menus + delete confirm (#989 task 4): right-click a row, the ContextMenu key, or a
  // right-click on the tree's empty background all open a `createFloatingMenu` (the SAME imperative
  // `@atypical/koine-ui` overlay explorer.ts uses, not a JSX reimplementation — see ExplorerPanel.tsx's
  // file-header note). Delete (menu item OR the Delete key) runs a `createModal`-based in-pane confirm.
  // These tests are apples-to-apples with explorer.test.ts's own parity assertions (same
  // `.explorer-menu[role="menu"]` / `.explorer-menu-item` / `.explorer-confirm-btn(-danger)` /
  // `.koi-modal-backdrop` queries) — see explorer.test.ts around lines 223-310, 354-369, 405-415.
  // New File/New Folder/Rename don't have an inline-edit UI yet (#989 task 5), so these only assert the
  // ROUTING target via `data-pending-edit` (see ExplorerPanel.tsx's `pendingEdit` doc comment) rather than
  // any rendered input.
  describe('context menus + delete confirm', () => {
    // `container` is typed `Element` by @testing-library/preact's RenderResult (not `HTMLElement`), so
    // these helpers accept that wider type — matching how the file's other tests call
    // `container.querySelectorAll<HTMLElement>(...)` directly rather than narrowing `container` itself.
    function fileRow(container: Element, name: string): HTMLElement {
      return Array.from(container.querySelectorAll<HTMLElement>('li[data-kind="file"] > .explorer-row')).find(
        (r) => r.querySelector('.explorer-name')?.textContent === name,
      )!;
    }
    function dirRow(container: Element): HTMLElement {
      return container.querySelector<HTMLElement>('li[data-kind="dir"] > .explorer-row')!;
    }
    function pendingEditOf(container: Element): string | null {
      return container.querySelector('.explorer')!.getAttribute('data-pending-edit');
    }
    // Clicking a menu item may call `setPendingEdit` (New File/New Folder/Rename), so route every click
    // through `act()` to flush that re-render before the caller reads `data-pending-edit`.
    function clickMenuItem(label: string): void {
      const item = Array.from(document.querySelectorAll<HTMLElement>('.explorer-menu-item')).find(
        (b) => b.textContent === label,
      )!;
      act(() => item.click());
    }
    // The confirm dialog is the shared createModal chrome: a .koi-modal-backdrop that is hidden when
    // closed. It's shown iff the backdrop is present and not hidden (mirrors explorer.test.ts's helper).
    function confirmShown(): boolean {
      const bd = document.querySelector<HTMLElement>('.koi-modal-backdrop');
      return !!bd && !bd.hidden;
    }
    // confirmDelete is `async` (mirroring explorer.ts's own await-based confirmDelete/openConfirm), so
    // cb.onDelete fires on a microtask after the OK button's click handler resolves the promise, not
    // synchronously within the click itself — let a pending microtask settle before asserting on it.
    function flush(): Promise<void> {
      return new Promise((r) => setTimeout(r, 0));
    }

    it('shows the row action menu with the expected labels on right-click', () => {
      const { container } = render(<ExplorerPanel cb={makeCallbacks()} groups={[group()]} />);
      dirRow(container).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));

      const menu = document.querySelector('.explorer-menu[role="menu"]');
      expect(menu).not.toBeNull();
      const labels = Array.from(menu!.querySelectorAll('.explorer-menu-item')).map((b) => b.textContent);
      expect(labels).toEqual(['New File', 'New Folder', 'Rename', 'Duplicate', 'Delete']);
    });

    it('New File from a nested file row targets its containing directory (menu)', () => {
      const { container } = render(<ExplorerPanel cb={makeCallbacks()} groups={[group()]} />);
      fileRow(container, 'order.koi').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
      clickMenuItem('New File');
      expect(pendingEditOf(container)).toBe('new-file:ROOT/orders');
    });

    it('New File from a top-level file row falls back to the root token (menu)', () => {
      const { container } = render(<ExplorerPanel cb={makeCallbacks()} groups={[group()]} />);
      fileRow(container, 'shared.koi').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
      clickMenuItem('New File');
      expect(pendingEditOf(container)).toBe('new-file:ROOT');
    });

    it('New Folder from a directory row targets that directory (menu)', () => {
      const { container } = render(<ExplorerPanel cb={makeCallbacks()} groups={[group()]} />);
      dirRow(container).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
      clickMenuItem('New Folder');
      expect(pendingEditOf(container)).toBe('new-folder:ROOT/orders');
    });

    it("Rename identifies the right-clicked entry's own token (menu)", () => {
      const { container } = render(<ExplorerPanel cb={makeCallbacks()} groups={[group()]} />);
      fileRow(container, 'shared.koi').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
      clickMenuItem('Rename');
      expect(pendingEditOf(container)).toBe('rename:ROOT/shared.koi');
    });

    it('Duplicate invokes cb.onDuplicate with the right-clicked entry (menu)', () => {
      const cb = makeCallbacks();
      const { container } = render(<ExplorerPanel cb={cb} groups={[group()]} />);
      fileRow(container, 'shared.koi').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
      clickMenuItem('Duplicate');
      expect(cb.onDuplicate).toHaveBeenCalledTimes(1);
      expect((cb.onDuplicate as ReturnType<typeof vi.fn>).mock.calls[0][0].token).toBe('ROOT/shared.koi');
    });

    it('Delete (menu) opens the confirm dialog before deleting, then deletes on confirm', async () => {
      const cb = makeCallbacks();
      const { container } = render(<ExplorerPanel cb={cb} groups={[group()]} />);
      fileRow(container, 'shared.koi').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
      clickMenuItem('Delete');

      expect(confirmShown()).toBe(true);
      expect(cb.onDelete).not.toHaveBeenCalled(); // not until confirmed

      act(() => {
        document.querySelector<HTMLElement>('.explorer-confirm-btn-danger')!.click();
      });
      await flush();
      expect((cb.onDelete as ReturnType<typeof vi.fn>).mock.calls[0][0].token).toBe('ROOT/shared.koi');
      expect(confirmShown()).toBe(false); // dialog dismissed
    });

    it('Delete key opens the confirm dialog before deleting, then deletes on confirm', async () => {
      const cb = makeCallbacks();
      const { container } = render(<ExplorerPanel cb={cb} groups={[group()]} />);
      const file = container.querySelector<HTMLElement>('li[data-token="ROOT/shared.koi"]')!;
      act(() => file.focus());
      act(() => {
        file.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
      });

      expect(confirmShown()).toBe(true);
      expect(cb.onDelete).not.toHaveBeenCalled();

      act(() => {
        document.querySelector<HTMLElement>('.explorer-confirm-btn-danger')!.click();
      });
      await flush();
      expect((cb.onDelete as ReturnType<typeof vi.fn>).mock.calls[0][0].token).toBe('ROOT/shared.koi');
      expect(confirmShown()).toBe(false);
    });

    it('cancels the delete confirm without deleting (Cancel button)', async () => {
      const cb = makeCallbacks();
      const { container } = render(<ExplorerPanel cb={cb} groups={[group()]} />);
      fileRow(container, 'shared.koi').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
      clickMenuItem('Delete');

      const cancelBtn = Array.from(document.querySelectorAll<HTMLElement>('.explorer-confirm-btn')).find(
        (b) => b.textContent === 'Cancel',
      )!;
      act(() => cancelBtn.click());
      await flush();
      expect(cb.onDelete).not.toHaveBeenCalled();
      expect(confirmShown()).toBe(false);
    });

    it('cancels the delete confirm without deleting (Escape)', async () => {
      const cb = makeCallbacks();
      const { container } = render(<ExplorerPanel cb={cb} groups={[group()]} />);
      fileRow(container, 'shared.koi').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
      clickMenuItem('Delete');
      expect(confirmShown()).toBe(true);

      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });
      await flush();
      expect(cb.onDelete).not.toHaveBeenCalled();
      expect(confirmShown()).toBe(false);
    });

    it('right-clicking empty tree space opens the root menu (New File / New Folder only) targeting the primary root', () => {
      const { container } = render(<ExplorerPanel cb={makeCallbacks()} groups={[group()]} />);
      const tree = container.querySelector<HTMLElement>('ul[role="tree"]')!;
      tree.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 1, clientY: 1 }));

      const labels = Array.from(document.querySelectorAll('.explorer-menu-item')).map((b) => b.textContent);
      expect(labels).toEqual(['New File', 'New Folder']);

      clickMenuItem('New File');
      expect(pendingEditOf(container)).toBe('new-file:ROOT');
    });

    it('root menu targets the FIRST group root in a multi-root workspace', () => {
      const { container } = render(
        <ExplorerPanel cb={makeCallbacks()} groups={[group('/home/me/sales'), secondGroup()]} />,
      );
      const tree = container.querySelector<HTMLElement>('ul[role="tree"]')!;
      tree.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 1, clientY: 1 }));

      clickMenuItem('New File');
      expect(pendingEditOf(container)).toBe('new-file:/home/me/sales');
    });
  });
});
