import type { Meta, StoryObj } from '@storybook/preact-vite';
import { AssistantChat } from '@/ai/components/AssistantChat';
import { createAppStore, type AppState } from '@/store/index';
import type { StagedEdit } from '@/ai/editSession';
import type { StoreApi } from 'zustand/vanilla';

// The assembled assistant view (#990 Task 6): Transcript + ChangeSetPanel + Composer composed inside
// the imperative panel's chrome — the transcript scroller first (with the change-set review mounted
// at its end so a long per-file diff scrolls with the conversation), then the controls row. The host
// factory (`createAssistantChat` in src/ai/aiPanel.ts) owns everything effectful, so the stories wire
// no-op host callbacks and seed their own `createAppStore()` through the real chat-slice actions —
// exercising exactly the states the store can produce, with the composition (does the review land
// inside the scroller? does the composer sit below?) that the per-panel stories can't show. The
// @storybook/addon-a11y axe pass guards each state.

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

const ORDER_BEFORE = `context Ordering {
  aggregate Order {
    id: OrderId
    total: Money
  }
}`;

const ORDER_AFTER = `context Ordering {
  aggregate Order {
    id: OrderId
    total: Money
    invariant total >= 0 "An order total can never be negative."
  }
}`;

/** The staged set the populated story reviews: one modified file + one brand-new file. */
const staged: StagedEdit[] = [
  { key: 'ordering/order.koi', relPath: 'ordering/order.koi', body: ORDER_AFTER, isNew: false },
  {
    key: 'new:billing/invoice.koi',
    relPath: 'billing/invoice.koi',
    body: 'context Billing {\n  value Invoice {\n    number: String\n  }\n}',
    isNew: true,
  },
];
const before = { 'ordering/order.koi': ORDER_BEFORE };

/** A store carrying a finished conversation, an unsent draft, and a staged change set under review. */
function populatedStore(): StoreApi<AppState> {
  const store = createAppStore();
  store.getState().appendChatMessage({ role: 'user', content: 'Model an ordering domain for me.' });
  store.getState().appendChatMessage({ role: 'assistant', content: KOINE_REPLY });
  store.getState().appendChatMessage({ role: 'user', content: 'Now add the invariant across the workspace.' });
  store.getState().appendChatMessage({ role: 'assistant', content: 'I staged the invariant plus a new Billing file.' });
  store.getState().stageChangeSet(staged, before, null);
  store.getState().setChatDraft('Also add a Payment aggregate.');
  return store;
}

const meta = {
  title: 'Panels/AssistantChat',
  component: AssistantChat,
  parameters: { layout: 'padded' },
  args: {
    store: createAppStore(),
    onApplyModel: () => {},
    onOpenPrefs: () => {},
    onApplyChangeSet: () => {},
    onDiscardChangeSet: () => {},
    onSend: () => {},
    onStop: () => {},
    onQuickAction: () => {},
    onExplain: () => {},
    onClear: () => {},
  },
} satisfies Meta<typeof AssistantChat>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The resting assembly: the intro empty state in the transcript scroller, no change set, and the
 *  composer (quick actions + prompt) below. */
export const Empty: Story = {
  args: { store: createAppStore() },
};

/** The full working surface: a populated conversation (markdown replies through MdHtml), the staged
 *  change-set review mounted at the END of the transcript scroller, and the composer carrying an
 *  unsent draft — the assembly a user sees mid-review. */
export const ConversationWithChangeSet: Story = {
  args: { store: populatedStore() },
};

/** A rejected/missing API key at send time: the ephemeral note bubble (with its "Open Settings"
 *  affordance) rides at the end of the transcript, above the composer. */
export const KeyNotice: Story = {
  args: {
    store: populatedStore(),
    notice: {
      kind: 'note',
      text: 'Add your API key in Settings to use the assistant. ',
      openSettings: true,
    },
  },
};
