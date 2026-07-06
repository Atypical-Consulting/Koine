import { describe, expect, test } from 'vitest';
import { fuzzy, highlight, rank } from '@/launcher/fuzzy';
import type { CatalogEntry } from '@/launcher/catalog';

// Ported verbatim from design/design_handoff_git_spotlight_logos/koine-launcher.js's `fuzzy` /
// `highlight` (the vanilla-JS prototype). These are pure, DOM-free functions: `fuzzy` returns a
// score + the matched index ranges in the ORIGINAL (not lower-cased) text; `highlight` turns those
// ranges into view-model segments instead of an HTML string with `<mark>`.

describe('fuzzy', () => {
  test('empty query matches everything with score 0 and no ranges', () => {
    expect(fuzzy('', 'Order')).toEqual({ score: 0, ranges: [] });
  });

  test('a non-subsequence returns null', () => {
    expect(fuzzy('xyz', 'Order')).toBeNull();
  });

  test('matches a simple subsequence and reports the matched indices in the original text', () => {
    const result = fuzzy('or', 'Order');
    expect(result).not.toBeNull();
    expect(result!.ranges).toEqual([0, 1]);
  });

  test('is case-insensitive: matching characters are looked up against the lower-cased text', () => {
    expect(fuzzy('OR', 'order')?.ranges).toEqual([0, 1]);
  });

  test('a prefix match outscores a match buried mid-string (word boundary + startsWith bonus)', () => {
    const prefixHit = fuzzy('or', 'Order')!;
    const midHit = fuzzy('or', 'Constructor')!;
    expect(prefixHit.score).toBeGreaterThan(midHit.score);
  });

  test('consecutive matched characters score +3 bonus each beyond the base +1', () => {
    // 'or' against 'Xor': both chars adjacent (found at 1, then 2 = prev+1), no word boundary, no hump.
    // char 1 ('o'): base 1. char 2 ('r'): base 1 + consecutive 3 = 4. total matched = 5.
    // length penalty: (3 - 2) * 0.15 = 0.15. No startsWith bonus ('xor' does not start with 'or').
    const result = fuzzy('or', 'Xor')!;
    expect(result.ranges).toEqual([1, 2]);
    expect(result.score).toBeCloseTo(1 + (1 + 3) - 0.15, 5);
  });

  test('a word-boundary match (index 0) scores +4 on top of the base +1', () => {
    // 'o' against 'Order': found at index 0 → word boundary bonus +4. Plus startsWith bonus +12
    // ('order'.startsWith('o')). Length penalty: (5 - 1) * 0.15 = 0.6.
    const result = fuzzy('o', 'Order')!;
    expect(result.ranges).toEqual([0]);
    expect(result.score).toBeCloseTo(1 + 4 + 12 - 0.6, 5);
  });

  test('a word-boundary match after a non-alphanumeric separator scores +4', () => {
    // 'l' against 'Order Line': found at index 6 ('L'), preceded by a space (non-alphanumeric) → +4
    // boundary bonus. Also a camelCase hump (+3, uppercase at index > 0). No consecutive bonus.
    const result = fuzzy('l', 'Order Line')!;
    expect(result.ranges).toEqual([6]);
    const expectedScore = 1 + 4 + 3 - (10 - 1) * 0.15;
    expect(result.score).toBeCloseTo(expectedScore, 5);
  });

  test('a camelCase hump (uppercase char at index > 0) scores +3', () => {
    // 'l' against 'orderLine': found at index 5 ('L'), preceded by 'r' (alphanumeric, no boundary
    // bonus), uppercase in the original text and index > 0 → hump bonus +3.
    const result = fuzzy('l', 'orderLine')!;
    expect(result.ranges).toEqual([5]);
    const expectedScore = 1 + 3 - (9 - 1) * 0.15;
    expect(result.score).toBeCloseTo(expectedScore, 5);
  });

  test('applies the loose-length penalty of -0.15 per unmatched character', () => {
    // 'a' against 'aaaaaaaaaa' (10 a's): matches at index 0 only (greedy left-to-right).
    // Word boundary (+4) + startsWith (+12) + base (1) - (10 - 1) * 0.15.
    const result = fuzzy('a', 'aaaaaaaaaa')!;
    expect(result.ranges).toEqual([0]);
    expect(result.score).toBeCloseTo(1 + 4 + 12 - 9 * 0.15, 5);
  });

  test('startsWith bonus of +12 applies when the text starts with the query (case-insensitive)', () => {
    const withPrefix = fuzzy('ord', 'Order')!;
    const withoutPrefix = fuzzy('ord', 'Coordinate')!;
    expect(withPrefix.score - withoutPrefix.score).toBeGreaterThan(0);
  });
});

