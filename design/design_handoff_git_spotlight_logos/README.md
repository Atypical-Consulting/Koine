# Handoff: Git (Source Control) Panel · Command Launcher (Spotlight) · Logo assets

## Overview
Three deliverables to implement in the Koine Studio app:

1. **Source Control panel** — the right-rail git view: branch/sync bar, commit composer, staged/changes/untracked file groups with per-row diffs, and a recent-commits log.
2. **Command Launcher ("Spotlight")** — a full-screen ⌘K command bar over the studio: fuzzy search across the domain model (symbols, events, rules, files, glossary, commands, commits), prefix modes, grouped results, a live preview pane, per-result quick actions, and a ⌘K action menu.
3. **Logo assets** — the Koine hexagon-κ mark in four variants (accent, white, ink, icon tile).

## About the design files
The HTML/JS files in this bundle are **design references created in HTML** — prototypes that show the intended look and behaviour. They are **not** production code to ship as-is. The task is to **recreate these designs in the existing app codebase** — **Preact + Vite** (`tooling/koine-studio`) — using its real components and the existing `--koi-*` / `--lang-*` design tokens (`src/styles/themes/`), never hardcoded values.

For the Source Control panel, the codebase **already has the real component** — `SourceControlPanel.tsx` (its compiled Preact source + Storybook stories are included here as `source-control-panel.reference.js`). Treat the HTML prototype as the **visual/interaction target** and the existing component as the **behavioural + data contract** to converge on.

The SVGs are commit-ready assets — copy them into the repo directly.

## Fidelity
**High-fidelity.** Colours, typography, spacing, and radii are final and expressed as `--koi-*` tokens (see **Design Tokens** below; full source in `tokens.css`). Exact SVG glyph paths are embedded in the prototype HTML.

---

# 1 — Source Control (git) panel

**Prototype:** the right rail of `Koine Studio Chrome v3.html` (already showing the panel).
**Real component contract:** `source-control-panel.reference.js` (`SourceControlPanel` + its stories).

## Data contract (from the real component)
The panel is driven by a `git` gateway object + a `folderToken` string. Props:
- `git` — `{ canUseGit: boolean, gitStatus(token), gitLog(token), gitBranches(token), gitStage(token, paths[]), gitUnstage(token, paths[]), gitCommit(token, message), gitCheckout(token, branch), gitDiff(token, relPath, staged) }`.
- `folderToken: string`, `refreshNonce?`, `dirtyCount?: number`, `onSaveAll?: () => Promise<void>`.

Status shape: `{ branch: string, files: { relPath: string, staged: boolean, status: 'modified'|'added'|'deleted'|'renamed'|'copied'|'untracked'|'conflicted' }[] }`. Log item: `{ sha, author, date (ISO), message }`.

Status glyphs / labels: `M` modified · `A` added · `D` deleted · `R` renamed · `C` copied · `U` untracked · `!` conflicted.

## States (all in the real component)
- **Browser (no git):** `git.canUseGit === false` → empty state "Source control is available in the desktop app — Git is unavailable in the browser."
- **Not a repo:** `gitStatus` throws → empty state prompting `git init`.
- **Loading:** status `null` → "Loading changes…".
- **Clean tree:** no files → "No changes — the working tree is clean." (log still shown).
- **Dirty tree:** file groups + composer + log.

## Layout (top → bottom)
Panel is a 320px column: `border-left:1px solid var(--koi-line); background:var(--koi-paper)`.

**Header** (`.right-header`, min-height 36px, `background:var(--koi-paper-2)`, bottom border): title **"Source Control"** (11px / 600 / uppercase / `letter-spacing:.06em` / muted) + right actions (`.hdr-ico`, 26px ghost): **Refresh** (spins 360° on click) and **overflow** (⋮).

**Body** (`.right-body`, scrollable, `padding:14px 14px 24px`):

1. **Branch + sync bar** (`.sc-branchbar`, flex, gap 8, margin-bottom 14):
   - `.sc-branch` — git-branch glyph + branch name (`main`) + double-chevron caret. `height:30px; background:var(--koi-surface); border:1px solid var(--koi-line); border-radius:var(--koi-radius-sm)`; 13px / 600. Hover → accent-tinted border. In the real component this is a `<select>` of `gitBranches` bound to `gitCheckout`.
   - `.sc-sync` — mono ahead/behind counts (`↑2 · ↓0`, ahead in `--koi-accent`) + refresh glyph. Title "Push N commits to origin/main".

