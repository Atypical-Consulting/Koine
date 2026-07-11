import { describe, expect, test, vi } from 'vitest';
import { act, render } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import { RelationshipsPanel, type RelationshipsPanelSlice, type RelationRowView } from './RelationshipsPanel';
import { RelationshipsPanel as RelationshipsPanelFromBarrel } from '../index';
import { createTestReadableStore } from '../host/storeTestUtils';
import type { SourceSpan } from './SortableTable';

const span = (line: number): SourceSpan => ({
  file: 'file:///m.koi',
  line,
  column: 3,
  endLine: line,
  endColumn: 9,
  offset: 0,
  length: 6,
});

const rrow = (
  source: string,
  relation: string,
  target: string,
  contexts: string[],
  rowSpan: SourceSpan | null,
): RelationRowView => ({ source, relation, target, contexts, span: rowSpan });

// Two structural relations, one in Sales and one in Inv — the shape the host adapter yields under "All
// contexts". Narrowing to Sales (a host-side scope change) is modelled by a store `set()` that drops the
// Inv row. The panel renders STRUCTURAL rows only — strategic context→context relations live in the
// Output → Context Map facet (#146), so none appear here.
const allRows: RelationRowView[] = [
  rrow('Order', 'contains', 'OrderItem', ['Sales'], span(8)),
  rrow('Stock', 'contains', 'StockLevel', ['Inv'], span(24)),
];

describe('RelationshipsPanel', () => {
  test('exports the same component from the barrel', () => {
    expect(RelationshipsPanelFromBarrel).toBe(RelationshipsPanel);
  });

  test('lists every structural relation, and a host scope change (set) narrows to the active context', () => {
    const store = createTestReadableStore<RelationshipsPanelSlice>({ rows: allRows });
    const { container } = render(<RelationshipsPanel store={store} handlers={{ goto: () => {} }} />);

    // Unscoped → both contexts' structural relations are present.
    expect(container.textContent).toContain('OrderItem');
    expect(container.textContent).toContain('StockLevel');

    // A host notification re-scopes to Sales (flushed via act()): Sales' row kept, Inv's dropped.
    act(() => store.set({ rows: [allRows[0]] }));
    expect(container.textContent).toContain('OrderItem');
    expect(container.textContent).not.toContain('StockLevel');
  });

  test('renders the Source · Relation · Target · Contexts columns', () => {
    const store = createTestReadableStore<RelationshipsPanelSlice>({ rows: allRows });
    const { container } = render(<RelationshipsPanel store={store} handlers={{ goto: () => {} }} />);
    const headers = Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(headers).toEqual(['Source', 'Relation', 'Target', 'Contexts']);
    const firstRow = Array.from(container.querySelectorAll('tbody tr')[0].querySelectorAll('td')).map(
      (td) => td.textContent,
    );
    expect(firstRow).toEqual(['Order', 'contains', 'OrderItem', 'Sales']);
  });

  test('a row with a span is click-to-source; a spanless structural row renders plain and is not clickable', () => {
    const goto = vi.fn();
    const store = createTestReadableStore<RelationshipsPanelSlice>({
      rows: [rrow('Order', 'references', 'Customer', ['Sales'], null)],
    });
    const { container } = render(<RelationshipsPanel store={store} handlers={{ goto }} />);
    const tr = container.querySelectorAll('tbody tr')[0] as HTMLElement;
    expect(tr.classList.contains('koi-row-link')).toBe(false);
    tr.click();
    expect(goto).not.toHaveBeenCalled();
  });

  // Regression (#1382 follow-up): rows are keyed on the CONTEXT-QUALIFIED edge, not the unqualified
  // `source relation target` label. Under "All contexts" two contexts can each hold e.g. `Order contains
  // OrderItem`; with label keys the duplicate sibling keys made a sort cross-wire the rows, so the focused
  // row could jump to the OTHER context's declaration.
  test('the same-named relation in two contexts keeps its own DOM row across a sort and jumps to its own source', () => {
    const goto = vi.fn();
    const salesSpan = span(3);
    const billingSpan = span(20);
    const store = createTestReadableStore<RelationshipsPanelSlice>({
      rows: [
        rrow('Order', 'contains', 'OrderItem', ['Sales'], salesSpan),
        rrow('Order', 'contains', 'OrderItem', ['Billing'], billingSpan),
      ],
    });
    const { container } = render(<RelationshipsPanel store={store} handlers={{ goto }} />);
    const before = Array.from(container.querySelectorAll('tbody tr'));
    // Both same-labelled relations render, in row order (Sales first).
    expect(before.map((r) => r.querySelector('td')!.textContent)).toEqual(['Order', 'Order']);
    expect(before.map((r) => r.querySelectorAll('td')[3].textContent)).toEqual(['Sales', 'Billing']);

    // Sort ascending by Contexts: Billing < Sales.
    act(() => container.querySelectorAll('thead th')[3].querySelector('button')!.click());

    const after = Array.from(container.querySelectorAll('tbody tr'));
    expect(after.map((r) => r.querySelectorAll('td')[3].textContent)).toEqual(['Billing', 'Sales']);
    // The composite context-qualified keys let Preact match each row to ITS old <tr> — never cross-wired…
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[0]);
    // …so activating the Billing row jumps to BILLING's Order declaration, not Sales'.
    (after[0] as HTMLElement).click();
    expect(goto).toHaveBeenCalledWith(billingSpan);
  });

  test('empty input renders the Relationships-specific empty-state text (no table)', () => {
    const store = createTestReadableStore<RelationshipsPanelSlice>({ rows: [] });
    const { container } = render(<RelationshipsPanel store={store} handlers={{ goto: () => {} }} />);
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('.koi-table-empty')!.textContent).toBe(
      'No structural relationships yet — add an aggregate or an entity reference to your model.',
    );
  });

  test('has no accessibility violations', async () => {
    const store = createTestReadableStore<RelationshipsPanelSlice>({ rows: allRows });
    const { container } = render(<RelationshipsPanel store={store} handlers={{ goto: () => {} }} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
