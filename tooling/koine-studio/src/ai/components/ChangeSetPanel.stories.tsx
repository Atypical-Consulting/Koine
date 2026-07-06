import type { Meta, StoryObj } from '@storybook/preact-vite';
import { ChangeSetPanel } from '@/ai/components/ChangeSetPanel';
import { createAppStore, type AppState } from '@/store/index';
import type { StagedEdit } from '@/ai/editSession';
import type { StoreApi } from 'zustand/vanilla';

// The assistant's change-set review as a declarative Preact panel (#990 Task 3): one row per staged
// file (accept checkbox, new/modified badge, relPath, inline line-diff), the once-per-turn staged-
// workspace diagnostics (#474), drift warnings (#473), and the Apply/Discard controls — every control
// state derived from the chat slice's `chat.changeSet` state machine (#984). Each story seeds its own
// `createAppStore()` and drives the slice into the phase under review via the real actions
// (stageChangeSet → beginChangeSetApply → resolveChangeSetApply / rejectChangeSetApply /
// invalidateChangeSet), so the stories exercise exactly the states the store can produce. The
// @storybook/addon-a11y axe pass guards each state's accessibility.

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

const INVOICE_BODY = `context Billing {
  value Invoice {
    number: String
    amount: Money
  }
}`;

/** The staged set every story reviews: one modified file (a real line-diff) + one brand-new file. */
const staged: StagedEdit[] = [
  { key: 'ordering/order.koi', relPath: 'ordering/order.koi', body: ORDER_AFTER, isNew: false },
  { key: 'billing/invoice.koi', relPath: 'billing/invoice.koi', body: INVOICE_BODY, isNew: true },
];
const before = { 'ordering/order.koi': ORDER_BEFORE };

/** A store whose chat slice holds the staged set, still in the initial reviewing phase. */
function reviewingStore(diagnostics: string | null = null): StoreApi<AppState> {
  const store = createAppStore();
  store.getState().stageChangeSet(staged, before, diagnostics);
  return store;
}

const meta = {
  title: 'Panels/ChangeSetPanel',
  component: ChangeSetPanel,
  parameters: { layout: 'padded' },
  args: {
    store: reviewingStore(),
    onApply: () => {},
    onDiscard: () => {},
  },
} satisfies Meta<typeof ChangeSetPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The freshly staged review: mixed new/modified rows with their diffs, everything accepted, and the
 *  Apply label counting the accepted files. */
export const Reviewing: Story = {
  args: { store: reviewingStore() },
};

/** An apply in flight: the label still tracks the accepted count but Apply is locked so a mid-apply
 *  toggle can't start a second concurrent write. */
export const Applying: Story = {
  render: (args) => {
    const store = reviewingStore();
    store.getState().beginChangeSetApply();
    return <ChangeSetPanel {...args} store={store} />;
  },
};

/** The terminal success: "Applied ✓", Discard gone, checkboxes locked — the review can never write a
 *  second time. */
export const Applied: Story = {
  render: (args) => {
    const store = reviewingStore();
    store.getState().beginChangeSetApply();
    store.getState().resolveChangeSetApply({ failed: [] });
    return <ChangeSetPanel {...args} store={store} />;
  },
};

/** A set retired by a newer turn (#473): superseded treatment, Apply + checkboxes disabled, and the
 *  polite live region announcing why it can no longer be applied. */
export const Superseded: Story = {
  render: (args) => {
    const store = reviewingStore();
    store.getState().invalidateChangeSet('superseded');
    return <ChangeSetPanel {...args} store={store} />;
  },
};

/** An apply that failed (#633): back to reviewing with the error in the live region and Apply
 *  RE-ENABLED so the still-checked set can be retried. */
export const FailedWithRetry: Story = {
  render: (args) => {
    const store = reviewingStore();
    store.getState().beginChangeSetApply();
    store.getState().rejectChangeSetApply('Apply failed: Error: disk write failed');
    return <ChangeSetPanel {...args} store={store} />;
  },
};

/** A file the user edited while the turn ran (#473): its row carries the sticky drift warning. */
export const DriftedRows: Story = {
  render: (args) => {
    const store = reviewingStore();
    store.getState().markChangeSetDrift(['ordering/order.koi']);
    return <ChangeSetPanel {...args} store={store} />;
  },
};

/** The end-of-turn staged-workspace validation reported errors (#474): the diagnostics block renders
 *  alongside the rows so a write that broke the model is visible BEFORE apply. */
export const WithDiagnostics: Story = {
  args: {
    store: reviewingStore(
      'ok: false — 2 error(s)\nordering/order.koi(4,5): error KOI0042: Unknown type `Money`\nbilling/invoice.koi(2,3): error KOI0007: Duplicate value object `Invoice`',
    ),
  },
};
