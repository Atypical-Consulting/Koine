// Tests for the shared `$bp-narrow` crossing helper (moved from shell/inspector/shared.ts, #1403 —
// createNarrowCrossHandler is not inspector-specific, it wraps isNarrowViewport() from this module).
import { afterEach, describe, expect, test, vi } from 'vitest';
import { BP_NARROW, createNarrowCrossHandler } from '@/shared/breakpoint';

describe('createNarrowCrossHandler', () => {
  const origWidth = window.innerWidth;
  const setWidth = (value: number) =>
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value });

  afterEach(() => setWidth(origWidth));

  test('a resize tick that does not cross the breakpoint is a no-op', () => {
    setWidth(1280);
    const onCross = vi.fn();
    const handler = createNarrowCrossHandler(onCross);
    setWidth(BP_NARROW + 1); // narrower, but still on the wide side
    handler();
    expect(onCross).not.toHaveBeenCalled();
  });

  test('crossing wide→narrow fires onCross(true) once; same-side churn after it stays silent', () => {
    setWidth(1280);
    const onCross = vi.fn();
    const handler = createNarrowCrossHandler(onCross);
    setWidth(500);
    handler();
    expect(onCross).toHaveBeenCalledTimes(1);
    expect(onCross).toHaveBeenCalledWith(true);
    handler(); // keyboard/address-bar churn on the narrow side — no re-fire
    expect(onCross).toHaveBeenCalledTimes(1);
  });

  test('crossing back narrow→wide fires onCross(false)', () => {
    setWidth(500);
    const onCross = vi.fn();
    const handler = createNarrowCrossHandler(onCross);
    setWidth(1280);
    handler();
    expect(onCross).toHaveBeenCalledTimes(1);
    expect(onCross).toHaveBeenCalledWith(false);
  });

  test('last-narrow-ness is seeded at creation, not on the first tick', () => {
    setWidth(500); // created narrow
    const onCross = vi.fn();
    const handler = createNarrowCrossHandler(onCross);
    handler(); // first tick, still narrow — not a cross
    expect(onCross).not.toHaveBeenCalled();
  });
});
