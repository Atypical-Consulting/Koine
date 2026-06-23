import type { Meta, StoryObj } from '@storybook/preact-vite';
import { EventsPanel } from '@/model/EventsPanel';
import type { DiagramEdge, DiagramGraph, DiagramNode, SourceSpan } from '@/lsp/lsp';
import { createAppStore } from '@/store/index';

// The bottom-panel Events table. The merged diagram graph is passed in (the controller owns the LSP
// fetch); the panel narrows it to the active bounded context. Stories build a small two-context graph
// fixture — identical to EventsPanel.test.tsx, which proves it a11y-clean — and a fresh createAppStore()
// per story so the `Scoped` story can seed `activeContext` without bleeding into the others.

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

// A domain event in Sales and an integration event in Shipping, so scoping to "Sales" drops the Shipping one.
const graph: DiagramGraph = {
  nodes: [
    node('Order', 'aggregate-root', 'Sales.Order', 3),
    node('OrderPlaced', 'event', 'Sales.OrderPlaced', 12),
    node('ShipDispatched', 'event', 'Shipping.ShipDispatched', 40),
    node('Shipment', 'aggregate-root', 'Shipping.Shipment', 30),
  ],
  edges: [edge('Order', 'OrderPlaced'), edge('Shipment', 'ShipDispatched')],
};

const meta = {
  title: 'Panels/EventsPanel',
  component: EventsPanel,
  parameters: { layout: 'padded' },
  args: {
    store: createAppStore(),
    graph,
    handlers: { goto: () => {} },
  },
} satisfies Meta<typeof EventsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Unscoped ("All contexts"): every bounded context's events are listed. */
export const AllContexts: Story = {};

/** Narrowed to the Sales context — only Sales' events remain. */
export const Scoped: Story = {
  render: (args) => {
    const store = createAppStore();
    store.getState().setActiveContext('Sales');
    return <EventsPanel {...args} store={store} />;
  },
};
