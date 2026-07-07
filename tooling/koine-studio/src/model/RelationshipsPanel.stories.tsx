import type { Meta, StoryObj } from '@storybook/preact-vite';
import { RelationshipsPanel } from '@/model/RelationshipsPanel';
import type { DiagramEdge, DiagramGraph, DiagramNode, SourceSpan } from '@/lsp/lsp';
import { createAppStore } from '@/store/index';

// The bottom-panel Relationships table: the tabular view of the model's STRUCTURAL edges (the diagram
// graph), narrowed to the active bounded context. Strategic context→context relations are NOT shown here
// — their home is the Output → Context Map facet (#146) — so only the graph is passed in (the controller
// owns the LSP fetch). The fixtures mirror RelationshipsPanel.test.tsx (proven a11y-clean); a fresh
// createAppStore() per story keeps the `Scoped` seed isolated.

const span = (line: number): SourceSpan => ({
  file: 'file:///m.koi',
  line,
  column: 3,
  endLine: line,
  endColumn: 9,
  offset: 0,
  length: 6,
});

const node = (id: string, kind: string, qualifiedName: string, line: number): DiagramNode => ({
  id,
  label: id,
  kind,
  qualifiedName,
  sourceSpan: span(line),
  stereotype: null,
  members: [],
});

const edge = (from: string, to: string): DiagramEdge => ({ from, to, label: null });

// A structural relation in Sales and one in Inv. Scoping to "Sales" keeps the Sales structural row and
// drops the Inv row. (Strategic context→context relations are the Context Map facet's concern, not this
// table's — so the fixture has none.)
const graph: DiagramGraph = {
  nodes: [
    node('Order', 'aggregate-root', 'Sales.Order', 3),
    node('OrderItem', 'value-object', 'Sales.OrderItem', 8),
    node('Stock', 'aggregate-root', 'Inv.Stock', 20),
    node('StockLevel', 'value-object', 'Inv.StockLevel', 24),
  ],
  edges: [edge('Order', 'OrderItem'), edge('Stock', 'StockLevel')],
};

const meta = {
  title: 'Panels/RelationshipsPanel',
  component: RelationshipsPanel,
  parameters: { layout: 'padded' },
  args: {
    store: createAppStore(),
    graph,
    handlers: { goto: () => {} },
  },
} satisfies Meta<typeof RelationshipsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Unscoped ("All contexts"): every structural relation is listed. */
export const AllContexts: Story = {};

/** Narrowed to Sales — Sales' structural row is kept; Inv's row is dropped. */
export const Scoped: Story = {
  render: (args) => {
    const store = createAppStore();
    store.getState().setActiveContext('Sales');
    return <RelationshipsPanel {...args} store={store} />;
  },
};
