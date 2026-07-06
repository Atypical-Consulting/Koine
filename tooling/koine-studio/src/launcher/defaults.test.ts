import { describe, expect, test } from 'vitest';
import { defaultResults } from '@/launcher/defaults';
import type { CatalogEntry } from '@/launcher/catalog';

// Ported from design/design_handoff_git_spotlight_logos/koine-launcher.js's `defaultResults()`: the
// curated empty-query view is a "Top hits" slice of domain symbols plus a "Recent" slice that prefers
// commits (when the host has git history) over files. buildCatalog already omits every commit entry
// when `!canUseGit` (see buildCatalog.test.ts), so "any commit entries present" is enough of a gate
// here without threading `canUseGit` through separately.

function entry(over: Partial<CatalogEntry> & Pick<CatalogEntry, 'id' | 'cat' | 'title'>): CatalogEntry {
  return { ...over };
}

describe('defaultResults — hits', () => {
  test('is the first 4 symbol entries, in catalog order', () => {
    const catalog: CatalogEntry[] = [
      entry({ id: 's1', cat: 'symbol', title: 'Order' }),
      entry({ id: 's2', cat: 'symbol', title: 'Money' }),
      entry({ id: 's3', cat: 'symbol', title: 'Customer' }),
      entry({ id: 's4', cat: 'symbol', title: 'Invoice' }),
      entry({ id: 's5', cat: 'symbol', title: 'Payment' }), // 5th symbol — dropped by the cap
      entry({ id: 'e1', cat: 'event', title: 'OrderPlaced' }), // not a symbol — never a candidate
    ];
    const { hits } = defaultResults(catalog);
    expect(hits.map((e) => e.id)).toEqual(['s1', 's2', 's3', 's4']);
  });

  test('is empty when the catalog has no symbol entries', () => {
    const catalog: CatalogEntry[] = [entry({ id: 'f1', cat: 'file', title: 'a.koi' })];
    expect(defaultResults(catalog).hits).toEqual([]);
  });
});

describe('defaultResults — recent', () => {
  test('prefers commit entries, preserving their (already newest-first) catalog order', () => {
    const catalog: CatalogEntry[] = [
      entry({ id: 'f1', cat: 'file', title: 'a.koi' }),
      entry({ id: 'c1', cat: 'commit', title: 'feat: x', hash: 'abc' }),
      entry({ id: 'c2', cat: 'commit', title: 'fix: y', hash: 'def' }),
    ];
    const { recent } = defaultResults(catalog);
    expect(recent.map((e) => e.id)).toEqual(['c1', 'c2']);
  });

  test('falls back to file entries when there are no commits (browser host / no git)', () => {
    const catalog: CatalogEntry[] = [
      entry({ id: 'f1', cat: 'file', title: 'a.koi' }),
      entry({ id: 'f2', cat: 'file', title: 'b.koi' }),
    ];
    const { recent } = defaultResults(catalog);
    expect(recent.map((e) => e.id)).toEqual(['f1', 'f2']);
  });

  test('caps recent at 4 entries', () => {
    const catalog: CatalogEntry[] = Array.from({ length: 6 }, (_, i) =>
      entry({ id: `c${i}`, cat: 'commit', title: `commit ${i}` }),
    );
    expect(defaultResults(catalog).recent).toHaveLength(4);
  });
});
