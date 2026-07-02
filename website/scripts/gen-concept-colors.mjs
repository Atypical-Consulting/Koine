// Generates the website's Concept Colors artifacts from the single source of truth
// `design/concept-colors.json` (ADR 0004). Run via `npm run gen:colors`.
//
// Emits (both committed, drift-guarded by src/playground/semanticTokens.test.ts):
//   - src/styles/concept-colors.generated.css   (--koi-ddd-<slug> vars; LIGHT is the site default in
//                                                :root, DARK under :root[data-theme='dark'])
//   - src/generated/concept-colors.json          (the concepts array — consumed by the playground decode
//                                                sync test AND the guides/concept-colors docs page, so the
//                                                rendered palette table can never drift from the source)
//
// A concept hex lives ONLY in design/concept-colors.json; edit that and re-run — never hand-edit outputs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const websiteRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(websiteRoot, '..');
const sourcePath = path.join(repoRoot, 'design', 'concept-colors.json');

const HEX = /^#[0-9a-f]{6}$/;

const { concepts } = JSON.parse(readFileSync(sourcePath, 'utf8'));
if (!Array.isArray(concepts) || concepts.length === 0) {
  throw new Error(`design/concept-colors.json has no "concepts" array`);
}
for (const c of concepts) {
  for (const key of ['slug', 'label', 'modifier', 'dark', 'light']) {
    if (typeof c[key] !== 'string' || c[key].length === 0) {
      throw new Error(`concept "${c.slug ?? '?'}" is missing "${key}"`);
    }
  }
  for (const key of ['dark', 'light']) {
    if (!HEX.test(c[key])) throw new Error(`concept "${c.slug}".${key} = "${c[key]}" is not a #rrggbb hex`);
  }
}

const BANNER = `GENERATED — do not edit. Source of truth: design/concept-colors.json (ADR 0004 — Concept Colors).
   Regenerate with \`npm run gen:colors\` in website/.`;

// --- CSS: light is the website default (:root); dark under :root[data-theme='dark'] ------------------
const lightVars = concepts.map((c) => `  --koi-ddd-${c.slug}: ${c.light};`).join('\n');
const darkVars = concepts.map((c) => `  --koi-ddd-${c.slug}: ${c.dark};`).join('\n');
const css = `/* ${BANNER} */

/* The DDD concept palette — one hue per concept, shared by the Playground editor (cm-st-k-<slug>) and the
   Concept Colors docs page. Light is the site default; the dark theme swaps in the saturated variants. */
:root {
${lightVars}
}

:root[data-theme='dark'] {
${darkVars}
}
`;
writeFileSync(path.join(websiteRoot, 'src', 'styles', 'concept-colors.generated.css'), css);

// --- JSON: the concepts array, for the playground sync test and the docs page ------------------------
mkdirSync(path.join(websiteRoot, 'src', 'generated'), { recursive: true });
const json = {
  note: `GENERATED — do not edit. Copied from design/concept-colors.json by website/scripts/gen-concept-colors.mjs (ADR 0004).`,
  concepts,
};
writeFileSync(
  path.join(websiteRoot, 'src', 'generated', 'concept-colors.json'),
  JSON.stringify(json, null, 2) + '\n',
);

console.log(`✓ concept colors generated (${concepts.length} concepts) → concept-colors.generated.css, generated/concept-colors.json`);
