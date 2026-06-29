import { describe, expect, test } from 'vitest';
import { byId } from '@/shared/sort';

describe('byId', () => {
  test('returns -1 / 1 / 0 ordering by id', () => {
    expect(byId({ id: 'a' }, { id: 'b' })).toBe(-1);
    expect(byId({ id: 'b' }, { id: 'a' })).toBe(1);
    expect(byId({ id: 'a' }, { id: 'a' })).toBe(0);
  });

  test('compares by raw code unit, not locale (so two runs serialize identically)', () => {
    // Uppercase precedes lowercase by code unit; a locale-aware compare would disagree.
    expect(byId({ id: 'Z' }, { id: 'a' })).toBe(-1);
  });

  test('sorts an array into ascending id order', () => {
    const items = [{ id: 'c' }, { id: 'a' }, { id: 'b' }];
    expect([...items].sort(byId).map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
});
