import type { Meta, StoryObj } from '@storybook/preact-vite';
import { render } from 'preact';
import { DocsPanelHost, type DocsPanelHostSlice } from './DocsPanelHost';
import { readableStoreOf } from '../host/storeTestUtils';

// A folder-derived Documentation page host. In Koine Studio the controller (surfaceLoaders.tsx)
// captures the mount node on first mount and paints the real <AdrPanel>/<NotesPanel> JSX into it via
// Preact's render(), reloading only when the workspace folder token changes — that full composition is
// storied on the koine-studio side (its DocsPanelHost story renders the real docs pages). In isolation
// here there is no controller and no docs pages, so `onMount` paints a small representative fixture so
// the host's capture-then-paint contract is visible. The story never changes `folderRootToken`, so the
// `load` reload path doesn't fire; it's wired to the same painter to document the folder-change contract.
// The store is the shared `readableStoreOf` double (host/storeTestUtils).

function paintFixture(host: HTMLElement): void {
  render(
    <article>
      <h3>0001 — Adopt Koine for the domain layer</h3>
      <p>
        The controller paints the real documentation page into this captured mount node; the host only
        governs WHEN it reloads (on a workspace-folder change).
      </p>
    </article>,
    host,
  );
}

const meta = {
  title: 'Panels/DocsPanelHost',
  component: DocsPanelHost,
  parameters: { layout: 'padded' },
  args: {
    store: readableStoreOf<DocsPanelHostSlice>({ folderRootToken: 'WS' }),
    onMount: paintFixture,
    load: paintFixture,
  },
} satisfies Meta<typeof DocsPanelHost>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The captured mount node with a representative controller paint inside it. */
export const Captured: Story = {};
