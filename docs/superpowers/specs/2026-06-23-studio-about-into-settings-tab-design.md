# Move the About dialog into Settings as a new "About" tab

**Date:** 2026-06-23
**Component:** Koine Studio (`tooling/koine-studio`)
**Status:** Design — awaiting review

## Problem

The **About** colophon is a standalone modal (`src/welcome/about.ts`, built on the shared
`createModal()` chrome). It is reached two ways: a dedicated ⓘ icon button in the top-right toolbar
(`#btn-about`, sitting right after the Settings gear) and an "About Koine Studio" command in the
palette (Help group). The toolbar already carries a Settings gear immediately beside the ⓘ button, so
two adjacent "meta" entry points crowd the toolbar. We want About to live as a tab inside the existing
tabbed **Settings** dialog, freeing the toolbar of one button while keeping a direct route for power
users.

## Decisions (from brainstorming)

1. **Drop the toolbar ⓘ button** (`#btn-about`). About is no longer a top-level toolbar control.
2. **Keep the palette command** "About Koine Studio", but repoint it to open Settings on the new
   About tab (`prefs.open('about')`).
3. **About becomes the last tab** in the Settings category rail, after Advanced:
   Appearance · Editor · Output · Assistant · MCP · Advanced · **About**.
4. **No change to the About content** — same monogram, "Koine Studio" wordmark, version chip, tagline,
   link grid (GitHub/Home/Docs/Blog), and creator credit; just re-housed inside a Settings panel.
