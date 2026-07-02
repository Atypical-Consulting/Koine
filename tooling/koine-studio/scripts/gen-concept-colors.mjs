// Generates the Studio's Concept Colors TS map from the single source of truth
// `design/concept-colors.json` (ADR 0004). Run via `npm run gen:colors`.
//
// Emits (committed, GENERATED banner, drift-guarded by src/model/conceptColors.test.ts):
//   - src/model/conceptColors.generated.ts        (CONCEPT_SLUGS + CONCEPT_COLORS)
//
// The --koi-ddd-<slug> CSS vars are NOT emitted here: after the @atypical/koine-ui extraction
// (issue #905) the design tokens live in that package — see tooling/koine-ui/scripts/gen-concept-colors.mjs,
// which emits the CSS palette. This script owns only the TypeScript map the editor/canvas consume.
//
// A concept hex lives ONLY in the JSON; edit the JSON and re-run this — never hand-edit the output.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const studioRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(studioRoot, '..', '..');
const sourcePath = path.join(repoRoot, 'design', 'concept-colors.json');

const HEX = /^#[0-9a-f]{6}$/;

/** WCAG relative luminance of a #rrggbb color. */
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const chan = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan((n >> 16) & 255) + 0.7152 * chan((n >> 8) & 255) + 0.0722 * chan(n & 255);
}

/** Contrast ratio of a color against pure white (#ffffff). */
function contrastOnWhite(hex) {
  return 1.05 / (luminance(hex) + 0.05);
}

const { concepts } = JSON.parse(readFileSync(sourcePath, 'utf8'));
if (!Array.isArray(concepts) || concepts.length === 0) {
  throw new Error(`design/concept-colors.json has no "concepts" array`);
}

// Validate every entry: well-formed hexes, and light values readable on a white background.
for (const c of concepts) {
  for (const key of ['slug', 'label', 'modifier', 'dark', 'light']) {
    if (typeof c[key] !== 'string' || c[key].length === 0) {
      throw new Error(`concept "${c.slug ?? '?'}" is missing "${key}"`);
    }
  }
  for (const key of ['dark', 'light']) {
    if (!HEX.test(c[key])) {
      throw new Error(`concept "${c.slug}".${key} = "${c[key]}" is not a #rrggbb hex`);
    }
  }
  const ratio = contrastOnWhite(c.light);
  if (ratio < 3.0) {
    throw new Error(`concept "${c.slug}".light (${c.light}) has ${ratio.toFixed(2)}:1 contrast on white — below the 3.0:1 floor`);
  }
  if (ratio < 4.5) {
    console.warn(`⚠ concept "${c.slug}".light (${c.light}) is ${ratio.toFixed(2)}:1 on white — below AA (4.5:1), still ≥ 3.0`);
  }
}

const BANNER_TS = `// GENERATED — do not edit. Source of truth: design/concept-colors.json (ADR 0004 — Concept Colors).
// Regenerate with \`npm run gen:colors\` in tooling/koine-studio.`;

// --- TypeScript module --------------------------------------------------------
const slugUnion = concepts.map((c) => `'${c.slug}'`).join(' | ');
const slugList = concepts.map((c) => `  '${c.slug}',`).join('\n');
const colorEntries = concepts
  .map(
    (c) =>
      `  '${c.slug}': { label: '${c.label}', modifier: '${c.modifier}', dark: '${c.dark}', light: '${c.light}' },`,
  )
  .join('\n');
const ts = `${BANNER_TS}

/** A DDD concept slug — the key of a \`--koi-ddd-<slug>\` var and a \`cm-st-k-<slug>\` editor class. */
export type ConceptSlug = ${slugUnion};

/** One concept's palette entry. \`modifier\` is the LSP semantic-token modifier name it maps to. */
export interface ConceptColor {
  readonly label: string;
  readonly modifier: string;
  readonly dark: string;
  readonly light: string;
}

/**
 * Concept slugs in LSP modifier-bit order: CONCEPT_SLUGS[i] is the concept for semantic-token
 * modifier bit i+1 (bit 0 is \`declaration\`). Editors decode a token's modifier bits against this.
 */
export const CONCEPT_SLUGS = [
${slugList}
] as const;

/** Every concept's palette entry, keyed by slug. Single source: design/concept-colors.json. */
export const CONCEPT_COLORS: Record<ConceptSlug, ConceptColor> = {
${colorEntries}
};
`;
writeFileSync(path.join(studioRoot, 'src', 'model', 'conceptColors.generated.ts'), ts);

console.log(`✓ concept colors generated (${concepts.length} concepts) → conceptColors.generated.ts`);
