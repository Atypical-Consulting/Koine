import type { Meta, StoryObj } from '@storybook/preact-vite';
import { expect } from 'storybook/test';
import { LeftRail } from './LeftRail';

// Regression guard for the rail's Domain·Files axis (Koine Studio issue #485). The Files section
// (#rail-files) must be VISUALLY hidden whenever it carries the `hidden` attribute — the state
// `applyAxis('domain')` puts it in over in the consuming app. `#rail-files` is a `.rail-sect`
// (`display: flex`, an AUTHOR rule), which outranks the UA `[hidden] { display: none }` in the cascade;
// without an explicit `#rail-files[hidden]` restore the Files tree LEAKS into the Domain axis. A
// happy-dom unit suite asserting only the `.hidden` PROPERTY is structurally blind to this — it never
// applies the compiled CSS — so the guard lives here, in the Storybook/Chromium project, where
// getComputedStyle reflects the real cascade. Moved from Koine Studio's `src/shell/leftRail.stories.tsx`
// (issue #905, Task 4).
//
// The stories render the production LeftRail component (wrapped in the real `#leftrail` host so the
// scoped rules apply). LeftRail's default state — Files hidden, Domain shown — IS the Domain axis; the
// Files story flips the same `hidden` attributes a consuming app's `applyAxis('files')` toggles, no
// controller needed.

const meta = {
  title: 'Components/LeftRail',
  parameters: { layout: 'fullscreen' },
  render: () => (
    <aside id="leftrail" class="pane">
      <LeftRail />
    </aside>
  ),
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Domain axis (the default): the Domain navigator owns the rail and the Files section is hidden. This
 * is the bug from #485 — before the `#rail-files[hidden]` restore, `#rail-files` computes `display: flex`
 * here and the Files tree leaks in below the Domain navigator.
 */
export const DomainAxisHidesFiles: Story = {
  play: async ({ canvasElement }) => {
    const files = canvasElement.querySelector<HTMLElement>('#rail-files')!;
    const domain = canvasElement.querySelector<HTMLElement>('#rail-domain-pane')!;
    // The Files pane carries `hidden` by default (the Domain-axis state) — it must compute display:none.
    await expect(files.hidden).toBe(true);
    await expect(getComputedStyle(files).display).toBe('none');
    // The Domain pane is the one showing.
    await expect(domain.hidden).toBe(false);
    await expect(getComputedStyle(domain).display).not.toBe('none');
  },
};

/**
 * Files axis: a workspace file tree owns the rail and the Domain navigator is hidden. Toggling the
 * `hidden` attributes here mirrors exactly what a consuming app's `applyAxis('files')` does, and guards
 * that the `#rail-files[hidden]` restore does NOT over-reach into hiding the Files pane when it is the
 * active axis.
 */
export const FilesAxisShowsFiles: Story = {
  play: async ({ canvasElement }) => {
    const files = canvasElement.querySelector<HTMLElement>('#rail-files')!;
    const domain = canvasElement.querySelector<HTMLElement>('#rail-domain-pane')!;
    // Mirror applyAxis('files'): surface Files, hide Domain.
    files.hidden = false;
    domain.hidden = true;
    await expect(getComputedStyle(files).display).not.toBe('none');
    await expect(getComputedStyle(domain).display).toBe('none');
  },
};
