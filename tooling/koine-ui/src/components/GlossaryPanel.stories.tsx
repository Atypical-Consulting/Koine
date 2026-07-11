import type { Meta, StoryObj } from '@storybook/preact-vite';
import {
  GlossaryPanel,
  type GlossaryEntryView,
  type GlossaryGroupView,
  type GlossaryPanelSlice,
  type GlossaryRange,
} from './GlossaryPanel';
import { readableStoreOf } from '../host/storeTestUtils';

// The ubiquitous-language glossary editor (coverage gauge + inline description editors). The host adapter
// scopes the glossary model to the active bounded context, groups it, and computes coverage; the stories
// seed a static `ReadableStore` double with an already-derived slice.

const range: GlossaryRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

const entry = (
  name: string,
  context: string,
  kind = 'value',
  doc: string | null = null,
): GlossaryEntryView => ({
  id: `${context}.${name}`,
  name,
  kind,
  context,
  qualifiedName: `${context}.${name}`,
  doc,
  nameRange: range,
});

function sliceOf(entries: GlossaryEntryView[]): GlossaryPanelSlice {
  const groups: GlossaryGroupView[] = [];
  for (const e of entries) {
    let g = groups.find((x) => x.context === e.context);
    if (!g) {
      g = { context: e.context, entries: [] };
      groups.push(g);
    }
    g.entries.push(e);
  }
  const documented = entries.filter((e) => e.doc != null && e.doc.trim().length > 0).length;
  const total = entries.length;
  const pct = total === 0 ? 0 : Math.round((documented / total) * 100);
  return { groups, coverage: { documented, total, pct } };
}

// A two-context glossary: Sales owns Order, Inv owns Stock; a partial documentation coverage.
const allEntries = [
  entry('Sales', 'Sales', 'context', 'The sales bounded context.'),
  entry('Order', 'Sales', 'aggregate', 'A customer order.'),
  entry('OrderItem', 'Sales', 'value'),
  entry('Inv', 'Inv', 'context'),
  entry('Stock', 'Inv', 'entity'),
];

const meta = {
  title: 'Panels/GlossaryPanel',
  component: GlossaryPanel,
  parameters: { layout: 'padded' },
  args: {
    store: readableStoreOf<GlossaryPanelSlice>(sliceOf(allEntries)),
    handlers: { onGoto: () => {}, onSave: () => {} },
  },
} satisfies Meta<typeof GlossaryPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Unscoped ("All contexts"): every bounded context's concepts are listed. */
export const AllContexts: Story = {};

/** Narrowed to the Sales context — the host adapter has already dropped Inv's concepts. */
export const Scoped: Story = {
  args: {
    store: readableStoreOf<GlossaryPanelSlice>(
      sliceOf(allEntries.filter((e) => e.context === 'Sales')),
    ),
  },
};
