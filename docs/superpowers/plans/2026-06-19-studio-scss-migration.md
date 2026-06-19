# Koine Studio SCSS Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the Studio IDE's single 3,358-line `styles.css` into a full 7-1 SCSS architecture (partials + token/theme layer + mixins library) with zero change to the rendered UI.

**Architecture:** Two phases. **Phase 1** mechanically slices the current CSS verbatim into contiguous partials in source order and proves equivalence with an empty *canonical-CSS diff*. **Phase 2** consolidates the slices into the final 7-1 taxonomy and rewrites them idiomatically (nesting, mixins, `@each` loops), proving equivalence with a *visual smoke* pass (before/after screenshots, light + dark). The `--koi-*` design tokens stay as runtime CSS custom properties throughout — they are never converted to SCSS `$variables`.

**Tech Stack:** TypeScript, Vite 8, `sass-embedded` (Dart Sass, modern compiler API), Node ESM scripts, chrome-devtools MCP for screenshots.

## Global Constraints

- All work happens in the **`busy-keller-3ab07d` worktree**: `/Users/phmatray/Repositories/dotnet/Koine/.claude/worktrees/busy-keller-3ab07d`. The Studio lives at `tooling/koine-studio/`.
- **Never** convert a `--koi-*` custom property to a SCSS `$variable`. Runtime theming (`document.documentElement.dataset.theme`) and the CodeMirror theme both read these `var()` tokens live. No token *value* may change.
- Module system is **`@use` / `@forward`** only — never `@import` (deprecated in Dart Sass).
- Nesting stays **shallow (≤3 levels)** to avoid specificity creep.
- Vite 8 auto-selects `sass-embedded` once installed; **no `vite.config.ts` change is required** and the `api` preprocessor option is removed in Vite 8 — do not add it.
- Commit with the GitHub identity: `git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "..."`.
- Scope is structural only: **no** visual redesign, token renames, new components, Tailwind/PostCSS, scoped-CSS conversion, or CodeMirror theme edits. The IDE must be pixel-identical in both themes at the end.
- Run all `npm`/`node` commands from `tooling/koine-studio/`.

---

## File Structure (final, after Phase 2)

```
tooling/koine-studio/src/styles/
  main.scss                       # @use's every layer in cascade order
  abstracts/
    _variables.scss  _functions.scss  _mixins.scss  _index.scss
  themes/
    _dark.scss  _light.scss
  base/
    _typography.scss  _scrollbars.scss  _animations.scss  _a11y.scss
  layout/
    _toolbar.scss  _split.scss  _inspector.scss
  components/
    _lang-split-button.scss  _lang-picker.scss  _file-tree.scss  _explorer.scss
    _confirm-dialog.scss  _context-menu.scss  _doc-panes.scss  _outline.scss
    _tooltip.scss  _diagnostics.scss  _welcome.scss  _command-palette.scss
    _modal.scss  _form-fields.scss  _settings.scss  _help.scss  _about.scss
    _glossary.scss  _floating-menu.scss  _diagrams.scss  _ai-panel.scss  _wizard.scss
tooling/koine-studio/scripts/
  scss-slice.mjs                  # Phase 1 slicer (kept in repo; harmless)
  css-canon.mjs                   # canonicalizer used by the diff gate
```

Supporting files modified: `tooling/koine-studio/package.json` (add `sass-embedded`),
`tooling/koine-studio/src/main.ts` (import the SCSS), `tooling/koine-studio/index.html` (remove the `<link>`).

---

## PHASE 0 — Baseline & tooling

### Task 1: Add Sass, write the canonicalizer, capture the baseline

**Files:**
- Modify: `tooling/koine-studio/package.json` (devDependencies)
- Create: `tooling/koine-studio/scripts/css-canon.mjs`

**Interfaces:**
- Produces: `node scripts/css-canon.mjs <path-to-scss-or-css>` → prints the **compressed** canonical CSS of that file to stdout. Used by every diff gate.

- [ ] **Step 1: Install `sass-embedded`**

Run (from `tooling/koine-studio/`):
```bash
npm add -D sass-embedded
```
Expected: `package.json` gains `"sass-embedded": "^<version>"` under devDependencies; `npm` exits 0.

- [ ] **Step 2: Write the canonicalizer script**

