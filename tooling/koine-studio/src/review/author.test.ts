import { describe, expect, test } from 'vitest';
import { resolveReviewAuthor, REVIEW_AUTHOR_FALLBACK } from '@/review/ReviewPanel';

// resolveReviewAuthor (#479) maps a configured Settings display name to the author attributed to a
// review comment: a non-blank name is trimmed and used; a blank/whitespace name falls back to the
// shared 'You' default, so attribution is unchanged until a real name is entered.
describe('resolveReviewAuthor (#479)', () => {
  test('an empty name resolves to the fallback', () => {
    expect(resolveReviewAuthor('')).toBe(REVIEW_AUTHOR_FALLBACK);
  });

  test('a whitespace-only name resolves to the fallback', () => {
    expect(resolveReviewAuthor('   ')).toBe(REVIEW_AUTHOR_FALLBACK);
  });

  test('a non-blank name is trimmed and used verbatim', () => {
    expect(resolveReviewAuthor('  Ada Lovelace ')).toBe('Ada Lovelace');
  });

  test('the fallback is the friendly default', () => {
    expect(REVIEW_AUTHOR_FALLBACK).toBe('You');
  });
});
