# design-sync notes — Koine Studio

## What this sync is

A **live-component + tokens** sync to claude.ai/design project **Koine Studio**
(`projectId` in `config.json`). It ships:
- **Live React-mountable components** — the real Studio panels (Preact) exposed on
  `window.KoineStudio.*` via a thin **Preact→React adapter** (`_ds_bundle.js`).
- **Design tokens** — every `--koi-*` / `--lang-*` token + the 9 token gallery cards.

Superset re-sync of the earlier tokens-only sync (that PR is #910). The token cards,
`tokens/`, `fonts/`, `styles.css`, `_ds_bundle.css` are unchanged from that sync.

## Why an adapter (the Preact/React problem)

Koine Studio is a **Preact** app; claude.ai/design's runtime and the design-sync
converter are **React 18 only** (they render `window.<Global>.*` with React). A Preact
component returns Preact vnodes React can't render. The adapter
(`.ds-adapter/adapter.js`) wraps each Preact component in a real React function
component: the outer wrapper uses the runtime's `window.React` for a host `<div>`, and
inside a layout effect it renders the Preact tree into that host with preact's own
`render()`. **Cross-boundary composition**: React `children` are bridged — React renders
them into a detached DOM host that is spliced into the Preact tree — so slots work both
ways. Proven end-to-end (store-bound + plain-props panels render under React 18, zero
console errors).

Key build detail mirrored from `.storybook/main.ts`: esbuild aliases `react` /
`react-dom` → `preact/compat` and `react/jsx-runtime` → `preact/jsx-runtime`, so the
panels' React-targeting deps (zustand's React hook) resolve to the single bundled preact
instance. Without this the panels throw "Invalid hook call". The ONLY real React is the
runtime's `window.React`, used by the adapter wrapper.

## Toolchain (`.ds-adapter/`) + rebuild recipe

Durable (committed): `adapter.js`, `card-runtime.js`, `stub-storybook-test.js`,
`scan.mjs`, `gen.mjs`, `gen-docs.mjs`, `manifest-overrides.json`, `package.json`.
Gitignored: `.ds-adapter/node_modules`, `.ds-adapter/manifest.json` (generated),
`ds-bundle-live/` (build output), `.design-sync/sb-reference/`.

From `tooling/koine-studio/`:
```bash
npm ci                                          # app deps (sass, fonts, preact)
(cd .ds-adapter && npm i && npx playwright install chromium)   # esbuild + react 18 (for _vendor UMD)
node .design-sync/ds-compile.mjs && sed -i '1{/^@charset/d}' ds-bundle/_ds_bundle.css   # tokens css
node .design-sync/ds-cards.mjs                  # token gallery cards
node .ds-adapter/scan.mjs                       # story manifest → .ds-adapter/manifest.json
node .ds-adapter/gen.mjs                         # _ds_bundle.js + _preview/*.js + component cards (seeds ds-bundle-live from ds-bundle)
node .ds-adapter/gen-docs.mjs                    # <Name>.d.ts + <Name>.prompt.md
# verify: serve ds-bundle-live/ and screenshot cards; storybook reference is the oracle:
#   npx storybook build -c .storybook -o .design-sync/sb-reference
```
`gen.mjs` seeds `ds-bundle-live/` by copying `ds-bundle/` (the tokens bundle), then adds
`_ds_bundle.js`, `_vendor/`, `_preview/`, and `components/<group>/<Name>/`.

## Roster (22 stories)

- **Adapted components (18)** on `window.KoineStudio`: all `*.stories.tsx` with a
  `component:` in meta. Store-bound ones read UI state from a `store`
  (`KoineStudio.createStore()`) and domain data from a `model`/`index` prop.
- **Scenes (2)**: `DeckStage`, `LeftRail` — no standalone component; exposed as
  zero-config scene components rendering their primary story.
- **Card-only (1)**: `SettingsPage` — imperative CodeMirror factory; its 3MB bundle
  would bloat `_ds_bundle.js` past the file cap, so it ships as a preview card only.
- **Skipped (1)**: `UnsavedIndicator` — renders `null` (effect-driven host button).
- Representative primary stories chosen in `manifest-overrides.json` (many "first"
  stories are empty states).

## Upload

Atomic path (project pinned before the run). The build is a **superset** of the
tokens sync, so reconciliation deletes = none. The project also carries user-added
`Koine Logo.html` + `screenshots/` and app-generated `_ds_manifest.json` /
`_adherence.oxlintrc.json` — **do not delete these** (leave the writes a superset, no
deletes). No `_ds_sync.json` anchor (off-script bundle) — every re-sync re-verifies.

## Re-sync risks (watch-list)

- **Bundle is not converter output.** `_ds_bundle.js` is hand-built via `.ds-adapter/`.
  If a panel's imports change (new heavy/server-only dep), extend the `stubPlugin` filter
  in `gen.mjs` (currently `@anthropic-ai/sdk`, `openai`, `node:*`).
- **`react`→`preact/compat` alias is load-bearing** — if panels regress to blank with
  "Invalid hook call", that alias broke.
- **Story fixtures drive the cards.** A card renders its story's primary story with
  preact; if a story's fixtures change, the card changes. Re-verify against a fresh
  `.design-sync/sb-reference`.
- **`import.meta` warnings** during `gen.mjs` are from wasm-host code pulled via the
  store; those paths aren't hit at render time. Harmless unless a panel starts calling
  `import.meta.env` at module scope.
- **`.d.ts` referenced types are opaque** (StoreApi/AppState/model types are the app's).
  The prop *shape* is faithful; the types don't resolve standalone.
- **SettingsPage** is preview-only by size choice — revisit if the file cap changes.
- Token-side risks from the tokens sync still apply: `tokens/tokens.css` is a hand-copy
  of `src/styles/themes/`; `@charset` must be stripped each compile.
