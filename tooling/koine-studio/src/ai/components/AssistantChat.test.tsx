// Tests for AssistantChat (#990 Task 6): the ASSEMBLED assistant view — Transcript + ChangeSetPanel +
// Composer over the injected store's chat slice. The per-panel suites own each half's behavior; this
// suite pins the COMPOSITION contract the assembly adds: the change-set review mounts at the end of
// the transcript scroller (so a long per-file diff scrolls with the conversation), the composer's
// controls row sits outside it, the ephemeral host props (notice) reach the transcript — and the whole
// populated assembly passes axe, per the migration recipe's story + axe-test requirement
// (CONTRIBUTING-preact-migration.md).
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import { createAppStore, type AppState } from '@/store/index';
import type { StagedEdit } from '@/ai/editSession';
import type { StoreApi } from 'zustand/vanilla';
import { AssistantChat, type AssistantChatProps } from '@/ai/components/AssistantChat';

const staged: StagedEdit[] = [
  {
    key: 'ordering/order.koi',
    relPath: 'ordering/order.koi',
    body: 'context Ordering {\n  aggregate Order {}\n}',
    isNew: false,
  },
  { key: 'new:billing/invoice.koi', relPath: 'billing/invoice.koi', body: 'context Billing {}', isNew: true },
];
const before = { 'ordering/order.koi': 'context Ordering {\n}' };

/** A store carrying a finished conversation (streaming off) with a change set under review. */
function populatedStore(): StoreApi<AppState> {
  const store = createAppStore();
  store.getState().appendChatMessage({ role: 'user', content: 'Model an ordering domain for me.' });
  store.getState().appendChatMessage({ role: 'assistant', content: 'Use an **aggregate** for the order.' });
  store.getState().appendChatMessage({ role: 'user', content: 'Stage the invariant everywhere.' });
  store.getState().appendChatMessage({ role: 'assistant', content: 'Staged across two files.' });
  store.getState().stageChangeSet(staged, before, null);
  return store;
}

function mount(store: StoreApi<AppState>, extra?: Partial<AssistantChatProps>) {
  return render(
    <AssistantChat
      store={store}
      onApplyModel={extra?.onApplyModel ?? (() => {})}
      onOpenPrefs={extra?.onOpenPrefs ?? (() => {})}
      onApplyChangeSet={extra?.onApplyChangeSet ?? (() => {})}
      onDiscardChangeSet={extra?.onDiscardChangeSet ?? (() => {})}
      onSend={extra?.onSend ?? (() => {})}
      onStop={extra?.onStop ?? (() => {})}
      onQuickAction={extra?.onQuickAction ?? (() => {})}
      onExplain={extra?.onExplain ?? (() => {})}
      onClear={extra?.onClear ?? (() => {})}
      {...extra}
    />,
  );
}

describe('AssistantChat (#990 assembly)', () => {
  test('composes transcript, change-set review and composer: the review mounts INSIDE the scroller, the controls row outside', () => {
    const { container } = mount(populatedStore());

    // The transcript renders the conversation (both roles, markdown through MdHtml).
    const transcript = container.querySelector('.koi-assistant-transcript')!;
    expect(transcript).not.toBeNull();
    const msgs = [...transcript.querySelectorAll('.koi-msg')];
    expect(msgs.length).toBe(4);
    expect(msgs[0].textContent).toBe('Model an ordering domain for me.');
    expect(msgs[1].querySelector('.koi-md strong')!.textContent).toBe('aggregate');

    // The change-set review renders INSIDE the transcript scroller (a long diff scrolls with the
    // conversation, like the imperative in-bubble island), with both staged rows.
    const changeset = container.querySelector('.koi-changeset')!;
    expect(changeset).not.toBeNull();
    expect(transcript.contains(changeset)).toBe(true);
    expect(changeset.querySelectorAll('.koi-changeset-file').length).toBe(2);

    // The composer's controls row is present and sits OUTSIDE the scroller.
    const controls = container.querySelector('.koi-assistant-controls')!;
    expect(controls).not.toBeNull();
    expect(transcript.contains(controls)).toBe(false);
    expect(controls.querySelector('.koi-assistant-input')).not.toBeNull();
    expect(controls.querySelector('.koi-assistant-send')).not.toBeNull();
  });

  test('the change-set gestures route to the host callbacks through the assembly', () => {
    const onApplyChangeSet = vi.fn();
    const onDiscardChangeSet = vi.fn();
    const { container } = mount(populatedStore(), { onApplyChangeSet, onDiscardChangeSet });

    fireEvent.click(container.querySelector('.koi-changeset-apply')!);
    expect(onApplyChangeSet).toHaveBeenCalledOnce();
    fireEvent.click(container.querySelector('.koi-changeset-discard')!);
    expect(onDiscardChangeSet).toHaveBeenCalledOnce();
  });

  test('the ephemeral notice prop reaches the transcript with its Open Settings affordance', () => {
    const onOpenPrefs = vi.fn();
    const { container } = mount(populatedStore(), {
      onOpenPrefs,
      notice: { kind: 'note', text: 'Add your API key in Settings to use the assistant. ', openSettings: true },
    });
    const note = container.querySelector('.koi-msg-note')!;
    expect(note).not.toBeNull();
    fireEvent.click(note.querySelector('.koi-link-btn')!);
    expect(onOpenPrefs).toHaveBeenCalledOnce();
  });

  test('has no accessibility violations (populated conversation + reviewing change set + notice)', async () => {
    const { container } = mount(populatedStore(), {
      notice: { kind: 'note', text: 'Add your API key in Settings to use the assistant. ', openSettings: true },
    });
    expect(await axe(container)).toHaveNoViolations();
  });
});
