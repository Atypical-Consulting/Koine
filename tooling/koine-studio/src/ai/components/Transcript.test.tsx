// Tests for Transcript (#990 Task 4): the assistant transcript as a declarative consumer of the chat
// slice — the keyed message list from `chat.messages` (user text verbatim, assistant markdown through
// MdHtml with the host-gated Apply affordance, #444), the EPHEMERAL streaming turn from `chat.turn`
// (live text + `koi-assistant-tool` cards with the pending/ok/error `data-state` machine, clamped
// results, formatted durations), and the ephemeral note/error bubbles. The imperative panel's DOM
// contract — `koi-msg`, `koi-msg-user/-assistant/-note/-error`, `koi-assistant-tool`, `koi-tool-*`,
// the sr-only state text, the intro empty state — must be preserved, and slice updates must PATCH the
// existing elements (keyed reuse), never rebuild the transcript.
import { describe, expect, test, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/preact';
import { fireEvent } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import { createAppStore, type AppState } from '@/store/index';
import type { StoreApi } from 'zustand/vanilla';
import { Transcript, TOOL_RESULT_CLAMP, type TranscriptProps } from '@/ai/components/Transcript';

/** A store whose chat slice holds a finished user → assistant exchange. */
function exchangeStore(assistantMd = 'Use an **aggregate** here.'): StoreApi<AppState> {
  const store = createAppStore();
  store.getState().appendChatMessage({ role: 'user', content: 'How should I model orders?' });
  store.getState().appendChatMessage({ role: 'assistant', content: assistantMd });
  return store;
}

function mount(store: StoreApi<AppState>, extra?: Partial<TranscriptProps>) {
  return render(
    <Transcript
      store={store}
      onApplyModel={extra?.onApplyModel ?? (() => {})}
      onOpenPrefs={extra?.onOpenPrefs ?? (() => {})}
      {...extra}
    />,
  );
}

const transcript = (c: Element) => c.querySelector('.koi-assistant-transcript') as HTMLElement;
const bubbles = (c: Element) => [...c.querySelectorAll('.koi-msg')] as HTMLElement[];
const cards = (c: Element) => [...c.querySelectorAll('.koi-assistant-tool')] as HTMLElement[];

describe('Transcript (#990)', () => {
  test('empty transcript renders only the intro empty state', () => {
    const { container } = mount(createAppStore());
    const intro = container.querySelector('.koi-assistant-intro')!;
    expect(intro).not.toBeNull();
    expect(intro.textContent).toContain('Domain copilot.');
    expect(bubbles(container)).toEqual([]);
  });

  test('the intro disappears once the transcript has content', () => {
    const { container } = mount(exchangeStore());
    expect(container.querySelector('.koi-assistant-intro')).toBeNull();
  });

  test('messages render in order with the koi-msg class contract; user text is verbatim', () => {
    const { container } = mount(exchangeStore());
    const all = bubbles(container);
    expect(all.length).toBe(2);
    expect(all[0].className).toBe('koi-msg koi-msg-user');
    expect(all[0].textContent).toBe('How should I model orders?');
    expect(all[1].className).toBe('koi-msg koi-msg-assistant');
  });

  test('assistant markdown renders through MdHtml: elements inside .koi-md, hostile content escaped', () => {
    const { container } = mount(exchangeStore('**bold** and <img src=x onerror=alert(1)>'));
    const md = bubbles(container)[1].querySelector('.koi-md')!;
    expect(md).not.toBeNull();
    expect(md.querySelector('strong')!.textContent).toBe('bold');
    // The single escaping boundary (#990 Task 2): raw markup in model output stays inert text.
    expect(container.querySelector('img')).toBeNull();
    expect(md.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  test('appending a message patches the list: the earlier bubble keeps its element identity', () => {
    const store = exchangeStore();
    const { container } = mount(store);
    const firstBefore = bubbles(container)[0];
    act(() => store.getState().appendChatMessage({ role: 'user', content: 'And invoices?' }));
    const all = bubbles(container);
    expect(all.length).toBe(3);
    expect(all[0]).toBe(firstBefore); // stable key: no rebuild
    expect(all[2].textContent).toBe('And invoices?');
  });

  describe('apply affordance (#444: host-gated)', () => {
    test('renders Apply once the gate resolves a candidate, and applies THAT candidate on click', async () => {
      const store = exchangeStore('```koine\ncontext Broken {\n```');
      const onApplyModel = vi.fn();
      const getApplyCandidate = vi.fn(() => Promise.resolve('context Repaired {}'));
      const { container } = mount(store, { onApplyModel, getApplyCandidate });

      await waitFor(() => expect(container.querySelector('.koi-assistant-apply')).not.toBeNull());
      const apply = container.querySelector('.koi-assistant-apply') as HTMLButtonElement;
      expect(getApplyCandidate).toHaveBeenCalledWith('```koine\ncontext Broken {\n```');
      expect(apply.textContent).toBe('Apply to editor');
      expect(apply.disabled).toBe(false);

      fireEvent.click(apply);
      // The gate's candidate (the repaired source), not the markdown, is what gets applied.
      expect(onApplyModel).toHaveBeenCalledExactlyOnceWith('context Repaired {}');
      expect(apply.textContent).toBe('Applied ✓');
      expect(apply.disabled).toBe(true);
    });

    test('no Apply when the gate resolves null, rejects, or the turn opted out (offerApply: false)', async () => {
      const nullGate = mount(exchangeStore(), { getApplyCandidate: () => Promise.resolve(null) });
      const throwing = mount(exchangeStore(), { getApplyCandidate: () => Promise.reject(new Error('down')) });

      const optedOut = createAppStore();
      optedOut.getState().appendChatMessage({ role: 'assistant', content: 'explanation', offerApply: false });
      const gate = vi.fn(() => Promise.resolve('context X {}'));
      const optedOutView = mount(optedOut, { getApplyCandidate: gate });

      // Flush the async gates, then confirm none of the three ever offered Apply (fail closed).
      await act(async () => {});
      expect(nullGate.container.querySelector('.koi-assistant-apply')).toBeNull();
      expect(throwing.container.querySelector('.koi-assistant-apply')).toBeNull();
      expect(optedOutView.container.querySelector('.koi-assistant-apply')).toBeNull();
      expect(gate).not.toHaveBeenCalled(); // an explanatory turn never even consults the gate
    });
  });

  describe('streaming turn', () => {
    test('renders the live text as a plain-text assistant bubble ("…" until the first delta)', () => {
      const store = createAppStore();
      store.getState().appendChatMessage({ role: 'user', content: 'q' });
      store.getState().startChatTurn();
      const { container } = mount(store);

      const stream = bubbles(container)[1];
      expect(stream.className).toBe('koi-msg koi-msg-assistant');
      expect(stream.textContent).toBe('…');
      // Plain text while streaming (the imperative panel streamed textContent, not markdown).
      expect(stream.querySelector('.koi-md')).toBeNull();

      act(() => store.getState().appendStreamingText('Hello **there**'));
      expect(stream.textContent).toBe('Hello **there**');
      expect(stream.querySelector('strong')).toBeNull();
    });

    test('streaming updates patch in place: earlier bubbles and the streaming bubble keep identity', () => {
      const store = createAppStore();
      store.getState().appendChatMessage({ role: 'user', content: 'q' });
      store.getState().startChatTurn();
      const { container } = mount(store);
      const [userBefore, streamBefore] = bubbles(container);

      act(() => store.getState().appendStreamingText('first '));
      act(() => store.getState().appendStreamingText('second'));
      const [userAfter, streamAfter] = bubbles(container);
      expect(userAfter).toBe(userBefore);
      expect(streamAfter).toBe(streamBefore);
      expect(streamAfter.textContent).toBe('first second');
    });

    test('the streaming bubble disappears once the turn settles', () => {
      const store = createAppStore();
      store.getState().appendChatMessage({ role: 'user', content: 'q' });
      store.getState().startChatTurn();
      const { container } = mount(store);
      expect(bubbles(container).length).toBe(2);
      act(() => {
        store.getState().appendChatMessage({ role: 'assistant', content: 'done' });
        store.getState().finishChatTurn();
      });
      expect(bubbles(container).length).toBe(2); // user + committed assistant; no live bubble left
      expect(store.getState().chat.turn).toBeNull();
    });
  });

  describe('tool cards', () => {
    function streamingWithCall(): StoreApi<AppState> {
      const store = createAppStore();
      store.getState().appendChatMessage({ role: 'user', content: 'validate' });
      store.getState().startChatTurn();
      store.getState().startToolCall({ id: 1, name: 'koine_validate', args: '{"source":"context A {}"}' });
      return store;
    }

    test('a pending card: <details> with data-state, decorative glyph, sr-only "running", name, "…" chip', () => {
      const { container } = mount(streamingWithCall());
      const card = cards(container)[0];
      expect(card.tagName).toBe('DETAILS');
      expect(card.dataset.state).toBe('pending');
      const glyph = card.querySelector('.koi-tool-glyph')!;
      expect(glyph.getAttribute('aria-hidden')).toBe('true');
      expect(glyph.textContent).toBe('…');
      expect(card.querySelector('.koi-tool-state')!.className).toBe('koi-sr-only koi-tool-state');
      expect(card.querySelector('.koi-tool-state')!.textContent).toBe('running');
      expect(card.querySelector('.koi-tool-name')!.textContent).toBe('koine_validate');
      expect(card.querySelector('.koi-tool-summary')!.textContent).toBe('…');
      expect(card.querySelector('.koi-tool-duration')!.textContent).toBe('');
      expect(card.querySelector('.koi-tool-detail')).toBeNull(); // the body only lands on completion
      // Inserted ABOVE the streaming bubble, like the imperative insertBefore.
      const children = [...transcript(container).children];
      expect(children.indexOf(card)).toBeLessThan(children.indexOf(bubbles(container)[1]));
    });

    test('completing a call flips the SAME element pending → ok with summary, duration and body', () => {
      const store = streamingWithCall();
      const { container } = mount(store);
      const cardBefore = cards(container)[0];

      act(() =>
        store.getState().completeToolCall({
          id: 1,
          state: 'ok',
          summary: 'valid',
          result: 'ok: true — compiled 1 file(s)',
          durationMs: 312,
        }),
      );

      const card = cards(container)[0];
      expect(card).toBe(cardBefore); // keyed by call id: the START's element is PATCHED, never remounted
      expect(card.dataset.state).toBe('ok');
      expect(card.querySelector('.koi-tool-glyph')!.textContent).toBe('✓');
      expect(card.querySelector('.koi-tool-state')!.textContent).toBe('succeeded');
      expect(card.querySelector('.koi-tool-summary')!.textContent).toBe('valid');
      expect(card.querySelector('.koi-tool-duration')!.textContent).toBe('312 ms');

      const detail = card.querySelector('.koi-tool-detail')!;
      const dts = [...detail.querySelectorAll('dt')].map((d) => d.textContent);
      expect(dts).toEqual(['Arguments', 'Result']);
      // Arguments are pretty-printed from the raw argsJson stashed at START.
      expect(detail.querySelectorAll('dd pre')[0].textContent).toBe('{\n  "source": "context A {}"\n}');
      expect(detail.querySelectorAll('dd pre')[1].textContent).toBe('ok: true — compiled 1 file(s)');
      expect(card.querySelector('.koi-tool-truncated')).toBeNull();
    });

    test('a failed call flips to error: ✕ glyph, sr-only "failed", the error message as the Result body', () => {
      const store = streamingWithCall();
      const { container } = mount(store);
      act(() =>
        store.getState().completeToolCall({ id: 1, state: 'error', summary: 'failed', result: 'boom', durationMs: 1400 }),
      );
      const card = cards(container)[0];
      expect(card.dataset.state).toBe('error');
      expect(card.querySelector('.koi-tool-glyph')!.textContent).toBe('✕');
      expect(card.querySelector('.koi-tool-state')!.textContent).toBe('failed');
      expect(card.querySelector('.koi-tool-duration')!.textContent).toBe('1.4 s'); // ≥ 1000 ms formats as seconds
      expect(card.querySelectorAll('.koi-tool-detail dd pre')[1].textContent).toBe('boom');
    });

    test('a result past TOOL_RESULT_CLAMP is clamped with the "(truncated)" note', () => {
      const store = streamingWithCall();
      const { container } = mount(store);
      const huge = 'x'.repeat(TOOL_RESULT_CLAMP + 100);
      act(() =>
        store.getState().completeToolCall({ id: 1, state: 'ok', summary: 'big', result: huge, durationMs: 5 }),
      );
      const card = cards(container)[0];
      expect(card.querySelectorAll('.koi-tool-detail dd pre')[1].textContent!.length).toBe(TOOL_RESULT_CLAMP);
      expect(card.querySelector('.koi-tool-truncated')!.textContent).toBe('(truncated)');
    });

    test('a second call appends a second card in order, patching (not rebuilding) the first', () => {
      const store = streamingWithCall();
      const { container } = mount(store);
      const firstBefore = cards(container)[0];
      const streamBefore = bubbles(container)[1];

      act(() => store.getState().startToolCall({ id: 2, name: 'koine_compile', args: '{}' }));
      const all = cards(container);
      expect(all.length).toBe(2);
      expect(all[0]).toBe(firstBefore);
      expect(all[1].querySelector('.koi-tool-name')!.textContent).toBe('koine_compile');
      // The streaming bubble survives the insert and stays BELOW both cards.
      const streamAfter = bubbles(container)[1];
      expect(streamAfter).toBe(streamBefore);
      const children = [...transcript(container).children];
      expect(children.indexOf(all[1])).toBeLessThan(children.indexOf(streamAfter));
    });
  });

  // Settled tool cards move from the host's ephemeral snapshot into the chat slice, attached to
  // their committed message (#1133): each assistant message with toolCalls renders its own cards
  // (not just the trailing one), and a card's expanded state — hoisted here because a native
  // <details>'s `open` is DOM state, lost on any remount — survives the commit remount by keying
  // on an identity that's stable across a card's live→settled transition.
  describe('settled tool cards attached to their message (#1133)', () => {
    const settledCall = (id: number): import('@/store/slices/chat').ChatToolCall => ({
      id,
      name: 'koine_compile',
      args: '{}',
      state: 'ok',
      summary: 'ok',
      result: 'compiled',
      durationMs: 10,
    });

    test('every assistant message with toolCalls renders its cards above its own bubble, not just the trailing one', () => {
      const store = createAppStore();
      store.getState().appendChatMessage({ role: 'user', content: 'q1' });
      store.getState().appendChatMessage({ role: 'assistant', content: 'reply1', toolCalls: [settledCall(1)] });
      store.getState().appendChatMessage({ role: 'user', content: 'q2' });
      store.getState().appendChatMessage({ role: 'assistant', content: 'reply2', toolCalls: [settledCall(2)] });
      const { container } = mount(store);

      const allCards = cards(container);
      expect(allCards.length).toBe(2);
      const children = [...transcript(container).children];
      const allBubbles = bubbles(container);
      // Each card sits directly above ITS OWN reply bubble (reply1's card before reply1, not just
      // the last message's).
      expect(children.indexOf(allCards[0])).toBeLessThan(children.indexOf(allBubbles[1]));
      expect(children.indexOf(allCards[1])).toBeLessThan(children.indexOf(allBubbles[3]));
    });

    test('expanding a live card, then committing the turn, keeps it open across the remount', () => {
      const store = createAppStore();
      store.getState().appendChatMessage({ role: 'user', content: 'q' });
      store.getState().startChatTurn();
      store.getState().startToolCall({ id: 1, name: 'koine_compile', args: '{}' });
      store.getState().completeToolCall({ id: 1, state: 'ok', summary: 'ok', result: 'compiled', durationMs: 10 });
      const { container } = mount(store);

      const before = cards(container)[0] as HTMLDetailsElement;
      act(() => {
        before.open = true;
        before.dispatchEvent(new Event('toggle'));
      });
      expect(before.open).toBe(true);

      act(() => store.getState().commitChatTurn({ role: 'assistant', content: 'done' }));

      const after = cards(container)[0] as HTMLDetailsElement;
      expect(after.open).toBe(true);
    });

    test('a workspace-key change renders cards collapsed (no cross-workspace open-state reuse)', () => {
      const store = createAppStore();
      store.getState().hydrateChat('ws-A', [{ role: 'assistant', content: 'reply', toolCalls: [settledCall(1)] }]);
      const { container } = mount(store);

      const before = cards(container)[0] as HTMLDetailsElement;
      act(() => {
        before.open = true;
        before.dispatchEvent(new Event('toggle'));
      });
      expect(before.open).toBe(true);

      act(() =>
        store.getState().hydrateChat('ws-B', [{ role: 'assistant', content: 'reply', toolCalls: [settledCall(1)] }]),
      );

      const after = cards(container)[0] as HTMLDetailsElement;
      expect(after.open).toBe(false);
    });
  });

  describe('ephemeral notices', () => {
    test('the no-key note: koi-msg-note bubble whose Open Settings link-button routes to onOpenPrefs', () => {
      const onOpenPrefs = vi.fn();
      const { container } = mount(createAppStore(), {
        onOpenPrefs,
        notice: { kind: 'note', text: 'Add your API key in Settings to use the assistant. ', openSettings: true },
      });
      const note = container.querySelector('.koi-msg-note')!;
      expect(note.className).toBe('koi-msg koi-msg-assistant koi-msg-note');
      expect(note.textContent).toContain('Add your API key in Settings');
      expect(container.querySelector('.koi-assistant-intro')).toBeNull(); // a notice counts as content

      const open = note.querySelector('.koi-link-btn') as HTMLButtonElement;
      expect(open.textContent).toBe('Open Settings');
      fireEvent.click(open);
      expect(onOpenPrefs).toHaveBeenCalledOnce();
    });

    test('an error notice: koi-msg-error bubble without the settings button', () => {
      const { container } = mount(createAppStore(), {
        notice: { kind: 'error', text: 'Request failed: connection refused' },
      });
      const err = container.querySelector('.koi-msg-error')!;
      expect(err.className).toBe('koi-msg koi-msg-assistant koi-msg-error');
      expect(err.textContent).toBe('Request failed: connection refused');
      expect(err.querySelector('.koi-link-btn')).toBeNull();
    });

    test('the stopped-partial marker rides INSIDE the last assistant bubble', () => {
      const { container } = mount(exchangeStore('partial reply'), { stoppedPartial: true });
      const last = bubbles(container)[1];
      const stopped = last.querySelector('.koi-assistant-stopped')!;
      expect(stopped).not.toBeNull();
      expect(stopped.textContent).toBe('Stopped.');
    });

    test('stoppedPartial marks nothing when the last message is not an assistant turn', () => {
      const store = createAppStore();
      store.getState().appendChatMessage({ role: 'user', content: 'only me' });
      const { container } = mount(store, { stoppedPartial: true });
      expect(container.querySelector('.koi-assistant-stopped')).toBeNull();
    });
  });

  // Per-bubble useState (the resolved Apply candidate, the terminal Applied lock) must never leak
  // across a transcript swap: bubbles are keyed positionally (`m${i}`), so a hydrateChat landing a
  // DIFFERENT conversation with an assistant message at the same index would otherwise reuse the
  // bubble — stale candidate and all. Assertions ride observable DOM + an explicit gate spy, per the
  // focus/refetch test gotcha (Preact reuses rows positionally, so a naive test can be false-green).
  describe('per-bubble state across transcript swaps', () => {
    test('a workspace swap does not carry a resolved Apply candidate onto the new transcript', async () => {
      const store = exchangeStore('A reply');
      let resolveB!: (v: string | null) => void;
      const getApplyCandidate = vi.fn((md: string) =>
        md === 'A reply'
          ? Promise.resolve('context A {}')
          : new Promise<string | null>((r) => {
              resolveB = r;
            }),
      );
      const { container } = mount(store, { getApplyCandidate });
      await waitFor(() => expect(container.querySelector('.koi-assistant-apply')).not.toBeNull());

      // Swap to workspace B, whose transcript ALSO has an assistant message at index 1. B's gate is
      // held pending, so any Apply visible now is A's stale candidate leaking across the swap.
      act(() =>
        store.getState().hydrateChat('ws-B', [
          { role: 'user', content: 'q in B' },
          { role: 'assistant', content: 'B reply' },
        ]),
      );
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(getApplyCandidate).toHaveBeenCalledWith('B reply'); // the NEW gate did run…
      expect(container.querySelector('.koi-assistant-apply')).toBeNull(); // …but nothing stale shows

      // And once B's gate settles null, still nothing to apply.
      resolveB(null);
      await act(async () => {});
      expect(container.querySelector('.koi-assistant-apply')).toBeNull();
    });

    test('a same-key transcript replacement resets the bubble even on the offerApply:false early return', async () => {
      const store = createAppStore();
      store.getState().hydrateChat('ws-1', [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'model reply' },
      ]);
      const getApplyCandidate = vi.fn(() => Promise.resolve('context X {}'));
      const { container } = mount(store, { getApplyCandidate });
      await waitFor(() => expect(container.querySelector('.koi-assistant-apply')).not.toBeNull());

      // The SAME workspace re-hydrates a different conversation whose message at this index is an
      // explanatory turn (offerApply: false). The reused bubble takes the early return — no new gate
      // run will ever overwrite the old candidate — so the reset must happen BEFORE that return.
      act(() =>
        store.getState().hydrateChat('ws-1', [
          { role: 'user', content: 'q2' },
          { role: 'assistant', content: 'explanation', offerApply: false },
        ]),
      );
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(container.querySelector('.koi-assistant-apply')).toBeNull();
    });
  });

  test('autoscrolls to the bottom as the transcript grows', () => {
    const store = exchangeStore();
    const { container } = mount(store);
    const el = transcript(container);
    // happy-dom has no layout, so pin the scroll geometry by hand and watch the setter.
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 500 });
    let scrolled = -1;
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => scrolled,
      set: (v: number) => {
        scrolled = v;
      },
    });
    act(() => store.getState().appendChatMessage({ role: 'user', content: 'more' }));
    expect(scrolled).toBe(500);
  });

  test('has no accessibility violations (messages + streaming tool cards + note)', async () => {
    const store = exchangeStore();
    store.getState().appendChatMessage({ role: 'user', content: 'now validate it' });
    store.getState().startChatTurn();
    store.getState().startToolCall({ id: 1, name: 'koine_validate', args: '{}' });
    store.getState().completeToolCall({ id: 1, state: 'ok', summary: 'valid', result: 'ok: true', durationMs: 10 });
    store.getState().startToolCall({ id: 2, name: 'koine_compile', args: '{}' });
    store.getState().appendStreamingText('Both ran.');
    const { container } = mount(store, {
      notice: { kind: 'note', text: 'Add your API key in Settings to use the assistant. ', openSettings: true },
    });
    expect(await axe(container)).toHaveNoViolations();
  });
});