describe('highlight', () => {
  test('no ranges returns the whole text as one unmatched segment', () => {
    expect(highlight('Order', [])).toEqual([{ text: 'Order', match: false }]);
  });

  test('splits matched and unmatched runs into segments in original text order', () => {
    expect(highlight('Order', [0, 1])).toEqual([
      { text: 'Or', match: true },
      { text: 'der', match: false },
    ]);
  });

  test('handles non-adjacent matched indices as separate matched segments', () => {
    expect(highlight('Order', [0, 4])).toEqual([
      { text: 'O', match: true },
      { text: 'rde', match: false },
      { text: 'r', match: true },
    ]);
  });

  test('a fully matched string is a single matched segment', () => {
    expect(highlight('or', [0, 1])).toEqual([{ text: 'or', match: true }]);
  });
});

// Ported from the prototype's `rank(query, cats)`, made pure: the prototype closed over a global
// `DATA` catalog array; this `rank` takes the pool as an explicit parameter instead.
describe('rank', () => {
  const entry = (over: Partial<CatalogEntry> & Pick<CatalogEntry, 'id' | 'title'>): CatalogEntry => ({
    cat: 'symbol',
    ...over,
  });

  test('a title match keeps the title fuzzy score and its highlight ranges', () => {
    const order = entry({ id: 'e0', title: 'Order' });
    const expected = fuzzy('or', 'Order')!;
    expect(rank('or', [order])).toEqual([{ entry: order, score: expected.score, ranges: expected.ranges }]);
  });

  test('when the title does not match, a secondary pass over keywords/ctx/sub scores sec.score * 0.4 - 2 with no title highlight', () => {
    const widget = entry({ id: 'e1', title: 'Widget', keywords: 'order sales root' });
    const hay = `${widget.keywords ?? ''} ${widget.ctx ?? ''} ${widget.sub ?? ''}`;
    const sec = fuzzy('sales', hay)!;
    expect(rank('sales', [widget])).toEqual([{ entry: widget, score: sec.score * 0.4 - 2, ranges: [] }]);
  });

  test('an entry matching neither the title nor keywords/ctx/sub is dropped', () => {
    const zzz = entry({ id: 'e2', title: 'Zzz', keywords: 'nothing here' });
    expect(rank('xyz123', [zzz])).toEqual([]);
  });

  test('sorts by score descending, ties breaking to the shorter title', () => {
    // Neither title is a subsequence of "apple"; both share identical keywords and omit ctx/sub, so
    // the secondary pass scores them exactly the same — only the tie-break (shorter title) can order them.
    const long = entry({ id: 'long', title: 'LongerTitleName', keywords: 'zzz apple' });
    const short = entry({ id: 'short', title: 'Ti', keywords: 'zzz apple' });
    const ranked = rank('apple', [long, short]);
    expect(ranked.map((r) => r.entry.id)).toEqual(['short', 'long']);
  });

  test('cats filters the pool to entries whose cat is included before scoring', () => {
    const cmd = entry({ id: 'cmd', cat: 'action', title: 'Generate' });
    const file = entry({ id: 'file', cat: 'file', title: 'Generate.koi' });
    const ranked = rank('gen', [cmd, file], ['action']);
    expect(ranked.map((r) => r.entry.id)).toEqual(['cmd']);
  });

  test('an empty query returns every pooled entry at score 0 with no ranges, in pool order', () => {
    const a = entry({ id: 'a', title: 'Alpha' });
    const b = entry({ id: 'b', title: 'Beta' });
    expect(rank('', [a, b])).toEqual([
      { entry: a, score: 0, ranges: [] },
      { entry: b, score: 0, ranges: [] },
    ]);
  });

  test('an empty query still applies the cats filter', () => {
    const cmd = entry({ id: 'cmd', cat: 'action', title: 'Generate' });
    const file = entry({ id: 'file', cat: 'file', title: 'ordering.koi' });
    expect(rank('', [cmd, file], ['file'])).toEqual([{ entry: file, score: 0, ranges: [] }]);
  });
});
