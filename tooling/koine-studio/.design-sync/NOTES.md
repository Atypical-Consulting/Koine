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
- **No standalone `<Name>.d.ts`.** claude.ai/design's compiler only treats a sibling
  `<Name>.tsx` as "the implementation" — it does not accept `_preview/*.js`, so a lone
  `.d.ts` re-fired the design-system check as an "orphan (no sibling implementation)" on
  every re-sync. `gen-docs.mjs` therefore emits **only** `<Name>.html` + `<Name>.prompt.md`
  (+ `_preview/<Name>.js`); the panels ship preview-only and the prop shape lives in the
  prompt snippet + the Studio source. Do **not** re-add the `.d.ts` emit without also
  emitting a real `<Name>.tsx` bound to a populated `window.KoineStudio_<id>.*` — today that
  namespaced global is empty, so a `.tsx` binding would resolve to `undefined` at runtime.
- **Token `@kind` annotations.** claude.ai/design classifies each `--koi-*` token; the
  `--koi-z-*` (9), `--koi-dur-*` (4) and `--koi-scrollbar-size` (1) tokens are none of
  color/spacing/radius/shadow/font, so they were flagged "unclassified" every re-sync. The
  classifier reads the standalone **`tokens/tokens.css`** — the hand-copy, NOT the compiled
  `_ds_bundle.css` — so the annotation must live there. Its canonical committed source is
  **`.design-sync/tokens.css`** (`@kind other` on those 14 declarations); copy it to
  `ds-bundle-live/tokens/tokens.css` before upload (no script generates that path — the
  tokens/fonts/styles.css seed lives only in the remote project as a superset carry-over).
  `src/styles/themes/_dark.scss` carries the same `/* @kind other */` markers so the app's
  own compiled `_ds_bundle.css` agrees; Sass `expanded` mode preserves loud comments. If a
  new token isn't color/spacing/radius/shadow/font, annotate it in BOTH places.
- Token-side risks from the tokens sync still apply: `tokens/tokens.css` is a hand-copy
  of `src/styles/themes/`; `@charset` must be stripped each compile.