5. **The About module is repurposed** from a modal factory into a panel-content factory, and moves
   from `src/welcome/` to `src/settings/` (it is now purely a Settings concern; `welcome/` is the
   start-screen's folder). Rationale: `prefs.ts` is already ~940 lines; inlining ~90 lines of colophon
   markup would bloat an already-large file, so the content stays in its own focused module.

## Current state (well-contained)

- `createAboutDialog()` in `src/welcome/about.ts` is imported **only** by `src/shell/ide.tsx`
  (`const about = createAboutDialog()`), wired to `#btn-about` and the palette `about` command. No
  other consumer (the welcome/start screen does not use it).
- The Settings dialog (`src/settings/prefs.ts`) builds tab panels with a local
  `panel(id, ...children)` helper (`<section class="koi-settings-panel" role="tabpanel">`) and renders
  a vertical rail from a `categories` array of `{ id, label, icon, panel }`. `selectCategory(index)`
  switches panels; `activeIndex` is preserved across opens.
- The About content already has its own stylesheet, `src/styles/components/_about.scss`
  (`.koi-about-*` classes).

## Design

### 1. Repurpose the About module — `src/welcome/about.ts` → `src/settings/about.ts`

- Move the file to `src/settings/about.ts` and update its header comment to describe a Settings panel
  rather than a modal.
- Replace the public API:
  - **Remove** `createAboutDialog(): AboutHandle` and the `AboutHandle` interface.
  - **Add** `export function createAboutPanel(): { el: HTMLElement; refresh(): void }`.
    - `el` is a container (e.g. `<div class="koi-about">`) holding the exact same children built
      today — `logo`, `wordmark`, `chip`, `tagline`, `links`, `credit` — using the same `.koi-about-*`
      classes and the same `platform.openExternal` link routing.
    - `refresh()` performs the lazy `platform.appVersion()` fetch currently in the modal's `onOpen`
      (fills the chip with `v<version>` or hides it; a failed fetch hides it). Safe to call on every
      Settings open.
- Drop the `createModal` import; keep `getPlatform`, `koineMark`, the `LINKS`/`TAGLINE`/`CREATOR_URL`
  constants and the link-building logic unchanged.

### 2. Add the About tab — `src/settings/prefs.ts`

- Import `createAboutPanel` from `@/settings/about` and build it once:
  `const about = createAboutPanel();`
- Add `ICON.about` to the `ICON` map, reusing the circle-ⓘ glyph from the old toolbar button
  (`index.html`'s `#btn-about` SVG: a circle with an `i`).
- Build the panel: `const aboutPanel = panel('about', about.el);`
- Append to the `categories` array **last** (after `advanced`):
  `{ id: 'about', label: 'About', icon: ICON.about, panel: aboutPanel }`.
- Call `about.refresh()` inside the existing `modal.onOpen(...)` so the version chip is current each
  time Settings opens.
- **Deep-link support.** Replace the returned `open: modal.open` with a wrapper:
  ```ts
  function open(categoryId?: string): void {
    if (categoryId) {
      const i = categories.findIndex((c) => c.id === categoryId);
      if (i >= 0) activeIndex = i;
    }
    modal.open();
  }
  return { open, close: modal.close };
  ```
  `onOpen` already ends with `selectCategory(activeIndex)`, so setting `activeIndex` before
  `modal.open()` lands on the requested tab; existing no-arg callers are unaffected. Update the
  `PrefsHandle` interface: `open(categoryId?: string): void`.

### 3. Repoint entry points — `src/shell/ide.tsx`

- Remove `import { createAboutDialog } from '@/welcome/about'`.
- Remove `const about = createAboutDialog();`.
- Remove the `el<HTMLButtonElement>('btn-about').addEventListener('click', () => about.open());` line.
- Change the palette command from `run: () => about.open()` to `run: () => prefs.open('about')`
  (id `about`, group `Help`, title "About Koine Studio" — all unchanged otherwise).

### 4. Remove the toolbar button — `index.html`

- Delete the `<button … id="btn-about" …>…</button>` block from `.toolbar-right`. The Settings gear
  (`#btn-prefs`) and the rest of the toolbar stay.

### 5. Styles — `src/styles/components/_about.scss`

- The `.koi-about-*` content rules are **not** modal-scoped (plain class selectors; the wordmark,
  tagline, chip, and credit already center themselves), so they are reused as-is inside the Settings
  panel. The only thing the narrow modal previously supplied was a constrained width — a settings
  panel is wider. Add a thin wrapper rule for the new `.koi-about` container: a `max-width`
  (≈ the modal's content width) with `margin-inline: auto` so the 2-column link grid and centered
  text don't stretch the full panel width, plus comfortable vertical padding to match the other
  panels' rhythm. No content-class changes. Update the file's top comment from "about dialog" to
  "About settings panel".

## Out of scope

- No change to the About content, links, version-fetch behavior, or copy.
- No change to other Settings categories or to the `createModal` chrome.
- No new keyboard shortcut for the About tab (it inherits Settings' `mod+,` and the palette command).

## Testing

- **prefs** (`src/settings/prefs.test.ts`): add `describe('Settings → About panel')`:
  - the **About** category renders as the last tab and its panel contains the "Koine Studio" wordmark
    and the four project links (GitHub/Home/Docs/Blog);
  - `refresh()` (via opening with a stubbed `appVersion`) populates the version chip with `v<version>`
    and hides it when the fetch resolves empty/throws;
  - `open('about')` selects the About tab (its panel is visible, the tab is `aria-selected`).
- **ide** (`src/shell/ide.test.ts`): remove the `#btn-about` button from the toolbar fixture
  (line ~253) so the markup matches the shipped `index.html`; confirm the suite stays green with the
  button and its listener gone.
- `npm run` typecheck + `vitest run` stay green. This is Studio frontend only — no Verify/Roslyn
  snapshots involved.

## Risks / notes

- `createAboutDialog` has a single consumer (`ide.tsx`), so removing it is well-contained; a stale
  import or the `#btn-about` listener left behind would throw at startup — both are removed together.
- The version chip must keep its fresh-on-open behavior; wiring `about.refresh()` into the existing
  `modal.onOpen` preserves that (the dialog re-fetches each open, exactly as the standalone modal did).
- `koineMark()` mints a fresh gradient id per call, so the panel's monogram won't collide with the
  welcome overlay's copy — this property is retained by reusing the same builder.
