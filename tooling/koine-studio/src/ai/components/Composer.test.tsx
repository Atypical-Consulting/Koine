// Tests for Composer (#990 Task 5): the assistant's input row + quick actions as a declarative
// consumer of the chat slice. The imperative panel's DOM contract must be preserved — the
// `koi-assistant-input` textarea (aria-label "Assistant prompt"), the `koi-assistant-send` /
// `koi-assistant-stop` busy swap, the `koi-assistant-action` quick actions (Explain diagnostics /
// Suggest invariants / Review model / Add an aggregate / Explain this construct) and the
// `koi-assistant-clear` button — while the textarea renders CONTROLLED over `chat.draft`
// (setChatDraft), busy derives from `chat.status === 'streaming'`, and every gesture delegates to a
// host callback (the AbortController and the send effect live with the host, never here).
import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import { createAppStore, type AppState } from '@/store/index';
import type { StoreApi } from 'zustand/vanilla';
import { Composer, type ComposerProps } from '@/ai/components/Composer';

function mount(store: StoreApi<AppState>, extra?: Partial<ComposerProps>) {
  return render(
    <Composer
      store={store}
      onSend={extra?.onSend ?? (() => {})}
      onStop={extra?.onStop ?? (() => {})}
      onQuickAction={extra?.onQuickAction ?? (() => {})}
      onExplain={extra?.onExplain ?? (() => {})}
      onClear={extra?.onClear ?? (() => {})}
    />,
  );
}

const input = (c: Element) => c.querySelector('.koi-assistant-input') as HTMLTextAreaElement;
const sendBtn = (c: Element) => c.querySelector('.koi-assistant-send') as HTMLButtonElement;
const stopBtn = (c: Element) => c.querySelector('.koi-assistant-stop') as HTMLButtonElement;
const clearBtn = (c: Element) => c.querySelector('.koi-assistant-clear') as HTMLButtonElement;
const actions = (c: Element) => [...c.querySelectorAll('.koi-assistant-action')] as HTMLButtonElement[];

/** Drive the slice into a streaming turn (the reactive source of the busy treatment). */
function streamingStore(): StoreApi<AppState> {
  const store = createAppStore();
  store.getState().startChatTurn();
  return store;
}

