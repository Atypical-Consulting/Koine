import type { Meta, StoryObj } from '@storybook/preact-vite';
import { Composer } from '@/ai/components/Composer';
import { createAppStore, type AppState } from '@/store/index';
import type { StoreApi } from 'zustand/vanilla';

// The assistant's input row + quick actions as a declarative Preact component (#990 Task 5): the
// controlled prompt textarea over `chat.draft`, the Send/Stop pair whose swap derives from
// `chat.status === 'streaming'`, the four canned quick actions plus "Explain this construct", and
// "Clear conversation" — all refused while a turn is streaming, exactly like the imperative panel's
// `setBusy`. Each story seeds its own `createAppStore()` and drives the chat slice through the real
// actions (setChatDraft / startChatTurn), so the stories exercise exactly the states the store can
// produce. The @storybook/addon-a11y axe pass guards each state.

/** A store whose chat slice carries an unsent composer draft. */
function draftStore(draft: string): StoreApi<AppState> {
  const store = createAppStore();
  store.getState().setChatDraft(draft);
  return store;
}

/** A store mid-turn: the reply is streaming, so every control is refused and Send swaps to Stop. */
function streamingStore(): StoreApi<AppState> {
  const store = createAppStore();
  store.getState().appendChatMessage({ role: 'user', content: 'Model a billing domain for me.' });
  store.getState().startChatTurn();
  return store;
}

const meta = {
  title: 'Panels/Composer',
  component: Composer,
  parameters: { layout: 'padded' },
  args: {
    store: createAppStore(),
    onSend: () => {},
    onStop: () => {},
    onQuickAction: () => {},
    onExplain: () => {},
    onClear: () => {},
  },
} satisfies Meta<typeof Composer>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The resting empty state: placeholder visible, Send enabled, Stop hidden, quick actions live. */
export const Empty: Story = {
  args: { store: createAppStore() },
};

/** An unsent draft in the controlled textarea (`chat.draft`) — the same state the host's
 *  error-rollback restore re-enters by dispatching `setChatDraft(prompt)`. */
export const IdleWithDraft: Story = {
  args: { store: draftStore('Model a billing domain with invoices and payments.') },
};

/** A turn streaming: the textarea and every quick action are disabled, Send is disabled and Stop is
 *  shown — the imperative panel's `setBusy(true)` treatment derived from the slice status. */
export const Streaming: Story = {
  args: { store: streamingStore() },
};
