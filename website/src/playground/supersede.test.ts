// Tests for the per-operation superseder the playground uses to drop stale in-flight calls (#353).
import { describe, it, expect } from 'vitest';
import { createSuperseder } from './supersede';

describe('createSuperseder (#353)', () => {
  it('next() aborts the previous operation and returns a fresh, un-aborted signal', () => {
    const s = createSuperseder();
    const first = s.next();
    expect(first.aborted).toBe(false);

    const second = s.next();
    expect(first.aborted).toBe(true); // a newer operation supersedes the prior one
    expect(second.aborted).toBe(false);
  });

  it('abort() cancels the in-flight operation without starting a new one', () => {
    const s = createSuperseder();
    const sig = s.next();
    s.abort();
    expect(sig.aborted).toBe(true);

    // abort() is idempotent / safe with nothing in flight.
    expect(() => s.abort()).not.toThrow();
  });

  it('two superseders are independent — one does not cancel the other', () => {
    const a = createSuperseder();
    const b = createSuperseder();
    const sigA = a.next();
    const sigB = b.next();

    a.next(); // supersede only A's operation
    expect(sigA.aborted).toBe(true);
    expect(sigB.aborted).toBe(false);
  });
});
