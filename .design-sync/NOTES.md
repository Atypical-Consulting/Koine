# design-sync notes — @atypical/koine-ui

Storybook-shape sync of the **@atypical/koine-ui** design system (`tooling/koine-ui`) to a
claude.ai/design project. Run everything from the **repo root** (`.design-sync/`, `.ds-sync/`,
`ds-bundle/` all live there; the converter/compare resolve `.design-sync/` from cwd).

## The core problem: Preact library → React runtime

koine-ui is a **Preact** component library (JSX compiled with Preact's automatic runtime; `preact`
externalized in its dist). claude.ai/design's runtime **and** the design-sync converter render with
**React 18**. A Preact component returns Preact vnodes React can't render.

**Fix (mirrors the sibling koine-studio sync):** the bundle ships each component wrapped in a thin
**Preact→React mount adapter**. `cfg.entry` points at a generated entry
(`tooling/koine-ui/dist/_ds_adapter_entry.mjs`, written by `.design-sync/gen-adapter-entry.mjs`) that
imports the real Preact components and re-exports React wrappers: each wrapper is a real React function
component (using the runtime's `window.React`) that renders the Preact subtree via preact's own
`render()` in a layout effect, and bridges React `children` back into the Preact tree. The generator
also exports `h`/`Fragment` (so owned previews can build Preact-vnode fixtures with the SAME preact
instance) and a `ThemeSurface` provider (see below). Adapter logic is verbatim from
`tooling/koine-studio/.ds-adapter/adapter.js`.

## Rebuild recipe (from repo root)

```bash
npm ci                                            # workspace install; postinstall builds koine-ui dist
npm i --no-save --no-package-lock react-dom@<react-ver>   # see "react-dom" below
# stage scripts + deps (.ds-sync): see .ds-sync/... (cp from the skill base + npm i esbuild ts-morph @types/react playwright + chromium)
npm run build -w @atypical/koine-ui               # (cfg.buildCmd) build dist
node .design-sync/gen-adapter-entry.mjs           # (cfg.buildCmd) write the adapter entry into dist/
npx storybook build -c tooling/koine-ui/.storybook -o "$(git rev-parse --show-toplevel)/.design-sync/sb-reference"
node .design-sync/patch-reference.mjs             # inject dark bg + brand fonts into the reference (see below)
node .ds-sync/resync.mjs --config .design-sync/config.json --node-modules "$PWD/node_modules" \
  --entry tooling/koine-ui/dist/_ds_adapter_entry.mjs --out ./ds-bundle   # first sync: omit --remote
```

## Repo-specific gotchas

- **`react-dom` isn't a repo dependency.** Root `node_modules` has `react` (via storybook/zustand) but no
  `react-dom`; the converter vendors both into `_vendor/` for the preview cards. Install it into
  node_modules WITHOUT touching the lockfile: `npm i --no-save --no-package-lock react-dom@<match react>`
  (currently 19.2.7). Not persisted in git (node_modules is ignored) — re-run on a fresh clone.
- **Added a top-level `types` field to `tooling/koine-ui/package.json`.** The package declared types only
  via `exports["."].types`; the converter's `.d.ts` resolver (`projectFor`/`findTypesRoot`) reads
  top-level `types`/`typings`, so with only the exports map it fell back to a non-existent
  `tooling/koine-ui/index.d.ts` and discovered **0 components** (`[TITLE_UNMAPPED]`). Added
  `"types": "./dist/index.d.ts"` (+ `"module"`) — a genuine compat improvement, committed. **If that field
  is ever removed, discovery breaks again.**
- **Dark surface + reference parity (`.design-sync/patch-reference.mjs`).** The components are built for
  Koine Studio's dark shell; `.storybook/preview.ts` sets `backgrounds.default: 'studio'`, but that addon
  parameter is NOT applied in a static `?story=` capture, so the reference renders light-ink components on
  a WHITE canvas (nearly invisible). And the storybook never imports the brand fonts. The patch injects
  `background:var(--koi-paper)` + the shipped `@font-face` (copied from `ds-bundle/fonts/`) into
  `sb-reference/iframe.html` so the ORACLE matches the shipped design. **Re-run it every time the reference
  is rebuilt** (it's idempotent). The preview side gets the dark ground from the `ThemeSurface` provider
  (`cfg.provider`).
- **Fonts.** `--koi-font-mono`/`--koi-font-body` (JetBrains Mono / Hanken Grotesk Variable) come from
  `@fontsource-variable/*` (root node_modules), wired via `cfg.extraFonts` (`wght.css` normal weights).
  Archivo (`--koi-font-display`) is defined but unreferenced by component CSS, so it's not shipped.
- **Owned previews (`.design-sync/previews/`).** DeckCard, DeckBar, ExportMenu, RightStrip are OWNED
  because the generated previews recompile the Preact stories with React's JSX runtime, which breaks their
  Preact idioms — string `style=` (DeckCard `mockBody`), Preact-vnode `icon` fixtures rendered by the
  Preact component (DeckCard/DeckBar → "Cannot add property __" / "style prop expects a mapping"), and
  content-width containers stretched by the full-width provider (ExportMenu menu right-anchor, RightStrip
  orientation). The owned copies mirror each story in React idiom, building icon fixtures with the bundle's
  own preact `h` (imported from `@atypical/koine-ui`, redirected to `window.KoineUi.h`).

## Re-sync risks (watch-list)

- **`_ds_adapter_entry.mjs` is generated, not committed** (dist is gitignored). `cfg.buildCmd` regenerates
  it; if the build order changes, ensure the entry exists before `package-build`. `[REFERENCE_STALE?]`
  after a bare adapter regen is expected (bundle sha moved, DS source didn't) — not a real staleness.
- **The `types` field** on koine-ui's package.json is load-bearing for component discovery (see gotchas).
- **New component?** `gen-adapter-entry.mjs` auto-discovers PascalCase component exports from
  `dist/index.d.ts`, so a new component is wrapped automatically — but if it uses Preact-idiom story
  fixtures/wrappers it will need an owned preview (see above).
- **`ThemeSurface` / `h` / `Fragment`** are extra bundle exports beyond the 6 real components
  (preview/host plumbing, not koine-ui API). Expected in the `window.KoineUi` export list.
- **No execution meta-test** — fidelity is proven only by the compare-vs-storybook grades. Owned previews
  are graded `match`; ExportMenu/RightStrip/LeftRail-Files are `close` (documented framing/interaction
  deltas — see `.cache/compare/*.grade.json` notes). Re-verify those if the DS layout changes.
- **The compare oracle depends on the reference patch.** A re-sync that rebuilds `sb-reference` but forgets
  `patch-reference.mjs` grades against a white-canvas, wrong-font oracle. Always re-run the patch.
