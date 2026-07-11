import { useState } from 'preact/hooks';

// The shared sortable table for the bottom-panel model tables (issue #144, #992 task 3). Replaces the
// old pure-DOM `renderTable`/`buildRow` builder (`modelTables.ts`), which was mounted through a callback
// ref that rebuilt the whole `<table>` — including sort state — on every host render. As a real Preact
// component, sort state lives in `useState` and the body is a sorted COPY of `props.rows`, so a
// re-render with a fresh `rows` array (e.g. the scope or model changed) re-applies the current sort
// instead of resetting it to 'none' — the one documented behavioral delta of this task (see
// SortableTable.test.tsx's "survives a re-render" case).
//
// Moved from koine-studio's src/model/SortableTable.tsx (issue #1408, fourth-tranche extraction). To keep
// koine-ui store- AND host-agnostic, `SourceSpan` and `TableHandlers` are redeclared STRUCTURALLY here
// rather than imported from koine-studio's `@/lsp` / `@/model/modelTables`. Studio's own types are
// structurally identical, so its call sites still type-check against these declarations across the
// package boundary — the reason a component this generic can live in the design-system package at all.

/** A model-table row's source span, in the shape Koine Studio's LSP layer produces (`@/lsp`). Redeclared
 *  structurally here so this package never imports a koine-studio module; Studio's `SourceSpan` is
 *  structurally identical, so rows typed with either satisfy {@link SortableTable}'s `T` bound. */
export interface SourceSpan {
  /** The source `.koi` uri the node was declared in (null for a synthesised node), matching Koine
   *  Studio's `@/lsp` `SourceSpan.file: string | null` — kept nullable so a Studio-typed row is
   *  structurally assignable to {@link SortableTable}'s `T` bound across the package boundary. */
  file: string | null;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  offset: number;
  length: number;
}

/** The row-interaction callbacks a model table needs — jump-to-source and an optional select-to-inspect
 *  (Koine Studio's `@/model/modelTables` `TableHandlers`, redeclared structurally, same rationale as
 *  {@link SourceSpan}). */
export interface TableHandlers {
  /** Reveal the row's declaration in the editor. */
  goto(span: SourceSpan): void;
  /** Select the row (e.g. so the Properties inspector loads it) — the Events table wires this. */
  onSelect?(qualifiedName: string, context: string): void;
}

/** A table column: its header text, the cell text for a row, and an optional per-cell class. */
export interface SortableTableColumn<T> {
  header: string;
  get(row: T): string;
  cellClass?(row: T): string | undefined;
}

/** No sort applied — the body renders in `rows`' given order. */
const UNSORTED = -1;

/**
 * A `<table>` of `rows` with `columns`, or — when `rows` is empty — a single empty-state paragraph
 * carrying `emptyText` (mirrors the diagnostics strip's empty note). Each data row that carries a `span`
 * (and/or an `onActivate`) becomes click- and keyboard-navigable; rows without either render plain.
 * Column headers are sort buttons: clicking one orders the body by that column (numeric-aware,
 * case-insensitive) and toggles ascending/descending, reflected via `aria-sort`. Sorting only re-orders
 * the display; `rows`' own order is the unsorted base.
 */
export function SortableTable<T extends { span: SourceSpan | null }>(props: {
  rows: T[];
  columns: SortableTableColumn<T>[];
  emptyText: string;
  /** The row's name for the jump-to-source `aria-label`/`title` (e.g. an event's name). */
  rowLabel: (row: T) => string;
  /** The row's identity key — MUST be unique across `rows` (Preact's keyed-children contract; duplicate
   *  sibling keys are undefined behavior, e.g. focus landing on the wrong row after a sort). Defaults to
   *  `rowLabel`, which is only safe when labels are unique; the Events table labels rows with the SIMPLE
   *  event name, which repeats across bounded contexts under the "All contexts" scope (Koine allows
   *  same-named events in different contexts, R13.2), so callers like it pass a qualified key. */
  rowKey?: (row: T) => string;
  handlers: TableHandlers;
  /** Fired (in addition to `handlers.goto`) when a row is activated — e.g. the Events table selects the
   *  row so the Properties inspector loads it. */
  onActivate?: (row: T) => void;
}) {
  const { rows, columns, emptyText, rowLabel, handlers, onActivate } = props;
  const rowKey = props.rowKey ?? rowLabel;
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 }>({ col: UNSORTED, dir: 1 });

  if (!rows.length) {
    return <p class="koi-table-empty">{emptyText}</p>;
  }

  const view =
    sort.col === UNSORTED
      ? rows
      : rows.slice().sort((a, b) => {
          const get = columns[sort.col].get;
          return sort.dir * get(a).localeCompare(get(b), undefined, { numeric: true, sensitivity: 'base' });
        });

  const toggleSort = (i: number): void => {
    setSort((prev) => ({ col: i, dir: prev.col === i && prev.dir === 1 ? -1 : 1 }));
  };

  return (
    <table class="koi-table">
      <thead>
        <tr>
          {columns.map((col, i) => (
            <th
              key={col.header}
              scope="col"
              aria-sort={i === sort.col ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
            >
              <button type="button" class="koi-th-sort" onClick={() => toggleSort(i)}>
                {col.header}
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {view.map((row) => (
          <SortableTableRow
            key={rowKey(row)}
            row={row}
            columns={columns}
            rowLabel={rowLabel}
            handlers={handlers}
            onActivate={onActivate}
          />
        ))}
      </tbody>
    </table>
  );
}

/** One body row: the column cells, made click/keyboard-navigable when it has a span (jump-to-source via
 *  `handlers.goto`) and/or an `onActivate` (select-to-inspect). Activating fires both. */
function SortableTableRow<T extends { span: SourceSpan | null }>(props: {
  row: T;
  columns: SortableTableColumn<T>[];
  rowLabel: (row: T) => string;
  handlers: TableHandlers;
  onActivate?: (row: T) => void;
}) {
  const { row, columns, rowLabel, handlers, onActivate } = props;
  const navigable = row.span !== null || !!onActivate;

  const activate = (): void => {
    if (row.span) handlers.goto(row.span); // reveal the declaration in the editor…
    onActivate?.(row); // …and (Events table) select it so the inspector loads it.
  };

  if (!navigable) {
    return (
      <tr>
        {columns.map((col) => (
          <td key={col.header} class={col.cellClass?.(row)}>
            {col.get(row)}
          </td>
        ))}
      </tr>
    );
  }

  // A focusable <tr> keeps the table semantics (cells stay real cells, so `role="button"` is out); the
  // aria-label gives screen-reader users a name + the jump-to-source affordance the bare row would lack.
  const label = `Jump to source: ${rowLabel(row)}`;
  return (
    <tr
      class="koi-row-link"
      tabIndex={0}
      title={label}
      aria-label={label}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      }}
    >
      {columns.map((col) => (
        <td key={col.header} class={col.cellClass?.(row)}>
          {col.get(row)}
        </td>
      ))}
    </tr>
  );
}
