import type { Meta, StoryObj } from '@storybook/preact-vite';
import { DeckSpine } from './DeckSpine';
import { SAMPLE_SURFACES } from './deckFixtures';

// The concept-7 "Flush" spine: one 36px chrome row that morphs by mode. Pure-props (a connected wrapper
// binds it to the deck store). Each story sets a different deck state so the split-button tabs, the inline
// facet strip, and the 2-up pane-headers + docked swap are all visible. Full-width chrome, so the stories
// render fullscreen on the studio background.
const meta = {
  title: 'Components/Deck/DeckSpine',
  component: DeckSpine,
  parameters: { layout: 'fullscreen' },
  args: {
    mode: 'focus',
    primary: 'visual',
    secondary: null,
    flipped: false,
    ratio: 0.5,
    surfaces: SAMPLE_SURFACES,
    activeFacet: (id: string) => (id === 'technical' ? 'editor' : id === 'output' ? 'generated' : id === 'docs' ? 'glossary' : null),
    onOverview: () => {},
    onFocus: () => {},
    onOpenBeside: () => {},
    onSelectFacet: () => {},
    onClose: () => {},
    onSwap: () => {},
    onSelectPane: () => {},
  },
} satisfies Meta<typeof DeckSpine>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 1-up: Canvas is focused (grown label + underline); the other three tabs reveal ⊞ "open beside" on hover. */
export const Focus1Up: Story = {};

/** 1-up on a surface WITH facets: Code focused, its Editor / Scenarios facet strip inline in the spine. */
export const Focus1UpWithFacets: Story = {
  args: { primary: 'technical' },
};

/** 2-up: Code (primary, underlined) beside Canvas, the ⇄ docked at the seam + a compact Overview at the end. */
export const Focus2Up: Story = {
  args: { primary: 'technical', secondary: 'visual', ratio: 0.55 },
};

/** Overview: the tab-strip with the bird's-eye toggle active; no facet strip, no ⊞. */
export const Overview: Story = {
  args: { mode: 'overview', primary: 'visual', secondary: 'technical' },
};
