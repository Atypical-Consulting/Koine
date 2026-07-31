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
import { hexToRgb, contrastRatio } from './contrast';

// Guards the --koi-* design-token relocation (issue #905, Task 2): tokens.css is now the single
// source of truth for the runtime CSS custom properties Koine Studio (and any other consumer) reads
// via var(...). This is a plain string check — the file is plain CSS, not a stylesheet the DOM parses
// in this Node test environment — so it just proves the core tokens made the move byte-for-byte.
const tokensCssPath = fileURLToPath(new URL('./tokens.css', import.meta.url));
const css = readFileSync(tokensCssPath, 'utf8');

describe('tokens.css', () => {
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

// Mirrors `.lx-item.sel { background: color-mix(in srgb, var(--koi-accent) 15%, transparent); }`
// composited over the launcher card's --koi-paper-2 surface: CSS color-mix(in srgb, ...) blends
// the raw (non-linearized) sRGB channel values by the given weight.
function mixSrgb(fgHex: string, bgHex: string, fgWeight: number): string {
  const [fr, fgc, fb] = hexToRgb(fgHex);
  const [br, bg, bb] = hexToRgb(bgHex);
  const blend = (f: number, b: number) => Math.round(f * fgWeight + b * (1 - fgWeight));
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(blend(fr, br))}${toHex(blend(fgc, bg))}${toHex(blend(fb, bb))}`;
}

describe('launcher match highlight contrast', () => {
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

  // The selected-row tint (color-mix(--koi-accent 15%, transparent) over --koi-paper-2) is the
  // WORST-CASE background per the issue's own spec — a future change to --koi-accent alone (used
  // elsewhere for pills/focus rings/etc.) must not silently drop this below AA again.
  test('dark theme --koi-hl-match clears WCAG AA on the worst-case selected-row tint', () => {
    const darkBlock = extractThemeBlock(css, ':root');
    const hlMatch = extractToken(darkBlock, '--koi-hl-match');
    const accent = extractToken(darkBlock, '--koi-accent');
    const paper2 = extractToken(darkBlock, '--koi-paper-2');
    const selectedRowBg = mixSrgb(accent, paper2, 0.15);
    expect(contrastRatio(hlMatch, selectedRowBg)).toBeGreaterThanOrEqual(4.5);
  });

  test('light theme --koi-hl-match clears WCAG AA on the worst-case selected-row tint', () => {
    const lightBlock = extractThemeBlock(css, "html[data-theme='light']");
    const hlMatch = extractToken(lightBlock, '--koi-hl-match');
    const accent = extractToken(lightBlock, '--koi-accent');
    const paper2 = extractToken(lightBlock, '--koi-paper-2');
    const selectedRowBg = mixSrgb(accent, paper2, 0.15);
    expect(contrastRatio(hlMatch, selectedRowBg)).toBeGreaterThanOrEqual(4.5);
  });
});

// Guards the --koi-muted a11y fix (issue #991, landed in PR #1416): --koi-muted previously read
// #7d8694, which measured only ~4.31–4.32:1 on the dark --koi-surface — under WCAG AA (4.5:1) for
// small text. This computes the real contrast ratio off the token hex values so a future edit to
// either token (here, or in a design-synced source that could re-overwrite it) can't silently
// regress below AA again.
describe('muted text contrast', () => {
  test('dark theme --koi-muted clears WCAG AA (>= 4.5:1) on --koi-surface', () => {
    const darkBlock = extractThemeBlock(css, ':root');
    const muted = extractToken(darkBlock, '--koi-muted');
    const surface = extractToken(darkBlock, '--koi-surface');
    expect(contrastRatio(muted, surface)).toBeGreaterThanOrEqual(4.5);
  });

  test('light theme --koi-muted clears WCAG AA (>= 4.5:1) on --koi-surface', () => {
    const lightBlock = extractThemeBlock(css, "html[data-theme='light']");
    const muted = extractToken(lightBlock, '--koi-muted');
    const surface = extractToken(lightBlock, '--koi-surface');
    expect(contrastRatio(muted, surface)).toBeGreaterThanOrEqual(4.5);
  });
});

// Guards the launcher `.lx-kind` chip / `.lx-sub` WCAG AA contrast fix (issue #1672 — the same root-
// cause class as #1161/#1263 above, different elements). `.lx-kind`'s background stays the raw
// `--koi-ddd-<slug>` identity hue tinted 18% (`--kc`, deliberately dark-only across both themes per
// ADR 0004 — the maxGraph canvas paints the literal dark hex into SVG) — only the TEXT moved to a
// scoped `--koi-ddd-<slug>-ink` token (see tokens.css) so every other `--koi-ddd-*` consumer (canvas,
// explorer icons, editor semantic tokens) stays untouched. Only the 10 kinds `catalog.ts`'s `KIND_META`
// renders a launcher chip for get checked (the other 5 DDD concepts — read-model, policy, factory,
// state-machine, spec — have no `.lx-kind` today). The worst-case background is the auto-selected first
// row's tint (`.lx-item.sel { background: color-mix(in srgb, var(--koi-accent) 15%, transparent) }` —
// `LauncherPanel` resets `selectedIndex` to 0 on every query/mode change, so the "Order" aggregate row
// axe measured this against IS selected by default), mirroring `--koi-hl-match`'s own "worst-case
// selected-row tint" tests above; it reproduces the issue's own measured ~4.09:1 dark-theme number for
// `.lx-sub` almost exactly.
const LAUNCHER_CHIP_KINDS = [
  'aggregate',
  'entity',
  'value',
  'enum',
  'service',
  'repository',
  'command',
  'query',
  'event',
  'integration-event',
];

const conceptColorsCss = readFileSync(
  fileURLToPath(new URL('./concept-colors.generated.css', import.meta.url)),
  'utf8',
);

/** Mirrors `.lx-kind { background: color-mix(in srgb, var(--kc) 18%, transparent) }` composited over
 * the launcher card's real surface. */
function chipBg(kcHex: string, panelBgHex: string): string {
  return mixSrgb(kcHex, panelBgHex, 0.18);
}

/** Mirrors `.lx-item.sel { background: color-mix(in srgb, var(--koi-accent) 15%, transparent) }`
 * composited over the panel surface — the worst-case row background a chip/sub can render on. */
function selectedRowBg(accentHex: string, panelBgHex: string): string {
  return mixSrgb(accentHex, panelBgHex, 0.15);
}

describe('launcher .lx-kind chip contrast (issue #1672)', () => {
  for (const [themeName, selector] of [
    ['dark', ':root'],
    ['light', "html[data-theme='light']"],
  ] as const) {
    test(`${themeName} theme: every chip kind's --koi-ddd-*-ink text clears WCAG AA (>= 4.5:1) on its resting background`, () => {
      const block = extractThemeBlock(css, selector);
      const paper2 = extractToken(block, '--koi-paper-2');
      for (const slug of LAUNCHER_CHIP_KINDS) {
        const kc = extractToken(conceptColorsCss, `--koi-ddd-${slug}`); // background tint stays the raw identity hue
        const ink = extractToken(block, `--koi-ddd-${slug}-ink`); // text uses the scoped, contrast-safe token
        const bg = chipBg(kc, paper2);
        expect(contrastRatio(ink, bg), `${slug} (${themeName}, resting)`).toBeGreaterThanOrEqual(4.5);
      }
    });

    test(`${themeName} theme: every chip kind's --koi-ddd-*-ink text clears WCAG AA on the worst-case selected-row background`, () => {
      const block = extractThemeBlock(css, selector);
      const paper2 = extractToken(block, '--koi-paper-2');
      const accent = extractToken(block, '--koi-accent');
      const worstBg = selectedRowBg(accent, paper2);
      for (const slug of LAUNCHER_CHIP_KINDS) {
        const kc = extractToken(conceptColorsCss, `--koi-ddd-${slug}`);
        const ink = extractToken(block, `--koi-ddd-${slug}-ink`);
        const bg = chipBg(kc, worstBg);
        expect(contrastRatio(ink, bg), `${slug} (${themeName}, selected)`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

describe('launcher .lx-sub contrast (issue #1672)', () => {
  test('dark theme --koi-muted-strong clears WCAG AA on the worst-case selected-row background', () => {
    const darkBlock = extractThemeBlock(css, ':root');
    const mutedStrong = extractToken(darkBlock, '--koi-muted-strong');
    const paper2 = extractToken(darkBlock, '--koi-paper-2');
    const accent = extractToken(darkBlock, '--koi-accent');
    const worstBg = selectedRowBg(accent, paper2);
    expect(contrastRatio(mutedStrong, worstBg)).toBeGreaterThanOrEqual(4.5);
  });

  test('light theme --koi-muted-strong clears WCAG AA on the worst-case selected-row background', () => {
    const lightBlock = extractThemeBlock(css, "html[data-theme='light']");
    const mutedStrong = extractToken(lightBlock, '--koi-muted-strong');
    const paper2 = extractToken(lightBlock, '--koi-paper-2');
    const accent = extractToken(lightBlock, '--koi-accent');
    const worstBg = selectedRowBg(accent, paper2);
    expect(contrastRatio(mutedStrong, worstBg)).toBeGreaterThanOrEqual(4.5);
  });
});
