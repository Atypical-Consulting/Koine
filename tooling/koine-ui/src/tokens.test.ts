// @vitest-environment node
//
// Pinned to the `node` environment (rather than the package default `happy-dom` — see
// vite.config.ts's `test.environment`, added for the DOM primitives in issue #905 Task 3):
// this test reads tokens.css straight off disk via `import.meta.url` + node:fs, which needs a
// real file:// URL. happy-dom's `import.meta.url` is not of scheme file and breaks
// fileURLToPath() below.
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Guards the --koi-* design-token relocation (issue #905, Task 2): tokens.css is now the single
// source of truth for the runtime CSS custom properties Koine Studio (and any other consumer) reads
// via var(...). This is a plain string check — the file is plain CSS, not a stylesheet the DOM parses
// in this Node test environment — so it just proves the core tokens made the move byte-for-byte.
const tokensCssPath = fileURLToPath(new URL('./tokens.css', import.meta.url));

describe('tokens.css', () => {
  const css = readFileSync(tokensCssPath, 'utf8');

  test('defines the default (dark) theme tokens on :root', () => {
    expect(css).toContain('--koi-fg:');
    expect(css).toContain('--koi-muted:');
    expect(css).toContain('--koi-accent:');
  });

  test('redefines the theme tokens for light mode under html[data-theme=\'light\']', () => {
    expect(css).toContain("html[data-theme='light']");
    expect(css).toContain('--koi-fg: #1c2230;');
  });

  test('the DDD-construct hue tokens are generated from the Concept Colors palette (ADR 0004)', () => {
    // The --koi-ddd-* hues moved out of tokens.css into concept-colors.generated.css, emitted from the
    // single source design/concept-colors.json by `npm run gen:colors`. tokens.css must no longer hand-
    // define them (that would be a second, drift-prone source), and the generated file must match the
    // palette exactly (dark values). styles.css @imports the generated file so the vars still resolve.
    expect(css).not.toContain('--koi-ddd-aggregate:'); // relocated out of tokens.css

    const generatedCss = readFileSync(
      fileURLToPath(new URL('./concept-colors.generated.css', import.meta.url)),
      'utf8',
    );
    const { concepts } = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../design/concept-colors.json', import.meta.url)), 'utf8'),
    ) as { concepts: { slug: string; dark: string }[] };

    expect(concepts).toHaveLength(15);
    for (const c of concepts) {
      expect(generatedCss, `--koi-ddd-${c.slug} in the generated palette`).toContain(
        `--koi-ddd-${c.slug}: ${c.dark};`,
      );
    }
  });
});

// Guards the launcher fuzzy-match `<mark>` contrast fix (issue #1161): light theme previously
// painted the highlighted match run in `--koi-accent` (#2f7fe0) on `--koi-paper-2` (#f4f6fa), which
// measures ~3.71:1 — under the WCAG 2.1 AA floor (4.5:1) for normal text (SC 1.4.3). This computes
// the real relative-luminance contrast ratio off the token hex values (no DOM/Chromium needed) so a
// future edit to either token can't silently regress below AA again.
function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.trim().replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return [r, g, b];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const [rl, gl, bl] = [r, g, b].map((c) => {
    const srgb = c / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hexToRgb(hex1));
  const l2 = relativeLuminance(hexToRgb(hex2));
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

function extractThemeBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} block in tokens.css`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}

function extractToken(block: string, token: string): string {
  const match = block.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6});`));
  expect(match, `${token} in the theme block`).not.toBeNull();
  return match![1];
}

describe('launcher match highlight contrast', () => {
  const css = readFileSync(tokensCssPath, 'utf8');

  test('dark theme --koi-hl-match clears WCAG AA (>= 4.5:1) on --koi-paper-2', () => {
    const darkBlock = extractThemeBlock(css, ':root');
    const hlMatch = extractToken(darkBlock, '--koi-hl-match');
    const paper2 = extractToken(darkBlock, '--koi-paper-2');
    expect(contrastRatio(hlMatch, paper2)).toBeGreaterThanOrEqual(4.5);
  });

  test('light theme --koi-hl-match clears WCAG AA (>= 4.5:1) on --koi-paper-2', () => {
    const lightBlock = extractThemeBlock(css, "html[data-theme='light']");
    const hlMatch = extractToken(lightBlock, '--koi-hl-match');
    const paper2 = extractToken(lightBlock, '--koi-paper-2');
    expect(contrastRatio(hlMatch, paper2)).toBeGreaterThanOrEqual(4.5);
  });
});