Create `tooling/koine-studio/scripts/css-canon.mjs`:
```js
// Compile any .scss/.css file to canonical compressed CSS and print to stdout.
// Sass infers its parsing syntax from the file extension, and CSS-syntax mode vs
// SCSS-syntax mode serialize some colors differently (e.g. CSS mode keeps
// `transparent`, SCSS mode rewrites it to `rgba(0,0,0,0)`). To compare the
// original styles.css against the new main.scss apples-to-apples, we force a .css
// input through SCSS syntax so BOTH sides normalize identically. An empty diff
// between two canonical outputs then proves the rule set + order are identical.
import * as sass from 'sass-embedded';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

const input = process.argv[2];
if (!input) {
  console.error('usage: node scripts/css-canon.mjs <file.scss|file.css>');
  process.exit(2);
}

let result;
if (extname(input) === '.css') {
  // No @use in a plain CSS file, so compiling from a string is safe and lets us
  // pin syntax: 'scss' to match how .scss inputs are normalized.
  result = await sass.compileStringAsync(readFileSync(input, 'utf8'), {
    syntax: 'scss',
    style: 'compressed',
    sourceMap: false,
  });
} else {
  // Path-based compile so relative @use/@forward resolve from the file's directory.
  result = await sass.compileAsync(input, { style: 'compressed', sourceMap: false });
}
process.stdout.write(result.css);
```

> **Note (added during execution):** the first cut of this script used a single
> `sass.compileAsync(input)` for both inputs, which silently picked CSS-syntax mode
> for `styles.css` and SCSS-syntax mode for `main.scss` — making the Task 4 gate
> report a false-positive diff (36 `transparent` → `rgba(0,0,0,0)` rewrites). The
> version above forces SCSS syntax for `.css` inputs so both sides normalize the
> same way; the gate then reports IDENTICAL. Fixed in commit `8ecabbc`.

- [ ] **Step 3: Capture the baseline canonical CSS**

Run (from `tooling/koine-studio/`):
```bash
node scripts/css-canon.mjs src/styles.css > /tmp/koine-css-baseline.css
wc -c /tmp/koine-css-baseline.css
```
Expected: a non-empty byte count (the compressed canonical form of the current stylesheet). This is the reference every Phase 1 diff compares against. (`/tmp` is intentional — the baseline is a throwaway gate artifact, not committed.) This step **also validates that the original CSS is valid SCSS** (it is, with one caveat: Sass treats `//` as a line comment, so an unquoted `url(http://…)` would break it). If Sass errors here, quote the offending `url()` in `styles.css` first and re-run — that is the only legal pre-edit to the original.

- [ ] **Step 4: Commit**

```bash
git add tooling/koine-studio/package.json tooling/koine-studio/package-lock.json tooling/koine-studio/scripts/css-canon.mjs
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "chore(studio): add sass-embedded + CSS canonicalizer for SCSS migration"
```

---

## PHASE 1 — Mechanical split (gate: empty canonical diff)

### Task 2: Slice `styles.css` into contiguous partials

The split is purely positional. Each partial is a **contiguous line range** of the original; `main.scss` `@use`s them in the original top-to-bottom order, so the concatenated output is byte-for-byte the original. The manifest below is the single source of truth — `endLine` is implied by the next entry's `startLine`; the final entry runs to EOF (line 3358).

**Files:**
- Create: `tooling/koine-studio/scripts/scss-slice.mjs`
- Create: `tooling/koine-studio/src/styles/main.scss` + all partials listed below (generated by the script)

**Interfaces:**
- Consumes: `src/styles.css` (untouched original), the manifest array embedded in the script.
- Produces: `src/styles/<folder>/_<name>.scss` partials + `src/styles/main.scss`.

- [ ] **Step 1: Write the slicer with the embedded manifest**

