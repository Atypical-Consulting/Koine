import type { Meta, StoryObj } from '@storybook/preact-vite';
import { ExplorerPanel } from '@/shell/ExplorerPanel';
import type { FsEntry } from '@/host';
import type { ExplorerCallbacks, ExplorerRootGroup } from '@/shell/explorer';

// The workspace explorer's static keyed-tree render (#989 task 2). Fixtures mirror
// ExplorerPanel.test.tsx (proven a11y-clean): a two-context tree (a nested `orders/order.koi` plus a
// top-level `shared.koi`) for the single-root stories, and a disjoint second root for the multi-root
// story. No story wires keyboard nav, drag-and-drop, inline create/rename or the context menu — those
// land in later #989 tasks; New file/New folder/the empty-state "New file" button are inert placeholders.

function sampleTree(): FsEntry[] {
  return [
    {
      token: 'ROOT/orders',
      name: 'orders',
      relPath: 'orders',
      kind: 'dir',
      children: [
        { token: 'ROOT/orders/order.koi', name: 'order.koi', relPath: 'orders/order.koi', kind: 'file' },
        { token: 'ROOT/orders/notes.txt', name: 'notes.txt', relPath: 'orders/notes.txt', kind: 'file' },
      ],
    },
    { token: 'ROOT/shared.koi', name: 'shared.koi', relPath: 'shared.koi', kind: 'file' },
  ];
}

function group(root = 'ROOT'): ExplorerRootGroup {
  return { root, entries: sampleTree() };
}

function secondGroup(): ExplorerRootGroup {
  return {
    root: '/home/me/billing',
    entries: [
      {
        token: 'BILL/invoices',
        name: 'invoices',
        relPath: 'invoices',
        kind: 'dir',
        children: [{ token: 'BILL/invoices/invoice.koi', name: 'invoice.koi', relPath: 'invoices/invoice.koi', kind: 'file' }],
      },
      { token: 'BILL/billing.koi', name: 'billing.koi', relPath: 'billing.koi', kind: 'file' },
    ],
  };
}

// isActive/isDirty/diagCounts drive the active row, the unsaved-changes dot and the error/warning badge
// so the Populated story shows every static-render affordance at once (order.koi is active + dirty;
// shared.koi carries an error badge).
const cb: ExplorerCallbacks = {
  onOpenFile: () => {},
  onNewFile: () => {},
  onNewFolder: () => {},
  onRename: () => {},
  onDelete: () => {},
  onDuplicate: () => {},
  onMove: () => {},
  isActive: (token) => token === 'ROOT/orders/order.koi',
  isDirty: (token) => token === 'ROOT/orders/order.koi',
  diagCounts: (token) => (token === 'ROOT/shared.koi' ? { errors: 1, warnings: 0 } : { errors: 0, warnings: 0 }),
  onAddRoot: () => {},
  onRemoveRoot: () => {},
};

const meta = {
  title: 'Panels/ExplorerPanel',
  component: ExplorerPanel,
  parameters: { layout: 'padded' },
  args: {
    cb,
    groups: [group()],
  },
} satisfies Meta<typeof ExplorerPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A single workspace root: a collapsible folder plus a top-level `.koi` file, with the active/dirty
 *  file and an error badge shown. */
export const SingleRoot: Story = {};

/** Two workspace roots — a labeled `.explorer-group-header` (folder name + Remove) per root. */
export const MultiRoot: Story = {
  args: { groups: [group('/home/me/sales'), secondGroup()] },
};

/** The debounced filter pre-seeded (via `initialFilterText`, a test/story-only seam) to "order" — only
 *  the matching file (and its ancestor folder) render, with the match highlighted and the count chip lit. */
export const Filtered: Story = {
  args: { initialFilterText: 'order' },
};

/** A filter matching nothing: the no-match empty state replaces the tree entirely. */
export const NoMatch: Story = {
  args: { initialFilterText: 'zzz-nope' },
};

/** No workspace open: the empty-workspace state (with its "New file" affordance) replaces the tree. */
export const EmptyWorkspace: Story = {
  args: { groups: [] },
};
