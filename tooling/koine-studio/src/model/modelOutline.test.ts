import { describe, expect, test } from 'vitest';
import { countsByContext, groupByConstruct } from '@/model/modelOutline';
import type { GlossaryEntry, GlossaryModel, Range } from '@/lsp/lsp';

const range = (line: number): Range => ({ start: { line, character: 2 }, end: { line, character: 8 } });

function entry(partial: Partial<GlossaryEntry> & { name: string; kind: string; context: string }): GlossaryEntry {
  return {
    id: `${partial.context}.${partial.name}`,
    qualifiedName: `${partial.context}.${partial.name}`,
    doc: null,
    nameRange: range(1),
    ...partial,
  };
}

// A two-context model with a spread of construct kinds, declared out of construct order so the
// grouping's own ordering is exercised (not the input order).
const model: GlossaryModel = {
  entries: [
    entry({ name: 'Sales', kind: 'context', context: 'Sales', nameRange: range(0) }),
    entry({ name: 'Order', kind: 'aggregate', context: 'Sales', nameRange: range(3) }),
    entry({ name: 'Money', kind: 'value', context: 'Sales' }),
    entry({ name: 'Weight', kind: 'quantity', context: 'Sales' }),
    entry({ name: 'OrderLine', kind: 'entity', context: 'Sales' }),
    entry({ name: 'OrderPlaced', kind: 'event', context: 'Sales' }),
    entry({ name: 'Status', kind: 'enum', context: 'Sales' }),
    entry({ name: 'Inventory', kind: 'context', context: 'Inventory' }),
    entry({ name: 'Stock', kind: 'aggregate', context: 'Inventory' }),
    entry({ name: 'StockDepleted', kind: 'integration event', context: 'Inventory' }),
  ],
};

describe('groupByConstruct', () => {
  test('groups by context (first-seen order), then by construct in display order', () => {
    const groups = groupByConstruct(model);
    expect(groups.map((g) => g.context)).toEqual(['Sales', 'Inventory']);

    const sales = groups[0];
    expect(sales.constructs.map((c) => c.label)).toEqual([
      'Aggregates',
      'Entities',
      'Value Objects',
      'Enumerations',
      'Domain Events',
    ]);
    // value + quantity both fold into Value Objects.
    const vos = sales.constructs.find((c) => c.label === 'Value Objects')!;
    expect(vos.entries.map((e) => e.name)).toEqual(['Money', 'Weight']);
  });

  test('omits the context entry itself and any empty construct bucket', () => {
    const groups = groupByConstruct(model);
    const inventory = groups[1];
    expect(inventory.constructs.map((c) => c.label)).toEqual(['Aggregates', 'Integration Events']);
    // The context's own glossary entry is a header, never a leaf.
    const names = inventory.constructs.flatMap((c) => c.entries.map((e) => e.name));
    expect(names).not.toContain('Inventory');
  });
});

describe('countsByContext', () => {
  test('tallies each present construct per context', () => {
    const counts = countsByContext(model);
    expect(counts[0].context).toBe('Sales');
    expect(counts[0].counts).toEqual([
      { label: 'Aggregates', count: 1 },
      { label: 'Entities', count: 1 },
      { label: 'Value Objects', count: 2 },
      { label: 'Enumerations', count: 1 },
      { label: 'Domain Events', count: 1 },
    ]);
    expect(counts[1].counts).toEqual([
      { label: 'Aggregates', count: 1 },
      { label: 'Integration Events', count: 1 },
    ]);
  });
});
