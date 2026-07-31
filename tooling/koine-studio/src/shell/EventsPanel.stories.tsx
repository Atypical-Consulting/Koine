import type { Meta, StoryObj } from '@storybook/preact-vite';
import {
  EventsPanel,
  type EventRowView,
  type EventsPanelSlice,
  type FlowRenderer,
  type ReadableStore,
  type SourceSpan,
  type TableHandlers,
} from '@atypical/koine-ui';

// The bottom-panel Events view's Table | Flow toggle (#1408). Koine Studio mounts the real
// `<EventsPanel>` via `loadEventsPanel` (`src/shell/inspector/surfaceLoaders.tsx`), feeding it the app's
// own `createEventsPanelStore` adapter (a real `StoreApi<AppState>` + the merged diagram graph) — too
// heavy to seed here, so this story fakes the `ReadableStore<EventsPanelSlice>` contract directly, the
// same way `SourceControlPanel.stories.tsx` fakes its `GitSurface` dependency. koine-ui ships its own
// `EventsPanel.stories.tsx`, but koine-ui's `vitest.config.ts` has no Storybook/Chromium/axe project, so
// it never runs a live colour-contrast pass — and this app owns the accent-tinted
// `.koi-events-view-btn[aria-pressed='true']` rule its own SCSS applies. This story closes that gap
// (#1706, following #1704's contrast fix there, verified only by computed relative-luminance math) via
// this package's `storybook` vitest project, which does run `@storybook/addon-a11y`'s Chromium pass.
//
// `EventsPanel`'s `view` state defaults to `'table'` (no `initialView` override), so the Table button is
// already `aria-pressed="true"` on initial mount — no `play` interaction needed to reach the tinted state.

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

const slice: EventsPanelSlice = {
  scopeKey: 'all',
  rows: [
    erow('OrderPlaced', 'Sales.OrderPlaced', 'domain', 'Order', 'Sales', 'on checkout'),
    erow('OrderShipped', 'Shipping.OrderShipped', 'integration', 'Shipment', 'Shipping'),
  ],
  flowNodes: [],
};

/** A static, never-notifying {@link ReadableStore} double over one fixed slice — this story never
 *  drives interactions, so no subscriber ever needs to hear about a change. */
function readableStoreOf<T>(value: T): ReadableStore<T> {
  return { getState: () => value, subscribe: () => () => {} };
}

const handlers: TableHandlers = { goto: () => {} };

// The Storybook flow renderer is a no-op — maxGraph stays a Koine Studio concern the story never loads.
const noRenderFlow: FlowRenderer = () => ({ dispose: () => {} });

const meta = {
  title: 'Shell/EventsPanel',
  component: EventsPanel,
  parameters: { layout: 'padded' },
  args: {
    store: readableStoreOf(slice),
    handlers,
    renderFlow: noRenderFlow,
  },
} satisfies Meta<typeof EventsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The default Table view: `.koi-events-view-btn[aria-pressed='true']` on the Table toggle, styled by
 *  this app's own accent-tinted rule. Axe's Chromium colour-contrast pass covers it. */
export const TableSelected: Story = {};
