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
