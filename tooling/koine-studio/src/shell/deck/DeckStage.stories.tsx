import type { Meta, StoryObj } from '@storybook/preact-vite';
import type { JSX } from 'preact';
import type { CenterView } from '@/store/slices/uiChrome';
import { createAppStore } from '@/store/index';
import { DECK_SURFACES } from '@/shell/deck/surfaces';
import { DeckBarConnected } from '@/shell/deck/DeckBar';
import { DeckStage } from '@/shell/deck/DeckStage';

// The full deck shell — bar + stage — driven by a real store. The stage runs the FLIP layout, so these
// stories show the actual 1-up / 2-up / overview geometry (under the Chromium project). Mock surface
// bodies stand in for the real editor/diagram/output/docs hosts. `enableKeyboard={false}` keeps the
// global 1–4 / Esc shortcuts out of the Storybook canvas.

function mockBody(view: CenterView): JSX.Element {
  const s = DECK_SURFACES[view];
  return (
    <div style={`position:absolute;inset:0;padding:18px 20px;font-size:13px;line-height:1.6;color:var(--koi-muted)`}>
      <div style={`color:${s.accent};font-weight:600;margin-bottom:6px`}>{s.label}</div>
      <div>
        Mock <strong style="color:var(--koi-fg)">{s.label}</strong> body. The real {s.tag} renders here in
        the app.
      </div>
    </div>
  );
}

function shell(store: ReturnType<typeof createAppStore>): JSX.Element {
  return (
    <div style="display:flex;flex-direction:column;height:560px;border:1px solid var(--koi-line);border-radius:8px;overflow:hidden">
      <DeckBarConnected store={store} />
      <DeckStage store={store} mockBody={mockBody} enableKeyboard={false} />
    </div>
  );
}

const meta = {
  title: 'Panels/Deck/DeckStage',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** 1-up: Canvas fills the stage; the others ghost off-screen. */
export const Focus1Up: Story = {
  render: () => {
    const store = createAppStore();
    store.getState().focusPrimary('visual');
    return shell(store);
  },
};

/** 2-up: Code beside Canvas with the resizable seam + swap; Code is the selected pane. */
export const Focus2Up: Story = {
  render: () => {
    const store = createAppStore();
    store.getState().focusPrimary('technical');
    store.getState().openBeside('visual');
    return shell(store);
  },
};

/** Overview: the 2×2 bird's-eye of all four surfaces. */
export const Overview: Story = {
  render: () => {
    const store = createAppStore();
    store.getState().setDeckMode('overview');
    return shell(store);
  },
};
