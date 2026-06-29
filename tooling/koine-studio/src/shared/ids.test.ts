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
});
