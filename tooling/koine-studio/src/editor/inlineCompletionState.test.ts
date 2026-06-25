import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInlineState, type InlineStateOptions } from './inlineCompletionState';

// The state machine is pure timing/abort logic — no DOM, no network. Fake timers drive the debounce
// deterministically; the provider is a vi.fn so we assert *when* and *with what* it is invoked.
describe('inline-completion state machine', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(over: Partial<InlineStateOptions<string>> = {}) {
    const fetch = vi.fn(async (_ctx: string, _signal: AbortSignal) => 'SUGGESTION');
    const state = createInlineState<string>({
      debounceMs: 300,
      isEnabled: () => true,
      canSuggest: () => true,
      fetch,
      ...over,
    });
    return { state, fetch };
  }

  it('schedules the fetch only after the debounce elapses', async () => {
    const { state, fetch } = setup();
    state.onType('a');
    expect(fetch).not.toHaveBeenCalled();
    expect(state.status).toBe('pending');
    await vi.advanceTimersByTimeAsync(300);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('coalesces rapid keystrokes into a single fetch for the latest context', async () => {
    const { state, fetch } = setup();
    state.onType('a');
    await vi.advanceTimersByTimeAsync(100);
    state.onType('ab'); // a fresh keystroke inside the debounce window resets the timer
    await vi.advanceTimersByTimeAsync(100);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('ab');
  });

  it('does not fetch when disabled', async () => {
    const { state, fetch } = setup({ isEnabled: () => false });
    state.onType('a');
    await vi.advanceTimersByTimeAsync(300);
    expect(fetch).not.toHaveBeenCalled();
    expect(state.status).toBe('idle');
  });

  it('does not fetch when canSuggest rejects the context', async () => {
    const { state, fetch } = setup({ canSuggest: () => false });
    state.onType('a');
    await vi.advanceTimersByTimeAsync(300);
    expect(fetch).not.toHaveBeenCalled();
    expect(state.status).toBe('idle');
  });

  it('moves to showing when a non-empty suggestion resolves', async () => {
    const { state } = setup();
    state.onType('a');
    await vi.advanceTimersByTimeAsync(300);
    await vi.runAllTimersAsync();
    expect(state.status).toBe('showing');
    expect(state.suggestion).toBe('SUGGESTION');
  });

  it('stays idle when the provider returns an empty/null continuation', async () => {
    const { state } = setup({ fetch: vi.fn(async () => null) });
    state.onType('a');
    await vi.advanceTimersByTimeAsync(300);
    await vi.runAllTimersAsync();
    expect(state.status).toBe('idle');
    expect(state.suggestion).toBeNull();
  });

  it('accept() returns the shown text and clears', async () => {
    const { state } = setup();
    state.onType('a');
    await vi.advanceTimersByTimeAsync(300);
    await vi.runAllTimersAsync();
    expect(state.accept()).toBe('SUGGESTION');
    expect(state.status).toBe('idle');
    expect(state.suggestion).toBeNull();
  });

  it('accept() returns null when nothing is showing', () => {
    const { state } = setup();
    expect(state.accept()).toBeNull();
  });

  it('dismiss() clears a shown suggestion', async () => {
    const { state } = setup();
    state.onType('a');
    await vi.advanceTimersByTimeAsync(300);
    await vi.runAllTimersAsync();
    state.dismiss();
    expect(state.status).toBe('idle');
    expect(state.suggestion).toBeNull();
  });

  it('aborts the in-flight request and ignores its stale result when a new edit arrives', async () => {
    const signals: AbortSignal[] = [];
    const resolvers: ((v: string | null) => void)[] = [];
    const fetch = vi.fn(
      (_ctx: string, signal: AbortSignal) =>
        new Promise<string | null>((resolve) => {
          signals.push(signal);
          resolvers.push(resolve);
        }),
    );
    const { state } = setup({ fetch });

    state.onType('first');
    await vi.advanceTimersByTimeAsync(300); // first request is now in flight
    expect(signals[0].aborted).toBe(false);

    state.onType('second'); // edit while pending → the prior request is aborted
    expect(signals[0].aborted).toBe(true);

    resolvers[0]('STALE-FIRST'); // the aborted request resolves late
    await Promise.resolve();
    expect(state.status).not.toBe('showing'); // its stale result must not surface
    expect(state.suggestion).toBeNull();

    await vi.advanceTimersByTimeAsync(300); // the second request runs
    resolvers[1]('FRESH-SECOND');
    await vi.runAllTimersAsync();
    expect(state.status).toBe('showing');
    expect(state.suggestion).toBe('FRESH-SECOND'); // only the latest request wins
  });

  it('notifies onChange when an async resolution changes the rendered state', async () => {
    const { state } = setup();
    const onChange = vi.fn();
    state.onChange = onChange;
    state.onType('a');
    await vi.advanceTimersByTimeAsync(300);
    await vi.runAllTimersAsync();
    expect(onChange).toHaveBeenCalled();
  });
});