Create `tooling/koine-studio/scripts/scss-slice.mjs`:
```js
// Phase 1 of the SCSS migration: slice src/styles.css into contiguous partials,
// in source order, and generate src/styles/main.scss that @use's them in that order.
// Output CSS is unchanged because @use just concatenates these verbatim slices.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SRC = 'src/styles.css';
const OUT = 'src/styles';

// [partialPath (relative to OUT), startLine (1-based)]. Ordered. Contiguous: each
// partial covers startLine..(nextStart-1); the last covers startLine..EOF.
const MANIFEST = [
  ['themes/_dark.scss', 1],
  ['themes/_light.scss', 56],
  ['base/_typography.scss', 96],
  ['base/_scrollbars.scss', 104],
  ['layout/_toolbar.scss', 160],
  ['components/_lang-split-button.scss', 265],
  ['components/_lang-picker.scss', 310],
  ['layout/_split.scss', 432],
  ['components/_file-tree.scss', 469],
  ['components/_explorer.scss', 532],
  ['components/_confirm-dialog.scss', 832],
  ['components/_context-menu.scss', 878],
  ['layout/_inspector.scss', 913],
  ['components/_doc-panes.scss', 1011],
  ['components/_outline.scss', 1121],
  ['components/_tooltip.scss', 1173],
  ['components/_diagnostics.scss', 1192],
  ['layout/_branded-header.scss', 1259],
  ['components/_welcome.scss', 1378],
  ['components/_command-palette.scss', 1557],
  ['components/_modal.scss', 1651],
  ['components/_form-fields.scss', 1729],
  ['components/_settings.scss', 1767],
  ['components/_help.scss', 2131],
  ['components/_about.scss', 2172],
  ['layout/_resizer.scss', 2328],
  ['components/_glossary-readability.scss', 2352],
  ['components/_copy-code-button.scss', 2371],
  ['components/_welcome-atmosphere.scss', 2402],
  ['base/_animations.scss', 2458],
  ['components/_glossary-editor.scss', 2521],
  ['layout/_inspector-tabs.scss', 2655],
  ['components/_floating-menu.scss', 2672],
  ['components/_diagrams.scss', 2753],
  ['components/_ai-panel.scss', 2805],
  ['components/_welcome-gallery.scss', 2965],
  ['components/_prefs-inputs.scss', 3005],
  ['components/_a11y.scss', 3023],
  ['components/_wizard.scss', 3037],
];

const lines = readFileSync(SRC, 'utf8').split('\n');
const EOF = lines.length; // includes any trailing empty element from final newline

for (let i = 0; i < MANIFEST.length; i++) {
  const [rel, start] = MANIFEST[i];
  const end = i + 1 < MANIFEST.length ? MANIFEST[i + 1][1] - 1 : EOF;
  // slice is [start-1 .. end-1] inclusive (1-based -> 0-based)
  const body = lines.slice(start - 1, end).join('\n');
  const abs = join(OUT, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body.endsWith('\n') ? body : body + '\n');
}

// Build main.scss @use list preserving order. @use paths are relative to main.scss,
// without leading underscore or extension.
const useLines = MANIFEST.map(([rel]) => {
  const noExt = rel.replace(/\.scss$/, '');
  const parts = noExt.split('/');
  parts[parts.length - 1] = parts[parts.length - 1].replace(/^_/, '');
  return `@use './${parts.join('/')}';`;
});
writeFileSync(
  join(OUT, 'main.scss'),
  '// Koine Studio styles — 7-1 SCSS. Generated split (Phase 1); see docs/superpowers/plans.\n' +
    '// @use order mirrors the original styles.css top-to-bottom so cascade is preserved.\n\n' +
    useLines.join('\n') + '\n',
);
console.log(`wrote ${MANIFEST.length} partials + main.scss`);
```

- [ ] **Step 2: Run the slicer**

Run (from `tooling/koine-studio/`):
```bash
node scripts/scss-slice.mjs
```
Expected: `wrote 39 partials + main.scss`. Verify the tree:
```bash
find src/styles -name '*.scss' | sort | head -50
```
Expected: 39 partials across `themes/ base/ layout/ components/` plus `src/styles/main.scss`.

- [ ] **Step 3: Sanity-check that no lines were lost**

Run (from `tooling/koine-studio/`):
```bash
# total non-main partial lines must equal the original line count
orig=$(wc -l < src/styles.css)
sliced=$(find src/styles -name '*.scss' ! -name 'main.scss' -exec cat {} + | wc -l)
echo "orig=$orig sliced=$sliced"
```
Expected: `sliced` ≥ `orig` and within a few lines (the only differences are trailing-newline normalization per file). The real proof is the canonical diff in Task 4 — this is just a smoke check.

- [ ] **Step 4: Commit**

```bash
git add tooling/koine-studio/scripts/scss-slice.mjs tooling/koine-studio/src/styles
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "refactor(studio): slice styles.css into 7-1 SCSS partials (Phase 1, no output change)"
```

### Task 3: Wire the SCSS into the build

**Files:**
- Modify: `tooling/koine-studio/src/main.ts` (add import after the font imports)
- Modify: `tooling/koine-studio/index.html` (remove the `<link>` to the old CSS)

**Interfaces:**
- Consumes: `src/styles/main.scss` from Task 2.

- [ ] **Step 1: Import the SCSS from the entry module**

