import { describe, expect, test } from 'vitest';
import { clashingRelPaths, isDirtyTrackable } from './sharedWorkspace';

describe('isDirtyTrackable', () => {
  test('a path-bearing buffer is always trackable (real on-disk file)', () => {
    expect(isDirtyTrackable({ path: '/work/order.koi' }, false)).toBe(true);
    expect(isDirtyTrackable({ path: '/work/order.koi' }, true)).toBe(true);
  });

  test('a path-null buffer in the in-memory shared workspace IS trackable', () => {
    expect(isDirtyTrackable({ path: null }, true)).toBe(true);
  });

  test('a path-null buffer outside the in-memory workspace (scratch) is NOT trackable', () => {
    // Scratch auto-persists to localStorage and must never go dirty.
    expect(isDirtyTrackable({ path: null }, false)).toBe(false);
  });
});

describe('clashingRelPaths', () => {
  test('no overlap means nothing clashes (safe to write)', () => {
    expect(clashingRelPaths(['a.koi', 'sub/b.koi'], ['c.koi'])).toEqual([]);
  });

  test('returns the targets that already exist, in target order', () => {
    expect(
      clashingRelPaths(['a.koi', 'sub/b.koi', 'c.koi'], ['sub/b.koi', 'a.koi']),
    ).toEqual(['a.koi', 'sub/b.koi']);
  });

  test('accepts a Set for existing', () => {
    expect(clashingRelPaths(['a.koi', 'b.koi'], new Set(['b.koi']))).toEqual(['b.koi']);
  });

  test('empty targets clash with nothing', () => {
    expect(clashingRelPaths([], ['a.koi'])).toEqual([]);
  });

  test('empty existing means a pristine folder — nothing clashes', () => {
    expect(clashingRelPaths(['a.koi', 'b.koi'], [])).toEqual([]);
  });
});
