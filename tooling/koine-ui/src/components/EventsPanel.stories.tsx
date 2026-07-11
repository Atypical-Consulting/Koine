import type { Meta, StoryObj } from '@storybook/preact-vite';
import {
  EventsPanel,
  type EventFlowNodeView,
  type EventRowView,
  type EventsPanelSlice,
  type FlowRenderer,
} from './EventsPanel';
import { readableStoreOf } from '../host/storeTestUtils';
import type { SourceSpan } from './SortableTable';

// The bottom-panel Events view (Table | Flow toggle). The host adapter pre-scopes the merged graph to the
// active context and pre-extracts the table rows + flow legend nodes; the maxGraph flow canvas is rendered
// host-side via an injected `renderFlow` callback. In Storybook the canvas renderer is a no-op (maxGraph is
// a Koine Studio concern) — the Flow story shows the SR-only legend + the empty mount.

const span = (line: number): SourceSpan => ({
  file: 'file:///m.koi',
  line,
  column: 3,
  endLine: line,
  endColumn: 9,
  offset: 0,
  length: 6,
});

const erow = (
  name: string,
  qualifiedName: string,
  type: 'domain' | 'integration',
  publishedBy: string,
  context: string,
  when = '',
): EventRowView => ({ name, qualifiedName, type, publishedBy, context, when, span: span(1) });

const fnode = (id: string, label: string, kind: EventFlowNodeView['kind'], context: string): EventFlowNodeView => ({
  id,
  label,
  kind,
  context,
});

const slice: EventsPanelSlice = {
  scopeKey: 'all',
  rows: [
    erow('OrderPlaced', 'Sales.OrderPlaced', 'domain', 'Order', 'Sales', 'on checkout'),
    erow('OrderShipped', 'Shipping.OrderShipped', 'integration', 'Shipment', 'Shipping'),
  ],
  flowNodes: [
    fnode('n1', 'OrderPlaced', 'domain-event', 'Sales'),
    fnode('n2', 'OrderShipped', 'integration-event', 'Shipping'),
  ],
};

// The Storybook flow renderer is a no-op — maxGraph stays a Koine Studio concern.
const noRenderFlow: FlowRenderer = () => ({ dispose: () => {} });

const meta = {
  title: 'Panels/EventsPanel',
  component: EventsPanel,
  parameters: { layout: 'padded' },
  args: {
    store: readableStoreOf<EventsPanelSlice>(slice),
    handlers: { goto: () => {} },
    renderFlow: noRenderFlow,
  },
} satisfies Meta<typeof EventsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The default Table view: the model's domain + integration events. */
export const Table: Story = {};

/** The Flow view — the host-owned canvas mount plus the SR-only legend of events in the flow. */
export const Flow: Story = { args: { initialView: 'flow' } };

/** Empty model — the Events-specific empty state. */
export const Empty: Story = {
  args: { store: readableStoreOf<EventsPanelSlice>({ scopeKey: 'all', rows: [], flowNodes: [] }) },
};
