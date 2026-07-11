import { describe, expect, test, vi } from 'vitest';
import { act, render } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import { SortableTable, type SortableTableColumn, type SourceSpan } from './SortableTable';
import { SortableTable as SortableTableFromBarrel } from '../index';

// SortableTable<T> is the shared table the Events/Relationships panels render into (issue #992 task 3):
// it replaces the pure-DOM renderTable/buildRow builder that used to rebuild the whole <table> (wiping
// sort state) on every call. Rows/columns are generic; the only contract is a `span` field for
// click/keyboard jump-to-source (mirrors the old renderTable<T extends { span: SourceSpan | null }>).
//
// Moved from koine-studio's src/model/SortableTable.tsx (issue #1408, fourth-tranche extraction): the
// component is store-free so it moved almost verbatim; SourceSpan/TableHandlers are redeclared
// structurally in koine-ui (SortableTable.tsx) rather than imported from koine-studio's @/lsp / @/model.

interface Row {
  name: string;
  value: string;
  span: SourceSpan | null;
}

const span = (line: number): SourceSpan => ({
  file: 'file:///m.koi',
  line,
  column: 3,
  endLine: line,
  endColumn: 9,
  offset: 0,
  length: 6,
});

const columns: SortableTableColumn<Row>[] = [
  { header: 'Name', get: (r) => r.name },
  { header: 'Value', get: (r) => r.value, cellClass: () => 'koi-value-cell' },
];

const rows: Row[] = [
  { name: 'Bravo', value: '2', span: span(20) },
  { name: 'alpha', value: '10', span: span(10) },
];

