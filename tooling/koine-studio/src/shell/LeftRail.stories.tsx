import type { Meta, StoryObj } from '@storybook/preact-vite';
import { LeftRail } from '@atypical/koine-ui';

// The left rail's Domain·Files axis switch (#759, ide.tsx:439 mounts the real `<LeftRail />` into the
// app's `<aside id="leftrail">` shell — see index.html). Koine Studio owns the accent-tinted
// `.rail-axis[aria-selected='true']` rule (`src/styles/layout/_leftrail.scss`) — koine-ui ships its own
// `LeftRail.stories.tsx` for the `hidden`-attribute Domain/Files cascade regression (#485), but koine-ui's
// `vitest.config.ts` has no Storybook/Chromium/axe project, so neither story ever ran a live
// colour-contrast pass against this app's own SCSS. This story closes that gap (#1706, following #1704's
// contrast fix, verified there only by computed relative-luminance math) by rendering the production
// component inside the same `#leftrail` shell markup the app boots, so the Chromium
// `@storybook/addon-a11y` axe pass in this package's `storybook` vitest project actually exercises it.
//
// LeftRail takes no props and renders once (no store subscription, per ide.tsx's render-once guardrail);
// its hard-coded default already has the Domain tab `aria-selected="true"`, so simply rendering it
// exercises the selected state — no `play` interaction needed.

const meta = {
  title: 'Shell/LeftRail',
  component: LeftRail,
  parameters: { layout: 'fullscreen' },
  render: () => (
    <aside id="leftrail" class="pane" aria-label="Workspace">
      <LeftRail />
    </aside>
  ),
} satisfies Meta<typeof LeftRail>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The rail's default mount: the Domain axis selected (`.rail-axis[aria-selected='true']`), Files
 *  hidden. Axe's Chromium colour-contrast pass covers the selected tab's accent-tinted pill. */
export const DomainSelected: Story = {};
