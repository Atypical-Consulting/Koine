// Tests for the browser host's compile-activity counter (#469): the in-flight signal that gates the
// Studio "Stop compilation" command on an actual compile (matching the playground's busy-only Stop).
import { afterEach, describe, expect, it } from 'vitest';

import { isCompileInFlight, markCompileEnd, markCompileStart } from '@/host/browser/compileActivity';

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
