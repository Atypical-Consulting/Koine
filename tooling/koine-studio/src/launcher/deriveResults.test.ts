import { describe, expect, test } from 'vitest';
import { deriveResults } from '@/launcher/deriveResults';
import { MODES } from '@/launcher/catalog';
import type { CatalogEntry } from '@/launcher/catalog';

// The pure grouping/derivation Task 7's selection reducer and Task 5's preview both need: given the
// live catalog + the parsed mode/query, what sections does `.lx-results` render, and what is the flat
// top-to-bottom row order across every section (the index space ↑/↓ and "selected row" key off)?
const catalog: CatalogEntry[] = [
  { id: 'cmd1', cat: 'action', title: 'New file' },
  { id: 'sym1', cat: 'symbol', kind: 'aggregate', title: 'Order' },
  { id: 'evt1', cat: 'event', kind: 'event', title: 'OrderPlaced' },
  { id: 'file1', cat: 'file', title: 'ordering.koi' },
  { id: 'commit1', cat: 'commit', title: 'fix: bug' },
];

describe('deriveResults — empty query, "all" mode', () => {
  test('returns the curated Top hits / Recent default set instead of the full catalog', () => {
    const { sections, visible } = deriveResults(catalog, MODES.all, '');
    expect(sections.map((s) => s.label)).toEqual(['Top hits', 'Recent']);
    expect(visible.map((r) => r.entry.id)).toEqual(['sym1', 'commit1']);
  });
});

describe('deriveResults — ranked query', () => {
  test('groups ranked results by category in GROUPS display order, skipping empty groups', () => {
    const { sections, visible } = deriveResults(catalog, MODES.all, 'or');
    expect(sections.map((s) => s.label)).toEqual(['Domain symbols', 'Events', 'Files']);
    expect(visible.map((r) => r.entry.id)).toEqual(['sym1', 'evt1', 'file1']);
  });

  test('a prefix mode restricts both ranking and grouping to its category', () => {
    const { sections, visible } = deriveResults(catalog, MODES['#'], 'Order');
    expect(sections.map((s) => s.label)).toEqual(['Events']);
    expect(visible.map((r) => r.entry.id)).toEqual(['evt1']);
  });

  test('visible is every section flattened top-to-bottom, in the same order they render', () => {
    const { sections, visible } = deriveResults(catalog, MODES.all, 'or');
    expect(visible).toEqual(sections.flatMap((s) => s.rows));
  });

  test('no matches yields no sections and an empty visible list', () => {
    const { sections, visible } = deriveResults(catalog, MODES.all, 'zzz-no-match');
    expect(sections).toEqual([]);
    expect(visible).toEqual([]);
  });
});
