import type { Meta, StoryObj } from '@storybook/preact-vite';
import { DeckBar } from '@/shell/deck/DeckBar';

// The slim bar above the deck stage: Overview toggle + the Canvas·Code·Output·Docs filmstrip + the
// keyboard hint. Pure-props (the app uses DeckBarConnected); each story sets a different deck state so
// the chip states (primary/secondary, the revealed "open beside") are all visible. The bar is
// full-width chrome, so the stories render fullscreen on the studio background.
const meta = {
  title: 'Panels/Deck/DeckBar',
  component: DeckBar,
  parameters: { layout: 'fullscreen' },
  args: {
    mode: 'focus',
    primary: 'visual',
    secondary: null,
    onOverview: () => {},
    onFocus: () => {},
    onOpenBeside: () => {},
  },
} satisfies Meta<typeof DeckBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 1-up: Canvas is the sole shown surface; the other three chips offer "open beside" on hover. */
export const Focus1Up: Story = {};

/** 2-up: Code is primary (filled) and Canvas is secondary (tinted outline); the rest stay neutral. */
export const Focus2Up: Story = {
  args: { primary: 'technical', secondary: 'visual' },
};

/** Overview: the bird's-eye toggle is active; no chip carries the "open beside" affordance. */
export const Overview: Story = {
  args: { mode: 'overview', primary: 'visual', secondary: 'technical' },
};
