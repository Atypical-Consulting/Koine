import type { Meta, StoryObj } from '@storybook/preact-vite';
import { render } from 'preact';
import { DocsPanelHost } from '@atypical/koine-ui';
import { AdrPanel, NotesPanel, type DocsPanelData, type DocsPanelHandlers } from '@/docs/DocsPanels';
import type { AdrFile, NoteFile } from '@/docs/docsStore';
import { renderMarkdown } from '@/editor/markdown';
import { createDocsPanelHostStore } from '@/store/readableStores';
import { createAppStore } from '@/store/index';

// A folder-derived Documentation page host — reused for both the Decisions (ADR) and Notes pages. In the
// app the controller (surfaceLoaders.tsx) captures the mount node on first mount and paints the real
// <AdrPanel> / <NotesPanel> JSX (#992 task 5) into it via Preact's render(), reloading only when the
// workspace folder token changes. In isolation there is no controller, so `onMount` mounts the same
// components against a representative fixture so the host's framing is visible. The story never changes
// folderRootToken, so the `load` reload path doesn't fire; it's wired to the same painter to document the
// folder-change contract.
//
// The host panel itself lives in @atypical/koine-ui since #1244 (behind its ReadableStore contract; the
// real app store is adapted via createDocsPanelHostStore). This story stays on the koine-studio side —
// unlike the other migrated panels' stories — because its real subject is the studio-only <AdrPanel> /
// <NotesPanel> pages painted INTO the host (their only story coverage); koine-ui's own DocsPanelHost
// story covers the bare host with a neutral fixture.

const handlers: DocsPanelHandlers = {
  onCreateAdr: () => {},
  onSaveAdr: () => {},
  onCreateNote: () => {},
  onReadNote: async () => '# Shipping is modelled as an external Gateway context\n\nDetails go here.\n',
  onSaveNote: () => {},
};

const adrs: AdrFile[] = [
  {
    token: 'WS/docs/adr/0001-adopt-koine.md',
    name: '0001-adopt-koine.md',
    number: 1,
    adr: {
      number: 1,
      title: 'Adopt Koine for the domain layer',
      status: 'accepted',
      context: 'We need a single source of truth for the ubiquitous language across five languages.',
      decision: 'Author the domain in Koine and generate every backend from it.',
      consequences: 'The `.koi` files become the canonical spec; generated code is never hand-edited.',
    },
  },
  {
    token: 'WS/docs/adr/0002-split-contexts.md',
    name: '0002-split-contexts.md',
    number: 2,
    adr: {
      number: 2,
      title: 'Split Ordering and Billing into separate contexts',
      status: 'proposed',
      context: 'Ordering and Billing were drifting toward incompatible invariants under one context.',
      decision: 'Split into two bounded contexts joined by a published-language integration event.',
      consequences: 'Each context can evolve its own model; the integration event becomes a versioned contract.',
    },
  },
];

const notes: NoteFile[] = [
  { token: 'WS/docs/notes/pricing-rounding.md', name: 'pricing-rounding.md', title: 'Pricing rounding' },
  { token: 'WS/docs/notes/shipping-gateway.md', name: 'shipping-gateway.md', title: 'Shipping gateway' },
];

function adrData(): DocsPanelData {
  return { canWrite: true, adrs, notes: [], renderMarkdown };
}
function notesData(): DocsPanelData {
  return { canWrite: true, adrs: [], notes, renderMarkdown };
}

function paintAdr(host: HTMLElement): void {
  render(<AdrPanel data={adrData()} handlers={handlers} />, host);
}
function paintNotes(host: HTMLElement): void {
  render(<NotesPanel data={notesData()} handlers={handlers} />, host);
}

const meta = {
  title: 'Panels/DocsPanelHost',
  component: DocsPanelHost,
  parameters: { layout: 'padded' },
  args: {
    store: createDocsPanelHostStore(createAppStore()),
    onMount: (_host: HTMLElement) => {},
    load: (_host: HTMLElement) => {},
  },
} satisfies Meta<typeof DocsPanelHost>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The Decisions (ADR) page: the real <AdrPanel> painted into the captured mount node. */
export const Decisions: Story = {
  args: {
    onMount: paintAdr,
    load: paintAdr,
  },
};

/** The Notes page: the same host, the real <NotesPanel>. */
export const Notes: Story = {
  args: {
    onMount: paintNotes,
    load: paintNotes,
  },
};