describe('SortableTable', () => {
  test('is re-exported from the package barrel', () => {
    // The component is part of @atypical/koine-ui's public API (index.ts), so it must be importable
    // from the barrel, not only the component file — this is what Studio's re-export shim consumes.
    expect(SortableTableFromBarrel).toBe(SortableTable);
  });

  test('renders a header row and one body row per input row, with the given columns', () => {
    const { container } = render(
      <SortableTable rows={rows} columns={columns} emptyText="none" rowLabel={(r) => r.name} handlers={{ goto: () => {} }} />,
    );
    const headers = Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(headers).toEqual(['Name', 'Value']);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    const firstRow = Array.from(container.querySelectorAll('tbody tr')[0].querySelectorAll('td')).map((td) => td.textContent);
    expect(firstRow).toEqual(['Bravo', '2']);
    // A column's cellClass is applied to its <td>.
    expect(container.querySelectorAll('tbody tr')[0].querySelectorAll('td')[1].classList.contains('koi-value-cell')).toBe(
      true,
    );
  });

  test('empty rows render the koi-table-empty paragraph, not a table', () => {
    const { container } = render(
      <SortableTable rows={[]} columns={columns} emptyText="No rows yet." rowLabel={(r) => r.name} handlers={{ goto: () => {} }} />,
    );
    expect(container.querySelector('table')).toBeNull();
    const empty = container.querySelector('p.koi-table-empty');
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toBe('No rows yet.');
  });

  test('a row with a span is a focusable .koi-row-link firing goto on click', () => {
    const goto = vi.fn();
    const { container } = render(
      <SortableTable rows={rows} columns={columns} emptyText="none" rowLabel={(r) => r.name} handlers={{ goto }} />,
    );
    const tr = container.querySelectorAll('tbody tr')[0] as HTMLElement;
    expect(tr.classList.contains('koi-row-link')).toBe(true);
    expect(tr.tabIndex).toBe(0);
    expect(tr.getAttribute('aria-label')).toBe('Jump to source: Bravo');
    tr.click();
    expect(goto).toHaveBeenCalledWith(rows[0].span);
  });

  test('Enter and Space on a focused row both invoke goto (keyboard access)', () => {
    const goto = vi.fn();
    const { container } = render(
      <SortableTable rows={rows} columns={columns} emptyText="none" rowLabel={(r) => r.name} handlers={{ goto }} />,
    );
    const tr = container.querySelectorAll('tbody tr')[0] as HTMLElement;
    tr.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(goto).toHaveBeenCalledTimes(1);
    tr.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    expect(goto).toHaveBeenCalledTimes(2);
  });

  test('a spanless row renders plain: no .koi-row-link, not focusable, click is a no-op', () => {
    const goto = vi.fn();
    const spanless: Row[] = [{ name: 'Plain', value: '1', span: null }];
    const { container } = render(
      <SortableTable rows={spanless} columns={columns} emptyText="none" rowLabel={(r) => r.name} handlers={{ goto }} />,
    );
    const tr = container.querySelectorAll('tbody tr')[0] as HTMLElement;
    expect(tr.classList.contains('koi-row-link')).toBe(false);
    expect(tr.tabIndex).not.toBe(0);
    tr.click();
    expect(goto).not.toHaveBeenCalled();
  });

  test('an onActivate handler fires alongside goto even on a spanless row', () => {
    const onActivate = vi.fn();
    const spanless: Row[] = [{ name: 'Plain', value: '1', span: null }];
    const { container } = render(
      <SortableTable
        rows={spanless}
        columns={columns}
        emptyText="none"
        rowLabel={(r) => r.name}
        handlers={{ goto: () => {} }}
        onActivate={onActivate}
      />,
    );
    const tr = container.querySelectorAll('tbody tr')[0] as HTMLElement;
    // onActivate makes even a spanless row navigable (mirrors the Events table's select-to-inspect row).
    expect(tr.classList.contains('koi-row-link')).toBe(true);
    tr.click();
    expect(onActivate).toHaveBeenCalledWith(spanless[0]);
  });

  test('clicking a column header sorts rows by that column (numeric-aware, case-insensitive) and toggles direction', () => {
    const { container } = render(
      <SortableTable rows={rows} columns={columns} emptyText="none" rowLabel={(r) => r.name} handlers={{ goto: () => {} }} />,
    );
    const nameHeader = container.querySelectorAll('thead th')[0];
    const names = () => Array.from(container.querySelectorAll('tbody tr')).map((r) => r.querySelector('td')!.textContent);

    expect(nameHeader.getAttribute('aria-sort')).toBe('none');

    act(() => nameHeader.querySelector('button')!.click()); // ascending — case-insensitive: 'alpha' < 'Bravo'
    expect(names()).toEqual(['alpha', 'Bravo']);
    expect(nameHeader.getAttribute('aria-sort')).toBe('ascending');

    act(() => nameHeader.querySelector('button')!.click()); // descending
    expect(names()).toEqual(['Bravo', 'alpha']);
    expect(nameHeader.getAttribute('aria-sort')).toBe('descending');
  });

  test('sorts numerically, not lexicographically, on a numeric-looking column', () => {
    const numericRows: Row[] = [
      { name: 'ten', value: '10', span: null },
      { name: 'two', value: '2', span: null },
    ];
    const { container } = render(
      <SortableTable
        rows={numericRows}
        columns={columns}
        emptyText="none"
        rowLabel={(r) => r.name}
        handlers={{ goto: () => {} }}
      />,
    );
    const valueHeader = container.querySelectorAll('thead th')[1];
    act(() => valueHeader.querySelector('button')!.click()); // ascending
    // Lexicographic sort would put '10' before '2'; numeric-aware sort puts 2 before 10.
    const values = () => Array.from(container.querySelectorAll('tbody tr')).map((r) => r.querySelectorAll('td')[1].textContent);
    expect(values()).toEqual(['2', '10']);
  });

  // Regression (issue #1382): rows are keyed on their stable rowLabel, NOT their post-sort position, so
  // a sort click lets Preact match old and new rows by identity and REORDER the existing <tr> DOM nodes.
  // A positional key (`${i}:${label}`) changes on nearly every sort, forcing an unmount/remount of every
  // row — needless DOM churn for a component shared by all the model tables.
  test('sorting reorders the existing row DOM nodes instead of remounting them', () => {
    const { container } = render(
      <SortableTable rows={rows} columns={columns} emptyText="none" rowLabel={(r) => r.name} handlers={{ goto: () => {} }} />,
    );
    const before = Array.from(container.querySelectorAll('tbody tr'));
    expect(before.map((r) => r.querySelector('td')!.textContent)).toEqual(['Bravo', 'alpha']);

    act(() => container.querySelectorAll('thead th')[0].querySelector('button')!.click()); // ascending by Name

    const after = Array.from(container.querySelectorAll('tbody tr'));
    expect(after.map((r) => r.querySelector('td')!.textContent)).toEqual(['alpha', 'Bravo']);
    // The very same <tr> nodes, by reference, now in swapped positions — reordered, not torn down.
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[0]);
  });

  // Regression (#1382 follow-up): rowLabel is NOT necessarily unique — the Events table labels rows with
  // the SIMPLE event name, and the default "All contexts" scope renders every context's rows in one tbody
  // while Koine allows same-named events/types in different contexts (per-context uniqueness, R13.2).
  // Duplicate sibling keys are undefined behavior under Preact's keyed-children contract — concretely the
  // focused row could come to represent the OTHER same-named row after a sort — so a caller passes an
  // explicit `rowKey` (a qualified/composite identity) and the table keys rows on THAT, not the label.
  test('rowKey keys same-labelled rows distinctly: both render and keep DOM identity across a sort', () => {
    interface KeyedRow extends Row {
      key: string;
    }
    const dupRows: KeyedRow[] = [
      { name: 'OrderPlaced', value: '2', span: span(20), key: 'Sales.OrderPlaced' },
      { name: 'OrderPlaced', value: '1', span: span(10), key: 'Billing.OrderPlaced' },
    ];
    // Re-typed so T infers as KeyedRow (a Row-typed column set would pin T to Row and reject `r.key`).
    const dupColumns: SortableTableColumn<KeyedRow>[] = columns;
    const { container } = render(
      <SortableTable
        rows={dupRows}
        columns={dupColumns}
        emptyText="none"
        rowLabel={(r) => r.name}
        rowKey={(r) => r.key}
        handlers={{ goto: () => {} }}
      />,
    );
    const before = Array.from(container.querySelectorAll('tbody tr'));
    // Both same-labelled rows render.
    expect(before.map((r) => r.querySelector('td')!.textContent)).toEqual(['OrderPlaced', 'OrderPlaced']);
    expect(before.map((r) => r.querySelectorAll('td')[1].textContent)).toEqual(['2', '1']);

    act(() => container.querySelectorAll('thead th')[1].querySelector('button')!.click()); // ascending by Value

    const after = Array.from(container.querySelectorAll('tbody tr'));
    expect(after.map((r) => r.querySelectorAll('td')[1].textContent)).toEqual(['1', '2']);
    // The very same <tr> nodes, by reference, in swapped positions: the distinct keys let Preact match
    // each row to ITS old DOM node — neither row was remounted or cross-wired to its same-named sibling.
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[0]);
  });

  test('has no accessibility violations', async () => {
    const { container } = render(
      <SortableTable rows={rows} columns={columns} emptyText="none" rowLabel={(r) => r.name} handlers={{ goto: () => {} }} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  // The one intentional behavioral delta of this task (#992 task 3): the OLD renderTable rebuilt the
  // whole <table> (via a callback ref) on every host render, which reset any in-progress sort back to
  // 'none'. SortableTable owns its sort state via useState, so a re-render that hands it a NEW rows array
  // (the underlying data changed, e.g. a scope/model change) — but keeps the component MOUNTED — must
  // keep the current sort selection, re-applying it to the new rows instead of wiping it.
  test('sort selection survives a re-render with new rows (delta from the old rebuild-the-DOM behavior)', () => {
    const { container, rerender } = render(
      <SortableTable rows={rows} columns={columns} emptyText="none" rowLabel={(r) => r.name} handlers={{ goto: () => {} }} />,
    );
    const nameHeader = () => container.querySelectorAll('thead th')[0];
    const names = () => Array.from(container.querySelectorAll('tbody tr')).map((r) => r.querySelector('td')!.textContent);

    act(() => nameHeader().querySelector('button')!.click()); // ascending by Name
    expect(names()).toEqual(['alpha', 'Bravo']);
    expect(nameHeader().getAttribute('aria-sort')).toBe('ascending');

    // New data arrives (a different rows array — same shape, new content) while the table stays mounted.
    const nextRows: Row[] = [
      { name: 'Charlie', value: '3', span: span(30) },
      { name: 'delta', value: '4', span: span(40) },
    ];
    act(() => {
      rerender(
        <SortableTable
          rows={nextRows}
          columns={columns}
          emptyText="none"
          rowLabel={(r) => r.name}
          handlers={{ goto: () => {} }}
        />,
      );
    });

    // The sort selection (ascending by Name) persisted and re-applies to the new rows.
    expect(nameHeader().getAttribute('aria-sort')).toBe('ascending');
    expect(names()).toEqual(['Charlie', 'delta']);
  });
});
