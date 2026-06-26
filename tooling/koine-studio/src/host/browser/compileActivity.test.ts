// Tests for the browser host's compile-activity counter (#469): the in-flight signal that gates the
// Studio "Stop compilation" command on an actual compile (matching the playground's busy-only Stop).
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isCompileInFlight,
  markCompileEnd,
  markCompileStart,
  onCompileActivityChange,
} from '@/host/browser/compileActivity';

describe('compile-activity counter (#469)', () => {
  // The counter is module-level singleton state; drain it after each test so cases don't leak.
  afterEach(() => {
    while (isCompileInFlight()) markCompileEnd();
  });

  it('is not in flight initially', () => {
    expect(isCompileInFlight()).toBe(false);
  });

  it('reports in flight after a start and idle again after the matching end', () => {
    markCompileStart();
    expect(isCompileInFlight()).toBe(true);

    markCompileEnd();
    expect(isCompileInFlight()).toBe(false);
  });

  it('stays in flight while a second compile is still outstanding', () => {
    markCompileStart();
    markCompileStart();
    expect(isCompileInFlight()).toBe(true);

    markCompileEnd();
    expect(isCompileInFlight()).toBe(true); // one still outstanding

    markCompileEnd();
    expect(isCompileInFlight()).toBe(false);
  });

  it('never goes negative on an unmatched end (stays idle, then a later start still registers)', () => {
    markCompileEnd(); // extra end with nothing in flight — must clamp at zero, not go negative
    expect(isCompileInFlight()).toBe(false);

    markCompileStart();
    expect(isCompileInFlight()).toBe(true); // a single start after the clamp still flips it true
  });
});

describe('compile-activity change notification (#516)', () => {
  // The counter is module-level singleton state; drain it after each test so cases don't leak.
  afterEach(() => {
    while (isCompileInFlight()) markCompileEnd();
  });

  it('fires once on the idle→busy edge and once on the busy→idle edge', () => {
    const listener = vi.fn();
    const unsubscribe = onCompileActivityChange(listener);

    markCompileStart(); // 0 → 1: busy began
    expect(listener).toHaveBeenCalledTimes(1);

    markCompileEnd(); // 1 → 0: busy ended
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('does NOT fire on nested transitions that stay busy (1↔2)', () => {
    const listener = vi.fn();
    const unsubscribe = onCompileActivityChange(listener);

    markCompileStart(); // 0 → 1: edge, fires
    expect(listener).toHaveBeenCalledTimes(1);

    markCompileStart(); // 1 → 2: still busy, no edge
    expect(listener).toHaveBeenCalledTimes(1);

    markCompileEnd(); // 2 → 1: still busy, no edge
    expect(listener).toHaveBeenCalledTimes(1);

    markCompileEnd(); // 1 → 0: edge, fires
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('stops firing after the returned unsubscribe is called', () => {
    const listener = vi.fn();
    const unsubscribe = onCompileActivityChange(listener);

    markCompileStart(); // 0 → 1: fires
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();

    markCompileEnd(); // 1 → 0: would be an edge, but the listener is gone
    markCompileStart(); // 0 → 1: another edge, still gone
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not fire on a clamped (no-op) unmatched end while already idle', () => {
    const listener = vi.fn();
    const unsubscribe = onCompileActivityChange(listener);

    markCompileEnd(); // already idle: clamps at zero, no 1→0 edge, no notification
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
  });
});
