/**
 * @atypical/koine-ui — the reusable design-system UI extracted from Koine Studio.
 *
 * Barrel entry point. As primitives and presentational components move in (issue #905, Tasks
 * 2-4), they get re-exported here. For now this only exports a sentinel so the package's build
 * and test pipeline can be proven end-to-end before any real UI moves in.
 */

// Importing styles.css here (a side-effect-only import) is what makes Vite's library build pick
// it up and extract it into dist/ — see vite.config.ts's `build.lib.cssFileName`, which names the
// emitted stylesheet to match the package's "./styles.css" export. In library mode Vite strips
// this import out of the emitted JS and writes the CSS to its own file rather than injecting it,
// so importing '@atypical/koine-ui' for the JS API alone never pulls in any CSS side effect —
// consumers opt in explicitly via `import '@atypical/koine-ui/styles.css'`.
import './styles.css';

export const KOINE_UI_VERSION = '0.1.0';
