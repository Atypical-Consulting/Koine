import type { Meta, StoryObj } from '@storybook/preact-vite';
import { CanvasPalette } from '@/diagrams/CanvasPalette';
import { createAppStore } from '@/store/index';

// The construct palette. The round-trip buttons enable only when a single bounded context is active;
// each story seeds a fresh createAppStore() so the active-scope state doesn't bleed between stories.
const meta = {
  title: 'Panels/CanvasPalette',
  component: CanvasPalette,
  parameters: { layout: 'fullscreen' },
  args: { store: createAppStore(), onAdd: () => {} },
} satisfies Meta<typeof CanvasPalette>;

export default meta;
type Story = StoryObj<typeof meta>;

/** "All contexts" active: the construct buttons are disabled (no unambiguous target). */
export const NoContext: Story = {};

/** A single bounded context active: the construct buttons are enabled. */
export const ContextActive: Story = {
  render: (args) => {
    const store = createAppStore();
    store.getState().setActiveContext('Ordering');
    return <CanvasPalette {...args} store={store} />;
  },
};
