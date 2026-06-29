# Preact migration recipe (Studio chrome)

> Status: **in progress** (#759, finishing the #193 foundation). This doc is the contract for migrating
> the remaining imperative-DOM islands in Studio's chrome onto Preact, one panel at a time.

## Why

Studio's interactive chrome was historically rendered three ways at once:

1. **Static markup** in `tooling/koine-studio/index.html` (panel shells — `#leftrail`, `#right-strip`,
   the `rview-*` right-rail hosts, the diagnostics/output tabpanels).
2. **Imperative DOM** — `innerHTML` / `document.createElement` string-assembly in `src/shell/*.ts`
   (e.g. the string builders `leftRailMarkup()` / `rightStripMarkup()`).
3. **Preact islands** — real `.tsx` components rendered with Preact `render()`, subscribing to the
   Zustand store via `useAppStore` (`src/store/hooks.ts`).

The imperative + static halves are where the bugs leak in (drifting `aria-*`/ids hand-maintained in
string markup; unfinished surfaces shipped as empty voids or "Coming soon." placeholders). The
direction is **monotonic toward Preact**: every migrated surface becomes a declarative subscriber of
the store, typed and axe-tested. Coexistence of paradigms *during* the rollout is acceptable.

## The reactive center and the seams (do not move these)

- **Zustand store** (`src/store/index.ts`, `createAppStore()` + the singleton `appStore`) is the
  reactive center. Migrated panels read state through `useAppStore(store, selector)` (`src/store/hooks.ts`)
  instead of querying the DOM and re-templating strings.
- **Host seam** (`src/host/`) stays the imperative I/O boundary (Tauri / browser-WASM). Panels read
  host capabilities **through the store**, never by reaching into `src/host` directly.

## Non-goals — surfaces that STAY imperative

- **CodeMirror** (the editor) and **maxGraph** (the domain canvas, #66) are imperative-by-design
  islands that own and mutate their own DOM/lifecycle. We may wrap them in a thin Preact host that
  mounts/unmounts them, but we do **not** re-render their internals through Preact. Do not "migrate" them.
- The **`src/host/` seam** stays imperative.

## Per-panel recipe (6 steps)

1. **Find the imperative mount.** Locate the `innerHTML` / `createElement` site in `src/shell/*.ts` (or
   the string builder) and the state the panel reads.
2. **Write the story + axe test FIRST (red).** A `Panel.stories.tsx` (`@storybook/preact-vite`, seed
   with `createAppStore()`) and a `Panel.test.tsx` with an `expect(await axe(container)).toHaveNoViolations()`
   assertion. a11y is verified, not hoped for.
3. **Implement `Panel.tsx`.** A Preact component taking `{ store }` (and any callbacks), subscribing via
   `useAppStore(store, selector)`. Move the markup off the string builder into JSX with proper
   `aria-*`/ids. **Preserve every id the controllers query** (or update the controller in the same task).
4. **Replace the imperative mount** with a single `render(<Panel store={appStore} … />, host)` at the
   existing host id. For a panel that *governs* a static index.html element (rather than owning a
   subtree), follow the `UnsavedIndicator` pattern: subscribe in a `useEffect`, drive the host node
   directly, and `return null` — so Preact and the imperative DOM never fight over the same node.
5. **Green.** `npx vitest run --project '!storybook'` (unit + axe). The Storybook/Chromium project runs
   in CI (`.github/workflows/koine-studio.yml`); don't expect it to run headless locally without Chromium.
6. **Commit.** One panel per task/PR; a panel never changes observable behavior (same ids, same affordances).

## Gating incomplete surfaces — `panelGate`

A surface that is not yet ready for users must be **hidden**, not shipped as an empty void or a
"Coming soon." placeholder. Use the capability gate (`src/shell/panelGate.ts`):

```ts
import { panelEnabled } from '@/shell/panelGate';

if (panelEnabled('my-surface')) {
  // render the real panel
}
// otherwise render nothing (hidden) — never a bare placeholder
```

`panelGate` is **default-closed and fail-closed**: a capability is hidden until explicitly enabled, and
a storage failure reads as hidden. In a **dev build** (`isDevMode()`), a gated panel is forced visible so
the developer building it can see it without flipping a flag. It reuses the throw-safe `PersistedFlag`
(`src/shell/localStorageFlag.ts`) — no new storage primitive. Enable a capability for a session with
`panelGate('my-surface').enable()` (writes `koine.studio.panel.my-surface`).

## Inventory of imperative islands (grouped)

> Updated as the migration proceeds (Task 8 re-runs the census). The `src/shell` `innerHTML` /
> `createElement` count is the headline metric.

- **Already Preact (reference patterns — do not redo):** `HistoryControls`, `UnsavedIndicator`,
  `CompilingIndicator`, `MobileZoneBar`, `StoreInspector`, `inspectorSheet`; `src/model/PropertiesPanel`,
  `RelationshipsPanel`, `EventsPanel`, `GlossaryPanel`, `ModelOutlinePanel`, `ContextBreadcrumb`,
  **`SourceControlPanel`**; `src/docs/DocsPanelHost`; the export menu (Preact JSX in
  `src/diagrams/CanvasPalette.tsx`).
- **Resolved by prior work (no longer placeholders):** the right-rail **Rules** / **Notes** tabs were
  retired in #730 (invariants now surface in Properties; model Notes live in the center Deck's Docs
  surface); the **Compatibility** `view-check` paints a real "Check against baseline…" idle state.
- **To convert (this issue):** the **right strip** (`rightStripMarkup()` in `src/shell/rightStrip.ts`),
  the **left rail** (`leftRailMarkup()` in `src/shell/leftRail.ts`), the **AI Chat** `view-assistant`
  host (imperative `src/ai/aiPanel.ts`).
- **Stay imperative (non-goals):** CodeMirror, maxGraph, the `src/host/` seam, and the global
  export-menu dismissal seam where it remains a document-level listener.