2. **Commit composer** (`.sc-composer`) — bordered card on `--koi-surface`, radius 10px (`--koi-radius-lg`). **focus-within** → border `--koi-accent` + 3px accent focus ring.
   - `textarea` — placeholder "Message (what changed and why)", 13px, min-height 58px, no resize. (`aria-label="Commit message"`.)
   - Foot (`.sc-composer-foot`): **split commit button** — primary `.sc-commit-btn` "Commit to main" (accent bg, `--koi-on-accent`, 600) with inline **⌘⏎** keycap + a `.sc-commit-caret` for commit options. **Disabled** (dimmed, non-interactive) until ≥1 **staged** file **and** a non-empty message.
   - **Save-before-commit guard** (real component): if `dirtyCount > 0` and `onSaveAll` exists, committing first opens a confirm dialog ("Save changes before committing?" → "Save all & commit"). Git commits what's on disk, so unsaved editor buffers must be flushed first.

3. **Staged group** (`.sc-group.staged`, `#sc-staged`) — hidden when empty. Header toggle "Staged" + accent-tinted count pill; hover reveals **Unstage all**.

4. **Changes group** (`#sc-changes`) — header "Changes" + count pill; hover reveals **Discard all** (danger) + **Stage all**. Below it an **Untracked** group follows the same pattern. File row (`.sc-file`):
   - Status glyph (`.sc-glyph`): **M** → `--koi-accent`, **A** → `--koi-hl-string` (green), **D** → `--koi-error`.
   - `.sc-file-open` — filename (`.sc-name`, hover → accent) + dir (`.sc-dir`, muted 11px). Click toggles an inline diff (`gitDiff`), rendered as a `<pre class="koi-sc-diff">`.
   - `.sc-stat` — mono `+n / −n` (add green, del red); **hidden on row hover**, replaced by `.sc-row-actions`: **Open changes** (eye), **Discard** (danger ×), **Stage** (＋, accent hover). Staged rows show **Unstage** instead.

5. **Recent commits** (`#sc-recent`) — header "Recent commits" + **View all**. Log item (`.sc-log-item`): round mono **avatar** (author initials, accent-tinted) + message (`.sc-log-msg`, 12.5px, ellipsis) + meta (`.sc-log-meta`): short SHA (`sha.slice(0,7)`, `code`) · author · relative date. Real component shows `log.slice(0, 10)`.

## Interactions
- **Stage / Unstage** (single + all) move rows between groups, rebuild that row's hover actions, recompute counts; staged group auto-shows/hides.
- **Commit** enabled only when staged > 0 **and** message non-empty; label reads "Commit N files to main". **⌘⏎** in the textarea commits. On success, clears staged rows + message and reloads status.
- Group headers collapse/expand (chevron rotates −90° collapsed). Refresh re-fetches status + log + branches; the button spins.
- Every mutation (`stage/unstage/commit/checkout`) goes through the component's `mutate()` wrapper: set busy → await op → reload; on error set `actionError` (shown as a `role="alert"` line).

## Tool-window spine (`.rstrip`, 42px)
Sits to the right of the panel — the IDE activity bar analogue that chooses which tool window fills the 320px column. Column, centered, gap 4, `background:var(--koi-paper-2)`, left border. Buttons (`.rstrip-btn`, 30px ghost, 16px glyph): **Properties**, **Assistant**, hairline separator, **Source Control**. Active button (`.on`) → `color:var(--koi-fg); background:color-mix(in srgb, var(--koi-accent) 16%, transparent)` + a 2px `--koi-accent-grad` marker on its left edge.

---

# 2 — Command Launcher ("Spotlight")

**Prototype:** `Koine Launcher - Spotlight.html` (opens with the launcher already open over a static studio backdrop). All styles are in that file's `<style>`; all data + logic in **`koine-launcher.js`** (`window.KoineLauncher`).

## Structure
A centered overlay (`.lx-scrim`, `z:var(--koi-z-modal)`) with a blurred dark scrim, opening ~15vh from top. The card (`.lx`) is 720px (→ **980px** when a preview pane is showing, `.has-preview`), `background:color-mix(in srgb, var(--koi-paper-2) 94%, transparent)` with `backdrop-filter: blur(20px)`, `border-radius:var(--koi-radius-lg)`, big drop shadow. Top → bottom:

