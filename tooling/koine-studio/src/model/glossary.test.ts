import { describe, expect, test } from 'vitest';
import { coverage, groupByContext } from '@/model/glossary';
import type { GlossaryEntry, Range } from '@/lsp/lsp';

const range = (line: number): Range => ({ start: { line, character: 0 }, end: { line, character: 4 } });

function entry(partial: Partial<GlossaryEntry> & { name: string }): GlossaryEntry {
  const context = partial.context ?? 'Ordering';
  return {
    id: `${context}.${partial.name}`,
    kind: 'value',
    context,
    qualifiedName: `${context}.${partial.name}`,
    doc: null,
    nameRange: range(1),
    ...partial,
  };
}

// The DOM-builder tests (renderGlossary/renderEntry/renderDescription/openDescriptionEditor — coverage
// gauge markup, ordering, and the inline description editor) now live in GlossaryPanel.test.tsx, exercised
// through the real JSX panel (#992 retired the pure-DOM builder). This file keeps only the pure data
// helpers `coverage` and `groupByContext`.

describe('coverage', () => {
  test('counts non-blank docs and rounds the percentage', () => {
    const entries = [
      entry({ name: 'Money', doc: 'An amount.' }),
      entry({ name: 'Currency', doc: null }),
      entry({ name: 'Email', doc: '   ' }), // blank → not documented
    ];
    expect(coverage(entries)).toEqual({ documented: 1, total: 3, pct: 33 });
  });

  test('an empty model is 0 / 0 at 0%', () => {
    expect(coverage([])).toEqual({ documented: 0, total: 0, pct: 0 });
  });
});

describe('groupByContext', () => {
  test('groups by context preserving first-seen order', () => {
    const groups = groupByContext([
      entry({ name: 'A', context: 'Ordering' }),
      entry({ name: 'B', context: 'Shipping' }),
      entry({ name: 'C', context: 'Ordering' }),
    ]);
    expect(groups.map((g) => g.context)).toEqual(['Ordering', 'Shipping']);
    expect(groups[0].entries.map((e) => e.name)).toEqual(['A', 'C']);
  });
});
