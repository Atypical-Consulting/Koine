import { afterEach, describe, expect, test, vi } from 'vitest';
import { countsByContext, groupByConstruct, renderModelOutline, type OutlineHandlers } from './modelOutline';
import type { GlossaryEntry, GlossaryModel, Range } from './lsp';

afterEach(() => {
  document.body.innerHTML = '';
});

const range = (line: number): Range => ({ start: { line, character: 0 }, end: { line, character: 4 } });

function entry(name: string, kind: string, context: string): GlossaryEntry {
  const qualifiedName = kind === 'context' ? context : `${context}.${name}`;
  return { id: qualifiedName, name, kind, context, qualifiedName, doc: null, nameRange: range(1) };
}

// A two-context model in declaration order: Ordering (with several constructs) then Shipping.
function model(): GlossaryModel {
  return {
    entries: [
      entry('Ordering', 'context', 'Ordering'),
      entry('Order', 'aggregate', 'Ordering'),
      entry('OrderItem', 'entity', 'Ordering'),
      entry('Money', 'value', 'Ordering'),
      entry('OrderStatus', 'enum', 'Ordering'),
      entry('OrderPlaced', 'event', 'Ordering'),
      entry('Shipping', 'context', 'Shipping'),
      entry('Shipment', 'aggregate', 'Shipping'),
      entry('OrderShipped', 'integration event', 'Shipping'),
    ],
  };
}

const noop: OutlineHandlers = { onSelect: () => {}, onGoto: () => {} };

describe('groupByConstruct', () => {
  test('groups by context (declaration order) then by construct, excluding the context entry itself', () => {
    const groups = groupByConstruct(model().entries);
    expect(groups.map((g) => g.context)).toEqual(['Ordering', 'Shipping']);

    const ordering = groups[0];
    expect(ordering.constructs.map((c) => c.label)).toEqual([
      'Aggregates',
      'Entities',
      'Value Objects',
      'Enums',
      'Domain Events',
    ]);
    expect(ordering.constructs[0].entries.map((e) => e.name)).toEqual(['Order']);

    const shipping = groups[1];
    expect(shipping.constructs.map((c) => c.label)).toEqual(['Aggregates', 'Integration Events']);
  });

  test('omits construct buckets that have no entries', () => {
    const groups = groupByConstruct([entry('Ordering', 'context', 'Ordering'), entry('Order', 'aggregate', 'Ordering')]);
    expect(groups[0].constructs.map((c) => c.label)).toEqual(['Aggregates']);
  });
});

describe('countsByContext', () => {
  test('counts each construct per context', () => {
    const counts = countsByContext(model().entries);
    expect(counts[0]).toEqual({
      context: 'Ordering',
      counts: [
        { label: 'Aggregates', count: 1 },
        { label: 'Entities', count: 1 },
        { label: 'Value Objects', count: 1 },
        { label: 'Enums', count: 1 },
        { label: 'Domain Events', count: 1 },
      ],
    });
    expect(counts[1].counts).toEqual([
      { label: 'Aggregates', count: 1 },
      { label: 'Integration Events', count: 1 },
    ]);
  });
});

describe('renderModelOutline', () => {
  test('renders each context, construct headers with counts, and leaf entries', () => {
    const root = renderModelOutline(model(), noop);
    document.body.appendChild(root);
    const text = root.textContent ?? '';
    expect(text).toContain('Ordering');
    expect(text).toContain('Shipping');
    expect(text).toContain('Aggregates');
    expect(text).toContain('Integration Events');
    // one selectable leaf button per non-context entry (7 of the 9 entries are non-context)
    const leaves = root.querySelectorAll('button.koi-outline-leaf');
    expect(leaves.length).toBe(7);
  });

  test('clicking a leaf selects it and jumps to source', () => {
    const onSelect = vi.fn();
    const onGoto = vi.fn();
    const root = renderModelOutline(model(), { onSelect, onGoto });
    document.body.appendChild(root);
    const orderLeaf = Array.from(root.querySelectorAll<HTMLButtonElement>('button.koi-outline-leaf')).find(
      (b) => b.textContent === 'Order',
    )!;
    orderLeaf.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].qualifiedName).toBe('Ordering.Order');
    expect(onGoto).toHaveBeenCalledTimes(1);
  });
});
