import type { Meta, StoryObj } from '@storybook/preact-vite';
import type { Platform } from '@/host';
// Explicit `.tsx` extension — see about.ts's identical import for why: on a case-insensitive filesystem
// the bare `@/settings/About` specifier silently resolves to the lowercase `about.ts` facade instead.
import { About } from '@/settings/About.tsx';

// The Settings → About tab content (#991 task 4): brand mark, wordmark, mono build chip, tagline,
// project-link grid and creator credit. `createAboutPanel()` (about.ts) is the thin facade that mounts
// this into a `.koi-about`-classed host for the real Settings dialog; these stories render `About`
// directly (wrapped in that same host class, matching the facade, so the panel's centered/max-width
// layout renders identically here) to drive the Storybook/Chromium `@storybook/addon-a11y` axe pass.
//
// `platform` is a minimal fake — only `appVersion`/`openExternal` are exercised by this panel — cast via
// the same `as unknown as Platform` idiom `colophon.test.ts` / `statusBar.test.tsx` already use for a
// partial Platform stub.
function fakePlatform(appVersion: () => Promise<string> = () => Promise.resolve('0.999.0')): Platform {
  return {
    appVersion,
    openExternal: () => {},
  } as unknown as Platform;
}

const meta = {
  title: 'Settings/About',
  component: About,
  parameters: { layout: 'padded' },
  args: { platform: fakePlatform(), refreshToken: 0 },
  render: (args) => (
    <div class="koi-about">
      <About {...args} />
    </div>
  ),
} satisfies Meta<typeof About>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Before any refresh (`refreshToken: 0`, the facade's initial mount): the build chip stays hidden. */
export const Unrefreshed: Story = {};

/** After a refresh (`refreshToken: 1`, as `createAboutPanel().refresh()` leaves it once Settings has
 *  opened): the build chip fills with the resolved version. */
export const Refreshed: Story = {
  args: { refreshToken: 1 },
};

/** A refresh whose `appVersion()` rejects (e.g. the Tauri command failing): the chip stays hidden rather
 *  than surfacing an error — pinning the "failed fetch leaves the chip hidden" contract visually too. */
export const RefreshFailed: Story = {
  args: {
    platform: fakePlatform(() => Promise.reject(new Error('app_version unavailable'))),
    refreshToken: 1,
  },
};
