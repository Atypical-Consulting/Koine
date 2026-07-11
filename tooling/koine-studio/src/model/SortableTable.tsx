// SortableTable moved into the shared design-system package (@atypical/koine-ui, issue #1408 —
// fourth-tranche host-adapter migration). This one-line re-export keeps existing Studio call sites
// (`@/model/SortableTable`) compiling unchanged. The component's row/handler types (`SourceSpan`,
// `TableHandlers`) are redeclared structurally in koine-ui and are structurally compatible with Studio's
// own `@/lsp` / `@/model/modelTables` types, so callers passing Studio-typed rows still type-check.
export { SortableTable, type SortableTableColumn } from '@atypical/koine-ui';
