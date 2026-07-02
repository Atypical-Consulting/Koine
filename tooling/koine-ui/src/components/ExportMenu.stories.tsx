import type { Meta, StoryObj } from '@storybook/preact-vite';
import { ExportMenu } from './ExportMenu';

// The diagram Export ▾ floating menu (#759 extraction). A native <details> disclosure: the Closed story
// is the compact toolbar default; the Open story pops the menu so the @storybook/addon-a11y axe pass and
// visual review see the format/Copy-Mermaid items in their open state.

const meta = {
  title: 'Components/ExportMenu',
  component: ExportMenu,
  parameters: { layout: 'centered' },
  args: {
    onExport: () => {},
    onCopyMermaid: () => {},
  },
} satisfies Meta<typeof ExportMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The compact toolbar default — the disclosure summary only, menu collapsed. */
export const Closed: Story = {};

/** The menu popped open, showing the SVG / PNG / PlantUML / Copy Mermaid items. */
export const Open: Story = {
  args: { defaultOpen: true },
};
