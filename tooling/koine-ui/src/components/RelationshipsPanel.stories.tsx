import type { Meta, StoryObj } from '@storybook/preact-vite';
import { RelationshipsPanel, type RelationshipsPanelSlice, type RelationRowView } from './RelationshipsPanel';
import { readableStoreOf } from '../host/storeTestUtils';
import type { SourceSpan } from './SortableTable';

// The bottom-panel Relationships table: the tabular view of the model's STRUCTURAL edges, narrowed to the
// active bounded context by the host adapter. Strategic context→context relations are NOT shown here —
// their home is the Output → Context Map facet (#146). The stories seed a static `ReadableStore` double
// (`readableStoreOf`) with pre-scoped rows, mirroring what Koine Studio's adapter yields.

const span = (line: number): SourceSpan => ({
  file: 'file:///m.koi',
  line,
  column: 3,
  endLine: line,
  endColumn: 9,
  offset: 0,
  length: 6,
});

const rrow = (
  source: string,
  relation: string,
  target: string,
  contexts: string[],
  line: number,
): RelationRowView => ({ source, relation, target, contexts, span: span(line) });

const allRows: RelationRowView[] = [
  rrow('Order', 'contains', 'OrderItem', ['Sales'], 8),
  rrow('Stock', 'contains', 'StockLevel', ['Inv'], 24),
];

const meta = {
  title: 'Panels/RelationshipsPanel',
  component: RelationshipsPanel,
  parameters: { layout: 'padded' },
  args: {
    store: readableStoreOf<RelationshipsPanelSlice>({ rows: allRows }),
    handlers: { goto: () => {} },
  },
} satisfies Meta<typeof RelationshipsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Unscoped ("All contexts"): every structural relation is listed. */
export const AllContexts: Story = {};

/** Narrowed to Sales — the host adapter has already dropped Inv's row. */
export const Scoped: Story = {
  args: { store: readableStoreOf<RelationshipsPanelSlice>({ rows: [allRows[0]] }) },
};

/** Empty model — the Relationships-specific empty state. */
export const Empty: Story = {
  args: { store: readableStoreOf<RelationshipsPanelSlice>({ rows: [] }) },
};
