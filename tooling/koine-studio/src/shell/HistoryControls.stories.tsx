import type { Meta, StoryObj } from '@storybook/preact-vite';
import { HistoryControls } from '@/shell/HistoryControls';
import { createAppStore } from '@/store/index';

// The undo/redo control pair. Disabled state is driven by the store's history slice (canUndo/canRedo).
// Default args supply the required props; the Enabled story overrides the store via `render` to seed the
// history flags, using a fresh createAppStore() so it doesn't bleed into the other story.
const meta = {
  title: 'Panels/HistoryControls',
  component: HistoryControls,
  parameters: { layout: 'centered' },
  args: {
    store: createAppStore(),
    onUndo: () => {},
    onRedo: () => {},
    undoTitle: 'Undo',
    redoTitle: 'Redo',
  },
} satisfies Meta<typeof HistoryControls>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Fresh history: both buttons disabled (nothing to undo or redo yet). */
export const Disabled: Story = {};

/** Both undo and redo available. */
export const Enabled: Story = {
  render: (args) => {
    const store = createAppStore();
    store.getState().setHistoryState({ canUndo: true, canRedo: true });
    return <HistoryControls {...args} store={store} />;
  },
};
