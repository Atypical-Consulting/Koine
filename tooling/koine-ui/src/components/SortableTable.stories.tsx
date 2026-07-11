import type { Meta, StoryObj } from '@storybook/preact-vite';
import { SortableTable, type SortableTableColumn, type SourceSpan } from './SortableTable';

// The shared sortable model table (issue #144 / #992 task 3): a dense, scannable `<table>` whose column
// headers are sort buttons (numeric-aware, case-insensitive, `aria-sort` reflected) and whose rows that
// carry a `span` are click/keyboard jump-to-source. It's store-free — plain `rows`/`columns`/`handlers`
// props — so this story seeds it directly (no `ReadableStore` double needed, unlike the panel stories).
//
// Moved from koine-studio's src/model/SortableTable.tsx (issue #1408, fourth-tranche extraction).

interface EventRow {
  name: string;
  type: string;
  publishedBy: string;
  span: SourceSpan | null;
}

const span = (line: number): SourceSpan => ({
  file: 'file:///sales.koi',
  line,
  column: 3,
  endLine: line,
  endColumn: 20,
  offset: 0,
  length: 17,
});

const columns: SortableTableColumn<EventRow>[] = [
  { header: 'Event', get: (r) => r.name },
  { header: 'Type', get: (r) => r.type },
  { header: 'Published by', get: (r) => r.publishedBy },
];

const rows: EventRow[] = [
  { name: 'OrderPlaced', type: 'domain', publishedBy: 'Order', span: span(12) },
  { name: 'PaymentCaptured', type: 'domain', publishedBy: 'Payment', span: span(28) },
  { name: 'InvoiceIssued', type: 'integration', publishedBy: 'Billing', span: span(41) },
];

const meta = {
  title: 'Panels/SortableTable',
  component: SortableTable,
  parameters: { layout: 'padded' },
  args: {
    rows,
    columns,
    emptyText: 'No events yet.',
    rowLabel: (r: EventRow) => r.name,
    handlers: { goto: () => {} },
  },
} satisfies Meta<typeof SortableTable<EventRow>>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A populated table: three sortable columns, each row a focusable jump-to-source link. */
export const WithRows: Story = {};

/** No rows: the table collapses to the `koi-table-empty` note carrying `emptyText`. */
export const Empty: Story = {
  args: { rows: [] },
};