describe('Composer (#990)', () => {
  test('idle DOM contract: labelled textarea, Send visible, Stop hidden, quick actions + Clear', () => {
    const { container } = mount(createAppStore());

    const ta = input(container);
    expect(ta).not.toBeNull();
    expect(ta.tagName).toBe('TEXTAREA');
    expect(ta.getAttribute('aria-label')).toBe('Assistant prompt');
    expect(ta.getAttribute('rows')).toBe('3');
    expect(ta.placeholder).toBe('Describe a domain to model, or ask about this one…  (⌘/Ctrl+Enter to send)');
    expect(ta.disabled).toBe(false);

    expect(sendBtn(container).textContent).toBe('Send');
    expect(sendBtn(container).disabled).toBe(false);
    expect(stopBtn(container).textContent).toBe('Stop');
    expect(stopBtn(container).hidden).toBe(true);

    // The exact quick-action set and order from the imperative panel (aiPanel.ts).
    expect(actions(container).map((b) => b.textContent)).toEqual([
      'Explain diagnostics',
      'Suggest invariants',
      'Review model',
      'Add an aggregate',
      'Explain this construct',
    ]);
    expect(actions(container).every((b) => !b.disabled)).toBe(true);
    expect(clearBtn(container).textContent).toBe('Clear conversation');
    expect(clearBtn(container).disabled).toBe(false);
  });

  test('the textarea is CONTROLLED over chat.draft: typing dispatches setChatDraft, a store write renders back', () => {
    const store = createAppStore();
    const { container } = mount(store);

    fireEvent.input(input(container), { target: { value: 'model a billing domain' } });
    expect(store.getState().chat.draft).toBe('model a billing domain');
    expect(input(container).value).toBe('model a billing domain');

    // The host's error-rollback restore is a plain dispatch — the textarea must follow the slice.
    act(() => store.getState().setChatDraft('restored prompt'));
    expect(input(container).value).toBe('restored prompt');
  });

  test('Send calls onSend with the current draft', () => {
    const store = createAppStore();
    store.getState().setChatDraft('  suggest invariants  ');
    const onSend = vi.fn();
    const { container } = mount(store, { onSend });

    fireEvent.click(sendBtn(container));
    expect(onSend).toHaveBeenCalledExactlyOnceWith('  suggest invariants  ');
  });

  test('⌘Enter and Ctrl+Enter send the draft; a plain Enter does not', () => {
    const store = createAppStore();
    store.getState().setChatDraft('draft');
    const onSend = vi.fn();
    const { container } = mount(store, { onSend });

    fireEvent.keyDown(input(container), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(input(container), { key: 'Enter', metaKey: true });
    fireEvent.keyDown(input(container), { key: 'Enter', ctrlKey: true });
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenNthCalledWith(1, 'draft');
    expect(onSend).toHaveBeenNthCalledWith(2, 'draft');
  });

  test('busy (streaming): input + Send + quick actions + Clear disabled, Stop shown', () => {
    const { container } = mount(streamingStore());

    expect(input(container).disabled).toBe(true);
    expect(sendBtn(container).disabled).toBe(true);
    expect(stopBtn(container).hidden).toBe(false);
    expect(actions(container).every((b) => b.disabled)).toBe(true);
    expect(clearBtn(container).disabled).toBe(true);
  });

  test('the busy swap is reactive: streaming flips the controls, settling restores them', () => {
    const store = createAppStore();
    const { container } = mount(store);
    expect(stopBtn(container).hidden).toBe(true);

    act(() => store.getState().startChatTurn());
    expect(stopBtn(container).hidden).toBe(false);
    expect(sendBtn(container).disabled).toBe(true);

    act(() => store.getState().finishChatTurn());
    expect(stopBtn(container).hidden).toBe(true);
    expect(sendBtn(container).disabled).toBe(false);
    expect(input(container).disabled).toBe(false);
  });

  test('Send, quick actions, Explain and Clear are no-ops while busy (belt-and-braces past disabled)', () => {
    const store = streamingStore();
    store.getState().setChatDraft('queued draft');
    const onSend = vi.fn();
    const onQuickAction = vi.fn();
    const onExplain = vi.fn();
    const onClear = vi.fn();
    const { container } = mount(store, { onSend, onQuickAction, onExplain, onClear });

    fireEvent.click(sendBtn(container));
    fireEvent.keyDown(input(container), { key: 'Enter', metaKey: true });
    for (const b of actions(container)) fireEvent.click(b);
    fireEvent.click(clearBtn(container));

    expect(onSend).not.toHaveBeenCalled();
    expect(onQuickAction).not.toHaveBeenCalled();
    expect(onExplain).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
  });

  test('Stop calls onStop while streaming (the AbortController lives with the host)', () => {
    const onStop = vi.fn();
    const { container } = mount(streamingStore(), { onStop });
    fireEvent.click(stopBtn(container));
    expect(onStop).toHaveBeenCalledOnce();
  });

  test('each quick action reports its identity; Explain and Clear route to their own callbacks', () => {
    const onQuickAction = vi.fn();
    const onExplain = vi.fn();
    const onClear = vi.fn();
    const { container } = mount(createAppStore(), { onQuickAction, onExplain, onClear });

    const [diagnostics, invariants, review, aggregate, explain] = actions(container);
    fireEvent.click(diagnostics);
    fireEvent.click(invariants);
    fireEvent.click(review);
    fireEvent.click(aggregate);
    expect(onQuickAction.mock.calls.map((c) => c[0])).toEqual([
      'explain-diagnostics',
      'suggest-invariants',
      'review-model',
      'add-aggregate',
    ]);

    fireEvent.click(explain);
    expect(onExplain).toHaveBeenCalledOnce();
    expect(onQuickAction).toHaveBeenCalledTimes(4); // Explain is NOT a canned quick action

    fireEvent.click(clearBtn(container));
    expect(onClear).toHaveBeenCalledOnce();
  });

  test('has no accessibility violations (idle with a draft, and busy)', async () => {
    const store = createAppStore();
    store.getState().setChatDraft('model a billing domain');
    const idle = mount(store);
    expect(await axe(idle.container)).toHaveNoViolations();

    const busy = mount(streamingStore());
    expect(await axe(busy.container)).toHaveNoViolations();
  });
});
