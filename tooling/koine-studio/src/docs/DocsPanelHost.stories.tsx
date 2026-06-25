import type { Meta, StoryObj } from '@storybook/preact-vite';
import { DocsPanelHost } from '@/docs/DocsPanelHost';
import { createAppStore } from '@/store/index';

// A folder-derived Documentation page host — reused for both the Decisions (ADR) and Notes pages. In the
// app the controller captures the mount node on first mount and paints the pure renderAdrPanel /
// renderNotesPanel into it (reloading only when the workspace folder token changes). In isolation there is
// no controller, so `onMount` paints a representative stand-in so the host's framing is visible. The story
// never changes folderRootToken, so the `load` reload path doesn't fire; it's wired to the same painter to
// document the folder-change contract.

function paintSampleDocs(host: HTMLElement, title: string, items: string[]): void {
  const section = document.createElement('section');
  section.className = 'koi-docs-panel';
  const heading = document.createElement('h2');
  heading.textContent = title;
  const list = document.createElement('ul');
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    list.append(li);
  }
  section.append(heading, list);
  host.replaceChildren(section);
}

const decisions = [
  'ADR-0001 — Adopt Koine for the domain layer',
  'ADR-0002 — Split Ordering and Billing into separate contexts',
];
const notes = [
  'Pricing rounds half-up to the currency’s minor unit',
  'Shipping is modelled as an external Gateway context',
];

const meta = {
  title: 'Panels/DocsPanelHost',
  component: DocsPanelHost,
  parameters: { layout: 'padded' },
  args: {
    store: createAppStore(),
    onMount: (_host: HTMLElement) => {},
    load: (_host: HTMLElement) => {},
  },
} satisfies Meta<typeof DocsPanelHost>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The Decisions (ADR) page: the stand-in paints a folder-derived list into the captured mount node. */
export const Decisions: Story = {
  args: {
    onMount: (host: HTMLElement) => paintSampleDocs(host, 'Decisions', decisions),
    load: (host: HTMLElement) => paintSampleDocs(host, 'Decisions', decisions),
  },
};

/** The Notes page: the same host, different folder-derived content. */
export const Notes: Story = {
  args: {
    onMount: (host: HTMLElement) => paintSampleDocs(host, 'Notes', notes),
    load: (host: HTMLElement) => paintSampleDocs(host, 'Notes', notes),
  },
};