1. **Input row** (`.lx-inrow`, 58px) — search glyph, an optional **mode pill** (`.lx-modepill`, accent-tinted, with a clear ×), the text `input` (18px, body font), a result **count**, and an `esc` keycap.
2. **Body** (`.lx-body`, 460px) — **results list** (`.lx-results`, flex:1; becomes `flex:0 0 540px` with a right border when a preview shows) + **preview pane** (`.lx-preview`, flex:1, hidden until `.has-preview`).
3. **Footer** (`.lx-footer`, 40px) — key hints (↑↓ navigate · ↵ open · ⌘K actions · tab fill) and a mode **legend** of chips (`.lx-mchip`).
4. **⌘K action menu** (`.lx-actmenu`) — floating popover, bottom-right, listing the selected result's actions.
5. **Toast** (`.lx-toast`) — bottom-center confirmation after running an action.

## Prefix modes (`KoineLauncher.MODES`)
Typing one of these as the **first character** filters to a category and shows the mode pill:
- `>` **Commands** · `@` **Symbols** · `#` **Events** · `/` **Files** · `:` **Glossary** · (no prefix = **All**).

## Result groups (`KoineLauncher.GROUPS`, in order)
Commands · Domain symbols · Events · Rules & states · Files · Glossary · Recent commits.

## Result row (`.lx-item`, height from density tweak, default 46px)
- **Glyph / kind chip:** domain symbols & events get a 2-letter **kind chip** (`.lx-kind`, colored by `--koi-ddd-*`, e.g. `AR` aggregate, `VO` value, `EM` enum, `EV` event, `IE` integration event, `CM` command, `QY` query, `EN` entity, `SV` service, `RP` repository). Other categories get a line-icon glyph (`.lx-glyph`).
- **Title** (14px) with fuzzy-match `<mark>` highlights (accent, 700) + **sub** (11.5px muted, may include a `·`-separated context).
- **Tail:** command keycap, file diff stat (`+4 −1`), or commit short-hash; plus a quick-action button on the selected row.
- Selected row (`.sel`): accent-tinted bg + a 2.5px `--koi-accent-grad` left bar.

## Live preview pane
When the selected result has a `preview()` (auto mode) — or always/never per the tweak — the pane renders a rich card: header (kind chip + name + sub), file path, a syntax-highlighted **code block**, a **meta grid** (`Kind / Context / Members / Emits / Invariants / …`), and category extras — a **state-machine** row for enums/aggregates, a **payload field list** for events, a **diff** for changed files, **glossary** definitions with "appears in" pills, **rule** expressions, **commit** file lists. All preview builders are in `koine-launcher.js` (`symbolPreview`, `eventPreview`, `actionPreview`, `filePreview`, `glossPreview`, `rulePreview`, `transitionPreview`, `commitPreview`).

## Per-result quick actions (`KoineLauncher.actionsFor`)
Each category exposes an ordered action list `[label, keycap, iconPath]`; the first is the default (↵). Examples: symbol → Go to definition ↵ / Find usages ⇧↵ / Peek ⌥↵ / Rename F2 / Copy name ⌘C. File → Open / Open changes / Reveal / Copy path. Commit → View / Copy hash / Revert. The **⌘K** menu lists them all; ↵ runs the default.

## Fuzzy ranking (`KoineLauncher.fuzzy` / `rank`)
Subsequence match with bonuses: **+3** consecutive, **+4** word-boundary, **+3** camelCase hump, **+12** prefix, minus a length penalty for loose matches. Titles are matched first (with highlight ranges); a secondary pass matches `keywords + ctx + sub` at 0.4× score with no highlight. Empty query → a curated **Top hits** + **Recent** default set.

## Keyboard
- **⌘K / Ctrl+K** — open; when open, toggle the action menu.
- **↑ / ↓** — move selection (wraps). **↵** — run default action. **Tab** — fill input with the selected title (prefixed by the active mode). **Esc** — clear query, else close. Mouse move selects; click runs default. In the action menu, ↑↓ + ↵ + Esc operate on it.

## Tweaks (prototype `<script>`, `#tw` panel — a spec, not a shipping surface)
The prototype persists a `koine-launcher-tweaks` localStorage object: `preview` (auto/on/off), `grouping`, `density` (compact/cozy/comfy → item height 40/46/54), `modes` on/off, `actions` on/off, `accent` swatch, `theme` (dark/light). These map to product settings/behaviour — not a required UI.

---

# 3 — Logo assets (`logo/`)
The Koine mark: a lowercase kappa inscribed in the hexagon of ports-and-adapters. Geometric, single-ink, drawn on a 120×120 grid, no font dependency — commit-ready SVGs.

| File | Use | Stroke |
|---|---|---|
| `koine-mark.svg` | Primary mark, transparent bg | accent `#5aa9ff` |
| `koine-mark-white.svg` | Reverse — for dark / accent surfaces | white `#ffffff` |
| `koine-mark-ink.svg` | Mono — for light backgrounds | ink `#1c2230` |
| `koine-icon-tile.svg` | App icon — mark on a rounded accent tile (rx 28, fill `#5aa9ff`, mark in `#08111f`) | — |

