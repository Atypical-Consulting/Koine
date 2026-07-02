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
