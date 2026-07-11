/**
 * @atypical/koine-ui — the reusable design-system UI extracted from Koine Studio.
 *
 * Barrel entry point. As primitives and presentational components move in (issue #905, Tasks
 * 2-4), they get re-exported here.
 */

// Importing styles.css here (a side-effect-only import) is what makes Vite's library build pick
// it up and extract it into dist/ — see vite.config.ts's `build.lib.cssFileName`, which names the
// emitted stylesheet to match the package's "./styles.css" export. In library mode Vite strips
// this import out of the emitted JS and writes the CSS to its own file rather than injecting it,
// so importing '@atypical/koine-ui' for the JS API alone never pulls in any CSS side effect —
// consumers opt in explicitly via `import '@atypical/koine-ui/styles.css'`.
import './styles.css';

export const KOINE_UI_VERSION = '0.1.0';

// --- Framework-free DOM/utility primitives (issue #905, Task 3) -----------------------------
// Moved verbatim from koine-studio/src/shared/*; no Preact dependency.
export * from './primitives/el';
export * from './primitives/floatingMenu';
export * from './primitives/overlay';
export * from './primitives/commandRegistry';

// palette.ts re-exports `Command` from commandRegistry.ts (the SSOT) for its own historical
// importers; export * from both modules would collide on that name, so palette's exports are
// named explicitly here instead (Command itself is already covered by the commandRegistry
// export above).
export { createCommandPalette, type PaletteHandle } from './primitives/palette';

// --- Store-free presentational components (issue #905, Task 4) ------------------------------
// Moved from koine-studio's src/shell/**; each still takes plain props/callbacks, no store or Tauri
// coupling. The deck's app-specific surface REGISTRY (Koine Studio's Canvas/Code/Output/Docs data) stays
// in the app — the deck components take a generic `surfaces` prop instead (see DeckCard.tsx's header note).
export { DeckCard, type DeckCardProps, type DeckCardSurface, type DeckCardFacet } from './components/DeckCard';
// DeckSpine is the concept-7 "Flush" single-row chrome that replaces Deck v2's two-row deck-bar + card-head.
export { DeckSpine, type DeckSpineProps, type DeckSpineMode } from './components/DeckSpine';
export { ExportMenu, type ExportFormat } from './components/ExportMenu';
export { AssistantView, ASSISTANT_MOUNT_CLASS } from './components/AssistantView';
export { LeftRail } from './components/LeftRail';
export { RightStrip } from './components/RightStrip';

// --- Framework-free instant tooltip (concept-7 "Flush") -------------------------------------
// A singleton `data-tip`/`data-key` tooltip that replaces native `title`; init once at app boot.
export { initInstantTooltip, type TooltipController } from './tooltip';

// --- DOM contract shared with koine-studio (issue #979) -------------------------------------
// The single source of truth for the ids/data-attributes/classes LeftRail.tsx & RightStrip.tsx render
// and koine-studio queries. `export *` re-exports the values plus the `RightStripView` type.
export * from './domIds';

// --- Generic store/host adapter contract (issue #944, second-tranche extraction) ------------
// A koine-studio-agnostic read/subscribe seam: components below depend on `ReadableStore<T>` +
// `useReadableStore` instead of Koine Studio's concrete `StoreApi<AppState>` + `useStore`/`useAppStore`.
// See host/store.ts's module doc for the full rationale and koine-studio's zustandToReadableStore
// adapter for how the real Zustand store satisfies this contract.
export { useReadableStore, type ReadableStore } from './host/store';

// --- Store-coupled components via the ReadableStore<T> host-adapter contract (issue #944) ---
// Moved from koine-studio's src/shell/HistoryControls.tsx and src/diagnostics/WorkspaceProblemsBadge.tsx —
// the two prototype targets for the host-adapter seam. Each depends on `ReadableStore<T>` (above) for its
// slice of host state instead of Koine Studio's concrete `StoreApi<AppState>`.
export { HistoryControls, type HistoryControlsSlice } from './components/HistoryControls';
export { WorkspaceProblemsBadge, type WorkspaceProblemsSlice } from './components/WorkspaceProblemsBadge';

// --- Third-tranche host-adapter migrations (issue #1244) -------------------------------------
// Moved from koine-studio's src/shell/UnsavedIndicator.tsx, src/diagnostics/DiagnosticsStripPanel.tsx
// and src/docs/DocsPanelHost.tsx, continuing #944's pattern: each depends on `ReadableStore<T>` for its
// slice of host state; the host-side classification/derivation stays in koine-studio's adapters
// (src/store/readableStores.ts).
export { UnsavedIndicator, type UnsavedIndicatorSlice } from './components/UnsavedIndicator';
export {
  DiagnosticsStripPanel,
  type DiagnosticsStripSlice,
  type DiagnosticsStripRow,
  type DiagnosticsStripRange,
} from './components/DiagnosticsStripPanel';
export { DocsPanelHost, type DocsPanelHostSlice } from './components/DocsPanelHost';

// --- Fourth-tranche host-adapter migrations (issue #1408) ------------------------------------
// Moved from koine-studio's src/model/SortableTable.tsx, continuing the extraction. SortableTable is
// store-free (it takes plain props/callbacks), so it moves as-is; its `SourceSpan` and `TableHandlers`
// row/handler types — which the Studio original imported from `@/lsp` / `@/model/modelTables` — are
// redeclared STRUCTURALLY here so this package never imports a koine-studio module. Studio's own types
// are structurally identical, so its call sites still type-check across the package boundary.
export {
  SortableTable,
  type SortableTableColumn,
  type SourceSpan,
  type TableHandlers,
} from './components/SortableTable';
// useCommittableField — the controlled explicit edit-mode hook (#1385/#1398) the migrated GlossaryPanel
// consumes; it has no store/Tauri coupling (only preact/hooks), so it moves verbatim. Old Studio path
// (`@/shared/useCommittableField`) becomes a one-line re-export shim.
export { useCommittableField, type CommittableField } from './useCommittableField';
// RelationshipsPanel — the bottom-dock structural-relations table, typed against ReadableStore<Slice>;
// the host adapter (`createRelationshipsPanelStore`) pre-scopes + pre-extracts the rows.
export {
  RelationshipsPanel,
  type RelationshipsPanelSlice,
  type RelationRowView,
} from './components/RelationshipsPanel';
// GlossaryPanel — the ubiquitous-language editor (coverage gauge + inline description editors); the host
// adapter (`createGlossaryPanelStore`) pre-scopes/groups the model and computes coverage. Edit handlers
// arrive as callback props; rows edit via the same-package useCommittableField.
export {
  GlossaryPanel,
  type GlossaryPanelSlice,
  type GlossaryGroupView,
  type GlossaryEntryView,
  type CoverageView,
  type GlossaryRange,
  type GlossaryHandlers,
} from './components/GlossaryPanel';
// EventsPanel — the bottom-dock events table with a Table | Flow toggle; the maxGraph flow canvas is
// rendered host-side via an injected `FlowRenderer` (maxGraph never enters koine-ui). The host adapter
// (`createEventsPanelStore`) pre-scopes + pre-extracts the rows and the flow legend nodes.
export {
  EventsPanel,
  type EventsPanelSlice,
  type EventRowView,
  type EventFlowNodeView,
  type EventFlowKindView,
  type FlowRenderer,
} from './components/EventsPanel';
