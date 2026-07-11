import type { Meta, StoryObj } from '@storybook/preact-vite';
import { ShortcutsTable } from '@/shared/HelpTable';
import { helpRows } from '@/shell/ideUtils';

// The keyboard-shortcuts table rendered into the shared createModal() body (src/shared/help.ts). Each
// ShortcutRow's chord is split on '+' into one .koi-kbd keycap per segment; a literal 'mod' segment
// renders as ⌘/Ctrl per platform (src/shared/platform.ts's modKey). `helpRows()` (src/shell/ideUtils.ts)
// is the real production data, so this story doubles as a visual check of the actual shortcuts list.
const meta = {
  title: 'Panels/ShortcutsTable',
  component: ShortcutsTable,
  parameters: { layout: 'padded' },
  args: {
    rows: helpRows(),
  },
} satisfies Meta<typeof ShortcutsTable>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The real production shortcut list, as shown in the F1 help overlay. */
export const Default: Story = {};

/** A single multi-segment chord — the shape pinned by HelpTable.test.tsx. */
export const SingleRow: Story = {
  args: {
    rows: [{ keys: 'mod+Shift+O', description: 'Open a folder of models' }],
  },
};

/** No shortcuts — the table renders an empty body rather than throwing. */
export const Empty: Story = {
  args: { rows: [] },
};
