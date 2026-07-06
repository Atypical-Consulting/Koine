import type { Meta, StoryObj } from '@storybook/preact-vite';
import { Transcript } from '@/ai/components/Transcript';
import { createAppStore, type AppState } from '@/store/index';
import type { StoreApi } from 'zustand/vanilla';

// The assistant transcript as a declarative Preact component (#990 Task 4): the keyed message list
// (user text verbatim, assistant markdown through MdHtml with the gated Apply affordance), the
// ephemeral streaming turn (live text + `koi-assistant-tool` cards) from `chat.turn`, and the
// ephemeral note/error bubbles the imperative panel painted as loose DOM. Each story seeds its own
// `createAppStore()` and drives the chat slice through the real actions (appendChatMessage →
// startChatTurn → appendStreamingText / startToolCall / completeToolCall), so the stories exercise
// exactly the states the store can produce. The @storybook/addon-a11y axe pass guards each state.

const KOINE_REPLY = `Here is a starting model for the ordering domain:

\`\`\`koine
context Ordering {
  aggregate Order {
    id: OrderId
    total: Money
  }
}
\`\`\`

The \`Order\` aggregate owns the order lifecycle.`;

/** A store whose chat slice holds a finished user → assistant exchange. */
function exchangeStore(): StoreApi<AppState> {
  const store = createAppStore();
  store.getState().appendChatMessage({ role: 'user', content: 'Model an ordering domain for me.' });
  store.getState().appendChatMessage({ role: 'assistant', content: KOINE_REPLY });
  return store;
}

/** A store mid-turn: the user message committed, the assistant reply still streaming. */
function streamingStore(): StoreApi<AppState> {
  const store = createAppStore();
  store.getState().appendChatMessage({ role: 'user', content: 'Explain the diagnostics.' });
  store.getState().startChatTurn();
  store.getState().appendStreamingText('The first diagnostic means the `Money` type is not');
  return store;
}

const meta = {
  title: 'Panels/Transcript',
  component: Transcript,
  parameters: { layout: 'padded' },
  args: {
    store: createAppStore(),
    onApplyModel: () => {},
    onOpenPrefs: () => {},
  },
} satisfies Meta<typeof Transcript>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The empty state: only the "Domain copilot" intro, shown until the first bubble. */
export const EmptyIntro: Story = {
  args: { store: createAppStore() },
};

/** A finished user → assistant exchange: the user's text verbatim, the assistant's markdown through
 *  MdHtml, and — once the host's apply-gate resolves the fenced model — the "Apply to editor"
 *  affordance on the assistant bubble. */
export const ExchangeWithApply: Story = {
  args: {
    store: exchangeStore(),
    // The host's #444 apply-gate: extract + validate the candidate. Stories resolve it directly.
    getApplyCandidate: () =>
      Promise.resolve('context Ordering {\n  aggregate Order {\n    id: OrderId\n    total: Money\n  }\n}'),
  },
};

/** A reply mid-stream: the live turn's accumulated text renders as a plain-text assistant bubble
 *  (markdown only lands once the turn commits). */
export const StreamingTurn: Story = {
  args: { store: streamingStore() },
};

/** The agentic loop's tool cards in all three states — a settled ok card, a settled error card, and
 *  a still-pending one — inserted above the streaming bubble like the imperative panel did. */
export const ToolCards: Story = {
  args: {
    store: (() => {
      const store = createAppStore();
      store.getState().appendChatMessage({ role: 'user', content: 'Validate and compile the model.' });
      store.getState().startChatTurn();
      store.getState().startToolCall({ id: 1, name: 'koine_validate', args: '{"source":"context A {}"}' });
      store.getState().completeToolCall({
        id: 1,
        state: 'ok',
        summary: 'valid, no diagnostics',
        result: 'ok: true — compiled 1 file(s)',
        durationMs: 312,
      });
      store.getState().startToolCall({ id: 2, name: 'koine_compile', args: '{"target":"csharp"}' });
      store.getState().completeToolCall({
        id: 2,
        state: 'error',
        summary: 'failed',
        result: 'compiler backend unreachable',
        durationMs: 1450,
      });
      store.getState().startToolCall({ id: 3, name: 'koine_format', args: '{"source":"context A {}"}' });
      return store;
    })(),
  },
};

/** A noisy tool result past TOOL_RESULT_CLAMP: the card's Result body is clamped with a visible
 *  "(truncated)" note so one large blob can't blow up the transcript. */
export const TruncatedToolResult: Story = {
  args: {
    store: (() => {
      const store = createAppStore();
      store.getState().appendChatMessage({ role: 'user', content: 'Compile everything.' });
      store.getState().startChatTurn();
      store.getState().startToolCall({ id: 1, name: 'koine_compile', args: '{"target":"csharp"}' });
      store.getState().completeToolCall({
        id: 1,
        state: 'ok',
        summary: 'compiled 42 files',
        result: 'line\n'.repeat(4000),
        durationMs: 2300,
      });
      return store;
    })(),
  },
};

/** A turn stopped mid-stream with usable output: the committed partial renders as a normal assistant
 *  bubble carrying the ephemeral "Stopped." marker. */
export const StoppedPartial: Story = {
  args: {
    store: (() => {
      const store = createAppStore();
      store.getState().appendChatMessage({ role: 'user', content: 'Review this model.' });
      store.getState().appendChatMessage({
        role: 'assistant',
        content: 'The model looks structurally sound, but the `Order` aggregate',
      });
      return store;
    })(),
    stoppedPartial: true,
  },
};

/** No usable API key at send time: the ephemeral note bubble with the "Open Settings" link-button
 *  routing to Preferences. */
export const NoKeyNote: Story = {
  args: {
    store: createAppStore(),
    notice: {
      kind: 'note',
      text: 'Add your API key in Settings to use the assistant. ',
      openSettings: true,
    },
  },
};

/** A failed request: the ephemeral error bubble the imperative panel painted on the reply. */
export const RequestError: Story = {
  args: {
    store: exchangeStore(),
    notice: { kind: 'error', text: 'Request failed: connection refused' },
  },
};
