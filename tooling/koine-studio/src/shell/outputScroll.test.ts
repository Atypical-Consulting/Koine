// Regression guard: the Generated-preview `.out2` grid (outputRail.ts scaffold) must cap its single
// row so the inner CodeMirror `.cm-scroller` and the `.out-rail` become bounded scroll containers.
//
// The measured bug: `.out2` declared only `grid-template-columns` and NO `grid-template-rows`, so its
// implicit row defaulted to `auto` and grew to the whole emitted file's height. That made the entire
// chain (`.out-view` → `.out-code` → `.cm-editor { height: 100% }` → `.cm-scroller`) content-sized, so
// nothing was ever a scroll container and the output pane could not scroll (verified in a real browser:
// with `auto` the row resolved to ~7300px = the file height; with `minmax(0, 1fr)` it caps at the pane
// height and the scroller overflows and scrolls). Pinning the row to `minmax(0, 1fr)` fills the absolute
// `.out2` box and — crucially — the `0` floor lets the descendants shrink below content so their
// `overflow` engages.
//
// Like splitLayout.test.ts (#527/#1154) this compiles the REAL `_deck.scss` with the same Dart Sass Vite
// uses and asserts the declaration in the compiled CSS. happy-dom runs no grid placement / pixel layout,
// so a computed-style geometry read is meaningless here — the stylesheet invariant is the layout-free
// guard; the browser drive (run-studio-web) is the pixel companion.
import { beforeAll, describe, expect, test } from 'vitest';
import * as sass from 'sass-embedded';
import { resolve } from 'node:path';

let deckCss = '';

beforeAll(async () => {
  // vitest runs from the package root (tooling/koine-studio), so this source path is stable local + CI.
  const scssPath = resolve(process.cwd(), 'src/styles/components/_deck.scss');
  deckCss = (await sass.compileAsync(scssPath)).css;
});

describe('.out2 output grid — scrollable-pane invariant', () => {
  test('caps its row with grid-template-rows: minmax(0, 1fr) so the code pane scrolls', () => {
    const oneLine = deckCss.replace(/\s+/g, '');
    // The `.out2` rule must set an explicit capped row — without it the row is `auto` and grows to the
    // generated file, breaking every inner scroll container.
    const rule = oneLine.slice(oneLine.indexOf('.out2{'), oneLine.indexOf('.out2{') + 200);
    expect(rule, 'the .out2 rule must exist in the compiled deck stylesheet').toContain('.out2{');
    expect(rule, 'the .out2 grid must pin a capped row so the CodeMirror scroller stays bounded').toContain(
      'grid-template-rows:minmax(0,1fr)',
    );
  });
});
