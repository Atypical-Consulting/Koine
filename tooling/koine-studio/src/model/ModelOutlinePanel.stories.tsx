import type { Meta, StoryObj } from '@storybook/preact-vite';
import { ModelOutlinePanel } from '@/model/ModelOutlinePanel';
import type { GlossaryEntry, GlossaryModel, Range } from '@/lsp/lsp';
import type { ModelOutlineHandlers } from '@/model/modelOutline';
import { createAppStore } from '@/store/index';

// The left-rail Explorer construct tree. It narrows by the active bounded context AND highlights the
// store's selected leaf, with a store-backed type-to-filter box on top. The model is passed in (the
// controller owns the LSP fetch). Fixtures mirror ModelOutlinePanel.test.tsx (proven a11y-clean); each
// non-default story builds a fresh createAppStore() so its scope/filter/selection seed stays isolated.

const range: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

// Sales owns Order, Inv owns Stock — scoping to "Sales" keeps Order and drops Stock.
const model: GlossaryModel = {
  entries: [
    { id: 'Sales.Order', name: 'Order', kind: 'aggregate', context: 'Sales', qualifiedName: 'Sales.Order', doc: null, nameRange: range },
    { id: 'Inv.Stock', name: 'Stock', kind: 'entity', context: 'Inv', qualifiedName: 'Inv.Stock', doc: null, nameRange: range },
  ] satisfies GlossaryEntry[],
};

const handlers: ModelOutlineHandlers = {
  onSelect: () => {},
  goto: () => {},
  onOpenContextMap: () => {},
  onOpenGlossary: () => {},
};

const meta = {
  title: 'Panels/ModelOutlinePanel',
  component: ModelOutlinePanel,
  parameters: { layout: 'padded' },
  args: {
    store: createAppStore(),
    model,
    handlers,
  },
} satisfies Meta<typeof ModelOutlinePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Unscoped, unfiltered ("All contexts"): every bounded context's construct leaves are present. */
export const AllContexts: Story = {};

/** Narrowed to the Sales context — only Sales' construct leaves remain. */
export const Scoped: Story = {
  render: (args) => {
    const store = createAppStore();
    store.getState().setActiveContext('Sales');
    return <ModelOutlinePanel {...args} store={store} />;
  },
};

/** The store-backed type-to-filter box pre-seeded with a query that keeps only the matching leaf. */
export const Filtered: Story = {
  render: (args) => {
    const store = createAppStore();
    store.getState().setOutlineFilter('Ord');
    return <ModelOutlinePanel {...args} store={store} />;
  },
};

/** A selected element cross-highlighted in the tree (the `is-selected` leaf). */
export const WithSelection: Story = {
  render: (args) => {
    const store = createAppStore();
    store.getState().setSelection({ qualifiedName: 'Sales.Order', context: 'Sales' });
    return <ModelOutlinePanel {...args} store={store} />;
  },
};