In `tooling/koine-studio/src/main.ts`, the current head is:
```ts
import '@fontsource-variable/archivo';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/jetbrains-mono';
import { init } from './ide';
```
Add the stylesheet import immediately after the font imports (Vite bundles it via `sass-embedded`):
```ts
import '@fontsource-variable/archivo';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/jetbrains-mono';
import './styles/main.scss';
import { init } from './ide';
```

- [ ] **Step 2: Remove the stale `<link>`**

In `tooling/koine-studio/index.html`, delete this line (currently line 6):
```html
    <link rel="stylesheet" href="/src/styles.css" />
```

- [ ] **Step 3: Verify the build compiles the SCSS**

Run (from `tooling/koine-studio/`):
```bash
npm run build
```
Expected: `tsc` passes and `vite build` completes with no Sass errors and emits a CSS asset. If Vite reports it cannot find a Sass implementation, confirm `sass-embedded` is in devDependencies (Task 1).

- [ ] **Step 4: Commit**

```bash
git add tooling/koine-studio/src/main.ts tooling/koine-studio/index.html
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "build(studio): load styles via SCSS entry import, drop styles.css link"
```

### Task 4: Prove equivalence and delete the monolith

**Files:**
- Delete: `tooling/koine-studio/src/styles.css`

**Interfaces:**
- Consumes: `scripts/css-canon.mjs` (Task 1), `/tmp/koine-css-baseline.css` (Task 1), `src/styles/main.scss` (Task 2).

- [ ] **Step 1: Canonical-diff the new SCSS against the baseline**

Run (from `tooling/koine-studio/`):
```bash
node scripts/css-canon.mjs src/styles/main.scss > /tmp/koine-css-built.css
diff /tmp/koine-css-baseline.css /tmp/koine-css-built.css && echo "IDENTICAL"
```
Expected: `IDENTICAL` (empty diff). **This is the Phase 1 gate — it must pass before deleting `styles.css`.** If the diff is non-empty, a manifest `startLine` is wrong: the diff shows which selector/rule moved; fix the offending `startLine` in `scripts/scss-slice.mjs`, re-run Task 2 Step 2, and re-diff.

- [ ] **Step 2: Delete the original monolith**

```bash
git rm tooling/koine-studio/src/styles.css
```

- [ ] **Step 3: Re-verify the build with the monolith gone**

Run (from `tooling/koine-studio/`):
```bash
npm run build && npm test
```
Expected: build succeeds; vitest suite passes (no test depends on `styles.css`).

- [ ] **Step 4: Commit**

```bash
git add -A tooling/koine-studio
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "refactor(studio): remove monolithic styles.css (split verified byte-identical)"
```

---

## PHASE 2 — Consolidate & idiomatic (gate: rule-set equivalence + final visual smoke)

Phase 2 reorganizes the 39 positional slices into the final ~28-partial taxonomy and rewrites them
idiomatically (nesting, mixins, `@each`). Idiomatic SCSS regenerates selectors and reorders output, so
the strict byte-identical canonical diff no longer applies. Verification is two-tier:

- **Per task — deterministic rule-set equivalence (primary gate):** `scripts/css-equiv.mjs` compiles
  `main.scss`, parses it, and compares *each selector's declaration set* (order-insensitive,
  at-rule-context-aware) against the proven Phase-1 baseline. EQUIVALENT means no selector gained, lost,
  or changed a declaration — exhaustive proof nothing renders differently, stronger than eyeballing
  screenshots. Every Phase 2 task must end EQUIVALENT.
- **Once at the end — visual smoke (Task 11):** the rule-set diff cannot see cascade-order changes among
  colliding same-specificity rules; a final screenshot pass over every screen in both themes confirms it.
  Baseline screenshots are captured at the start of Phase 2 (where the SCSS output is identical to the
  original), so the final pass is a true before/after.

### Task 5: Build the equivalence comparator + capture the visual baseline

**Files:**
- Create: `tooling/koine-studio/scripts/css-equiv.mjs`
- Create: `tooling/koine-studio/scripts/css-equiv.test.mjs` (vitest spec — TDD for the comparator)
- Modify: `tooling/koine-studio/package.json` (add `postcss` devDependency)
- Produces baseline screenshots under `/tmp/koine-shots/baseline/` (best-effort)

**Interfaces:**
- Produces: `node scripts/css-equiv.mjs <baseline.css|scss> <candidate.css|scss>` → exit 0 + `EQUIVALENT`
  when every (at-rule-context, selector) has the same declaration set on both sides; exit 1 + a report of
  added/removed/changed rules otherwise. Canonicalizes each input via the same compressed compile as
  `css-canon.mjs` (SCSS syntax mode for `.css`).

