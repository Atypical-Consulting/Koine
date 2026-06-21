# Move the destination-language selector from the toolbar to Settings → Output

**Date:** 2026-06-22
**Component:** Koine Studio (`tooling/koine-studio`)
**Status:** Design — awaiting review

## Problem

The destination language for the emitted-code preview lives in the toolbar as a fused
**split button** (`.lang-split`): the left half (`#btn-preview-run`) both *displays* the current
language and *runs* the preview, and the right half (`#btn-lang-menu`) opens a popover picker. This
is the only language control, the chosen target is **session-only** (resets to C# on every reload),
and it crowds the toolbar. We want the language to be a real, persisted preference, chosen from the
Settings dialog, with a leaner toolbar.

## Decisions (from brainstorming)

1. **Remove the toolbar control entirely** — no Preview/Run split button and no language readout in
   the toolbar. `New`, `Open`, `Generate`, and `Check` stay.
2. **Persist** the chosen language across sessions (a new field in the Settings store).
3. **Drop** the `⌘1`–`⌘4` shortcuts and the per-language command-palette entries.
4. New Settings section is named **"Output"**.
5. The picker is a **segmented control with language color dots** (reusing `.lang-dot`).
6. The Code mode's preview sub-tab is **relabelled to show the active language** (e.g. `Generated · C#`).

## How the preview is reached afterward

The emitted code is shown in the **Code** workspace mode's **"Generated"** sub-tab
(`#tech-tab-preview`), which already auto-loads on open and tracks edits live — no run button needed.
The command palette's **"Show Emitted Preview"** (`view-preview`) command stays as the quick jump.
Generate is untouched: the Generate wizard has its own "Target language" step and never read the
toolbar target.

## Scope of `currentTarget` today

`currentTarget` in `ide.ts` drives **only** the emitted preview (`lsp.emitPreview(currentTarget)` and
the preview pane's syntax-highlighting language). It is read in exactly the toolbar split-button
block. The Generate wizard uses its own independent `state.target`. So this change is well-contained.

## Design

### 1. Persistence — `src/store.ts`

- Promote the target-language type to the store as the single source of truth:
  `export type PreviewTarget = 'csharp' | 'typescript' | 'python' | 'php';` plus an ordered id list
  `export const PREVIEW_TARGETS: readonly PreviewTarget[]` for validation/iteration.
- Add `previewTarget: PreviewTarget` to the `Settings` interface and to `DEFAULT_SETTINGS`
  (`previewTarget: 'csharp'`).
- In `loadSettings()`, add one field-validation line consistent with the existing style:
  coerce `parsed.previewTarget` to a member of `PREVIEW_TARGETS`, else `DEFAULT_SETTINGS.previewTarget`
  (add a small `coercePreviewTarget()` helper alongside the existing coercers).

### 2. Settings UI — `src/prefs.ts`

- Add a new category **Output** to the rail, placed after **Editor**:
  Appearance · Editor · **Output** · Assistant · MCP · Advanced.
  - New `ICON.output` in the 16×16 line-icon idiom (a code/braces glyph).
- Add a control factory `langPicker(onSelect)` modeled on the existing `accentPicker`/`segmented`
  factories: a `role="radiogroup"` of buttons, each `role="radio"` with a `.lang-dot[data-lang=…]`
  plus the language name; single-selection; exposes `{ el, set(value) }`. Its options are a local
  `{ value: PreviewTarget; label: string }[]` list in `prefs.ts` (ids from `store`'s `PREVIEW_TARGETS`,
  display names like `C#` / `TypeScript` / `Python` / `PHP` defined here) — display strings stay out
  of the store.
- The Output panel has one row:
  `row('Language', 'The language the Generated preview emits.', langPicker.el)`.
  Selecting commits `{ previewTarget }` via the existing `commit()` path.
- Repopulate it in `populate(s)` via `langPicker.set(s.previewTarget)`.

### 3. Toolbar removal — `index.html`

- Delete the `<div class="lang-split">…</div>` (run button + caret) from `#toolbar`. The surrounding
  `tb-group` keeps the `Generate` button.

### 4. Live wiring — `src/ide.ts`

- Remove the split-button block: remove `runBtn`/`caretBtn`/`currentLabel`/`currentDot` and the
  popover functions (`openLangMenu`, `closeLangMenu`, `onLangDocPointer`, `onLangKeydown`) and their
  listeners. Retain `LANGS` but trim it to `{ id, name }` (drop the now-unused `hint`/`label` fields)
  so `setTarget()` can resolve the `<name>` for the `Generated · <name>` tab label.
- `currentTarget` initializes from `loadSettings().previewTarget` (not a hardcoded `'csharp'`).
- Replace the old `setTarget()` (which updated the toolbar button) with one that:
  - updates `currentTarget`,
  - updates the **Generated** sub-tab label to `Generated · <name>` (`#tech-tab-preview`),
  - is a no-op early-return when the value is unchanged.
- In the single `onChange` handler (the existing re-skin path, ~`ide.ts:2335`): when
  `s.previewTarget !== currentTarget`, call the new `setTarget(s.previewTarget)`, invalidate the
  cached preview (`docViewsLoaded.preview = false`), and re-emit immediately if the Generated tab is
  currently visible (`activeTech === 'preview'` && tech view visible); otherwise the next
  `selectTech('preview')` re-emits via its existing `!docViewsLoaded.preview` guard.
- Call `setTarget(currentTarget)` once at startup so the tab label reflects the persisted value.

### 5. Shortcuts & palette — `src/ide.ts`

- Remove the `mod+1`…`mod+4` branches from the global keydown handler.
- Remove the `preview-cs` / `preview-ts` / `preview-py` / `preview-php` palette commands.
  **Keep** `view-preview` ("Show Emitted Preview").
- Remove the `⌘1`…`⌘4` rows from the keyboard-shortcuts help (`helpRows()`).

### 6. Styles — `src/styles`

- `_lang-picker.scss` (the popover menu) is fully dead → delete it and its `@use` in `main.scss`.
- `_lang-split-button.scss`: the `.lang-split` / `.lang-run` / `.lang-caret` / `.lang-caret-ico`
  rules are dead. `.lang-dot` (and its `@each a.$languages` color mapping) is **reused** by the new
  segmented picker → move `.lang-dot` into the Output picker's styles in `_settings.scss` (or a small
  `_lang-dot.scss`), then delete `_lang-split-button.scss` and drop its `@use`.
- Add segmented-radio styling for the Output picker in `_settings.scss` (reuse `.koi-segmented`
  conventions; each option holds a dot + label).

## Out of scope

- The Generate wizard keeps its own target step. (Optional future touch, not included: seed the
  wizard's initial `state.target` from `previewTarget`.)

## Testing

- **store** (`tests`-side, mirroring existing store coverage): `previewTarget` defaults to `'csharp'`;
  a persisted value round-trips through `saveSettings`/`loadSettings`; an invalid stored value coerces
  back to the default.
- **prefs** (`prefs.test.ts`): the **Output** category renders with the four language options;
  selecting a non-default language fires `onChange` with a Settings object whose `previewTarget`
  matches; reopening reflects the persisted value via `populate`.
- Full `npm run` typecheck + `vitest run` stay green; no Verify/Roslyn snapshots are involved (this is
  Studio frontend only).

## Risks / notes

- After this change the language can only be changed from Settings, and the preview is reached from
  the Code tab. This is intentional per the brainstorming decisions. The `Generated · <name>` tab
  label keeps the active target visible outside Settings.
- `.lang-dot` must keep its `data-lang` color mapping intact during the move, or the picker dots lose
  their per-language hues.
