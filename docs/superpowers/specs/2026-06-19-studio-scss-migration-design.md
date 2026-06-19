# Koine Studio — `styles.css` → 7-1 SCSS migration

**Date:** 2026-06-19
**Status:** Design approved; pending spec review → implementation plan
**Scope:** `tooling/koine-studio/` (the TypeScript + Vite + Tauri Studio IDE)

## Problem

The Studio IDE's styling lives in a single monolithic stylesheet,
`tooling/koine-studio/src/styles.css` — **3,358 lines / ~74 KB**, organized only by
~50 `/* --- section --- */` comment banners. It has grown unwieldy to navigate and
maintain. The project is **not** Blazor and does **not** use Tailwind or PostCSS; it is
vanilla CSS built by **Vite 8**, which supports SCSS natively.

## Goal

Restructure the monolith into a **full 7-1 SCSS architecture** — partials, a token/theme
layer, and a mixins/functions library — with idiomatic SCSS (nesting, mixins, `@each`
loops) replacing the hand-repeated patterns. **The rendered IDE must remain
pixel-identical**: this is a pure structural migration, not a redesign.

## Key constraint: tokens stay runtime CSS custom properties

The ~50 `--koi-*` custom properties are the live theming system. `:root` holds the dark
defaults; `html[data-theme='light']` redefines every token; `document.documentElement.dataset.theme`
flips them at runtime, and the CodeMirror editor theme reads the same `var()` tokens so a
theme flip re-themes the editor for free.

Therefore the `--koi-*` tokens are **NOT** converted to SCSS `$variables` (those compile
away and would break runtime theming). They stay as CSS custom properties that emit real
CSS, living in the `themes/` layer. SCSS `$variables` are used **only** for build-time
concerns the runtime never observes: breakpoints, z-index ordering, and the maps that
drive loops. **No token value changes** — light and dark must behave bit-for-bit as today.

## Current facts (recon)

- One file: `tooling/koine-studio/src/styles.css` (3,358 lines).
- Wiring: `index.html:6` → `<link rel="stylesheet" href="/src/styles.css" />`.
  `src/main.ts` imports `@fontsource-variable/{archivo,hanken-grotesk,jetbrains-mono}` then `./ide`.
- Build: Vite `^8.0.0`. No `sass`, no PostCSS, no Tailwind. `build` script is `tsc && vite build`.
- Token block: `:root` (lines 1–54), `html[data-theme='light']` override (56–92).
- At-rules: `@keyframes koi-pulse / koi-rise / koi-fade`; `@media (max-width:640px)` and
  `@media (prefers-reduced-motion: reduce)`; `@supports not selector(::-webkit-scrollbar)`.
