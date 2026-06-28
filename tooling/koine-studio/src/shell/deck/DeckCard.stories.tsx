import type { Meta, StoryObj } from '@storybook/preact-vite';
import type { ComponentChildren, JSX } from 'preact';
import { DeckCard } from '@/shell/deck/DeckCard';
import { DECK_SURFACES } from '@/shell/deck/surfaces';

// One surface card: header (icon + label + hoisted facet sub-strip + tag + close) over a body slot.
// The card's layout classes are normally applied by the FLIP engine; these static stories simulate the
// relevant ones (in-pair / is-selected) via the rootRef so the 2-up header styling is visible. A sized
// mock body gives the absolutely-positioned card a real footprint inside the framed stage.

function mockBody(label: string): JSX.Element {
  return (
    <div
      style="position:absolute;inset:0;width:600px;height:300px;padding:18px 20px;color:var(--koi-muted);font-size:13px;line-height:1.6"
    >
      <strong style="color:var(--koi-fg)">{label}</strong> surface body — real content (editor, diagram,
      compiler output, docs) is hosted here in the app.
    </div>
  );
}

function frame(children: ComponentChildren): JSX.Element {
  return <div class="deck-stage is-focus" style="position:relative;height:360px;max-width:680px">{children}</div>;
}

const meta = {
  title: 'Panels/Deck/DeckCard',
  component: DeckCard,
  parameters: { layout: 'padded' },
  args: {
    surface: DECK_SURFACES.output,
    activeFacet: 'generated',
    inPair: false,
    isSelected: false,
    onActivate: () => {},
    onSelectFacet: () => {},
    onClose: () => {},
    rootRef: () => {},
  },
} satisfies Meta<typeof DeckCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Solo (1-up): full header with the facet sub-strip; tag shown, close hidden. */
export const WithFacets: Story = {
  render: (args) => frame(<DeckCard {...args}>{mockBody('Output')}</DeckCard>),
};

/** Canvas has a single view, so no facet sub-strip renders. */
export const NoFacets: Story = {
  args: { surface: DECK_SURFACES.visual, activeFacet: null },
  render: (args) => frame(<DeckCard {...args}>{mockBody('Canvas')}</DeckCard>),
};

/** The selected pane of a 2-up: accent-tinted header + cap, reachable close button. */
export const InPairSelected: Story = {
  args: { surface: DECK_SURFACES.technical, activeFacet: 'editor', inPair: true, isSelected: true },
  render: (args) =>
    frame(
      <DeckCard
        {...args}
        rootRef={(el) => el && el.classList.add('in-pair', 'is-selected')}
      >
        {mockBody('Code')}
      </DeckCard>,
    ),
};

/** The non-selected pane of a 2-up: neutral header, clickable to take the selection. */
export const InPairUnselected: Story = {
  args: { surface: DECK_SURFACES.visual, activeFacet: null, inPair: true, isSelected: false },
  render: (args) =>
    frame(
      <DeckCard {...args} rootRef={(el) => el && el.classList.add('in-pair')}>
        {mockBody('Canvas')}
      </DeckCard>,
    ),
};
