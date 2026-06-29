import { afterEach, describe, expect, test, vi } from 'vitest';
import { prefixedId } from '@/shared/ids';

describe('prefixedId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('uses crypto.randomUUID, prefixed', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'abc-123' });
    expect(prefixedId('review')).toBe('review-abc-123');
  });

  test('falls back to a unique, monotonic id across calls when crypto.randomUUID is absent', () => {
    vi.stubGlobal('crypto', undefined);
    const a = prefixedId('note');
    const b = prefixedId('note');
    expect(a).toMatch(/^note-/);
    expect(b).toMatch(/^note-/);
    expect(a).not.toBe(b);
  });

  test('fallback carries a per-session timestamp segment so persisted ids survive a counter reset', () => {
    // The counter resets to 0 every page load; without the timestamp a reloaded `review-1` would
    // collide with a freshly-minted one (review ids are persisted to .koine/reviews.json and reloaded).
    vi.stubGlobal('crypto', undefined);
    // `${prefix}-${base36 timestamp}-${counter}` — two segments after the prefix, not just a counter.
    expect(prefixedId('review')).toMatch(/^review-[0-9a-z]+-\d+$/);
  });
});
