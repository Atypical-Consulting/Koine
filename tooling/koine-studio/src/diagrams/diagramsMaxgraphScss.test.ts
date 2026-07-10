// Regression guard for #1210 and #1294: the Context Map's active-context focus ring, and the domain
// canvas's cross-highlight selection ring, must actually be DRAWN, not merely class-toggled. happy-dom's
// getComputedStyle returns '' for var()/custom-property values resolved from a matched stylesheet rule
// (see src/shell/splitLayout.test.ts), so unit tests can't read the ring's real colour or box-shadow off
// a mounted element — they can only ever assert the class was added, which is exactly the false-positive
// #1210 measured (the class was present, toggled correctly, while nothing painted). This compiles the
// REAL `_diagrams-maxgraph.scss` (same Dart Sass as Vite) and asserts the compiled declaration text
// instead. Colour-contrast proper (does the ring actually read against the tile in a real browser, light
// AND dark theme) is caught by the Storybook/Chromium axe project, not this happy-dom unit run.
import { beforeAll, describe, expect, test } from 'vitest';
import * as sass from 'sass-embedded';
import { resolve } from 'node:path';

let oneLine = '';
let rule = '';
let selectedRule = '';
let selectedContextRule = '';

beforeAll(async () => {
  // vitest runs from the package root (tooling/koine-studio), so this source path is stable across
  // local + CI invocations. The file has no `@use`/`@include` — every rule is CSS custom properties —
  // so it compiles standalone with no load-path setup.
  const scssPath = resolve(process.cwd(), 'src/styles/components/_diagrams-maxgraph.scss');
  const css = (await sass.compileAsync(scssPath)).css;
  oneLine = css.replace(/\s+/g, '');
  rule = oneLine.match(/\.koi-ctxmap-graph\.koi-node\.is-scoped\{([^}]*)\}/)?.[1] ?? '';
  selectedRule = oneLine.match(/\.koi-node\.is-selected\{([^}]*)\}/)?.[1] ?? '';
  // `context`, `value` and `value-object` share one on-accent-ring rule (grouped selector), so this
  // matches from the first selector in the group through to the closing brace.
  selectedContextRule =
    oneLine.match(/\.koi-node--simple\[data-kind=context\]\.is-selected(?:,[^{]*)?\{([^}]*)\}/)?.[1] ?? '';
});

describe('.koi-ctxmap-graph .koi-node.is-scoped — the active-context focus ring (#1210)', () => {
  test('the ring is drawn INSET, not as an outer box-shadow', () => {
    // .koi-node sets `overflow: hidden` (it clips label text); an OUTER box-shadow on an element with
    // `overflow: hidden` is clipped away entirely and never paints. The ring must live inside the
    // border box instead — BOTH layers (the crisp inner ring and the soft outer halo), since a bare
    // non-inset layer alongside an inset one would still get clipped for that layer.
    expect(oneLine, 'the .is-scoped rule must exist').toContain('.koi-ctxmap-graph.koi-node.is-scoped{');
    expect(rule, 'the crisp ring layer must be inset').toContain('box-shadow:inset0002pxvar(--koi-on-accent)');
    expect(rule, 'the soft halo layer must also be inset').toContain(
      ',inset0005pxcolor-mix(insrgb,var(--koi-on-accent)28%,transparent);',
    );
  });

  test('the ring colour is NOT the tile fill (--koi-accent) — it must have real contrast against it', () => {
    // The context tile's own fill/border IS var(--koi-accent) (.koi-node--simple[data-kind='context']),
    // so a ring drawn in that same colour has ~1.0 contrast against its own background — invisible even
    // if it weren't clipped. `--koi-on-accent` is the token already paired with `--koi-accent` for
    // legible content on top of it, in both themes (tokens.css).
    expect(rule).not.toContain('var(--koi-accent)');
    expect(rule).toContain('var(--koi-on-accent)');
  });
});

describe('.koi-node.is-selected — the domain-canvas selection cross-highlight ring (#1294)', () => {
  test('the ring is drawn INSET, not as an outer box-shadow', () => {
    // Same root cause as #1210: .koi-node sets `overflow: hidden` (it clips label text), which clips an
    // OUTER box-shadow away entirely before it can paint. The ring must live inside the border box.
    expect(oneLine, 'the .is-selected rule must exist').toContain('.koi-node.is-selected{');
    expect(selectedRule, 'the ring must be inset').toContain('box-shadow:inset0002pxvar(--koi-accent)');
  });

  test('a [data-kind=\'context\'] node gets an on-accent ring, since its own fill IS --koi-accent', () => {
    // .koi-node--simple[data-kind='context'] fills/borders itself in var(--koi-accent) — a same-colour
    // ring on that one kind would have ~1.0 contrast against its own background, same as #1210's
    // .is-scoped ring did before its fix.
    expect(oneLine, 'the context-kind override rule must exist').toContain(
      '.koi-node--simple[data-kind=context].is-selected,',
    );
    expect(selectedContextRule, 'the override ring must also be inset').toContain(
      'box-shadow:inset0002pxvar(--koi-on-accent)',
    );
    expect(selectedContextRule, 'the override ring must not use the tile-fill colour').not.toContain(
      'var(--koi-accent)',
    );
  });

  test('[data-kind=\'value\'] and [data-kind=\'value-object\'] nodes also get an on-accent ring', () => {
    // --koi-ddd-value (#5aa9f0) is a near-exact match for dark theme's --koi-accent (#5aa9ff) — a
    // ~1.0-contrast collision discovered by code review, not a hue different enough to "already
    // contrast fine" the way the other --koi-ddd-* kinds do. Both the fielded (.koi-node--class) and
    // empty (.koi-node--simple) render shapes share this override, so the selector is bare `.koi-node`.
    expect(oneLine, 'the value-kind override must be grouped into the same rule').toContain(
      '.koi-node[data-kind=value].is-selected,.koi-node[data-kind=value-object].is-selected{',
    );
  });
});
