import { describe, expect, test } from 'vitest';
import { basename } from '@/shared/path';

describe('basename', () => {
  test('returns the last segment of a forward-slashed path', () => {
    expect(basename('a/b/billing.koi')).toBe('billing.koi');
  });

  test('returns the last segment of a back-slashed path', () => {
    expect(basename('C:\\Users\\me\\model.koi')).toBe('model.koi');
  });

  test('splits on either separator (mixed)', () => {
    expect(basename('a/b\\c.koi')).toBe('c.koi');
  });

  test('strips a trailing forward separator and returns the last real segment', () => {
    expect(basename('a/b/')).toBe('b');
  });

  test('strips a trailing back separator and returns the last real segment', () => {
    expect(basename('a\\b\\')).toBe('b');
  });

  test('returns a bare segment (no separator) unchanged', () => {
    expect(basename('billing.koi')).toBe('billing.koi');
  });

  test('returns the last segment of a file:// uri', () => {
    expect(basename('file:///c/foo/bar.koi')).toBe('bar.koi');
  });

  test('returns the original for an empty string', () => {
    expect(basename('')).toBe('');
  });

  test('returns the original when there is no non-empty segment (all separators)', () => {
    expect(basename('///')).toBe('///');
  });
});
