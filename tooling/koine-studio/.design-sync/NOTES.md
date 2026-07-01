# design-sync notes — Koine Studio

## What this sync is

A **tokens & visual-styles** sync to claude.ai/design project **Koine Studio**
(`projectId` in `config.json`). NOT live components.

**Why not components:** Koine Studio (`tooling/koine-studio`) is a **Preact**
application (`@storybook/preact-vite`, `preact/compat` aliasing, zero `react`
dependency), `"private": true`, no library `dist`/exports. The design-sync converter
and the claude.ai/design runtime are **React 18 only** (`lib/bundle.mjs` externalizes
`react`/`react-dom` to `window.React`; the string "preact" appears nowhere in the
toolchain). Preact components return Preact vnodes React cannot render, so the
converter's storybook/package shapes do not apply. The 22 `*.stories.tsx` are also
app *panels* bound to the zustand domain store, not reusable UI primitives.
Decision (approved by user 2026-07-01): sync the design foundation only. This bundle
is therefore **hand-authored** (the skill's "upload format is the contract" escape
hatch), not converter output — `config.json.shape` is the custom marker `"styles-only"`.

## Rebuild recipe (fully deterministic)

From `tooling/koine-studio/`:

```bash
npm ci                                   # sass-embedded + @fontsource-variable/*
mkdir -p ds-bundle/tokens ds-bundle/fonts ds-bundle/components/tokens
node .design-sync/ds-compile.mjs         # main.scss -> ds-bundle/_ds_bundle.css (then strip @charset line 1)
node .design-sync/ds-cards.mjs           # -> ds-bundle/components/tokens/*/*.html
# hand-maintained (committed under .design-sync/, copy into ds-bundle/):
#   tokens/tokens.css, fonts/fonts.css + 3 latin woff2, styles.css, README.md, _ds_needs_recompile
```

`ds-compile.mjs` strips nothing itself — the `@charset "UTF-8";` on line 1 of the
compiled CSS must be removed before it is `@import`ed from `styles.css` (it's invalid
inside an import). This sync did it with `sed -i '1{/^@charset/d}'`.

`tokens/tokens.css`, `fonts/fonts.css`, `styles.css`, `README.md` are hand-authored,
not generated. The authoritative token source is `src/styles/themes/{_dark,_light}.scss`
+ `abstracts/_ddd.scss`. `tokens.css` is a curated copy of those — keep it in sync if
the theme files change (see risk below). Fonts are the `latin-wght-normal.woff2` files
from `node_modules/@fontsource-variable/{archivo,hanken-grotesk,jetbrains-mono}/files/`.

`README.md` = `conventions.md` (via `readmeHeader`) + a gallery index, stitched by the
`cat` in the sync (there is no converter to prepend it automatically).

## Upload

Incremental path, plan writes = `components/** tokens/** fonts/** _ds_bundle.css
styles.css README.md _ds_needs_recompile`. **No `_ds_sync.json` anchor** is shipped
(honest choice for an off-script bundle — the converter's anchor format is
component-oriented). Consequence: every re-sync re-verifies from scratch (re-run the
recipe, re-screenshot cards, re-upload). `ds-bundle/` is gitignored build output.

## Re-sync risks (watch-list)

- **`tokens/tokens.css` is a hand-copy of `src/styles/themes/`.** If a `--koi-*` token
  is added/renamed/recolored in the SCSS themes or `_ddd.scss`, it will NOT flow into
  the sync automatically — update `tokens/tokens.css` AND the relevant gallery card in
  `ds-cards.mjs` (and `LIGHT_SCOPE` there, which duplicates the light values for the
  inline light panes). `_ds_bundle.css` IS regenerated from source each run, so the
  component classes stay current; only the curated `tokens.css` + card data can drift.
- **`.design-sync/ds-cards.mjs` `LIGHT_SCOPE`** duplicates the light-theme token values
  so Colors/Syntax cards can show a light pane. Keep it equal to `tokens.css`'s light block.
- **Fonts:** only the `latin` subset ships (3 woff2). Non-latin glyphs fall back. If the
  app adds a weight axis beyond `wght`, revisit `fonts/fonts.css` ranges (Archivo/Hanken
  100–900, JetBrains 100–800).
- **`@charset` strip** must be re-applied every rebuild (sass re-emits it).
- If Koine Studio ever ships a real **React** component library, redo this as a proper
  converter sync (storybook shape) — this styles-only bundle is the interim.

## Verification done this run

All 9 cards rendered in a real browser (chromium) against a static server over
`ds-bundle/`: fonts loaded (200), full `@import` closure resolved, both themes correct,
`.koi-*` control classes styled from the compiled bundle. Screenshots reviewed for
Colors, Typography, Syntax, DDD palette, Controls, Elevation, Radius.
