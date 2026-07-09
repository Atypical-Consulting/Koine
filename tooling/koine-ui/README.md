# @atypical/koine-ui

Framework-free design tokens and Preact UI primitives extracted from Koine Studio (issue
[#905](https://github.com/Atypical-Consulting/Koine/issues/905)). It carries the `--koi-*` design
system, the shared DOM/interaction engines those components run on, and the presentational
components that don't need a store or a host (Tauri/browser) to render — so a second surface
(the docs-site playground, a future embed, another IDE) can reuse Koine Studio's look and
interaction patterns without pulling in the whole IDE.

This is a **store-free** package: no Zustand (or any other concrete state-management library) may
be imported here, and no `Platform`/Tauri host coupling. That doesn't mean every component is
*data*-free, though — issue [#944](https://github.com/Atypical-Consulting/Koine/issues/944) added a
generic `ReadableStore<T>` host-adapter contract (see below) so a component that DOES need live
data from a host's store can still live here, typed against the generic contract instead of Koine
Studio's concrete `AppState`. Koine Studio itself remains the only consumer that assembles these
pieces (plain and store-coupled alike) into the actual IDE.

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
| `DeckSpine` | The single 34px chrome row above a deck stage (concept-7 "Flush"): the surface switcher AND the pane title/facets/close, morphing between overview / 1-up (split-button tabs + inline facets) / 2-up (two pane-headers + a docked ⇄ swap). Surfaces are passed in as a prop, not hardcoded. |
| `ExportMenu` | The diagram "Export ▾" floating menu — a native `<details>` disclosure offering SVG / PNG / PlantUML export plus "copy Mermaid source". |
| `AssistantView` (+ `ASSISTANT_MOUNT_CLASS`) | A thin Preact host that renders a single mount node once and never re-renders it, so a host can attach an imperative AI-chat panel into it without Preact and the panel fighting over reconciliation. |
| `LeftRail` | A left sidebar's markup as a Preact component: a labelled Domain·Files axis switch over one navigator host, rendered once so imperative children mounted into it are never reconciled away. |

Each component's own doc comment (at the top of its `.tsx` file) has the full design rationale,
including what was deliberately generalized when it was extracted from Koine Studio (e.g.
`DeckSpine`'s `surfaces` prop replaces a hardcoded app-specific surface registry).

**Generic host-adapter contract** (issue #944 — lets a component read live data from a host's store
without this package depending on that store):

| Export | What it does |
| --- | --- |
| `ReadableStore<T>` | A minimal `{ getState(): T; subscribe(listener): () => void }` interface — the seam a component depends on INSTEAD of a concrete store type. Any host (Koine Studio's Zustand `StoreApi<AppState>`, a future embedding) satisfies it via its own adapter. |
| `useReadableStore(store)` | The Preact hook a component calls to subscribe to a `ReadableStore<T>`'s slice and re-render on change — the `koine-ui`-side counterpart to Zustand's `useStore(store, selector)`, without importing Zustand. |

**Store-coupled components via `ReadableStore<T>`** (issue #944's prototype targets — each takes a
`store: ReadableStore<SomeSlice>` prop instead of Koine Studio's `StoreApi<AppState>`):

| Component | What it does |
| --- | --- |
| `HistoryControls` | The top-bar Undo/Redo button pair; disabled state driven by `ReadableStore<HistoryControlsSlice>` (`{ canUndo, canRedo }`). |
| `WorkspaceProblemsBadge` | The status-bar workspace-wide problems rollup; driven by `ReadableStore<WorkspaceProblemsSlice>` (`{ kind, parts, fileCount }` — already classified AND formatted, so this package never needs Koine Studio's `LspDiagnostic` type or re-derives its pluralisation wording). |

### The host-adapter pattern — when to reach for it, and how

Two shapes exist for crossing the store/host boundary into `koine-ui`; pick per-component, not
uniformly:

1. **Props/callbacks refactor** (no `ReadableStore` involved) — when a component reads at most a
   couple of primitives that rarely change and doesn't need the "subscribe to just this slice"
   performance property, just pass already-selected values + callbacks straight through
   (`onUndo`/`onRedo` in `HistoryControls` are already this shape). Simplest option; prefer it when
   it doesn't cost you anything.
2. **`ReadableStore<T>` host adapter** — when a component needs to re-render reactively as the
   host's data changes *while mounted* (not just once at render time), use the contract above. The
   recipe, proven by `HistoryControls`/`WorkspaceProblemsBadge`:
   - **Define a narrow slice interface** in the component's own file — sized to exactly what that
     component reads (`HistoryControlsSlice`, `WorkspaceProblemsSlice`), never Koine Studio's whole
     `AppState`. If the raw host data isn't `koine-ui`-safe to depend on (e.g. Koine Studio's
     `LspDiagnostic` type), have the **host's adapter selector** pre-classify/summarise it into
     plain primitives — keep any domain classification logic (severity buckets, etc.) in its single
     owning module on the Koine Studio side, not duplicated in `koine-ui`.
   - **Component depends only on `ReadableStore<TheSlice>` + `useReadableStore`** — never the
     concrete store type, never Zustand.
   - **The host writes a small adapter** wrapping its real store to satisfy the contract. Koine
     Studio's is `zustandToReadableStore(store, selector, isEqual?)`
     (`tooling/koine-studio/src/store/readableStoreAdapter.ts`), which mirrors what Zustand's own
     `useStore(store, selector)` does internally: subscribe once to the whole store, but only notify
     when the selected slice changes under `isEqual` — preserving the "re-render only on this slice"
     property the pre-extraction direct `useStore` call had. `isEqual` defaults to `Object.is`
     (correct for a selector that returns a reference-stable value, e.g. picking one immutable field
     straight off the state); pass the adapter's `shallowEqual` (Zustand's own `shallow`) when the
     selector builds a fresh object of PRIMITIVE fields each call (`HistoryControlsSlice`); write a
     small dedicated comparator when a field is itself an array/object built fresh each call
     (`WorkspaceProblemsSlice`'s `parts: string[]` — `shallowEqual`'s one-level `Object.is` would
     never consider two content-equal-but-different-instance arrays equal, so
     `readableStores.ts`'s `problemsSliceEqual` compares `parts` element-wise instead). Keep the
     actual `zustandToReadableStore(...)` calls out of a line-budget-guarded call site (Koine
     Studio's `ide.tsx`) by giving each adapted store its own small factory function
     (`tooling/koine-studio/src/store/readableStores.ts`).
   - **Port the component's tests/stories** to mock `ReadableStore<T>` directly (a plain object with
     `getState`/`subscribe`/a test-only `set()`, see `HistoryControls.test.tsx`) instead of a real or
     fake Zustand store — `koine-ui`'s tests never construct a Zustand store. Add a host-side test
     (`tooling/koine-studio/src/store/readableStores.test.ts`) that pins the REAL wiring end-to-end
     (a real `createAppStore()`) so a change to the store's shape or a classifier is caught there.
   - **Export the component (and its slice type) from `koine-ui`'s barrel**
     (`tooling/koine-ui/src/index.ts`) — without this the component isn't importable from
     `@atypical/koine-ui` at all; easy to forget since none of the steps above touch `index.ts`.
   - **Port any CSS the component's class names need** into `tooling/koine-ui/src/components.css`,
     **copying rather than moving** the source rules from Koine Studio's SCSS partials when those
     class names are also used by other, non-migrating panels (the common case — chrome classes like
     button/badge/group styling tend to be shared). Copying keeps Studio's own SCSS untouched (zero
     regression risk for what stays behind) at the cost of the two stylesheets needing to be kept in
     sync by hand if that shared rule ever changes. Check every class name the moved markup renders,
     including ones on child elements like icons (`HistoryControls`' `.tb-ico` SVG glyphs were missed
     in this PR's first pass — masked inside the full app, since both stylesheets load together, but
     it would have rendered unstyled in this package's own Storybook, the first real signal a
     standalone consumer would have caught).

## What stays out of this package

Deeply Tauri/desktop-only-capability panels — e.g. the terminal panel
(`tooling/koine-studio/src/shell/terminal/terminalPanel.tsx`, gated on `Platform.canRunShell`) —
are **permanent exclusions**: they have no meaningful behavior on a host without that capability, so
there's no generic contract worth designing for them.

The remaining store/host-coupled panels not yet migrated (`PropertiesPanel`, `SourceControlPanel`,
`DeckStage`, `StoreInspector`, `UnsavedIndicator`, `DiagnosticsStripPanel`, `CanvasPalette`,
`DocsPanelHost`, `EventsPanel`, `GlossaryPanel`, `RelationshipsPanel`, `settingsPage`, and
`AssistantView`'s sibling panels) are candidates for a **next-tranche follow-up** using the
host-adapter pattern above — see issue #944's Task 1 audit comment for the full per-component
coupling breakdown and which look like the next-best candidates.

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
