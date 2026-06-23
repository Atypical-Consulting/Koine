import type { Meta, StoryObj } from '@storybook/preact-vite';
import { ContextBreadcrumb } from '@/model/ContextBreadcrumb';
import { createAppStore } from '@/store/index';

// ContextBreadcrumb is the cleanest leaf panel to story-ize: idiomatic Preact JSX, store injected as a
// prop, mutations routed out through onScopeChange. Default args supply the required props (the component
// has no optional props, so a `render`-only story wouldn't type-check); a story overrides the store via
// `render` when it needs a specific scope, building a FRESH createAppStore() so stories never share state.
const meta = {
  title: 'Panels/ContextBreadcrumb',
  component: ContextBreadcrumb,
  parameters: { layout: 'centered' },
  args: {
    store: createAppStore(),
    contexts: ['Ordering', 'Billing', 'Shipping'],
    index: null,
    onScopeChange: () => {},
  },
} satisfies Meta<typeof ContextBreadcrumb>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The default "All contexts" state: the scope selector lists every bounded context, nothing narrowed. */
export const AllContexts: Story = {};

/** Narrowed to a single bounded context — the selector reflects the active scope (full-strength styling). */
export const Scoped: Story = {
  render: (args) => {
    const store = createAppStore();
    store.getState().setActiveContext('Ordering');
    return <ContextBreadcrumb {...args} store={store} />;
  },
};
