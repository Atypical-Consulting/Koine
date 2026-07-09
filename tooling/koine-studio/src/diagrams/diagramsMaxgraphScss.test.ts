// Regression guard for #1210: the Context Map's active-context focus ring must actually be DRAWN, not
// merely class-toggled. happy-dom's getComputedStyle returns '' for var()/custom-property values
// resolved from a matched stylesheet rule (see src/shell/splitLayout.test.ts), so unit tests can't read
// the ring's real colour or box-shadow off a mounted element — they can only ever assert `.is-scoped` was
// added, which is exactly the false-positive #1210 measured (the class was present, toggled correctly,
// while nothing painted). This compiles the REAL `_diagrams-maxgraph.scss` (same Dart Sass as Vite) and
// asserts the compiled declaration text instead. Colour-contrast proper (does the ring actually read
// against the tile in a real browser, light AND dark theme) is caught by the Storybook/Chromium axe
// project, not this happy-dom unit run.
import { beforeAll, describe, expect, test } from 'vitest';
import * as sass from 'sass-embedded';
import { resolve } from 'node:path';

let oneLine = '';

beforeAll(async () => {
  // vitest runs from the package root (tooling/koine-studio), so this source path is stable across
  // local + CI invocations. The file has no `@use`/`@include` — every rule is CSS custom properties —
  // so it compiles standalone with no load-path setup.
  const scssPath = resolve(process.cwd(), 'src/styles/components/_diagrams-maxgraph.scss');
  const css = (await sass.compileAsync(scssPath)).css;
  oneLine = css.replace(/\s+/g, '');
});

describe('.koi-ctxmap-graph .koi-node.is-scoped — the active-context focus ring (#1210)', () => {
  test('the ring is drawn INSET, not as an outer box-shadow', () => {
    // .koi-node sets `overflow: hidden` (it clips label text); an OUTER box-shadow on an element with
    // `overflow: hidden` is clipped away entirely and never paints. The ring must live inside the
    // border box instead — BOTH layers (the crisp inner ring and the soft outer halo), since a bare
    // non-inset layer alongside an inset one would still get clipped for that layer.
    expect(oneLine, 'the .is-scoped rule must exist').toContain('.koi-ctxmap-graph.koi-node.is-scoped{');
    expect(oneLine, 'the crisp ring layer must be inset').toContain('box-shadow:inset0002pxvar(--koi-on-accent)');
    expect(oneLine, 'the soft halo layer must also be inset').toContain(
      ',inset0005pxcolor-mix(insrgb,var(--koi-on-accent)28%,transparent);',
    );
    // Guard against a regression back to a bare (non-inset) leading layer, e.g. `box-shadow:0 0 0 2px`.
    expect(oneLine).not.toMatch(/\.koi-ctxmap-graph\.koi-node\.is-scoped\{[^}]*box-shadow:0/);
  });

  test('the ring colour is NOT the tile fill (--koi-accent) — it must have real contrast against it', () => {
    const rule = oneLine.match(/\.koi-ctxmap-graph\.koi-node\.is-scoped\{([^}]*)\}/)?.[1] ?? '';
    // The context tile's own fill/border IS var(--koi-accent) (.koi-node--simple[data-kind='context']),
    // so a ring drawn in that same colour has ~1.0 contrast against its own background — invisible even
    // if it weren't clipped. `--koi-on-accent` is the token already paired with `--koi-accent` for
    // legible content on top of it, in both themes (tokens.css).
    expect(rule).not.toContain('var(--koi-accent)');
    expect(rule).toContain('var(--koi-on-accent)');
  });
});