- [ ] **Step 1 (TDD): write the comparator's failing tests first**

Cover at minimum: (a) identical inputs → EQUIVALENT; (b) a changed declaration value → NOT equivalent
(reported); (c) an added/removed declaration → NOT equivalent; (d) the SAME rules in a DIFFERENT source
order → EQUIVALENT (order-insensitive); (e) the same declarations in a different ORDER within one rule →
EQUIVALENT; (f) a multi-selector rule (`.a,.b{}`) compared per-selector; (g) rules inside
`@media`/`@supports` keyed by their at-rule context (a rule moved out of an `@media` is NOT equivalent);
(h) `@keyframes` compared by name→frames as a set.

- [ ] **Step 2: implement `css-equiv.mjs` to pass**

Compile each input to compressed CSS (reuse the `css-canon` syntax-mode logic — SCSS syntax for `.css`),
parse with `postcss`, walk every rule tracking its at-rule context, expand selector lists, and build a map
`"<at-context>||<selector>" -> sorted(declarations)`. Compare the two maps; report keys present in only
one side and keys whose declaration sets differ. Handle `@keyframes` as `name -> sorted frames`.

- [ ] **Step 3: run the tests — all green, output pristine.**

- [ ] **Step 4: self-check against the live baseline**

`node scripts/css-equiv.mjs /tmp/koine-css-baseline.css src/styles/main.scss` must print `EQUIVALENT`
(current `main.scss` IS the baseline). If not, the comparator has a bug — fix before proceeding.

- [ ] **Step 5: capture the visual baseline (best-effort, for Task 11)**

Start `npm run dev:web` (serves :1430 after building WASM). Via the chrome-devtools MCP, screenshot these
screens in BOTH dark and light into `/tmp/koine-shots/baseline/<screen>-<theme>.png`: `start` (welcome
overlay), `editor` (file tree + editor), `settings`, `palette`, `glossary`, `wizard`, `inspector`, `ai`.
These are the before-images for the final visual pass. If the app cannot be driven to a screen, note which
and proceed — the deterministic gate is the binding proof.

- [ ] **Step 6: commit**

```bash
git add tooling/koine-studio/scripts/css-equiv.mjs tooling/koine-studio/scripts/css-equiv.test.mjs tooling/koine-studio/package.json tooling/koine-studio/package-lock.json
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "test(studio): add deterministic CSS rule-set equivalence comparator for Phase 2"
```

### Task 6: Create the `abstracts/` layer

`abstracts/` emits **no CSS**, so adding it does not change output — re-run the canonical diff as a bonus gate at the end of this task.

**Files:**
- Create: `tooling/koine-studio/src/styles/abstracts/_variables.scss`
- Create: `tooling/koine-studio/src/styles/abstracts/_functions.scss`
- Create: `tooling/koine-studio/src/styles/abstracts/_mixins.scss`
- Create: `tooling/koine-studio/src/styles/abstracts/_index.scss`

**Interfaces:**
- Produces: `@use '../abstracts' as a;` exposes `a.$bp-narrow`, `a.$languages`, and the mixins `a.popover-surface`, `a.ghost-button`. Each component partial that needs them adds that `@use` at its top.

- [ ] **Step 1: Write `_variables.scss` (build-time-only SCSS values)**

```scss
// Build-time-only SCSS values. NEVER put --koi-* runtime tokens here — those live in themes/.
$bp-narrow: 640px; // mirrors the @media (max-width: 640px) breakpoint in the source

// Destination-language brand hues — values are the runtime tokens; drives the identity-dot @each loop.
$languages: (
  csharp: var(--lang-csharp),
  typescript: var(--lang-typescript),
  python: var(--lang-python),
);
```

- [ ] **Step 2: Write `_functions.scss` (empty stub for now — YAGNI)**

```scss
// Reserved for build-time helper functions. None needed yet.
```

- [ ] **Step 3: Write `_mixins.scss` with the two genuinely-shared recipes**

