import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import type { FsEntry } from '@/host';
import type { ExplorerCallbacks, ExplorerRootGroup } from '@/shell/explorer';
import { ExplorerPanel } from '@/shell/ExplorerPanel';
import { createAppStore } from '@/store/index';

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
    const store = createAppStore();
    const { container } = render(<ExplorerPanel store={store} cb={makeCallbacks()} groups={[group()]} />);

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
    const store = createAppStore();
    const { container } = render(
      <ExplorerPanel store={store} cb={makeCallbacks()} groups={[{ root: 'ROOT', entries: nestedTree() }]} />,
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
    const store = createAppStore();
    const { container } = render(
      <ExplorerPanel store={store} cb={makeCallbacks()} groups={[group('/home/me/sales'), secondGroup()]} />,
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
    const store = createAppStore();
    const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);

    const row = Array.from(container.querySelectorAll<HTMLElement>('li[data-kind="file"] .explorer-row')).find(
      (r) => r.querySelector('.explorer-name')?.textContent === 'shared.koi',
    )!;
    row.click();

    expect(cb.onOpenFile).toHaveBeenCalledWith('ROOT/shared.koi');
  });

  it('toggles a directory open/closed on click, hiding/showing its nested file', () => {
    const store = createAppStore();
    const { container } = render(<ExplorerPanel store={store} cb={makeCallbacks()} groups={[group()]} />);

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
    const store = createAppStore();
    const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);

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
    const store = createAppStore();
    const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);

    const row = container.querySelector<HTMLElement>('li[data-token="ROOT/orders/order.koi"] .explorer-row')!;
    const badge = row.querySelector('.tree-badge');
    expect(badge).not.toBeNull();
    expect(badge!.classList.contains('tree-badge-err')).toBe(true);
    expect(badge!.textContent).toBe('2');
  });

  it('marks the active file with aria-current and aria-selected', () => {
    const cb = makeCallbacks({ isActive: vi.fn((token: string) => token === 'ROOT/shared.koi') });
    const store = createAppStore();
    const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);

    const li = container.querySelector<HTMLElement>('li[data-token="ROOT/shared.koi"]')!;
    expect(li.getAttribute('aria-selected')).toBe('true');
    expect(li.querySelector('.explorer-row')!.getAttribute('aria-current')).toBe('true');
  });

  it('filters by name (debounced) and highlights the match, reporting a match count', () => {
    vi.useFakeTimers();
    try {
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={makeCallbacks()} groups={[group()]} />);
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
    const store = createAppStore();
    const { container } = render(<ExplorerPanel store={store} cb={makeCallbacks()} groups={[]} />);

    expect(container.querySelector('ul[role="tree"]')).toBeNull();
    expect(container.querySelector('.explorer-empty')).not.toBeNull();
    expect(container.querySelector('.explorer-empty-line')?.textContent).toBe('This folder is empty.');
  });

  it('renders a no-match state when the filter matches nothing, without a role=tree wrapper', () => {
    const store = createAppStore();
    store.getState().setExplorerFilter('zzz-nope');
    const { container } = render(<ExplorerPanel store={store} cb={makeCallbacks()} groups={[group()]} />);

    expect(container.querySelector('ul[role="tree"]')).toBeNull();
    expect(container.querySelector('.explorer-empty')?.textContent).toContain('No files match');
  });

  it('renders one group header per root, labeled by the folder name, for 2+ roots', () => {
    const store = createAppStore();
    const { container } = render(<ExplorerPanel store={store} cb={makeCallbacks()} groups={[group('/home/me/sales'), secondGroup()]} />);

    const headers = Array.from(container.querySelectorAll<HTMLElement>('.explorer-group-header'));
    expect(headers.length).toBe(2);
    expect(headers.map((h) => h.querySelector('.explorer-group-name')?.textContent)).toEqual(['sales', 'billing']);
  });

  it('single-root render produces no group header (entries stay direct tree children)', () => {
    const store = createAppStore();
    const { container } = render(<ExplorerPanel store={store} cb={makeCallbacks()} groups={[group()]} />);
    expect(container.querySelector('.explorer-group-header')).toBeNull();
    expect(container.querySelector('.explorer-group')).toBeNull();
  });

  it("clicking a group's Remove affordance invokes onRemoveRoot with that group's root", () => {
    const onRemoveRoot = vi.fn();
    const cb = makeCallbacks({ onRemoveRoot });
    const store = createAppStore();
    const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group('/home/me/sales'), secondGroup()]} />);

    const removeBtns = Array.from(container.querySelectorAll<HTMLElement>('.explorer-group-remove'));
    expect(removeBtns.length).toBe(2);
    removeBtns[1].click();
    expect(onRemoveRoot).toHaveBeenCalledWith('/home/me/billing');
  });

  it('clicking the "Add folder" affordance invokes onAddRoot', () => {
    const onAddRoot = vi.fn();
    const cb = makeCallbacks({ onAddRoot });
    const store = createAppStore();
    const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);

    container.querySelector<HTMLElement>('.explorer-add-root')!.click();
    expect(onAddRoot).toHaveBeenCalledTimes(1);
  });

  it('Collapse all / Expand all toggle every directory at once', () => {
    const store = createAppStore();
    const { container } = render(<ExplorerPanel store={store} cb={makeCallbacks()} groups={[group()]} />);
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
    const store = createAppStore();
    const { container, rerender } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);

    const untouchedParent = container.querySelector('li[data-token="ROOT/orders"]');
    const untouched = container.querySelector('li[data-token="ROOT/orders/order.koi"]');
    expect(untouchedParent).not.toBeNull();
    expect(untouched).not.toBeNull();

    const dirtyCb = makeCallbacks({ isDirty: vi.fn((token: string) => token === 'ROOT/shared.koi') });
    act(() => rerender(<ExplorerPanel store={store} cb={dirtyCb} groups={[group()]} />));

    const stillUntouchedParent = container.querySelector('li[data-token="ROOT/orders"]');
    const stillUntouched = container.querySelector('li[data-token="ROOT/orders/order.koi"]');
    expect(stillUntouchedParent).toBe(untouchedParent); // same node reference, not just deep-equal
    expect(stillUntouched).toBe(untouched); // same node reference, not just deep-equal

    // Sanity: the changed row DID pick up the new dirty dot.
    const sharedRow = container.querySelector('li[data-token="ROOT/shared.koi"] .explorer-row')!;
    expect(sharedRow.querySelector('.tree-dirty')).not.toBeNull();
  });

  it('has no accessibility violations (single-root tree)', async () => {
    const store = createAppStore();
    const { container } = render(<ExplorerPanel store={store} cb={makeCallbacks()} groups={[group()]} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no accessibility violations (multi-root tree)', async () => {
    const store = createAppStore();
    const { container } = render(<ExplorerPanel store={store} cb={makeCallbacks()} groups={[group('/home/me/sales'), secondGroup()]} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  // The specific scenario the axe fix targets: multi-root groups (the header/Remove-button leak that
  // originally tripped aria-required-children) TOGETHER with multi-level nested subdirectories in one
  // of those roots, so both structural fixes are exercised in the same accessibility tree at once.
  it('has no accessibility violations (multi-root, with a multi-level nested subdirectory)', async () => {
    const nestedGroup: ExplorerRootGroup = { root: '/home/me/sales', entries: nestedTree() };
    const store = createAppStore();
    const { container } = render(<ExplorerPanel store={store} cb={makeCallbacks()} groups={[nestedGroup, secondGroup()]} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no accessibility violations (empty state)', async () => {
    const store = createAppStore();
    const { container } = render(<ExplorerPanel store={store} cb={makeCallbacks()} groups={[]} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no accessibility violations (no-match / filtered-empty state)', async () => {
    const store = createAppStore();
    store.getState().setExplorerFilter('zzz-nope');
    const { container } = render(<ExplorerPanel store={store} cb={makeCallbacks()} groups={[group()]} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  // --- keyboard navigation (#989 task 3): one delegated onKeyDown on ul[role=tree], routed through the
  // SHARED rovingTreeNav.ts router (handleTreeKeydown) — the same one explorer.ts, the domain navigator
  // and the syntax-tree panel already use (#1105). These tests pin behavioral parity with explorer.ts's
  // old per-row `rowNav`/`onRowKeydown` (explorer.test.ts's equivalents), not a reinvention of the model.
  describe('keyboard navigation', () => {
    it('ArrowDown/ArrowUp move the roving tab stop through every visible row in flattenVisible order, crossing group boundaries (clamped, no wrap)', () => {
      const store = createAppStore();
      const { container } = render(
        <ExplorerPanel store={store} cb={makeCallbacks()} groups={[group('/home/me/sales'), secondGroup()]} />,
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
      const store = createAppStore();
      store.getState().setExplorerCollapsedMany(['ROOT/orders']);
      const { container } = render(<ExplorerPanel store={store} cb={makeCallbacks()} groups={[group()]} />);
      const dir = container.querySelector<HTMLElement>('li[data-token="ROOT/orders"]')!;
      expect(dir.getAttribute('aria-expanded')).toBe('false');
      act(() => dir.focus());

      act(() => { dir.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
      // order.koi is hidden (its parent is collapsed) — focus lands directly on shared.koi.
      expect((document.activeElement as HTMLElement).dataset.token).toBe('ROOT/shared.koi');
    });

    it('ArrowRight opens a closed directory in place (focus stays), then descends into its child on the next press', () => {
      const store = createAppStore();
      store.getState().setExplorerCollapsedMany(['ROOT/orders']);
      const { container } = render(<ExplorerPanel store={store} cb={makeCallbacks()} groups={[group()]} />);
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
      const store = createAppStore();
      const { container } = render(
        <ExplorerPanel store={store} cb={makeCallbacks()} groups={[{ root: 'ROOT', entries: nestedTree() }]} />,
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
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={makeCallbacks()} groups={[group()]} />);
      const file = container.querySelector<HTMLElement>('li[data-token="ROOT/orders/order.koi"]')!;
      act(() => file.focus());

      act(() => { file.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
      expect((document.activeElement as HTMLElement).dataset.token).toBe('ROOT/orders');
    });

    it('Enter opens a focused file and toggles a focused directory', () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);

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
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={makeCallbacks()} groups={[group()]} />);
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
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[{ root: 'R', entries: nested }]} />);

      const deep = container.querySelector<HTMLElement>('li[data-token="R/a/b/c.koi"]')!;
      act(() => deep.focus());
      act(() => { deep.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });

      expect(cb.onOpenFile).toHaveBeenCalledTimes(1);
      expect(cb.onOpenFile).toHaveBeenCalledWith('R/a/b/c.koi');
    });

    it('does not consume Backspace (no preventDefault, no callback, focus unchanged)', () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);
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
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={makeCallbacks()} groups={[group()]} />);
      const file = container.querySelector<HTMLElement>('li[data-token="ROOT/shared.koi"]')!;
      act(() => file.focus());

      for (const key of ['F2', 'Delete', 'ContextMenu']) {
        const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        act(() => { file.dispatchEvent(ev); });
        expect(ev.defaultPrevented).toBe(true);
      }
    });

    // Code-review fix (Fix 1): the delegated handler used to fall back to `effectiveFocusedToken` (which
    // defaults to the FIRST visible row) whenever a keydown didn't land on an actual row — so Tabbing to
    // the multi-root group's own Remove button (a real tabbable `<button>` nested inside a
    // `.explorer-group` `<li role="treeitem" data-root=…>`, which has NO `data-token`) and pressing Delete
    // used to open a delete-confirm for the WRONG entry (the tree's first row), not no-op. Arrow-key
    // navigation is deliberately untouched by this fix (still falls back to `effectiveFocusedToken`, by
    // design) — only Delete/F2/ContextMenu require a real row under the event.
    it('Delete/F2/ContextMenu on a non-row focusable element (the group-remove button) is a no-op, not a wrong-row action', () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(
        <ExplorerPanel store={store} cb={cb} groups={[group('/home/me/sales'), secondGroup()]} />,
      );
      const removeBtn = container.querySelector<HTMLElement>('.explorer-group-remove')!;
      act(() => removeBtn.focus());
      expect(document.activeElement).toBe(removeBtn);

      for (const key of ['Delete', 'F2', 'ContextMenu']) {
        act(() => {
          removeBtn.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        });
      }

      expect(cb.onDelete).not.toHaveBeenCalled();
      expect(container.querySelector('.explorer-rename')).toBeNull(); // F2 opened no rename input
      expect(document.querySelector('.explorer-menu[role="menu"]')).toBeNull(); // ContextMenu opened no menu
    });
  });

  // --- context menus + delete confirm (#989 task 4): right-click a row, the ContextMenu key, or a
  // right-click on the tree's empty background all open a `createFloatingMenu` (the SAME imperative
  // `@atypical/koine-ui` overlay explorer.ts uses, not a JSX reimplementation — see ExplorerPanel.tsx's
  // file-header note). Delete (menu item OR the Delete key) runs a `createModal`-based in-pane confirm.
  // These tests are apples-to-apples with explorer.test.ts's own parity assertions (same
  // `.explorer-menu[role="menu"]` / `.explorer-menu-item` / `.explorer-confirm-btn(-danger)` /
  // `.koi-modal-backdrop` queries) — see explorer.test.ts around lines 223-310, 354-369, 405-415. New
  // File/New Folder/Rename DO have a real inline-edit `<input>` as of #989 task 5 — the routing tests
  // below drive that input end-to-end (type + commit) and assert the resulting `cb.onNewFile`/
  // `onNewFolder`/`onRename` call, rather than a placeholder `data-pending-edit` attribute.
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
    // Drive the inline create input (#989 task 5): type `value` and press Enter to commit.
    function commitCreate(container: Element, value: string): void {
      const input = container.querySelector<HTMLInputElement>('.explorer-create .explorer-rename')!;
      expect(input).not.toBeNull();
      act(() => {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
    }
    // Drive the inline rename input for `token` (#989 task 5): type `value` and press Enter to commit.
    function commitRename(container: Element, token: string, value: string): void {
      const input = container.querySelector<HTMLInputElement>(`li[data-token="${token}"] .explorer-rename`)!;
      expect(input).not.toBeNull();
      act(() => {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
    }
    // Clicking a menu item may open an inline edit (New File/New Folder/Rename), so route every click
    // through `act()` to flush that re-render before the caller looks for the resulting input.
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
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={makeCallbacks()} groups={[group()]} />);
      dirRow(container).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));

      const menu = document.querySelector('.explorer-menu[role="menu"]');
      expect(menu).not.toBeNull();
      const labels = Array.from(menu!.querySelectorAll('.explorer-menu-item')).map((b) => b.textContent);
      expect(labels).toEqual(['New File', 'New Folder', 'Rename', 'Duplicate', 'Delete']);
    });

    it('New File from a nested file row targets its containing directory (menu)', () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);
      fileRow(container, 'order.koi').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
      clickMenuItem('New File');

      // The create row lands INSIDE the orders directory's own children list, ahead of order.koi.
      const ordersChildren = container.querySelector('li[data-token="ROOT/orders"] > ul.explorer-children')!;
      expect(ordersChildren.querySelector(':scope > li.explorer-create-li')).not.toBeNull();

      commitCreate(container, 'extra.koi');
      expect(cb.onNewFile).toHaveBeenCalledWith('ROOT/orders', 'extra.koi');
    });

    it('New File from a top-level file row falls back to the root token (menu)', () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);
      fileRow(container, 'shared.koi').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
      clickMenuItem('New File');

      commitCreate(container, 'catalog.koi');
      expect(cb.onNewFile).toHaveBeenCalledWith('ROOT', 'catalog.koi');
    });

    it('New Folder from a directory row targets that directory (menu)', () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);
      dirRow(container).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
      clickMenuItem('New Folder');

      const ordersChildren = container.querySelector('li[data-token="ROOT/orders"] > ul.explorer-children')!;
      expect(ordersChildren.querySelector(':scope > li.explorer-create-li')).not.toBeNull();

      commitCreate(container, 'archive');
      expect(cb.onNewFolder).toHaveBeenCalledWith('ROOT/orders', 'archive');
    });

    it("Rename identifies the right-clicked entry's own token (menu)", () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);
      fileRow(container, 'shared.koi').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
      clickMenuItem('Rename');

      const input = container.querySelector<HTMLInputElement>('li[data-token="ROOT/shared.koi"] .explorer-rename')!;
      expect(input).not.toBeNull();
      expect(input.value).toBe('shared.koi'); // prefilled with the current name

      commitRename(container, 'ROOT/shared.koi', 'common.koi');
      const renamed = (cb.onRename as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(renamed[0].token).toBe('ROOT/shared.koi');
      expect(renamed[1]).toBe('common.koi');
    });

    it('Duplicate invokes cb.onDuplicate with the right-clicked entry (menu)', () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);
      fileRow(container, 'shared.koi').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
      clickMenuItem('Duplicate');
      expect(cb.onDuplicate).toHaveBeenCalledTimes(1);
      expect((cb.onDuplicate as ReturnType<typeof vi.fn>).mock.calls[0][0].token).toBe('ROOT/shared.koi');
    });

    it('Delete (menu) opens the confirm dialog before deleting, then deletes on confirm', async () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);
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
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);
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
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);
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
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);
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
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);
      const tree = container.querySelector<HTMLElement>('ul[role="tree"]')!;
      tree.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 1, clientY: 1 }));

      const labels = Array.from(document.querySelectorAll('.explorer-menu-item')).map((b) => b.textContent);
      expect(labels).toEqual(['New File', 'New Folder']);

      clickMenuItem('New File');
      // Single-root: the create row is a direct child of the tree (no group wrapper) — see the toolbar
      // tests below for the same structural assertion driven off the toolbar button instead.
      expect(tree.querySelector(':scope > li.explorer-create-li')).not.toBeNull();
      commitCreate(container, 'catalog.koi');
      expect(cb.onNewFile).toHaveBeenCalledWith('ROOT', 'catalog.koi');
    });

    it('root menu targets the FIRST group root in a multi-root workspace', () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(
        <ExplorerPanel store={store} cb={cb} groups={[group('/home/me/sales'), secondGroup()]} />,
      );
      const tree = container.querySelector<HTMLElement>('ul[role="tree"]')!;
      tree.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 1, clientY: 1 }));

      clickMenuItem('New File');
      const salesItems = container.querySelector<HTMLElement>(
        '.explorer-group[data-root="/home/me/sales"] > .explorer-group-items',
      )!;
      expect(salesItems.querySelector(':scope > li.explorer-create-li')).not.toBeNull();
      commitCreate(container, 'catalog.koi');
      expect(cb.onNewFile).toHaveBeenCalledWith('/home/me/sales', 'catalog.koi');
    });
  });

  // --- inline create/rename (#989 task 5): the create-row / rename-input are CONTROLLED, keyed elements
  // rendered off `ExplorerPanel`'s own `editing` state — not explorer.ts's imperative DOM-insert
  // technique. The load-bearing test in this block ("survives a changed re-render mid-edit") is the
  // concrete proof that keyed reconciliation makes explorer.ts's whole `renaming`/`creating`/
  // `flushPendingRender()` deferral machinery unnecessary: a re-render triggered by something ELSE
  // changing (here, an unrelated file's dirty flag) must reconcile onto the SAME `<input>` DOM node,
  // never tearing it down or losing the half-typed value.
  describe('inline create/rename (#989 task 5)', () => {
    function fileRow(container: Element, name: string): HTMLElement {
      return Array.from(container.querySelectorAll<HTMLElement>('li[data-kind="file"] > .explorer-row')).find(
        (r) => r.querySelector('.explorer-name')?.textContent === name,
      )!;
    }

    it("toolbar New File mounts the create row inside the PRIMARY root's group (multi-root)", () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(
        <ExplorerPanel store={store} cb={cb} groups={[group('/home/me/sales'), secondGroup()]} />,
      );

      act(() => container.querySelector<HTMLElement>('.explorer-toolbar .explorer-tool')!.click());

      const salesItems = container.querySelector<HTMLElement>(
        '.explorer-group[data-root="/home/me/sales"] > .explorer-group-items',
      )!;
      const createLi = salesItems.querySelector<HTMLElement>(':scope > li.explorer-create-li');
      expect(createLi).not.toBeNull();

      // Never leaks into the billing group, nor sits as a stray direct child of the shared tree.
      const billingItems = container.querySelector<HTMLElement>(
        '.explorer-group[data-root="/home/me/billing"] > .explorer-group-items',
      )!;
      expect(billingItems.querySelector('.explorer-create-li')).toBeNull();
      const tree = container.querySelector<HTMLElement>('ul[role="tree"]')!;
      expect(Array.from(tree.children)).not.toContain(createLi);

      const input = container.querySelector<HTMLInputElement>('.explorer-create .explorer-rename')!;
      act(() => {
        input.value = 'catalog.koi';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
      expect(cb.onNewFile).toHaveBeenCalledWith('/home/me/sales', 'catalog.koi');
    });

    it('toolbar New File in single-root mode mounts the create row directly in the tree (no group)', () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);

      act(() => container.querySelector<HTMLElement>('.explorer-toolbar .explorer-tool')!.click());

      expect(container.querySelector('.explorer-group')).toBeNull();
      const tree = container.querySelector<HTMLElement>('ul[role="tree"]')!;
      const createLi = tree.querySelector<HTMLElement>(':scope > li.explorer-create-li');
      expect(createLi).not.toBeNull();

      const input = createLi!.querySelector<HTMLInputElement>('.explorer-rename')!;
      expect(input.placeholder).toBe('name.koi');
      expect(input.getAttribute('aria-label')).toBe('New file name');
      act(() => {
        input.value = 'catalog.koi';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
      expect(cb.onNewFile).toHaveBeenCalledWith('ROOT', 'catalog.koi');
    });

    it('the toolbar New folder button opens a folder-flavored create row', () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);
      const tools = Array.from(container.querySelectorAll<HTMLElement>('.explorer-toolbar .explorer-tool'));
      act(() => tools.find((b) => b.getAttribute('aria-label') === 'New folder')!.click());

      const input = container.querySelector<HTMLInputElement>('.explorer-create .explorer-rename')!;
      expect(input.placeholder).toBe('folder name');
      expect(input.getAttribute('aria-label')).toBe('New folder name');
      act(() => {
        input.value = 'archive';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
      expect(cb.onNewFolder).toHaveBeenCalledWith('ROOT', 'archive');
    });

    it('Escape cancels an inline create without calling onNewFile', () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);
      act(() => container.querySelector<HTMLElement>('.explorer-toolbar .explorer-tool')!.click());

      const input = container.querySelector<HTMLInputElement>('.explorer-create .explorer-rename')!;
      act(() => {
        input.value = 'scrap.koi';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });

      expect(cb.onNewFile).not.toHaveBeenCalled();
      expect(container.querySelector('.explorer-create')).toBeNull();
    });

    it('keeps an inline create open and flags an invalid name instead of creating (Enter)', () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);
      act(() => container.querySelector<HTMLElement>('.explorer-toolbar .explorer-tool')!.click());

      const input = container.querySelector<HTMLInputElement>('.explorer-create .explorer-rename')!;
      act(() => {
        input.value = 'bad/name';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });

      expect(cb.onNewFile).not.toHaveBeenCalled();
      expect(input.classList.contains('is-invalid')).toBe(true);
      expect(container.querySelector('.explorer-create')).not.toBeNull(); // still open to fix
    });

    it('cancels an inline create with an invalid name on blur (never traps the user in a bad-name row)', () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);
      act(() => container.querySelector<HTMLElement>('.explorer-toolbar .explorer-tool')!.click());

      const input = container.querySelector<HTMLInputElement>('.explorer-create .explorer-rename')!;
      act(() => {
        input.value = 'bad/name';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      // The real `.blur()` method (#989 task 7), not a synthetic `new Event('blur')`: this file now
      // transitively imports zustand's React binding (via `useAppStore`), which resolves through the
      // `react` → `preact/compat` alias — and `preact/compat` translates an `onBlur` prop to listen for
      // 'focusout' (React's own blur delegation strategy), not the raw 'blur' event Preact core would use
      // un-aliased. happy-dom's real `.blur()` dispatches BOTH 'blur' AND a bubbling 'focusout' (mirroring
      // real browsers), so it satisfies either listener strategy; a bare synthetic 'blur' Event no longer
      // reaches this input's handler now that `preact/compat` is in the module graph.
      act(() => { input.blur(); });

      expect(cb.onNewFile).not.toHaveBeenCalled();
      expect(container.querySelector('.explorer-create')).toBeNull();
    });

    it('F2 starts an inline rename and commits the typed name on Enter', () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);
      const file = container.querySelector<HTMLElement>('li[data-token="ROOT/shared.koi"]')!;
      act(() => file.focus());
      act(() => { file.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })); });

      const input = file.querySelector<HTMLInputElement>('.explorer-rename')!;
      expect(input).not.toBeNull();
      expect(input.value).toBe('shared.koi');

      act(() => {
        input.value = 'common.koi';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });

      const renamed = (cb.onRename as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(renamed[0].token).toBe('ROOT/shared.koi');
      expect(renamed[1]).toBe('common.koi');
      expect(container.querySelector('.explorer-rename')).toBeNull();
    });

    it('F2 on a DIRECTORY row also starts an inline rename (no file-only guard)', () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);
      const dir = container.querySelector<HTMLElement>('li[data-token="ROOT/orders"]')!;
      act(() => dir.focus());
      act(() => { dir.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })); });

      const input = dir.querySelector<HTMLInputElement>(':scope > .explorer-row .explorer-rename')!;
      expect(input).not.toBeNull();
      expect(input.value).toBe('orders');

      act(() => {
        input.value = 'purchase-orders';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
      const renamed = (cb.onRename as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(renamed[0].token).toBe('ROOT/orders');
      expect(renamed[1]).toBe('purchase-orders');
    });

    it('preselects the stem (before the last dot) for a file rename', () => {
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={makeCallbacks()} groups={[group()]} />);
      const file = container.querySelector<HTMLElement>('li[data-token="ROOT/shared.koi"]')!;
      act(() => file.focus());
      act(() => { file.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })); });

      const input = file.querySelector<HTMLInputElement>('.explorer-rename')!;
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe('shared'.length); // up to (not including) ".koi"
    });

    it('Escape cancels an inline rename without calling onRename (label restored)', () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);
      const file = container.querySelector<HTMLElement>('li[data-token="ROOT/shared.koi"]')!;
      act(() => file.focus());
      act(() => { file.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })); });

      const input = file.querySelector<HTMLInputElement>('.explorer-rename')!;
      act(() => {
        input.value = 'whatever.koi';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });

      expect(cb.onRename).not.toHaveBeenCalled();
      expect(container.querySelector('.explorer-rename')).toBeNull();
      expect(fileRow(container, 'shared.koi')).toBeTruthy(); // label restored
    });

    it('discards an invalid rename on blur without calling onRename', () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);
      const file = container.querySelector<HTMLElement>('li[data-token="ROOT/shared.koi"]')!;
      act(() => file.focus());
      act(() => { file.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })); });

      const input = file.querySelector<HTMLInputElement>('.explorer-rename')!;
      act(() => {
        input.value = 'bad/name';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      // Real `.blur()`, not a synthetic 'blur' Event — see the sibling create-row test's comment above for
      // why (#989 task 7: this file now transitively loads `preact/compat`, which listens for 'focusout').
      act(() => { input.blur(); });

      expect(cb.onRename).not.toHaveBeenCalled();
      expect(container.querySelector('.explorer-rename')).toBeNull(); // discarded, label restored
    });

    it('a no-op rename (name unchanged) closes the edit without calling onRename', () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);
      const file = container.querySelector<HTMLElement>('li[data-token="ROOT/shared.koi"]')!;
      act(() => file.focus());
      act(() => { file.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })); });

      const input = file.querySelector<HTMLInputElement>('.explorer-rename')!;
      act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });

      expect(cb.onRename).not.toHaveBeenCalled();
      expect(container.querySelector('.explorer-rename')).toBeNull();
    });

    // The load-bearing test for the whole #989 migration: a re-render triggered by something ELSE
    // changing (an unrelated file's dirty flag) WHILE a rename is mid-edit, with a half-typed,
    // uncommitted value, must reconcile onto the SAME `<input>` DOM node — not tear it down and lose the
    // in-progress text — because the row is keyed by its own token. explorer.ts needed a `renaming` flag
    // plus `flushPendingRender()` to defend against exactly this scenario (see its own parity test,
    // explorer.test.ts:458-478, which only proves survival across an IDENTICAL re-render). This test goes
    // further: the props actually CHANGE mid-edit, which explorer.test.ts's version never exercises.
    it('survives a re-render with CHANGED groups/cb props while a rename is mid-edit (keyed reconciliation, #989)', () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container, rerender } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);
      const file = container.querySelector<HTMLElement>('li[data-token="ROOT/shared.koi"]')!;
      act(() => file.focus());
      act(() => { file.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })); });

      const input = container.querySelector<HTMLInputElement>('.explorer-rename')!;
      expect(input).not.toBeNull();
      act(() => {
        input.value = 'ren'; // half-typed, not yet committed
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(input.value).toBe('ren');

      // A diagnostics push re-renders with CHANGED props — a DIFFERENT file (order.koi) just became
      // dirty — while the rename above is still open and uncommitted.
      const dirtyCb = makeCallbacks({ isDirty: vi.fn((t: string) => t === 'ROOT/orders/order.koi') });
      act(() => rerender(<ExplorerPanel store={store} cb={dirtyCb} groups={[group()]} />));

      const stillInput = container.querySelector<HTMLInputElement>('.explorer-rename')!;
      expect(stillInput).toBe(input); // SAME DOM node reference — not torn down and rebuilt
      expect(stillInput.value).toBe('ren'); // half-typed value untouched
      expect(cb.onRename).not.toHaveBeenCalled(); // no spurious commit
      expect(dirtyCb.onRename).not.toHaveBeenCalled();

      // Sanity: the re-render's OWN change did take effect elsewhere in the tree.
      const orderRow = container.querySelector('li[data-token="ROOT/orders/order.koi"] .explorer-row')!;
      expect(orderRow.querySelector('.tree-dirty')).not.toBeNull();

      // Enter now commits exactly once, with the (still-current) typed value.
      act(() => { stillInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
      expect(dirtyCb.onRename).toHaveBeenCalledTimes(1);
      expect((dirtyCb.onRename as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('ren');
    });

    // Design decision #3 (#989): an upstream deletion of the edited entry mid-edit cancels rather than
    // commits. Simulated here by re-rendering with `shared.koi` removed from `groups` while its rename is
    // open — Preact unmounts the `<input>` (this row no longer exists to render), and a late `blur` event
    // on that now-detached node must be a no-op rather than firing `onRename` for a vanished entry.
    it('an upstream deletion of the edited entry cancels the pending rename instead of committing (isConnected blur guard)', () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container, rerender } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);
      const file = container.querySelector<HTMLElement>('li[data-token="ROOT/shared.koi"]')!;
      act(() => file.focus());
      act(() => { file.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })); });

      const input = container.querySelector<HTMLInputElement>('.explorer-rename')!;
      expect(input).not.toBeNull();

      const groupsWithoutShared: ExplorerRootGroup[] = [
        { root: 'ROOT', entries: sampleTree().filter((e) => e.token !== 'ROOT/shared.koi') },
      ];
      act(() => rerender(<ExplorerPanel store={store} cb={cb} groups={groupsWithoutShared} />));
      expect(input.isConnected).toBe(false); // Preact already removed it — the entry it belonged to is gone

      // A synthetic 'blur' Event (not the real `.blur()` method) is intentional here: happy-dom's real
      // `.blur()` no-ops on an already-disconnected node, which would prove nothing about the
      // `isConnected` guard this test targets. The assertion holds either way (no call), so it's immune to
      // the sibling tests' `preact/compat` 'focusout'-translation wrinkle (see their comments).
      act(() => { input.dispatchEvent(new Event('blur')); });
      expect(cb.onRename).not.toHaveBeenCalled();
    });
  });

  // --- drag-and-drop move (#989 task 6): HTML5 DnD wired per-row (draggable + dragstart/dragover/
  // dragleave/drop/dragend) and on the tree background. Drop validity comes from `explorerModel.ts`'s
  // `parentMapOf` — DATA ancestry, never `Element.contains()` — which is what makes it immune to a
  // re-render mid-drag (see the last test below, strictly stronger than explorer.test.ts's own "defers a
  // re-render while a drag is in progress" parity test since it exercises a re-render with CHANGED data,
  // not just an identical one). The other tests mirror explorer.test.ts's own drag assertions (~720-780)
  // for the actual RULES (self/descendant/current-parent rejection, file-row-routes-to-parent), just
  // replacing the underlying DOM-containment technique.
  describe('drag-and-drop move (#989 task 6)', () => {
    function fileRow(container: Element, name: string): HTMLElement {
      return Array.from(container.querySelectorAll<HTMLElement>('li[data-kind="file"] > .explorer-row')).find(
        (r) => r.querySelector('.explorer-name')?.textContent === name,
      )!;
    }
    function dirRow(container: Element): HTMLElement {
      return container.querySelector<HTMLElement>('li[data-kind="dir"] > .explorer-row')!;
    }
    // Fires a plain (non-DragEvent) Event, mirroring explorer.test.ts's own `fireDrag` helper — the
    // handlers only ever touch `ev.dataTransfer` via optional chaining, so a plain Event (whose
    // `dataTransfer` is `undefined`) exercises the exact same code path a real DragEvent would.
    function fireDrag(el: Element, type: string): void {
      act(() => {
        el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
      });
    }

    it('moves an entry into a directory via drag-and-drop', () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);

      fireDrag(fileRow(container, 'shared.koi'), 'dragstart');
      fireDrag(dirRow(container), 'dragover');
      fireDrag(dirRow(container), 'drop');

      const call = (cb.onMove as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0].token).toBe('ROOT/shared.koi');
      expect(call[1]).toBe('ROOT/orders');
    });

    it("dropping onto a FILE row moves into that file's containing directory (no dead zone)", () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);

      fireDrag(fileRow(container, 'shared.koi'), 'dragstart'); // top-level file
      fireDrag(fileRow(container, 'order.koi'), 'drop'); // onto a file inside orders/

      const call = (cb.onMove as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0].token).toBe('ROOT/shared.koi');
      expect(call[1]).toBe('ROOT/orders'); // routed to the file's parent directory, not a no-op
    });

    it('rejects a drag-drop back into the same parent directory (no-op)', () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);

      fireDrag(fileRow(container, 'order.koi'), 'dragstart'); // already inside orders/
      fireDrag(dirRow(container), 'drop');
      expect(cb.onMove).not.toHaveBeenCalled();
    });

    it('rejects dropping a directory onto itself and into its own subtree (parentMap ancestor walk)', () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(
        <ExplorerPanel store={store} cb={cb} groups={[{ root: 'ROOT', entries: nestedTree() }]} />,
      );
      const outerDirRow = container.querySelector<HTMLElement>('li[data-token="ROOT/orders"] > .explorer-row')!;
      const innerDirRow = container.querySelector<HTMLElement>('li[data-token="ROOT/orders/2024"] > .explorer-row')!;

      fireDrag(outerDirRow, 'dragstart');
      fireDrag(outerDirRow, 'drop'); // onto itself
      fireDrag(innerDirRow, 'drop'); // into its own descendant
      expect(cb.onMove).not.toHaveBeenCalled();
    });

    it('root-background drop moves a nested entry to the primary root, but is a no-op for an already-top-level entry', () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);
      const tree = container.querySelector<HTMLElement>('ul[role="tree"]')!;

      // Already at the root -> no-op.
      fireDrag(fileRow(container, 'shared.koi'), 'dragstart');
      fireDrag(tree, 'drop');
      expect(cb.onMove).not.toHaveBeenCalled();

      // Nested -> moves to the primary root.
      fireDrag(fileRow(container, 'order.koi'), 'dragstart');
      fireDrag(tree, 'drop');
      const call = (cb.onMove as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0].token).toBe('ROOT/orders/order.koi');
      expect(call[1]).toBe('ROOT');
    });

    it('a rename-input row does not start a row drag (dragstart is prevented while editing targets it)', () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);
      const file = container.querySelector<HTMLElement>('li[data-token="ROOT/shared.koi"]')!;
      act(() => file.focus());
      act(() => { file.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })); });
      expect(file.querySelector('.explorer-rename')).not.toBeNull(); // mid-rename

      const row = file.querySelector<HTMLElement>(':scope > .explorer-row')!;
      const ev = new Event('dragstart', { bubbles: true, cancelable: true });
      act(() => { row.dispatchEvent(ev); });
      expect(ev.defaultPrevented).toBe(true); // dragstart was prevented, not started

      // Prove no drag actually started: a subsequent drop elsewhere fires no cb.onMove.
      fireDrag(dirRow(container), 'drop');
      expect(cb.onMove).not.toHaveBeenCalled();
    });

    // The load-bearing test for this task: STRICTLY STRONGER than explorer.test.ts's own "defers a
    // re-render while a drag is in progress" parity test (~736-757), which only proves survival across an
    // IDENTICAL re-render. Here the re-render's props actually CHANGE mid-drag (a DIFFERENT file's dirty
    // flag flips) — proving drop-validity checks stay correct not because a rebuild was deferred (there is
    // no such machinery here, and none is needed), but because validity is DATA-derived (`parentMapOf`) and
    // the dragged row's own DOM identity survives the re-render purely from being a keyed `<li key={token}>`.
    it("a mid-drag re-render with CHANGED data keeps the dragged row's DOM identity and the drop still fires the right onMove", () => {
      const cb = makeCallbacks();
      const store = createAppStore();
      const { container, rerender } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);

      const sharedLi = container.querySelector<HTMLElement>('li[data-token="ROOT/shared.koi"]')!;
      fireDrag(fileRow(container, 'shared.koi'), 'dragstart');
      expect(sharedLi.classList.contains('is-dragging')).toBe(true);

      // A diagnostics push mid-drag re-renders with CHANGED props — order.koi becomes dirty — while the
      // drag above is still in flight. NOT a rebuild: this is the same keyed <li>, unlike explorer.ts's
      // innerHTML-wipe render, which the OLD parity test had to defer specifically to avoid.
      const dirtyCb = makeCallbacks({ isDirty: vi.fn((t: string) => t === 'ROOT/orders/order.koi') });
      act(() => rerender(<ExplorerPanel store={store} cb={dirtyCb} groups={[group()]} />));

      const stillSharedLi = container.querySelector<HTMLElement>('li[data-token="ROOT/shared.koi"]')!;
      expect(stillSharedLi).toBe(sharedLi); // SAME DOM node reference, not rebuilt
      expect(stillSharedLi.classList.contains('is-dragging')).toBe(true); // drag state survived the re-render

      // Sanity: the re-render's OWN change did take effect elsewhere in the tree.
      const orderRow = container.querySelector('li[data-token="ROOT/orders/order.koi"] .explorer-row')!;
      expect(orderRow.querySelector('.tree-dirty')).not.toBeNull();

      // Drop still validates against the live `drag` state and fires the move.
      fireDrag(dirRow(container), 'dragover');
      fireDrag(dirRow(container), 'drop');
      expect((dirtyCb.onMove as ReturnType<typeof vi.fn>).mock.calls[0][0].token).toBe('ROOT/shared.koi');
      expect((dirtyCb.onMove as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('ROOT/orders');
    });
  });

  // ADR-0009 (#1188) active-context scope emphasis — the #989 gap this task fills in. Mirrors
  // explorer.test.ts's own "explorer — active-context scope emphasis (ADR 0009 / #1188)" describe
  // block (~lines 991-1069) scenario-for-scenario, driven through the `activeContext` prop instead of
  // the old imperative `Explorer.setActiveContext()` call — this is the parity gate the eventual
  // facade swap (task 8) depends on: once explorer.ts becomes a thin wrapper around `ExplorerPanel`,
  // that OLD suite's assertions run against THIS component, so every scenario there needs an
  // equivalent here today.
  describe('active-context scope emphasis (ADR 0009 / #1188)', () => {
    // Two context files (distinct stems), a non-`.koi` file, and a folder — same shape as
    // explorer.test.ts's own scopeTree(), so the two suites stay easy to cross-reference.
    function scopeTree(): FsEntry[] {
      return [
        { token: 'ROOT/Billing.koi', name: 'Billing.koi', relPath: 'Billing.koi', kind: 'file' },
        { token: 'ROOT/Ordering.koi', name: 'Ordering.koi', relPath: 'Ordering.koi', kind: 'file' },
        { token: 'ROOT/README.md', name: 'README.md', relPath: 'README.md', kind: 'file' },
        { token: 'ROOT/sub', name: 'sub', relPath: 'sub', kind: 'dir', children: [] },
      ];
    }
    function scopeGroup(): ExplorerRootGroup {
      return { root: 'ROOT', entries: scopeTree() };
    }
    function rowByName(container: Element, name: string): HTMLElement {
      return Array.from(container.querySelectorAll<HTMLElement>('.explorer-row')).find(
        (r) => r.querySelector('.explorer-name')?.textContent === name,
      )!;
    }

    it("emphasises the active context's .koi and de-emphasises the other contexts' .koi — never hiding", () => {
      const store = createAppStore();
      const { container } = render(
        <ExplorerPanel store={store} cb={makeCallbacks()} groups={[scopeGroup()]} activeContext="Billing" />,
      );

      expect(rowByName(container, 'Billing.koi').classList.contains('is-scoped')).toBe(true);
      expect(rowByName(container, 'Billing.koi').classList.contains('dim')).toBe(false);
      expect(rowByName(container, 'Ordering.koi').classList.contains('dim')).toBe(true);
      // Non-`.koi` files and folders stay neutral — the emphasis is on the context axis only.
      expect(rowByName(container, 'README.md').classList.contains('dim')).toBe(false);
      expect(rowByName(container, 'README.md').classList.contains('is-scoped')).toBe(false);
      expect(rowByName(container, 'sub').classList.contains('dim')).toBe(false);
      expect(rowByName(container, 'sub').classList.contains('is-scoped')).toBe(false);
      // Nothing is hidden — every row still renders (the whole-tree overview survives).
      expect(container.querySelectorAll('.explorer-row')).toHaveLength(4);
    });

    it('matches the context stem case-insensitively', () => {
      const store = createAppStore();
      const { container } = render(
        <ExplorerPanel store={store} cb={makeCallbacks()} groups={[scopeGroup()]} activeContext="BILLING" />,
      );
      expect(rowByName(container, 'Billing.koi').classList.contains('is-scoped')).toBe(true);
    });

    it('clears the emphasis for the All-contexts view (null)', () => {
      const store = createAppStore();
      const { container, rerender } = render(
        <ExplorerPanel store={store} cb={makeCallbacks()} groups={[scopeGroup()]} activeContext="Billing" />,
      );
      expect(rowByName(container, 'Billing.koi').classList.contains('is-scoped')).toBe(true);

      act(() =>
        rerender(<ExplorerPanel store={store} cb={makeCallbacks()} groups={[scopeGroup()]} activeContext={null} />),
      );
      expect(container.querySelector('.explorer-row.is-scoped')).toBeNull();
      expect(container.querySelector('.explorer-row.dim')).toBeNull();
    });

    it('defaults to no emphasis when activeContext is omitted', () => {
      const store = createAppStore();
      const { container } = render(<ExplorerPanel store={store} cb={makeCallbacks()} groups={[scopeGroup()]} />);
      expect(container.querySelector('.explorer-row.is-scoped')).toBeNull();
      expect(container.querySelector('.explorer-row.dim')).toBeNull();
    });

    it('a scope naming no .koi emphasises nothing — a no-op, not a whole-tree dim', () => {
      const store = createAppStore();
      const { container } = render(
        <ExplorerPanel store={store} cb={makeCallbacks()} groups={[scopeGroup()]} activeContext="Shipping" />,
      );
      expect(container.querySelector('.explorer-row.is-scoped')).toBeNull();
      expect(container.querySelector('.explorer-row.dim')).toBeNull();
    });

    it('never dims the active (open) file, even when it is out of scope', () => {
      const store = createAppStore();
      const cb = makeCallbacks({ isActive: (t: string) => t === 'ROOT/Ordering.koi' });
      const { container } = render(
        <ExplorerPanel store={store} cb={cb} groups={[scopeGroup()]} activeContext="Billing" />,
      );
      // Ordering.koi is the OPEN file but a different context — it stays legible (aria-current highlight).
      expect(rowByName(container, 'Ordering.koi').classList.contains('dim')).toBe(false);
      expect(rowByName(container, 'Billing.koi').classList.contains('is-scoped')).toBe(true);
    });

    it('survives a re-render (the emphasis is derived fresh from props every render)', () => {
      const store = createAppStore();
      const cb = makeCallbacks();
      const { container, rerender } = render(
        <ExplorerPanel store={store} cb={cb} groups={[scopeGroup()]} activeContext="Billing" />,
      );
      act(() => rerender(<ExplorerPanel store={store} cb={cb} groups={[scopeGroup()]} activeContext="Billing" />));
      expect(rowByName(container, 'Billing.koi').classList.contains('is-scoped')).toBe(true);
      expect(rowByName(container, 'Ordering.koi').classList.contains('dim')).toBe(true);
    });
  });

  // "Reveal in Files" (#453) + auto-reveal-on-active-change — the #989 task 8 gap this fills in ahead of
  // the facade swap. Mirrors explorer.test.ts's own "reveal active" / "reveal by context" its (~lines
  // 786-832) scenario-for-scenario, driven through the `reveal`/`activeContext`(via `cb.isActive`) props
  // instead of the old imperative `Explorer.revealByContext()`/auto-reveal-in-renderRoots() — the parity
  // gate `explorer.tsx`'s facade (task 8) depends on.
  describe('reveal (#989 task 8)', () => {
    function dirRow(container: Element): HTMLElement {
      return container.querySelector<HTMLElement>('li[data-kind="dir"] > .explorer-row')!;
    }
    function fileRow(container: Element, name: string): HTMLElement {
      return Array.from(container.querySelectorAll<HTMLElement>('.explorer-row')).find(
        (r) => r.querySelector('.explorer-name')?.textContent === name,
      )!;
    }

    it('revealByContext (the `reveal` prop) expands the ancestor folder and marks the matching .koi file is-revealed', () => {
      const store = createAppStore();
      const cb = makeCallbacks();
      const { container, rerender } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);

      // Collapse orders/ so the target is hidden.
      act(() => dirRow(container).click());
      expect(dirRow(container).closest('li')!.getAttribute('aria-expanded')).toBe('false');

      // The 'order' bounded context lives in orders/order.koi — reveal it by context name (case-
      // insensitive stem match): the ancestor folder re-expands and the file row is marked revealed.
      act(() => rerender(<ExplorerPanel store={store} cb={cb} groups={[group()]} reveal={{ context: 'order', seq: 1 }} />));
      expect(dirRow(container).closest('li')!.getAttribute('aria-expanded')).toBe('true');
      expect(fileRow(container, 'order.koi').classList.contains('is-revealed')).toBe(true);
    });

    it('is a silent no-op for a context with no matching .koi file', () => {
      const store = createAppStore();
      const cb = makeCallbacks();
      const { container, rerender } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);

      expect(() =>
        act(() =>
          rerender(<ExplorerPanel store={store} cb={cb} groups={[group()]} reveal={{ context: 'Nonexistent', seq: 1 }} />),
        ),
      ).not.toThrow();
      expect(container.querySelector('.explorer-row.is-revealed')).toBeNull();
    });

    it('re-triggers on the SAME context via a `seq` bump (a plain string would miss a repeat)', () => {
      const store = createAppStore();
      const cb = makeCallbacks();
      const { container, rerender } = render(
        <ExplorerPanel store={store} cb={cb} groups={[group()]} reveal={{ context: 'order', seq: 1 }} />,
      );
      expect(fileRow(container, 'order.koi').classList.contains('is-revealed')).toBe(true);

      // The user manually collapses orders/ again after the reveal...
      act(() => dirRow(container).click());
      expect(dirRow(container).closest('li')!.getAttribute('aria-expanded')).toBe('false');

      // ...and the SAME context is revealed again (seq bumped) — it must re-expand, not no-op as an
      // unchanged `context` string would.
      act(() => rerender(<ExplorerPanel store={store} cb={cb} groups={[group()]} reveal={{ context: 'order', seq: 2 }} />));
      expect(dirRow(container).closest('li')!.getAttribute('aria-expanded')).toBe('true');
    });

    it('auto-reveal fires only when the active file token changes, and respects a later manual collapse', () => {
      const store = createAppStore();
      const cb = makeCallbacks();
      const { container, rerender } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);

      act(() => dirRow(container).click()); // collapse orders/
      expect(dirRow(container).closest('li')!.getAttribute('aria-expanded')).toBe('false');

      // order.koi becomes active — a re-render auto-reveals it by re-expanding orders/.
      const activeCb = makeCallbacks({ isActive: (t: string) => t === 'ROOT/orders/order.koi' });
      act(() => rerender(<ExplorerPanel store={store} cb={activeCb} groups={[group()]} />));
      expect(dirRow(container).closest('li')!.getAttribute('aria-expanded')).toBe('true');

      // The user collapses again; a re-render with the SAME active file must not fight them (the effect
      // only fires when the active TOKEN changes, not on every re-render).
      act(() => dirRow(container).click());
      act(() => rerender(<ExplorerPanel store={store} cb={activeCb} groups={[group()]} />));
      expect(dirRow(container).closest('li')!.getAttribute('aria-expanded')).toBe('false');
    });

    // Code-review fix (Fix 2): `expandExplorerTokens` is a STORE write — Preact doesn't re-render (and
    // mount the previously-collapsed ancestor's children) synchronously within the SAME layout-effect pass
    // that calls it, so a bare `findRowEl(...)?.scrollIntoView(...)` right after it used to silently miss
    // the target row (it doesn't exist in the DOM yet — see ExplorerItem.tsx: a collapsed dir's children
    // simply aren't rendered). The expand/highlight land correctly regardless (already covered above) —
    // this pins that the scroll ALSO actually happens, once the row mounts, for BOTH reveal mechanisms.
    it('retries scrollIntoView (revealByContext) once a previously-collapsed ancestor actually mounts the revealed row', () => {
      const store = createAppStore();
      const cb = makeCallbacks();
      const { container, rerender } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);

      // Collapse orders/ BEFORE the reveal fires, so order.koi's row doesn't exist in the DOM at all when
      // the reveal effect's first (synchronous) pass runs.
      act(() => dirRow(container).click());
      expect(dirRow(container).closest('li')!.getAttribute('aria-expanded')).toBe('false');

      const scrolled: Element[] = [];
      const orig = Element.prototype.scrollIntoView;
      // happy-dom doesn't implement scrollIntoView; install a spy that records the element it lands on
      // (same pattern as GlossaryPanel.test.tsx's own scroll-target test).
      Element.prototype.scrollIntoView = function (this: Element) {
        scrolled.push(this);
      };
      try {
        act(() => rerender(<ExplorerPanel store={store} cb={cb} groups={[group()]} reveal={{ context: 'order', seq: 1 }} />));
        expect(dirRow(container).closest('li')!.getAttribute('aria-expanded')).toBe('true');
        const targetLi = container.querySelector<HTMLElement>('li[data-token="ROOT/orders/order.koi"]')!;
        expect(scrolled).toContain(targetLi);
      } finally {
        Element.prototype.scrollIntoView = orig;
      }
    });

    it('retries scrollIntoView (auto-reveal) once a previously-collapsed ancestor actually mounts the newly-active row', () => {
      const store = createAppStore();
      const cb = makeCallbacks();
      const { container, rerender } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);

      act(() => dirRow(container).click()); // collapse orders/
      expect(dirRow(container).closest('li')!.getAttribute('aria-expanded')).toBe('false');

      const scrolled: Element[] = [];
      const orig = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (this: Element) {
        scrolled.push(this);
      };
      try {
        const activeCb = makeCallbacks({ isActive: (t: string) => t === 'ROOT/orders/order.koi' });
        act(() => rerender(<ExplorerPanel store={store} cb={activeCb} groups={[group()]} />));
        expect(dirRow(container).closest('li')!.getAttribute('aria-expanded')).toBe('true');
        const targetLi = container.querySelector<HTMLElement>('li[data-token="ROOT/orders/order.koi"]')!;
        expect(scrolled).toContain(targetLi);
      } finally {
        Element.prototype.scrollIntoView = orig;
      }
    });

    // Code-review fix (Fix 3): `.is-revealed` is documented (`_explorer.scss`) as a TRANSIENT mark, but
    // `setRevealedToken` used to have exactly one call site, so once set it persisted forever — surviving
    // file switches, filtering, diagnostics pushes — until another explicit reveal. It must clear once a
    // DIFFERENT file becomes active (a real user navigation), but NOT when the revealed file itself is the
    // one that becomes active.
    it('clears the reveal highlight once a DIFFERENT file becomes active (transient, not permanent)', () => {
      const store = createAppStore();
      const cb = makeCallbacks();
      const { container, rerender } = render(
        <ExplorerPanel store={store} cb={cb} groups={[group()]} reveal={{ context: 'order', seq: 1 }} />,
      );
      expect(fileRow(container, 'order.koi').classList.contains('is-revealed')).toBe(true);

      // shared.koi becomes the active/open file — a real user navigation unrelated to the reveal.
      const activeCb = makeCallbacks({ isActive: (t: string) => t === 'ROOT/shared.koi' });
      act(() =>
        rerender(<ExplorerPanel store={store} cb={activeCb} groups={[group()]} reveal={{ context: 'order', seq: 1 }} />),
      );

      expect(container.querySelector('.explorer-row.is-revealed')).toBeNull();
    });

    it('does NOT clear the reveal highlight when the revealed file itself becomes the active one', () => {
      const store = createAppStore();
      const cb = makeCallbacks();
      const { container, rerender } = render(
        <ExplorerPanel store={store} cb={cb} groups={[group()]} reveal={{ context: 'order', seq: 1 }} />,
      );
      expect(fileRow(container, 'order.koi').classList.contains('is-revealed')).toBe(true);

      const activeCb = makeCallbacks({ isActive: (t: string) => t === 'ROOT/orders/order.koi' });
      act(() =>
        rerender(<ExplorerPanel store={store} cb={activeCb} groups={[group()]} reveal={{ context: 'order', seq: 1 }} />),
      );

      expect(fileRow(container, 'order.koi').classList.contains('is-revealed')).toBe(true);
    });

    // Code-review fix (Fix 4): a reveal firing while the user has a row/root context menu open shouldn't
    // scroll the tree out from under that menu's fixed-position chrome. The expand/highlight still apply
    // regardless — only the scroll itself is gated.
    it('skips the reveal scroll (but still expands/highlights) while a context menu is open', () => {
      const store = createAppStore();
      const cb = makeCallbacks();
      const { container, rerender } = render(<ExplorerPanel store={store} cb={cb} groups={[group()]} />);

      fileRow(container, 'shared.koi').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }),
      );
      expect(document.querySelector('.explorer-menu[role="menu"]')).not.toBeNull();

      const scrolled: Element[] = [];
      const orig = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (this: Element) {
        scrolled.push(this);
      };
      try {
        act(() => rerender(<ExplorerPanel store={store} cb={cb} groups={[group()]} reveal={{ context: 'order', seq: 1 }} />));
        expect(fileRow(container, 'order.koi').classList.contains('is-revealed')).toBe(true);
        expect(scrolled.length).toBe(0);
      } finally {
        Element.prototype.scrollIntoView = orig;
      }
    });
  });
});