- Usage: 544 `var()` references, 63 `color-mix()`.
- Comments already name shared patterns ("mirrors `.explorer-menu`", "built on the shared
  modal chrome", "shared stroke recipe", "reuses these classes") — the seams for mixins.
- Some classes are reused across components (e.g. `.tree-dirty`/`.tree-badge` shared by
  file-tree + explorer; form-field classes shared by Settings + wizard).

## Target structure

New `tooling/koine-studio/src/styles/`; the old `src/styles.css` is deleted. Pragmatic 7-1:
classic `vendor/` and `pages/` are **dropped** (no vendor CSS file — CodeMirror is themed
via JS/`var()`; single-page app), which keeps the layout honest to YAGNI.

```
src/styles/
  main.scss                 # @use's every layer in cascade order (abstracts → themes → base → layout → components)
  abstracts/                # NO CSS output
    _variables.scss         # $bp-narrow:640px; z-index tiers (overlay/modal/palette/popover);
                            #   $languages map (csharp/typescript/python -> hue); $syntax-tokens list
    _functions.scss
    _mixins.scss            # ghost-button, segmented-cluster, floating-popover, modal-chrome,
                            #   focus-ring, custom-scrollbar, tb-ico stroke recipe
    _index.scss             # @forward the above (so consumers do one @use 'abstracts')
  themes/
    _dark.scss              # :root token defaults (current lines 1-54)
    _light.scss             # html[data-theme='light'] override (current 56-92)
  base/
    _scrollbars.scss        # uniform scrollbar block + @supports fallback
    _typography.scss        # editor font-size var + base element type
    _animations.scss        # @keyframes koi-pulse/koi-rise/koi-fade + prefers-reduced-motion
  layout/
    _toolbar.scss  _split.scss  _inspector.scss
  components/               # ~one partial per UI piece
    _lang-split-button.scss  _lang-picker.scss  _file-tree.scss  _explorer.scss
    _context-menu.scss  _confirm-dialog.scss  _doc-panes.scss  _outline.scss
    _tooltip.scss  _diagnostics.scss  _welcome.scss  _command-palette.scss  _modal.scss
    _form-fields.scss  _settings.scss  _help.scss  _about.scss  _glossary.scss
    _floating-menu.scss  _diagrams.scss  _ai-panel.scss  _wizard.scss  _a11y.scss
```

Module system: **`@use` / `@forward`** (modern Sass), never `@import`. Shared classes that
two components rely on stay in the most general owning partial; shared *visual recipes*
become `@mixin`s (or `%placeholder`s) in `abstracts/_mixins.scss`.

Exact section→partial line boundaries are finalized during implementation by slicing the
current comment banners; the partial list above is the agreed taxonomy.

## Idiomatic SCSS payoff (Phase 2)

- **`@each` loops** over `$languages` (csharp/typescript/python → brand hue) to generate the
  identity-dot and picker-row rules instead of three hand-written copies.
- **Mixins / placeholders** for the patterns the comments already flag as shared: floating
  popover chrome (lang-picker ≈ context-menu ≈ floating-menu), modal chrome (confirm dialogs
  build on it), the `.tb-ico` stroke recipe, focus-ring, segmented button cluster, custom scrollbar.
- **Nesting** scoped within each component partial, kept **shallow (≤3 levels)** to avoid
  specificity creep.

## Build wiring

- Add **`sass-embedded`** as a devDependency (Vite 8 native; faster than `sass`).
- Replace the `<link rel="stylesheet" href="/src/styles.css" />` in `index.html` with
  **`import './styles/main.scss';`** at the top of `src/main.ts` (idiomatic Vite path → HMR +
  bundling). The `@fontsource-variable/*` imports are untouched.
- `tsc && vite build` is unaffected (tsc ignores `.scss`).

## Execution & verification (two phases)

### Phase 1 — pure split, zero rewriting
Slice the current CSS **verbatim** into the partials, preserving source order; `main.scss`
`@use`s them in that exact order. Wire `sass-embedded` + the `main.ts` import.

**Gate (mechanical diff):** compile with sass, then run **both** the original `styles.css`
and the compiled output through the same normalizer (strip comments, normalize whitespace —
e.g. a shared `prettier --parser css` or `postcss`/`css-tree` normalize pass) and `diff`.
The diff **must be empty**. This proves the split lost nothing and reordered nothing before
any idiomatic rewriting begins.

### Phase 2 — go idiomatic
Introduce nesting, mixins, and the `@each` loops **partial by partial**. Selectors
regenerate, so the byte-diff no longer applies → switch to **visual smoke**:

1. Before Phase 2, capture **baseline screenshots** of: start/welcome overlay, editor +
   file tree, Settings dialog, command palette, glossary editor, Generate-Project wizard —
   each in **both light and dark** theme.
2. After each idiomatic pass, re-shoot and compare via the browser MCP.

Run the app with **`npm run dev:web`** (port 1430 — no Tauri/Rust shell needed). The WASM
backend must be published once via `scripts/build-wasm.mjs` so the IDE renders.

## Out of scope (YAGNI)

No visual redesign, no token renames, no new components, no Tailwind/PostCSS, no
CSS-module/scoped-CSS conversion, no CodeMirror theme changes, no `vendor/`/`pages/` folders.
The rendered IDE is pixel-identical at the end.

## Success criteria

1. `tooling/koine-studio/src/styles.css` is gone; `src/styles/` holds the 7-1 tree.
2. `npm run build` (`tsc && vite build`) succeeds with `sass-embedded`.
3. Phase 1 normalized-CSS diff against the original is empty.
4. Phase 2 visual smoke shows the IDE pixel-identical in both themes across the key screens.
5. No `--koi-*` token value changed; runtime light/dark switching (incl. CodeMirror) works.
6. All edits made in the `busy-keller-3ab07d` worktree.

## Notes / risks

- All recon read the **main repo** copy of `styles.css`; the worktree copy is identical
  (3,358 lines) and is where every edit lands.
- The normalizer for the Phase 1 diff must treat comments and whitespace identically for
  both inputs, or the gate will produce noise. Pick one tool and run both files through it.
- Running `dev:web` for visual smoke requires the published WASM backend; build it once up front.
