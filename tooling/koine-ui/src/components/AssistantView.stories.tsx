import type { Meta, StoryObj } from '@storybook/preact-vite';
import { AssistantView } from './AssistantView';

// The thin Preact host for a right-rail AI Chat panel (#759). In the consuming app (Koine Studio) the
// host renders an empty mount node and an imperative panel populates it; these stories inject
// representative `koi-assistant` markup as children so the host's accessibility can be axe-checked with
// realistic content (the @storybook/addon-a11y pass) without booting a real SDK-backed panel. The
// `.koi-assistant*` classes used by the WithAssistantContent story are Koine Studio's own chrome
// (styled by the app, not by this package) — see this package's README/Task 4 report for why that CSS
// stayed in the app; the story still demonstrates the mount contract even unstyled here.

const meta = {
  title: 'Components/AssistantView',
  component: AssistantView,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof AssistantView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The empty host as it renders before an imperative panel attaches — a bare mount node. */
export const EmptyHost: Story = {};

/** With representative assistant chrome injected, mimicking what a host's imperative panel builds into
 *  the mount node: a scrolling transcript with an intro, and the prompt controls below. */
export const WithAssistantContent: Story = {
  render: () => (
    <div style={{ height: '420px', display: 'flex' }}>
      <AssistantView>
        <div class="koi-assistant">
          <div class="koi-assistant-transcript">
            <p class="koi-assistant-intro">
              Ask the assistant to explain a construct, draft a value object, or review your invariants.
            </p>
          </div>
          <div class="koi-assistant-controls">
            <label class="koi-assistant-quick" for="story-prompt">
              Prompt
            </label>
            <textarea id="story-prompt" rows={2} placeholder="Describe a change…" />
            <button type="button" class="koi-assistant-action">
              Send
            </button>
          </div>
        </div>
      </AssistantView>
    </div>
  ),
};
