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
// coupling. DeckBar's app-specific surface REGISTRY (Koine Studio's Canvas/Code/Output/Docs data) stays
// in the app — DeckBar takes a generic `surfaces` prop instead (see DeckBar.tsx's header note).
export { DeckCard, type DeckCardProps, type DeckCardSurface, type DeckCardFacet } from './components/DeckCard';
export { DeckBar, type DeckBarProps, type DeckBarMode } from './components/DeckBar';
export { ExportMenu, type ExportFormat } from './components/ExportMenu';
export { AssistantView, ASSISTANT_MOUNT_CLASS } from './components/AssistantView';
export { LeftRail } from './components/LeftRail';
