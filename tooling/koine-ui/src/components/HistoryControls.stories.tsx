import type { Meta, StoryObj } from '@storybook/preact-vite';
import { HistoryControls, type HistoryControlsSlice } from './HistoryControls';
import type { ReadableStore } from '../host/store';

// The undo/redo control pair. Disabled state is driven by the host's `ReadableStore<HistoryControlsSlice>`
// (issue #944's host-adapter contract) instead of koine-studio's concrete Zustand store — this Storybook
// file mocks that contract directly, matching HistoryControls.test.tsx's `createMockHistoryStore`.

function readableStoreOf(initial: HistoryControlsSlice): ReadableStore<HistoryControlsSlice> {
  return {
    getState: () => initial,
    subscribe: () => () => {},
  };
}

const meta = {
  title: 'Panels/HistoryControls',
  component: HistoryControls,
  parameters: { layout: 'centered' },
  args: {
    store: readableStoreOf({ canUndo: false, canRedo: false }),
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
  args: {
    store: readableStoreOf({ canUndo: true, canRedo: true }),
  },
};
