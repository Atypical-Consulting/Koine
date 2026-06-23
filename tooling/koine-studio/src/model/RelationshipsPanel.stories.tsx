import type { Meta, StoryObj } from '@storybook/preact-vite';
import { RelationshipsPanel } from '@/model/RelationshipsPanel';
import type { ContextMapResult, DiagramEdge, DiagramGraph, DiagramNode, SourceSpan } from '@/lsp/lsp';
import { createAppStore } from '@/store/index';

// The bottom-panel Relationships table. It narrows BOTH the structural edges (the diagram graph) and the
// strategic context-map relations to the active bounded context. Graph + context map are passed in (the
// controller owns the LSP fetch). The fixtures mirror RelationshipsPanel.test.tsx (proven a11y-clean); a
// fresh createAppStore() per story keeps the `Scoped` seed isolated.

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

// A structural relation in Sales and one in Inv, plus a strategic Sales→Shipping relation. Scoping to
// "Sales" keeps the Sales structural row + the strategic row and drops the Inv row.
const graph: DiagramGraph = {
  nodes: [
    node('Order', 'aggregate-root', 'Sales.Order', 3),
    node('OrderItem', 'value-object', 'Sales.OrderItem', 8),
    node('Stock', 'aggregate-root', 'Inv.Stock', 20),
    node('StockLevel', 'value-object', 'Inv.StockLevel', 24),
  ],
  edges: [edge('Order', 'OrderItem'), edge('Stock', 'StockLevel')],
};

const contextMap: ContextMapResult = {
  contexts: ['Sales', 'Shipping', 'Inv'],
  relations: [
    { upstream: 'Sales', downstream: 'Shipping', kind: 'Customer/Supplier', bidirectional: false, sharedTypes: [], acl: [] },
  ],
};

const meta = {
  title: 'Panels/RelationshipsPanel',
  component: RelationshipsPanel,
  parameters: { layout: 'padded' },
  args: {
    store: createAppStore(),
    graph,
    contextMap,
    handlers: { goto: () => {} },
  },
} satisfies Meta<typeof RelationshipsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Unscoped ("All contexts"): every structural and strategic relation is listed. */
export const AllContexts: Story = {};

/** Narrowed to Sales — Sales' structural row + the Sales→Shipping strategic row; Inv's row is dropped. */
export const Scoped: Story = {
  render: (args) => {
    const store = createAppStore();
    store.getState().setActiveContext('Sales');
    return <RelationshipsPanel {...args} store={store} />;
  },
};
