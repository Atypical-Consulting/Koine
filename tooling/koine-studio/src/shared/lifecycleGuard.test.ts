import { describe, expect, test } from 'vitest';
import { createLifecycleGuard } from '@/shared/lifecycleGuard';

describe('createLifecycleGuard', () => {
  test('isDisposed() flips from false to true after dispose()', () => {
    const guard = createLifecycleGuard();
    expect(guard.isDisposed()).toBe(false);
    guard.dispose();
    expect(guard.isDisposed()).toBe(true);
  });

  test('a freshly-next()-ed token is isCurrent() on its own sequence', () => {
    const guard = createLifecycleGuard();
    const seq = guard.createSequence();
    const token = seq.next();
    expect(seq.isCurrent(token)).toBe(true);
  });

  test('a superseding next() call makes the prior token stale', () => {
    const guard = createLifecycleGuard();
    const seq = guard.createSequence();
    const staleToken = seq.next();
    seq.next();
    expect(seq.isCurrent(staleToken)).toBe(false);
  });

  test('two independent sequences on the same guard do not interfere', () => {
    const guard = createLifecycleGuard();
    const seqA = guard.createSequence();
    const seqB = guard.createSequence();
    const tokenA = seqA.next();
    const tokenB = seqB.next();
    // Bumping B must not invalidate A's current token.
    seqB.next();
    expect(seqA.isCurrent(tokenA)).toBe(true);
    expect(seqB.isCurrent(tokenB)).toBe(false);
  });

  test('isCurrent() is false after dispose(), even for a numerically-current token', () => {
    const guard = createLifecycleGuard();
    const seq = guard.createSequence();
    const token = seq.next();
    expect(seq.isCurrent(token)).toBe(true);
    guard.dispose();
    expect(seq.isCurrent(token)).toBe(false);
  });
});