Only factor declarations that are **exactly duplicated** across selectors; selector-specific props stay inline at the call site.
```scss
// Floating popover surface — chrome shared by .lang-menu, the explorer/context menus, and the
// floating action menu (the source comments note these "mirror .explorer-menu"). Verbatim from
// the original .lang-menu rule (minus its selector-specific z-index/min-width, which stay inline).
@mixin popover-surface {
  position: fixed;
  list-style: none;
  margin: 0;
  padding: 4px;
  background: var(--koi-paper-2);
  border: 1px solid var(--koi-line);
  border-radius: var(--koi-radius-sm);
  box-shadow: var(--koi-shadow);
}

// Ghost toolbar button — transparent surface, ink-soft text, lifts to surface/fg on hover.
// Verbatim from the original `.toolbar-actions button, #btn-check` rules.
@mixin ghost-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  color: var(--koi-ink-soft);
  border: 1px solid transparent;
  border-radius: 5px;
  padding: 5px 11px;
  font-family: var(--koi-font-body);
  font-size: 0.82rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;

  &:hover:not(:disabled) {
    background: var(--koi-surface);
    color: var(--koi-fg);
  }
  &:disabled {
    opacity: 0.45;
    cursor: default;
  }
}
```

- [ ] **Step 4: Write `_index.scss` to forward the layer**

```scss
@forward 'variables';
@forward 'functions';
@forward 'mixins';
```

- [ ] **Step 5: Verify nothing changed yet**

Run (from `tooling/koine-studio/`):
```bash
node scripts/css-canon.mjs src/styles/main.scss > /tmp/koine-css-built.css
diff /tmp/koine-css-baseline.css /tmp/koine-css-built.css && echo "STILL IDENTICAL"
```
Expected: `STILL IDENTICAL` — `abstracts/` is not yet `@use`d by any emitting partial, so output is unchanged.

- [ ] **Step 6: Commit**

```bash
git add tooling/koine-studio/src/styles/abstracts
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "feat(studio): add SCSS abstracts layer (variables, mixins) — no output change"
```

### Task 7: Consolidate & idiomatize `base/` + `themes/`

**Files:**
- Modify: `tooling/koine-studio/src/styles/base/_animations.scss` (receive `@keyframes koi-pulse`)
- Modify: `tooling/koine-studio/src/styles/components/_lang-picker.scss` (remove the migrated `@keyframes koi-pulse`)
- Modify: `tooling/koine-studio/src/styles/main.scss` (no order change needed; `@keyframes` placement is cascade-neutral)

**Interfaces:**
- Consumes: the Phase 1 partials.

- [ ] **Step 1: Move `@keyframes koi-pulse` into `base/_animations.scss`**

Cut the `@keyframes koi-pulse { ... }` block (originally lines 422–431) out of `components/_lang-picker.scss` and paste it into `base/_animations.scss` next to `koi-rise`/`koi-fade`. `@keyframes` are global and order-independent, so this is visually safe. Leave the `.lang-dot` pulse *usage* (`animation: koi-pulse ...`) in `_lang-picker.scss`.

- [ ] **Step 2: Shallow-nest both base partials**

In `base/_scrollbars.scss` and `base/_animations.scss`, collapse repeated parent selectors into nested blocks (≤3 levels). Do not alter declarations, selector targets, or the `@supports`/`@media (prefers-reduced-motion)` guards.

- [ ] **Step 3: Equivalence gate**

Run (from `tooling/koine-studio/`): `node scripts/css-equiv.mjs /tmp/koine-css-baseline.css src/styles/main.scss`. Expected: `EQUIVALENT` (moving a `@keyframes` block and nesting do not change any selector's declaration set). If NOT equivalent, the report names the changed rule — fix the nest/move until equivalent before committing.

- [ ] **Step 4: Commit**

```bash
git add tooling/koine-studio/src/styles
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "refactor(studio): consolidate base/ (keyframes + nesting), no visual change"
```

### Task 8: Consolidate & idiomatize `layout/`

**Files:**
- Modify: `tooling/koine-studio/src/styles/layout/_toolbar.scss` (absorb `_branded-header.scss`)
- Modify: `tooling/koine-studio/src/styles/layout/_split.scss` (absorb `_resizer.scss`)
- Modify: `tooling/koine-studio/src/styles/layout/_inspector.scss` (absorb `_inspector-tabs.scss`)
- Delete: `layout/_branded-header.scss`, `layout/_resizer.scss`, `layout/_inspector-tabs.scss`
- Modify: `tooling/koine-studio/src/styles/main.scss` (drop the three removed `@use`s)

**Interfaces:**
- Consumes: `a.ghost-button` from `abstracts/` (Task 6).

- [ ] **Step 1: Merge the split layout partials**

Append the body of `_branded-header.scss` into `_toolbar.scss`, `_resizer.scss` into `_split.scss`, and `_inspector-tabs.scss` into `_inspector.scss` (drop the redundant `/* === */` banner comments). Then `git rm` the three absorbed files and remove their `@use` lines from `main.scss`. Because the absorbed blocks move *earlier* in the cascade, verify (Step 3) that none of their selectors collide with rules in the skipped-over region; the visual smoke is the proof.

- [ ] **Step 2: Apply `ghost-button` + shallow nesting in `_toolbar.scss`**

Add `@use '../abstracts' as a;` at the top. Replace the duplicated declaration body of `.toolbar-actions button, #btn-check` with `@include a.ghost-button;`, keeping `#btn-check`'s extra `background`/`border-color` inline. Nest `.tb-group`, `.lang-*`, and the branded-header selectors (≤3 levels). Keep `.tb-ico` as its own class (it is shared via the class in HTML — do not mixin-ize it).

