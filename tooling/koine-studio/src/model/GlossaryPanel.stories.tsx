import type { Meta, StoryObj } from '@storybook/preact-vite';
import { GlossaryPanel } from '@/model/GlossaryPanel';
import type { GlossaryEntry, GlossaryModel, Range } from '@/lsp/lsp';
import type { GlossaryHandlers } from '@/model/glossary';
import { createAppStore } from '@/store/index';

// The ubiquitous-language glossary editor (coverage gauge + inline description editors). The glossary
// model is passed in (the controller owns the LSP fetch); the panel narrows it to the active bounded
// context. Fixtures mirror GlossaryPanel.test.tsx (proven a11y-clean); a fresh createAppStore() per story
// isolates the `Scoped` seed.

const range: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

const entry = (name: string, context: string, kind = 'value'): GlossaryEntry => ({
  id: `${context}.${name}`,
  name,
  kind,
  context,
  qualifiedName: `${context}.${name}`,
  doc: null,
  nameRange: range,
});

// A two-context glossary: Sales owns Order, Inv owns Stock. Scoping to "Sales" keeps Order, drops Stock.
const model: GlossaryModel = { entries: [entry('Order', 'Sales', 'aggregate'), entry('Stock', 'Inv', 'entity')] };

const handlers: GlossaryHandlers = { onGoto: () => {}, onSave: () => {} };

const meta = {
  title: 'Panels/GlossaryPanel',
  component: GlossaryPanel,
  parameters: { layout: 'padded' },
  args: {
    store: createAppStore(),
    model,
    handlers,
  },
} satisfies Meta<typeof GlossaryPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Unscoped ("All contexts"): every bounded context's concepts are listed. */
export const AllContexts: Story = {};

/** Narrowed to the Sales context — only Sales' concepts remain. */
export const Scoped: Story = {
  render: (args) => {
    const store = createAppStore();
    store.getState().setActiveContext('Sales');
    return <GlossaryPanel {...args} store={store} />;
  },
};
