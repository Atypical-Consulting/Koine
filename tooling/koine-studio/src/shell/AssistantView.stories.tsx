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

/** The expandable tool-call cards `createAssistantPanel` builds above a reply while the assistant runs
 *  koine tools — one native <details> per call, in each of the three states (pending / ok / error). The
 *  ok + error cards render expanded so the axe pass also covers the Arguments/Result body contrast (the
 *  unit-level axe pass misses color-contrast; this Chromium story is the gate). */
export const WithToolCards: Story = {
  render: () => (
    <div style={{ height: '520px', display: 'flex' }}>
      <AssistantView>
        <div class="koi-assistant">
          <div class="koi-assistant-transcript">
            <div class="koi-msg koi-msg-user">Validate the current model, then compile it.</div>

            <details class="koi-assistant-tool" data-state="pending">
              <summary>
                <span class="koi-tool-glyph" aria-hidden="true">
                  …
                </span>
                <span class="koi-sr-only koi-tool-state">running</span>
                <span class="koi-tool-name">koine_validate</span>
                <span class="koi-tool-summary">…</span>
                <span class="koi-tool-duration"></span>
              </summary>
            </details>

            <details class="koi-assistant-tool" data-state="ok" open>
              <summary>
                <span class="koi-tool-glyph" aria-hidden="true">
                  ✓
                </span>
                <span class="koi-sr-only koi-tool-state">succeeded</span>
                <span class="koi-tool-name">koine_validate</span>
                <span class="koi-tool-summary">ok: no diagnostics</span>
                <span class="koi-tool-duration">312 ms</span>
              </summary>
              <dl class="koi-tool-detail">
                <dt>Arguments</dt>
                <dd>
                  <pre>{'{\n  "source": "context Billing {}"\n}'}</pre>
                </dd>
                <dt>Result</dt>
                <dd>
                  <pre>ok: true — no diagnostics. The model compiles.</pre>
                  <span class="koi-tool-truncated">(truncated)</span>
                </dd>
              </dl>
            </details>

            <details class="koi-assistant-tool" data-state="error" open>
              <summary>
                <span class="koi-tool-glyph" aria-hidden="true">
                  ✕
                </span>
                <span class="koi-sr-only koi-tool-state">failed</span>
                <span class="koi-tool-name">koine_compile</span>
                <span class="koi-tool-summary">failed</span>
                <span class="koi-tool-duration">1.4 s</span>
              </summary>
              <dl class="koi-tool-detail">
                <dt>Arguments</dt>
                <dd>
                  <pre>{'{\n  "target": "csharp"\n}'}</pre>
                </dd>
                <dt>Result</dt>
                <dd>
                  <pre>Error: target "csharp" requires a model that parses</pre>
                </dd>
              </dl>
            </details>

            <div class="koi-msg koi-msg-assistant">
              <div class="koi-md">The model validates cleanly, but compilation needs a fix first.</div>
            </div>
          </div>
        </div>
      </AssistantView>
    </div>
  ),
};
