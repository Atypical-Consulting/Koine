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
  // DOM node comes back after, not merely an equal-looking one.
  it('keeps the same DOM node for an unrelated row across a re-render (keyed identity)', () => {
    const cb = makeCallbacks();
    const { container, rerender } = render(<ExplorerPanel cb={cb} groups={[group()]} />);

    const untouched = container.querySelector('li[data-token="ROOT/orders/order.koi"]');
    expect(untouched).not.toBeNull();

    const dirtyCb = makeCallbacks({ isDirty: vi.fn((token: string) => token === 'ROOT/shared.koi') });
    act(() => rerender(<ExplorerPanel cb={dirtyCb} groups={[group()]} />));

    const stillUntouched = container.querySelector('li[data-token="ROOT/orders/order.koi"]');
    expect(stillUntouched).not.toBeNull();
    expect(stillUntouched).toBe(untouched); // same node reference, not just deep-equal

    // Sanity: the changed row DID pick up the new dirty dot.
    const sharedRow = container.querySelector('li[data-token="ROOT/shared.koi"] .explorer-row')!;
    expect(sharedRow.querySelector('.tree-dirty')).not.toBeNull();
  });

  it('has no accessibility violations (populated tree)', async () => {
    const { container } = render(<ExplorerPanel cb={makeCallbacks()} groups={[group('/home/me/sales'), secondGroup()]} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no accessibility violations (empty state)', async () => {
    const { container } = render(<ExplorerPanel cb={makeCallbacks()} groups={[]} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