- [ ] **Step 3: Equivalence gate**

Run: `node scripts/css-equiv.mjs /tmp/koine-css-baseline.css src/styles/main.scss`. Expected: `EQUIVALENT`. The `ghost-button` mixin must reproduce `.toolbar-actions button, #btn-check` and its `:hover`/`:disabled` rules exactly; if the report flags any of those selectors, the mixin's declaration set is off — reconcile until equivalent before committing.

- [ ] **Step 4: Commit**

```bash
git add -A tooling/koine-studio/src/styles
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "refactor(studio): consolidate layout/ + ghost-button mixin, no visual change"
```

### Task 9: Consolidate the split component partials

**Files:**
- Modify: `components/_welcome.scss` (absorb `_welcome-atmosphere.scss` + `_welcome-gallery.scss`)
- Modify: `components/_glossary.scss` (rename target; absorb `_glossary-readability.scss` + `_glossary-editor.scss`)
- Modify: `components/_doc-panes.scss` (absorb `_copy-code-button.scss`)
- Modify: `components/_form-fields.scss` (absorb `_prefs-inputs.scss`)
- Move: `components/_a11y.scss` → `base/_a11y.scss`
- Delete: the absorbed partials
- Modify: `tooling/koine-studio/src/styles/main.scss` (update `@use` list)

**Interfaces:**
- Consumes: Phase 1 component partials.

- [ ] **Step 1: Merge non-contiguous component groups**

Create `components/_glossary.scss` = `_glossary-readability.scss` body followed by `_glossary-editor.scss` body. Append `_welcome-atmosphere.scss` + `_welcome-gallery.scss` into `_welcome.scss`. Append `_copy-code-button.scss` into `_doc-panes.scss`. Append `_prefs-inputs.scss` into `_form-fields.scss`. Move `_a11y.scss` (the `visually-hidden` utility) to `base/_a11y.scss`. `git rm` every absorbed file and update `main.scss`'s `@use` list to reference the consolidated partials only (keep overall source order).

- [ ] **Step 2: Shallow-nest each consolidated partial**

Nest child selectors under their block parents (≤3 levels). No declaration changes.

- [ ] **Step 3: Equivalence gate**

Run: `node scripts/css-equiv.mjs /tmp/koine-css-baseline.css src/styles/main.scss`. Expected: `EQUIVALENT` — merging non-contiguous blocks relocates rules but must not add, drop, or change any selector's declarations. If the report flags a rule, a merge dropped or duplicated something — fix before committing.

- [ ] **Step 4: Commit**

```bash
git add -A tooling/koine-studio/src/styles
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "refactor(studio): consolidate split component partials, no visual change"
```

### Task 10: Idiomatic rewrite — popover mixin + language `@each` loop

**Files:**
- Modify: `components/_lang-split-button.scss` (the `@each` loop)
- Modify: `components/_lang-picker.scss`, `components/_context-menu.scss`, `components/_floating-menu.scss` (popover mixin)

**Interfaces:**
- Consumes: `a.popover-surface`, `a.$languages` from `abstracts/`.

- [ ] **Step 1: Replace the three hand-written language-dot rules with an `@each` loop**

In `components/_lang-split-button.scss`, add `@use '../abstracts' as a;` and replace:
```scss
.lang-dot[data-lang="csharp"] { --dot: var(--lang-csharp); }
.lang-dot[data-lang="typescript"] { --dot: var(--lang-typescript); }
.lang-dot[data-lang="python"] { --dot: var(--lang-python); }
```
with:
```scss
@each $name, $hue in a.$languages {
  .lang-dot[data-lang="#{$name}"] { --dot: #{$hue}; }
}
```
This regenerates the identical three rules in the same order.

