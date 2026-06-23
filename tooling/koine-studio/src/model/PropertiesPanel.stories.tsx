import type { Meta, StoryObj } from '@storybook/preact-vite';
import { PropertiesPanel } from '@/model/PropertiesPanel';
import { buildModelIndex } from '@/model/modelIndex';
import type { DiagramNode, DocsFile, DocsResult, GlossaryEntry, GlossaryModel, Range } from '@/lsp/lsp';
import type { InspectorHandlers } from '@/model/inspector';
import { createAppStore } from '@/store/index';

// The right-rail Properties inspector. It subscribes to the `selection` slice ONLY; the joined model index
// is passed in (the controller owns the fetch). With nothing selected it renders the inspector's own empty
// state. The index is built the same way PropertiesPanel.test.tsx (proven a11y-clean) does — a real
// buildModelIndex over a tiny glossary + a docs diagram node — so the `Selected` story resolves a genuine
// element and shows real inspector text.

const range: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } };

function makeIndex() {
  const glossary: GlossaryModel = {
    entries: [
      { id: 'Sales', name: 'Sales', kind: 'context', context: 'Sales', qualifiedName: 'Sales', doc: null, nameRange: range },
      { id: 'Sales.Order', name: 'Order', kind: 'aggregate', context: 'Sales', qualifiedName: 'Sales.Order', doc: null, nameRange: range },
    ] satisfies GlossaryEntry[],
  };
  const orderNode: DiagramNode = {
    id: 'Sales.Order',
    label: 'Order',
    kind: 'aggregate',
    qualifiedName: 'Sales.Order',
    sourceSpan: null,
    stereotype: 'aggregate root',
    members: [{ text: 'id: OrderId', kind: 'field' }],
  };
  const file: DocsFile = {
    path: 'docs/x.md',
    contents: '',
    diagrams: [{ caption: 'c', kind: 'aggregate', mermaid: '', graph: { nodes: [orderNode], edges: [] } }],
  };
  const docs: DocsResult = { files: [file] };
  return buildModelIndex(glossary, docs);
}

const handlers: InspectorHandlers = { onGoto: () => {} };

const meta = {
  title: 'Panels/PropertiesPanel',
  component: PropertiesPanel,
  parameters: { layout: 'padded' },
  args: {
    store: createAppStore(),
    index: makeIndex(),
    handlers,
  },
} satisfies Meta<typeof PropertiesPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Nothing selected → the inspector's empty state. */
export const Empty: Story = {};

/** An element selected → the inspector resolves it from the index and shows its properties. */
export const Selected: Story = {
  render: (args) => {
    const store = createAppStore();
    store.getState().setSelection({ qualifiedName: 'Sales.Order', context: 'Sales' });
    return <PropertiesPanel {...args} store={store} />;
  },
};