Geometry (all variants): hexagon `polygon points="106,60 83,99.84 37,99.84 14,60 37,20.16 83,20.16"` (stroke-width 6); κ = three strokes at stroke-width 7.5 (`M48 36 V84`, `M48 60 L78 36`, `M48 60 L78 84`), `stroke-linejoin/linecap: round`.

**In-app use:** the top-bar brand tile uses the mark on an accent chip via `<use href="#kmark">` (see the `#kmark` symbol in the Spotlight prototype's inline SVG defs). Suggested repo home `tooling/koine-studio/src/assets/brand/`. Favicon: point at `koine-mark.svg` (or `koine-icon-tile.svg` for a filled tile). Recolour by setting `stroke` — light theme accent is `#2f7fe0`.

---

## Design Tokens (full source: `tokens.css` — dark default + `html[data-theme='light']`)
Use the `--koi-*` custom properties; never hardcode. Key values used here (dark):
- **Surfaces:** paper `#0e1117` · paper-2 `#161b22` · surface `#1c2230` · line `#2a3242`.
- **Text:** fg `#d6dde8` · muted `#7d8694` · ink-soft `#aeb8c6`.
- **Accent:** `--koi-accent #5aa9ff` (light `#2f7fe0`) · on-accent `#08111f` · cyan `#34d3c4` · `--koi-accent-grad` = 135° accent→cyan.
- **State:** error `#ff6b6b` · added = `--koi-hl-string #7ee787` · deleted = `--koi-error` · modified/ahead = `--koi-accent`.
- **Radius:** 2xs 2 · xs 4 · sm 6 · base 8 · lg 10 · pill 999. (Note: the prototype's `.sc-composer` uses `var(--koi-radius-md, 10px)` — **`--koi-radius-md` is not a real token**; use `--koi-radius-lg`.)
- **Motion:** `--koi-dur-fast .12s` · `-base .14s` · `-mid .15s` · `-slow .18s`.
- **Z-index:** modal 100 · popover 120 · toast 300.
- **Fonts:** body = Hanken Grotesk · display = Archivo · mono = JetBrains Mono (self-hosted variable fonts, `fonts/fonts.css`).
- **DDD kind palette** (launcher kind chips + diagram nodes): aggregate `#8b87f5` · entity `#34d399` · value `#5aa9f0` · enum `#fbbf24` · event `#f472b6` · integration-event `#2dd4bf` · service `#fb923c` · repository `#94a3b8` · command `#ef4444` · query `#38bdf8` · state-machine `#06b6d4`.
- **Syntax:** keyword `--koi-hl-keyword` · type `--koi-hl-type` · string `--koi-hl-string` · number `--koi-hl-number` · comment `--koi-hl-comment` · property `--koi-hl-sem-property`.

## Assets in this bundle
- `Koine Launcher - Spotlight.html` — Spotlight prototype (open in a browser; opens on load).
- `koine-launcher.js` — the launcher's catalog, fuzzy ranking, modes, preview builders, actions (`window.KoineLauncher`).
- `Koine Studio Chrome v3.html` — studio shell prototype; the right rail is the Source Control panel + tool-window spine.
- `source-control-panel.reference.js` — compiled Preact source + Storybook stories for the **real** `SourceControlPanel.tsx` — the behavioural + data contract to converge on.
- `tokens.css` — the full `--koi-*` / `--lang-*` token source (dark + light).
- `logo/*.svg` — the four brand mark variants.

> **Rendering the prototypes:** both HTML files reference the app's root `styles.css` (which `@import`s `fonts/`, `tokens.css`, and the compiled `_ds_bundle.css`). To view them outside the project, point that `<link>` at the app stylesheet, or drop `tokens.css` + the font files beside them. The `Chrome v3.html` left rail loads `railframes/*.html` iframes that aren't in this bundle — the right-rail panel (the deliverable) renders regardless.

## Real source to edit (Preact + Vite, `tooling/koine-studio`)
- Source Control: `src/model/SourceControlPanel.tsx` (+ its SCSS under `src/styles/`).
- Launcher: recreate as a Preact command-palette component; port the catalog/ranking/preview logic from `koine-launcher.js`, wired to the real model index + git store.
- Tokens: `src/styles/themes/{_dark,_light}.scss`, `abstracts/_ddd.scss`. Brand SVGs → `src/assets/brand/`.
