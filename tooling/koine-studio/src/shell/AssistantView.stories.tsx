import type { Meta, StoryObj } from '@storybook/preact-vite';
import { AssistantView } from '@/shell/AssistantView';

// The thin Preact host for the right-rail AI Chat (#759). In production the host renders an empty mount
// node and `createAssistantPanel` (imperative, src/ai/aiPanel.ts) populates it; these stories inject
// representative `koi-assistant` markup as children so the host's accessibility can be axe-checked with
// realistic content (the @storybook/addon-a11y pass) without booting the SDK-backed panel.

const meta = {
  title: 'Panels/AssistantView',
  component: AssistantView,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof AssistantView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The empty host as it renders before the imperative panel attaches — a bare mount node. */
export const EmptyHost: Story = {};

/** With representative assistant chrome injected, mimicking what `createAssistantPanel` builds into the
 *  mount node: a scrolling transcript with an intro, and the prompt controls below. */
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
