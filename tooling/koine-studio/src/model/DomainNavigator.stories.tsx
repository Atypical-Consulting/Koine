import type { Meta, StoryObj } from '@storybook/preact-vite';
// Explicit `.tsx` extension (allowImportingTsExtensions is on): `DomainNavigator.tsx` and the
// `domainNavigator.ts` barrel differ ONLY by case, so a bare `@/model/DomainNavigator` probes `.ts`
// first and case-insensitively resolves to the lowercase barrel on macOS — importing the component as
// `undefined` (Preact then silently renders "[object Object]", no error). The explicit extension pins it.
import { DomainNavigator } from '@/model/DomainNavigator.tsx';
import type { GlossaryEntry, GlossaryModel, ModelNode, Range } from '@/lsp/lsp';
import type { DomainNavigatorHandlers, TacticalHandlers } from '@/model/DomainNavigator.tsx';
import { createAppStore } from '@/store/index';

// The DDD Domain navigator (#453, migrated to Preact in #991): a strategic bounded-context list with two
// cross-context doorways, drilling into a per-context tactical tree of aggregates + owned constructs. The
// component is props-driven (the live `mountDomainNavigator` facade owns the LSP fetch + store
// subscription); these stories seed the `cache` + altitude directly so each altitude renders statically.
// A fresh `createAppStore()` per story isolates the drill/breadcrumb writes. Fixtures mirror
// domainNavigator.test.ts (proven a11y-clean); the Storybook/Chromium project runs each story with axe.

const range: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

const entry = (name: string, context: string, kind: string): GlossaryEntry => ({
  id: `${context}.${name}`,
  name,
  kind,
  context,
  qualifiedName: `${context}.${name}`,
  doc: null,
  nameRange: range,
});

// A two-context glossary (Ordering, Billing), each with a spread of constructs so the count badge tallies.
function fakeGlossary(contexts: string[]): GlossaryModel {
  const entries: GlossaryEntry[] = [];
  for (const ctx of contexts) {
    entries.push(entry(ctx, ctx, 'context'));
    entries.push(entry(`${ctx}Order`, ctx, 'aggregate'));
    entries.push(entry(`${ctx}Line`, ctx, 'entity'));
    entries.push(entry(`${ctx}Money`, ctx, 'value'));
    entries.push(entry(`${ctx}Status`, ctx, 'enum'));
    entries.push(entry(`${ctx}Placed`, ctx, 'event'));
  }
  return { entries };
}

const node = (kind: string, title: string, children: ModelNode[] = []): ModelNode => ({
  kind,
  qualifiedName: title,
  title,
  members: [],
  children,
});

// The Ordering context as a model graph: one aggregate owning three constructs, plus a context-level peer.
const orderingTree: ModelNode = node('model', '', [
  node('context', 'Ordering', [
    { ...node('aggregate', 'Order', [node('entity', 'Order'), node('value', 'Money'), node('event', 'OrderPlaced')]), qualifiedName: 'Ordering.Order' },
    node('value', 'Currency'),
  ]),
]);

const cache = { model: fakeGlossary(['Ordering', 'Billing']), relLinks: 3, tree: orderingTree };

const handlers: DomainNavigatorHandlers = { onOpenContextMap: () => {}, onOpenGlossary: () => {} };
const tacticalHandlers: TacticalHandlers = { onSelect: () => {}, goto: () => {}, reveal: () => {}, setAxis: () => {} };

const meta = {
  title: 'Panels/DomainNavigator',
  component: DomainNavigator,
  parameters: { layout: 'padded' },
  args: {
    store: createAppStore(),
    navAltitude: 'strategic',
    activeContext: 'all',
    outlineFilter: '',
    cache,
    contentToken: 0,
    handlers,
    tacticalHandlers,
  },
} satisfies Meta<typeof DomainNavigator>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The strategic altitude — every bounded context plus the Context Map / Glossary doorways. */
export const Strategic: Story = {};

/** Strategic, scoped to Ordering — its row carries the active-context marker (◆ + accent), the rest plain. */
export const StrategicScoped: Story = {
  args: { activeContext: 'Ordering' },
};

/** The tactical altitude for the Ordering context — the breadcrumb + its aggregates and owned constructs. */
export const Tactical: Story = {
  render: (args) => {
    const store = createAppStore();
    store.getState().setActiveContext('Ordering');
    store.getState().setNavAltitude('tactical');
    return <DomainNavigator {...args} store={store} navAltitude="tactical" activeContext="Ordering" />;
  },
};

/** The loading placeholder shown before the strategic fetch resolves (the filter input is hidden). */
export const Loading: Story = {
  args: { cache: null },
};

/** The empty state — a valid but element-less model (the filter input is hidden). */
export const Empty: Story = {
  args: { cache: { model: { entries: [] }, relLinks: 0, tree: null } },
};
