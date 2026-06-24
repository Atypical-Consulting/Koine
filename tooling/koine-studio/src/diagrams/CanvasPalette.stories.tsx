import type { Meta, StoryObj } from '@storybook/preact-vite';
import { CanvasPalette } from '@/diagrams/CanvasPalette';
import { createAppStore } from '@/store/index';
import { buildModelIndex, type ModelIndex } from '@/model/modelIndex';
import type { GlossaryModel, Range } from '@/lsp/lsp';

const range: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

// A model index holding one aggregate `Sales.Orders`, so a selection of it enables the aggregate-scoped
// (rule / repository) buttons (#254).
function aggregateIndex(): ModelIndex {
  const glossary: GlossaryModel = {
    entries: [
      { id: 'Sales', name: 'Sales', kind: 'context', context: 'Sales', qualifiedName: 'Sales', doc: null, nameRange: range },
      { id: 'Sales.Orders', name: 'Orders', kind: 'aggregate', context: 'Sales', qualifiedName: 'Sales.Orders', doc: null, nameRange: range },
    ],
  };
  return buildModelIndex(glossary, { files: [] });
}

// The construct palette. Context-scoped buttons enable only when a single bounded context is active;
// aggregate-scoped buttons (rule / repository) enable only when an aggregate is selected. Each story
// seeds a fresh createAppStore() so the active-scope/selection state doesn't bleed between stories.
const meta = {
  title: 'Panels/CanvasPalette',
  component: CanvasPalette,
  parameters: { layout: 'fullscreen' },
  args: { store: createAppStore(), index: null, onAdd: () => {}, onAddAggregateMember: () => {} },
} satisfies Meta<typeof CanvasPalette>;

export default meta;
type Story = StoryObj<typeof meta>;

/** "All contexts" active, nothing selected: every button is disabled (no unambiguous target). */
export const NoContext: Story = {};

/** A single bounded context active: the context-scoped construct buttons are enabled. */
export const ContextActive: Story = {
  render: (args) => {
    const store = createAppStore();
    store.getState().setActiveContext('Ordering');
    return <CanvasPalette {...args} store={store} />;
  },
};

/** An aggregate selected: the aggregate-scoped Rule + Repository buttons are enabled (#254). */
export const AggregateSelected: Story = {
  render: (args) => {
    const store = createAppStore();
    store.getState().setSelection({ qualifiedName: 'Sales.Orders', context: 'Sales' });
    return <CanvasPalette {...args} store={store} index={aggregateIndex()} />;
  },
};
