# @atypical/koine-ui

Framework-free design tokens and Preact UI primitives extracted from Koine Studio (issue
[#905](https://github.com/Atypical-Consulting/Koine/issues/905)). It carries the `--koi-*` design
system, the shared DOM/interaction engines those components run on, and the presentational
components that don't need a store or a host (Tauri/browser) to render — so a second surface
(the docs-site playground, a future embed, another IDE) can reuse Koine Studio's look and
interaction patterns without pulling in the whole IDE.

This is a **presentation-only** package: no Zustand store, no `Platform` port, no host coupling.
Koine Studio itself remains the only consumer that assembles these pieces into the actual IDE.

## Install

External consumer:

```bash
npm install @atypical/koine-ui
```

Internal monorepo consumer (this repo is an npm workspaces root with `"workspaces": ["tooling/*", "website"]`):
add the package to `dependencies` with `"@atypical/koine-ui": "*"` — that's the exact syntax
`tooling/koine-studio/package.json` and `website/package.json` both use; npm's workspace symlink
resolution takes care of the rest (no `workspace:` protocol needed on this npm 11.16.0 setup).

## The mandatory `styles.css` import

Every component and the design tokens rely on `var(--koi-*)` custom properties resolving from an
ancestor element. Importing the JS entry point alone does **not** pull in any CSS (see the
side-effect-import note in `src/index.ts`) — you must import the stylesheet **once**, typically at
app boot:

```ts
import '@atypical/koine-ui/styles.css';
```

Without it, components render unstyled/broken. `styles.css` bundles two files:

- `tokens.css` — the `--koi-*` custom properties: fonts, radii, shadows, the z-index layering
  scale, and the full color/theme palette (including the DDD-aware hues used for context-map/
  aggregate accents).
- `components.css` — the CSS for the five presentational components below.

### Theming

Tokens ship **two themes**, matching Koine Studio's own mechanism unchanged:

- `:root` is the dark theme (the default).
- `html[data-theme='light']` redefines every `--koi-*` theme token for light.

Flip the active theme by setting `document.documentElement.dataset.theme = 'light' | 'dark'` —
this re-themes every `@atypical/koine-ui` component, and (because it's just CSS custom properties)
any consumer CSS built on the same `--koi-*` tokens re-themes for free too.

## `preact` peer dependency

`preact` (`^10`) is a **peerDependency**, not a bundled dependency — you must install it yourself.
This is the standard "Preact singleton" rule: hooks and context break if two copies of Preact end
up in the module graph (each copy has its own internal hook-state map), so the package leaves
Preact resolution entirely to the consumer instead of vendoring its own copy.

## Public API (`src/index.ts`)

```ts
import { KOINE_UI_VERSION, /* … */ } from '@atypical/koine-ui';
```

- `KOINE_UI_VERSION` — the package version as a string constant.

**Framework-free DOM/utility primitives** (no Preact dependency — plain DOM/JS, usable from any
framework or none):

| Export | What it does |
| --- | --- |
| `el()` | A typed, minimal DOM builder (`el(tag, options?, children?)`) — collapses the `createElement` + `className =` + `setAttribute` + `addEventListener` quartet into one expression. |
| `createFloatingMenu()` (`FloatingMenuItem`, `FloatingMenuConfig`, `FloatingMenuOpenOptions`, `FloatingMenu`) | The shared floating "popup menu" engine: builds a `<ul role="menu">`, positions it (anchored under a trigger, or at an explicit viewport point for a context menu), dismisses on outside-pointerdown / Tab / Escape, and runs Arrow/Home/End keyboard nav. |
| `registerOverlay()`, `visibleFocusables()`, `FOCUSABLE_SELECTOR`, `createModal()`, `createConfirmDialog()`, `createPromptDialog()`, `koiConfirm()`, `koiPrompt()` | Shared overlay infrastructure: a z-order Esc-stack (so a single Escape closes only the top-most open overlay) plus the common `.koi-modal*` chrome — backdrop, header/body/footer, backdrop-click-to-close, and focus capture/restore/trap. |
| `createCommandRegistry()` (`Command`, `CommandRegistry`) | A DOM-free, host-agnostic command registry — the single source of truth for the `Command` interface that the palette, toolbar, and keymap all read from. |
| `createCommandPalette()` (`PaletteHandle`) | A Cmd/Ctrl-K style command palette overlay that self-mounts to `document.body`; filters commands by case-insensitive subsequence match, wraps on Up/Down, and defers Esc handling to the shared overlay stack. |

**Store-free presentational Preact components** (each takes plain props/callbacks — no store, no
host coupling):

| Component | What it does |
| --- | --- |
| `DeckCard` | One surface card on a "deck" stage: a header (icon + label + facet sub-strip + tag + close) over a host-agnostic body slot (a re-parented `HTMLElement` via ref, or `children` for stories/tests). |
| `DeckBar` | The slim bar above a deck stage: an Overview toggle, a generic surface filmstrip (surfaces passed in as a prop, not hardcoded), and a keyboard hint. |
| `ExportMenu` | The diagram "Export ▾" floating menu — a native `<details>` disclosure offering SVG / PNG / PlantUML export plus "copy Mermaid source". |
| `AssistantView` (+ `ASSISTANT_MOUNT_CLASS`) | A thin Preact host that renders a single mount node once and never re-renders it, so a host can attach an imperative AI-chat panel into it without Preact and the panel fighting over reconciliation. |
| `LeftRail` | A left sidebar's markup as a Preact component: a labelled Domain·Files axis switch over one navigator host, rendered once so imperative children mounted into it are never reconciled away. |

Each component's own doc comment (at the top of its `.tsx` file) has the full design rationale,
including what was deliberately generalized when it was extracted from Koine Studio (e.g.
`DeckBar`'s `surfaces` prop replaces a hardcoded app-specific surface registry).

## What stays out of this package

Store-coupled and host(Tauri)-coupled panels — `PropertiesPanel`, `SourceControlPanel`,
`DeckStage`, `HistoryControls`, `WorkspaceProblemsBadge`, and similar — intentionally **stay in
Koine Studio** (`tooling/koine-studio/src/**`). They depend on the Zustand store and/or the
`Platform` host port, which this package deliberately does not take a dependency on. Extracting
them (behind an injected data/callback API instead of a direct store subscription) is a candidate
for a **follow-up issue**, not this one.

## Development

From `tooling/koine-ui/`:

```bash
npm run build              # tsc && vite build → dist/index.js, dist/index.d.ts, dist/styles.css
npm test                   # vitest run (or `npx vitest run`)
npm run test:watch         # vitest watch mode
```

Browse the component catalogue with Storybook:

```bash
npm run storybook          # dev server on :6007
npm run build-storybook    # static build → storybook-static/
```
