// Regression guard for #527: the Studio three-pane shell (`#split`) must resolve to a single grid
// ROW for every `data-orientation` / `data-siderail-side` combination. The measured bug was that the
// side-rail-left configuration assigns the five panes descending `grid-column` values in DOM order
// (Workspace=5 … Properties=1); under sparse `grid-auto-flow: row` with *no* `grid-row`, the grid
// auto-placement cursor cannot backtrack to an earlier column, so each later pane is bumped to a new
// implicit row → five rows → an anti-diagonal staircase that shatters the shell. Pinning every pane to
// `grid-row: 1` gives each a definite row, so column order can never staircase them again.
//
// This compiles the REAL `_split.scss` (same Dart Sass that Vite uses) and asserts, via
// getComputedStyle, the grid-row each pane RESOLVES TO. happy-dom does not run the CSS grid placement
// algorithm (there is no pixel layout), so this is a stylesheet/structural invariant, not a geometry
// check; the Storybook (Chromium) visual story is the belt-and-suspenders pixel companion.
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import * as sass from 'sass-embedded';
import { resolve } from 'node:path';

/** The five grid items that live directly on `#split`: rail | resizer | center | resizer | inspector. */
const SPLIT_CHILDREN = [
  { id: 'leftrail', cls: 'pane' },
  { id: 'leftrail-resizer', cls: 'koi-resizer' },
  { id: 'center', cls: 'pane' },
  { id: 'split-resizer', cls: 'koi-resizer' },
  { id: 'right', cls: 'pane' },
] as const;

let splitCss = '';

beforeAll(async () => {
  // Compile the real shell stylesheet (it `@use`s '../abstracts'). vitest runs from the package root
  // (tooling/koine-studio), so this source path is stable across local + CI invocations.
  const scssPath = resolve(process.cwd(), 'src/styles/layout/_split.scss');
  splitCss = (await sass.compileAsync(scssPath)).css;
});

afterEach(() => {
  document.head.querySelectorAll('style[data-test-split]').forEach((n) => n.remove());
  document.body.innerHTML = '';
});

/** Mount the compiled `#split` stylesheet + the real five-pane DOM, with the given shell data-* attrs. */
function mountSplit(attrs: {
  orientation: 'horizontal' | 'vertical';
  siderailSide: 'left' | 'right';
}): void {
  const style = document.createElement('style');
  style.setAttribute('data-test-split', '');
  style.textContent = splitCss;
  document.head.appendChild(style);

  const split = document.createElement('main');
  split.id = 'split';
  split.dataset.orientation = attrs.orientation;
  split.dataset.siderailSide = attrs.siderailSide;
  for (const child of SPLIT_CHILDREN) {
    const el = document.createElement('div');
    el.id = child.id;
    el.className = child.cls;
    split.appendChild(el);
  }
  document.body.appendChild(split);
}

describe('#split shell — tool-window stripe width (regression for #1154)', () => {
  // The right-edge tool-window stripe (`#right-strip`, grid track 6) reads `--koi-rstrip-w`. Every
  // `grid-template-columns` references it fallback-only, so the stripe's actual width is whatever `#split`
  // resolves `--koi-rstrip-w` to. PR #1140 handoff parity (#1154) pins that to 42px = 2.625rem (was the
  // 2.25rem/36px fallback), defined ONCE on `#split` as the single source so all nine references widen
  // together. We assert against the compiled `_split.scss` (real Dart Sass, same as splitCss above) rather
  // than getComputedStyle: happy-dom computes standard longhands (see the #527 grid-row test) but does not
  // resolve custom properties or `var()` from a matched stylesheet rule, so a computed-style read of the
  // token or the track returns empty here — the compiled-CSS assertion is the reliable, layout-free guard.
  // (splitCss is assigned in beforeAll, so read it inside each test — not at describe-collection time.)

  test('#split defines --koi-rstrip-w as 2.625rem (42px) — the single-source width', () => {
    const oneLine = splitCss.replace(/\s+/g, '');
    // The token is defined nowhere else (every other occurrence is a `var(--koi-rstrip-w, 2.25rem)`
    // fallback), so the bare declaration is the single source; a revert to 36px would drop this.
    expect(oneLine, 'the 42px single source must be declared, not left to the 2.25rem fallback').toContain(
      '--koi-rstrip-w:2.625rem',
    );
    // And it must NOT be (re)defined at the old 36px value anywhere.
    expect(oneLine, 'the stripe must not be redefined at the old 36px width').not.toContain(
      '--koi-rstrip-w:2.25rem',
    );
  });

  test('the stripe track still reads the --koi-rstrip-w token (definition actually feeds the grid)', () => {
    // The base grid template must consume the token so the single-source definition reaches track 6; the
    // 2.25rem fallback stays as the belt-and-suspenders default the definition overrides.
    const oneLine = splitCss.replace(/\s+/g, '');
    expect(oneLine).toContain('var(--koi-rstrip-w,2.25rem)');
  });
});

describe('#split shell — single-row invariant (regression for #527)', () => {
  // Orientation does not place the outer shell (it stacks the editor groups inside `#center`), but the
  // bug was reported under `data-orientation=vertical`, so we toggle it alongside the side-rail side to
  // prove the shell stays single-row regardless. The side-rail-left case is the descending-column
  // configuration that produced the measured staircase.
  for (const orientation of ['horizontal', 'vertical'] as const) {
    for (const siderailSide of ['right', 'left'] as const) {
      test(`orientation=${orientation}, siderail=${siderailSide}: every pane resolves to grid-row 1`, () => {
        mountSplit({ orientation, siderailSide });
        for (const child of SPLIT_CHILDREN) {
          const el = document.getElementById(child.id);
          expect(el, `#${child.id} should be mounted`).not.toBeNull();
          const gridRow = getComputedStyle(el as HTMLElement).gridRow;
          expect(gridRow, `#${child.id} must be pinned to grid-row 1 so it cannot staircase`).toBe('1');
        }
      });
    }
  }
});
