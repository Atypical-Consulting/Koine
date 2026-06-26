// Tests for the status-bar "compiling…" indicator (#516): the transient affordance that surfaces the
// existing compile-in-flight signal (#469) while the compiler is busy, debouncing the reveal so a fast
// keystroke-diagnose doesn't flash it on and off (matching the playground's busy affordance).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/preact';
import { axe } from 'vitest-axe';

import { CompilingIndicator } from '@/shell/CompilingIndicator';
import { isCompileInFlight, markCompileEnd, markCompileStart } from '@/host/browser/compileActivity';

const DEBOUNCE_MS = 150;
// The visual pulsing pill (shown/hidden), and the separate always-present polite live region.
const indicator = (c: Element) => c.querySelector('[data-role="compiling"]') as HTMLElement | null;
const liveRegion = (c: Element) => c.querySelector('[data-role="compiling-status"]') as HTMLElement | null;
const isShown = (el: HTMLElement | null) => el != null && !el.hasAttribute('hidden');

describe('CompilingIndicator (#516)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // The compile-activity counter is module-level singleton state — drain it so cases don't leak.
    while (isCompileInFlight()) markCompileEnd();
    vi.useRealTimers();
  });

  it('is hidden initially (idle, nothing compiling)', () => {
    const { container } = render(<CompilingIndicator />);
    const el = indicator(container);
    expect(el).not.toBeNull(); // the visual pill exists…
    expect(isShown(el)).toBe(false); // …but it shows nothing while idle
    expect(el!.textContent).toBe('');

    // The announcer is always present in the a11y tree (so it can announce later), but silent while idle.
    const live = liveRegion(container);
    expect(live).not.toBeNull();
    expect(live!.getAttribute('aria-live')).toBe('polite');
    expect(live!.textContent).toBe('');
  });

  it('reveals "compiling…" only after the debounce elapses while still busy', () => {
    const { container } = render(<CompilingIndicator />);

    act(() => {
      markCompileStart(); // idle → busy
    });
    expect(isShown(indicator(container))).toBe(false); // not yet — the reveal is debounced

    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    });
    expect(isShown(indicator(container))).toBe(false); // still within the debounce window

    act(() => {
      vi.advanceTimersByTime(1);
    });
    const el = indicator(container);
    expect(isShown(el)).toBe(true);
    expect(el!.textContent).toContain('compiling');
    // The persistent polite announcer now carries the text, so a screen reader announces it.
    expect(liveRegion(container)!.textContent).toContain('compiling');
  });

  it('shows nothing when busy ends before the debounce fires (fast keystroke-diagnose)', () => {
    const { container } = render(<CompilingIndicator />);

    act(() => {
      markCompileStart(); // idle → busy
    });
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS - 50); // a quick compile finishes inside the window
    });
    act(() => {
      markCompileEnd(); // busy → idle before the reveal timer fires
    });
    act(() => {
      vi.advanceTimersByTime(200); // let any stale timer fire — it must NOT reveal
    });
    expect(isShown(indicator(container))).toBe(false);
  });

  it('hides immediately when busy ends after it became visible', () => {
    const { container } = render(<CompilingIndicator />);

    act(() => {
      markCompileStart();
    });
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    expect(isShown(indicator(container))).toBe(true);

    act(() => {
      markCompileEnd(); // busy → idle
    });
    expect(isShown(indicator(container))).toBe(false); // hidden immediately, no debounce on hide
  });

  it('stays visible across a nested compile and hides only when the last one settles', () => {
    const { container } = render(<CompilingIndicator />);

    act(() => {
      markCompileStart(); // 0 → 1
      markCompileStart(); // 1 → 2 (nested, e.g. diagnose + emit-preview)
    });
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    expect(isShown(indicator(container))).toBe(true);

    act(() => {
      markCompileEnd(); // 2 → 1, still busy
    });
    expect(isShown(indicator(container))).toBe(true); // one compile still outstanding

    act(() => {
      markCompileEnd(); // 1 → 0
    });
    expect(isShown(indicator(container))).toBe(false);
  });

  it('unsubscribes and clears the timer on teardown (no late update after unmount)', () => {
    const { container, unmount } = render(<CompilingIndicator />);

    act(() => {
      markCompileStart(); // schedule the reveal timer
    });
    unmount();

    // Firing the pending timer + further activity after unmount must not throw or update anything.
    expect(() =>
      act(() => {
        vi.advanceTimersByTime(500);
        markCompileEnd();
        markCompileStart();
        vi.advanceTimersByTime(500);
      }),
    ).not.toThrow();
    expect(indicator(container)).toBeNull(); // the component is gone
  });

  it('has no accessibility violations while visible', async () => {
    vi.useRealTimers(); // axe runs async work + a real macrotask debounce; keep real timers here
    const { container } = render(<CompilingIndicator debounceMs={0} />);
    await act(async () => {
      markCompileStart();
      await new Promise((resolve) => setTimeout(resolve, 10)); // let the 0 ms reveal timer fire
    });
    expect(isShown(indicator(container))).toBe(true);
    expect(await axe(container)).toHaveNoViolations();
  });
});
