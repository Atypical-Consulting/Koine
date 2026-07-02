// Generates @atypical/koine-ui's Concept Colors CSS from the single source of truth
// `design/concept-colors.json` (ADR 0004). Run via `npm run gen:colors`.
//
// Emits (committed, GENERATED banner, drift-guarded by src/conceptColors.test.ts):
//   - src/concept-colors.generated.css   (the --koi-ddd-<slug> design tokens)
//
// After the @atypical/koine-ui extraction (issue #905, Task 2) the Studio design tokens live in this
// package's tokens.css; this file replaces the hand-written DDD palette block with a generated one so
// a concept hex is written ONLY in design/concept-colors.json. styles.css @imports this alongside
// tokens.css/components.css, so Vite's library build folds it into the published styles.css.
//
// The DDD palette is emitted DARK-ONLY (the :root default): the maxGraph canvas paints SVG shapes with
// the literal `.dark` hex (var() can't resolve in SVG fill), so keeping the CSS var dark-only under the
// opt-in light theme too keeps the canvas shape, the HTML node label, and the explorer icon all on the
// one canonical concept hue. The contrast-tuned `light` values still drive the website playground (light
// default) and the VS Code light-theme rules, where the surface actually renders on white.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const sourcePath = path.join(repoRoot, 'design', 'concept-colors.json');

const HEX = /^#[0-9a-f]{6}$/;

const { concepts } = JSON.parse(readFileSync(sourcePath, 'utf8'));
if (!Array.isArray(concepts) || concepts.length === 0) {
  throw new Error(`design/concept-colors.json has no "concepts" array`);
}
for (const c of concepts) {
  if (typeof c.slug !== 'string' || !HEX.test(c.dark ?? '')) {
    throw new Error(`concept "${c.slug ?? '?'}" has a missing slug or malformed dark hex "${c.dark}"`);
  }
}

const vars = concepts.map((c) => `  --koi-ddd-${c.slug}: ${c.dark};`).join('\n');
const css = `/* GENERATED — do not edit. Source of truth: design/concept-colors.json (ADR 0004 — Concept Colors).
   Regenerate with \`npm run gen:colors\` in tooling/koine-ui. */

/* The DDD concept palette — one hue per DDD concept, shared by the Studio Explorer icons, the inspector
   accent, the diagram nodes, and (via cm-st-k-<slug>) the code editor. Dark-only :root default; see the
   generator header for why the canvas keeps the dark hue under the light theme too. */
:root {
${vars}
}
`;
writeFileSync(path.join(pkgRoot, 'src', 'concept-colors.generated.css'), css);

console.log(`✓ concept colors generated (${concepts.length} concepts) → src/concept-colors.generated.css`);
