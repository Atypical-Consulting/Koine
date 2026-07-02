import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { CONCEPT_COLORS, CONCEPT_SLUGS, type ConceptSlug } from '@/model/conceptColors.generated';

// Concept Colors (ADR 0004): the generated TS module must never drift from the single source of truth
// `design/concept-colors.json`, and every `light` value must stay readable on a white background.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const source = JSON.parse(
  readFileSync(path.join(repoRoot, 'design', 'concept-colors.json'), 'utf8'),
) as {
  concepts: { slug: string; label: string; modifier: string; dark: string; light: string }[];
};

const HEX = /^#[0-9a-f]{6}$/;

/** WCAG relative luminance of a #rrggbb color. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const chan = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan((n >> 16) & 255) + 0.7152 * chan((n >> 8) & 255) + 0.0722 * chan(n & 255);
}

const contrastOnWhite = (hex: string): number => 1.05 / (luminance(hex) + 0.05);

describe('concept colors — generated module vs source', () => {
  test('the generated module exists and covers all 15 concepts, in source order', () => {
    expect(source.concepts).toHaveLength(15);
    expect(CONCEPT_SLUGS).toHaveLength(15);
    expect([...CONCEPT_SLUGS]).toEqual(source.concepts.map((c) => c.slug));
  });

  test('every generated color matches design/concept-colors.json exactly', () => {
    for (const c of source.concepts) {
      const generated = CONCEPT_COLORS[c.slug as ConceptSlug];
      expect(generated, `missing generated entry for "${c.slug}"`).toBeDefined();
      expect(generated).toEqual({ label: c.label, modifier: c.modifier, dark: c.dark, light: c.light });
    }
  });

  test('every dark and light value is a #rrggbb hex', () => {
    for (const slug of CONCEPT_SLUGS) {
      expect(CONCEPT_COLORS[slug].dark).toMatch(HEX);
      expect(CONCEPT_COLORS[slug].light).toMatch(HEX);
    }
  });

  test('every light value has ≥ 3.0:1 contrast against white', () => {
    for (const slug of CONCEPT_SLUGS) {
      const ratio = contrastOnWhite(CONCEPT_COLORS[slug].light);
      expect(ratio, `${slug}.light (${CONCEPT_COLORS[slug].light}) contrast on white`).toBeGreaterThanOrEqual(3.0);
    }
  });

  test('each concept maps to a distinct LSP modifier name', () => {
    const modifiers = source.concepts.map((c) => c.modifier);
    expect(new Set(modifiers).size).toBe(modifiers.length);
  });
});

// The VS Code extension (tooling/koine-textmate) hand-writes its default semantic-token color rules
// (it has no generator), so this sync test guards them against the single-source palette: every
// `*.<modifier>:koine` default hex must equal that concept's `dark`, and every concept must be covered.
describe('VS Code extension concept-color rules (koine-textmate) vs palette', () => {
  const pkg = JSON.parse(
    readFileSync(path.join(repoRoot, 'tooling', 'koine-textmate', 'package.json'), 'utf8'),
  ) as {
    contributes: {
      semanticTokenModifiers?: { id: string }[];
      semanticTokenScopes?: { language: string; scopes: Record<string, string[]> }[];
      configurationDefaults?: {
        'editor.semanticTokenColorCustomizations'?: {
          rules?: Record<string, string>;
          '[*Light*]'?: { rules?: Record<string, string> };
        };
      };
    };
  };

  test('default (dark) rules use the concept dark hex; the [*Light*] override uses the light hex', () => {
    const custom = pkg.contributes.configurationDefaults?.['editor.semanticTokenColorCustomizations'] ?? {};
    const darkRules = custom.rules ?? {};
    const lightRules = custom['[*Light*]']?.rules ?? {};
    for (const c of source.concepts) {
      // Dark themes (the common default): the saturated dark hex.
      expect(darkRules[`*.${c.modifier}:koine`], `dark rule for ${c.modifier}`).toBe(c.dark);
      // Light themes: the contrast-tuned light variant (the dark hex is near-invisible on white).
      expect(lightRules[`*.${c.modifier}:koine`], `light rule for ${c.modifier}`).toBe(c.light);
    }
    // No stray rules beyond the 15 concepts (a removed concept would leave a dangling rule).
    expect(Object.keys(darkRules)).toHaveLength(source.concepts.length);
    expect(Object.keys(lightRules)).toHaveLength(source.concepts.length);
  });

  test('the extension declares every concept modifier and maps a scope for each', () => {
    const declared = (pkg.contributes.semanticTokenModifiers ?? []).map((m) => m.id).sort();
    expect(declared).toEqual(source.concepts.map((c) => c.modifier).sort());

    const scopes = pkg.contributes.semanticTokenScopes?.[0]?.scopes ?? {};
    for (const c of source.concepts) {
      expect(scopes[`*.${c.modifier}`], `scope for ${c.modifier}`).toBeDefined();
    }
  });
});