- [ ] **Step 2: Apply `popover-surface` to the floating menus**

In `_lang-picker.scss` (`.lang-menu`), `_context-menu.scss` (`.explorer-menu`), and `_floating-menu.scss`, add `@use '../abstracts' as a;` and replace the exactly-shared chrome declarations with `@include a.popover-surface;`, leaving each selector's unique props (e.g. `.lang-menu`'s `z-index: 120; min-width: 184px;`) inline. Verify per-selector that the union of included + inline declarations equals the original declaration set.

- [ ] **Step 3: Equivalence gate**

Run: `node scripts/css-equiv.mjs /tmp/koine-css-baseline.css src/styles/main.scss`. Expected: `EQUIVALENT`. The `@each` loop must regenerate the three `.lang-dot[data-lang=…]` rules with identical `--dot` values, and `popover-surface` + inline props must equal each menu's original declaration set. If the report flags `.lang-dot`, `.lang-menu`, `.explorer-menu`, or the floating-menu selectors, reconcile before committing.

- [ ] **Step 4: Commit**

```bash
git add tooling/koine-studio/src/styles
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "refactor(studio): popover mixin + language @each loop, no visual change"
```

### Task 11: Final cascade order, full smoke, cleanup

**Files:**
- Modify: `tooling/koine-studio/src/styles/main.scss` (reorder `@use` to the canonical 7-1 cascade)

**Interfaces:** none new.

- [ ] **Step 1: Reorder `main.scss` to the canonical cascade**

Reorder the `@use` list to: `abstracts` (if emitting nothing it can be omitted from `main.scss` and `@use`d only where needed), then `themes/*`, `base/*`, `layout/*`, `components/*`. The reorder can shift cascade order, so it is validated by BOTH gates in Step 2.

- [ ] **Step 2: Final deterministic gate, then the single full visual smoke**

First the deterministic proof: `node scripts/css-equiv.mjs /tmp/koine-css-baseline.css src/styles/main.scss` → must be `EQUIVALENT` (no selector's declaration set changed across all of Phase 2). Then the cascade-order confirmation the rule-set diff cannot give: with `npm run dev:web` running, re-shoot all 8 screens in both themes into `/tmp/koine-shots/final/` and compare against `/tmp/koine-shots/baseline/` (from Task 5). Expected: every pair pixel-identical. Investigate and fix any diff before proceeding. If baseline screenshots could not be captured in Task 5, instead walk each screen live in both themes and confirm it renders correctly (the deterministic gate already proves declaration-equivalence; this pass covers cascade order).

- [ ] **Step 3: Full build + tests**

Run (from `tooling/koine-studio/`):
```bash
npm run build && npm test
```
Expected: both pass.

- [ ] **Step 4: Verify the final tree shape**

Run (from `tooling/koine-studio/`):
```bash
find src/styles -name '*.scss' | sort
test ! -f src/styles.css && echo "monolith gone"
```
Expected: the final 7-1 tree (~28 partials + `main.scss`), no `styles.css`.

- [ ] **Step 5: Commit**

```bash
git add tooling/koine-studio/src/styles
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "refactor(studio): finalize 7-1 SCSS cascade order; migration complete"
```

---

## Self-review notes (coverage vs spec)

- **7-1 taxonomy** → File Structure section + Tasks 2/7/8/9. `vendor/` & `pages/` dropped per spec YAGNI.
- **Tokens stay runtime CSS vars** → Global Constraints + Task 6 Step 1 (explicit prohibition).
- **`@use`/`@forward`, no `@import`** → Global Constraints; slicer emits `@use`.
- **`sass-embedded` + `main.ts` import + drop `<link>`** → Tasks 1 & 3 (Vite-8 config confirmed: no `preprocessorOptions` needed).
- **Phase 1 mechanical empty-diff gate** → Tasks 1–4 (`css-canon.mjs` canonical diff).
- **Phase 2 gate = rule-set equivalence + final visual** → Task 5 builds `css-equiv.mjs` (TDD); Tasks 6–10 each end `EQUIVALENT` against the Phase-1 baseline; Task 11 runs the deterministic gate plus the single full visual smoke (`dev:web` on :1430, both themes).
- **Idiomatic payoff (mixins, `@each`)** → Tasks 6/8/10 with concrete code.
- **Pixel-identical, no redesign** → every Phase 2 task ends EQUIVALENT (no selector's declaration set changed); Task 11 adds the cascade-order visual sweep.
- **Worktree + commit identity** → Global Constraints; every commit step uses the identity flags.
