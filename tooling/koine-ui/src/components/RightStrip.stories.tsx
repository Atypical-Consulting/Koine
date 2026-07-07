import type { Meta, StoryObj } from '@storybook/preact-vite';
import { RightStrip } from './RightStrip';

// The right-edge tool-window stripe (#759). Rendered inside its real #right-strip toolbar shell so the
// vertical icon toggles read as the Rider-style stripe and the @storybook/addon-a11y axe pass sees the
// buttons in their toolbar landmark with aria-controls resolving to #right.

const meta = {
  title: 'Panels/RightStrip',
  component: RightStrip,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div style={{ display: 'flex', gap: '8px' }}>
        <aside id="right" aria-label="Properties" style={{ width: '1px' }} />
        <div
          id="right-strip"
          role="toolbar"
          aria-label="Tool windows"
          aria-orientation="vertical"
          style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}
        >
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof RightStrip>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The stripe with all four tool-window toggles (Properties · AI Chat · Source Control · Syntax Tree). A
 *  decorative `.rstrip-sep` hairline (aria-hidden, non-interactive) groups the git tool-window — Source
 *  Control — apart from Properties/AI Chat, per the PR #1140 handoff (#1154). Its width/position styling
 *  and the 42px stripe track live Studio-side (`_inspector.scss` / `_split.scss`, koine-ui ships no SCSS),
 *  so this story renders the separator node without that hairline paint — the pixel-faithful look is in
 *  the running Studio. This story remains the structural + `@storybook/addon-a11y` gate for the stripe. */
export const Default: Story = {};
