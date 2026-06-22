# Koine Studio — Workspace Undo/Redo

**Date:** 2026-06-22
**Status:** Design approved, pending implementation plan
**Area:** `tooling/koine-studio`

## Summary

Add a single, unified undo/redo system to Koine Studio, surfaced as two buttons in the
top bar (plus `Cmd/Ctrl+Z` and `Cmd/Ctrl+Shift+Z`). The `.koi` **code text is the single
source of truth**: every editing surface (code editor, properties/inspector panel, visual
diagram editor) writes into the code, and undo/redo restore a previous **code state**. The
diagram, inspector, and glossary then re-derive from the restored code automatically — they
are projections, not independent histories.

Reactive enable/disable state (`canUndo` / `canRedo`) lives in the Zustand store; the undo
mechanics live in a new `historyController` module that owns the snapshot stacks.

## Goals

- One coherent undo/redo timeline across **all** edit surfaces (typing, inspector edits,
  diagram gestures, renames, cross-file structured edits).
- Buttons in the top bar with reactive enabled/disabled state, plus keyboard shortcuts.
- Correct multi-file behaviour: a structured edit that touches several buffers undoes as a
  single step that restores every affected file.
- Restored state re-derives all views (diagram/inspector/glossary) for free.

## Non-goals

- Persisting history across reloads (history is in-memory, session-scoped).
- Preserving history across structural file operations (rename/move/delete/create a file)
  — these clear the stack (see Limitations).
- A visible history timeline / "undo tree" UI. Linear past/future only.

## Background: how editing flows today

(Verified against the current code.)

- The editable document text lives in `workspaceController`'s `buffers` Map (one `Buffer`
  per open `file://` uri, each with `text` + `dirty`). The Zustand `WorkspaceSlice.buffers`
  is a read-only projection of it.
- The CodeMirror editor handle exposes `getDoc()`, `setDoc(doc)`, `applyEdits(edits)`.
  `setDoc` and `applyEdits` both **dispatch through CodeMirror**, which fires the editor's
  `onChange`. (`src/editor.ts:789`, `:803`)
- `ide.tsx`'s `onChange` handler is the universal active-buffer funnel: it calls
  `workspace.syncActiveBuffer(doc)` (writes text + flips `dirty`) and then
  `controller.onDocEdited()`, which re-derives the diagram/inspector/glossary (debounced).
  (`src/ide.tsx:376`)
- Every **structured edit** funnels through `workspace.applyWorkspaceEdit(edit)`: the active
  buffer is edited via `editor.applyEdits()` (→ `onChange`), and **other** open buffers are
  patched directly in their stored text + `lsp.syncDoc()`. (`src/workspaceController.ts:623`)
- CodeMirror currently has its own built-in `history()` + `historyKeymap` extension
  (`src/editor.ts:752`, `:769`). **This is removed** (see Decisions) so there is exactly one
  undo stack.

These two seams — `onDocEdited` (re-derive views from code) and `applyWorkspaceEdit`
(structured-edit choke point) — are what make a clean snapshot-based history possible.

## Decisions

1. **Single unified timeline.** CodeMirror's internal `history()` / `historyKeymap` are
   removed from the editor extensions. The new workspace history is the one and only undo
   stack, so `Cmd+Z` behaves identically whether the last edit came from typing, the
   inspector, or the diagram.
2. **Per typing-burst granularity.** Typing is coalesced into history steps via a short idle
   debounce and natural boundaries (blur, file switch, save, just-before a structured edit).
   In-editor typing undo steps back by a burst, not by a single keystroke. This is the
   accepted trade-off for a single clean timeline.
3. **Snapshot the whole open buffer set** per step (`{ activeUri, docs: { uri: { text,
   dirty } } }`). `.koi` files are small and unchanged buffers share their existing string
   instances, so memory is negligible; depth is capped (~100 steps) as a backstop.
4. **History truth in a controller, reactive flags in the store.** Mirrors the existing
   `workspaceController` → `WorkspaceSlice` split: the controller owns the stacks and
   mechanics; a `historySlice` exposes only `canUndo`/`canRedo` for the UI to subscribe to.
5. **Clear history on structural file ops.** Snapshots key on `file://` uris; rekeying them
   across a rename/move/delete is out of scope, so those operations reset the stack.

## Architecture

Three pieces, each matching a pattern already in the codebase.

### `historyController.ts` (new — owns the truth)

A factory `createHistoryController(deps)` mirroring `createWorkspaceController`. Internal
state:

- `past: Snapshot[]` — states we can return to.
- `present: Snapshot` — the last committed snapshot (the baseline).
- `future: Snapshot[]` — states we can redo into.
- `isRestoring: boolean` — guards the restore's own `onChange` from re-capturing.
- a debounce timer handle for typing coalescing.

```ts
interface Snapshot {
  activeUri: string;
  docs: Record<string, { text: string; dirty: boolean }>;
}
```

Public surface:

- `noteEdit(opts?: { immediate?: boolean }): void` — called on every real edit. With
  `immediate` (structured edits) it flushes any pending typing commit and commits the
  current state at once; otherwise it (re)arms the debounce. A commit pushes the prior
  `present` to `past`, sets `present` to the current snapshot, clears `future`, caps depth,
  and republishes `canUndo`/`canRedo`.
- `undo(): void` / `redo(): void` — flush any pending typing commit first, then move one
  step (`future.unshift(present)` / `past.push(present)`), set the new `present`, and
  `restore(present)`.
- `reset(): void` — clear all stacks + timer, snapshot the current buffers as the new
  `present` baseline, republish (`canUndo=canRedo=false`).
- `captureBaseline(): void` — re-seed `present` from the current buffers without touching
  the stacks (used right after a workspace finishes opening).

Injected deps (DI, like `workspaceController`):

- `buffers(): Map<string, Buffer>` and `activeUri(): string` — read current state.
- `editor: { getDoc, setDoc }` — write the active buffer.
- `lsp: { syncDoc(uri, text) }` — keep the server in sync for non-active buffers.
- `activateFile(uri): void` — focus the file a restore changed (from `workspaceController`).
- `onRestored(): void` — the view-refresh seam; `ide.tsx` wires this to
  `controller.onDocEdited()` + `renderTree()`.
- `publish(state: { canUndo: boolean; canRedo: boolean }): void` — writes into the store
  slice.

**Capture flow.** On a real edit, `ide.tsx`'s `onChange` calls `history.noteEdit()` (debounced)
unless `history.isRestoring`. `applyWorkspaceEdit` calls `history.noteEdit({ immediate: true })`
after applying, so each structured/cross-file edit is one discrete step (the active-buffer
`onChange` that fired during it just (re)armed the debounce, which the immediate commit then
supersedes).

**Restore flow** (`restore(snap)`):

```text
isRestoring = true
for each (uri, { text, dirty }) in snap.docs:
    buf = buffers.get(uri); if missing → skip
    if buf.text !== text:
        buf.text = text
        if uri === activeUri: editor.setDoc(text)   // fires onChange; capture suppressed
        else:                 lsp.syncDoc(uri, text)
    buf.dirty = dirty
if snap.activeUri !== activeUri and buffers.has(snap.activeUri):
    activateFile(snap.activeUri)                     // reveal the changed file
onRestored()                                         // re-derive views + renderTree
isRestoring = false
```

The `isRestoring` guard suppresses **history capture** only — `onDocEdited` still runs, so
the diagram/inspector/glossary re-derive from the restored code (the whole point).

### `historySlice` (Zustand store — reactive projection)

```ts
interface HistorySlice {
  canUndo: boolean;
  canRedo: boolean;
  setHistoryState(s: { canUndo: boolean; canRedo: boolean }): void;
}
```

Added to the composed store in `src/store/index.ts` alongside the existing six slices. The
controller's `publish` calls `appStore.getState().setHistoryState(...)`.

### `<HistoryControls>` (Preact island — the buttons)

A small island at `src/panels/HistoryControls.tsx`, mounted into the top bar's
`toolbar-actions` group (same island pattern and location as `src/panels/UnsavedIndicator.tsx`).
Subscribes to `canUndo` / `canRedo` via the store hook and renders two `<button>`s:

- Undo (↶) and Redo (↷) inline SVG icons, reusing the `tb-ico` / `tb-group` toolbar classes.
- `aria-label="Undo"` / `"Redo"`, `title` showing the platform shortcut.
- `disabled` bound to `!canUndo` / `!canRedo`.
- `onClick` → `historyController.undo()` / `.redo()`.

### Wiring in `ide.tsx`

- Construct `historyController` after `workspaceController` + the editor handle exist,
  passing the deps above; `publish` → `setHistoryState`.
- In the `onChange` handler: after `syncActiveBuffer` + `onDocEdited`, call
  `history.noteEdit()` unless `history.isRestoring`.
- In `applyWorkspaceEdit` (or its `ide.tsx` tail): call `history.noteEdit({ immediate: true })`.
- After a workspace finishes opening (`onFolderOpened` / new-model / shared-open):
  `history.reset()`.
- On structural file ops (`handleRename`/`handleMove`/`handleDelete`/`handleNewFile`):
  `history.reset()`.
- Register global keymap: `Cmd/Ctrl+Z` → `history.undo()`, `Cmd/Ctrl+Shift+Z` →
  `history.redo()` (and remove CM's `history()` + `historyKeymap` from `src/editor.ts`).
- Mount `<HistoryControls>` into the toolbar.

## UI / keyboard

- Buttons live in `index.html`'s `<div class="toolbar-actions">` group (a new `tb-group`),
  rendered by the `<HistoryControls>` island.
- `Cmd/Ctrl+Z` = undo, `Cmd/Ctrl+Shift+Z` = redo, app-wide (not editor-scoped), driving the
  single stack.
- Disabled buttons are not focus-trapping and carry the shortcut in their tooltip.

## Edge cases & limitations

- **Workspace swap / New model / open folder** → `history.reset()`; buttons disable.
- **Structural file op (rename/move/delete/create)** → `history.reset()`. Deliberate
  limitation: undo does not span these operations.
- **Restore targets a closed uri** → skipped (shouldn't occur given the reset-on-structural
  rule).
- **Dirty dot correctness** → snapshots carry per-buffer `dirty`, so undoing back to a
  just-saved state restores `dirty=false` and the unsaved indicator updates via `renderTree()`.
- **Depth cap (~100)** → oldest `past` entries drop; `log`/no user-facing message needed.

## Testing

Follow the existing studio test setup (Vitest, `npm test` = `vitest run`) with co-located
`*.test.ts(x)` files, and the spy-based style already used for `WorkspaceLsp` /
`WorkspaceEditor`.

- **`historyController` unit tests:** noteEdit coalescing (rapid edits → one step after
  debounce/flush); immediate commit for structured edits; undo/redo move correctly;
  `future` cleared on a new edit after undo; depth cap drops oldest; `reset` clears and
  re-baselines; `isRestoring` suppresses capture.
- **Restore correctness:** a multi-file snapshot restores text to the active buffer (via
  `setDoc`) and a non-active buffer (via `syncDoc`), restores `dirty`, and activates the
  snapshot's `activeUri`.
- **`historySlice` test:** `setHistoryState` updates `canUndo`/`canRedo`.
- **Integration-ish:** a simulated structured edit then `undo()` restores the prior buffer
  text and `onRestored` fires.

## File touch list

- `src/historyController.ts` + `src/historyController.test.ts` — new module + unit tests.
- `src/store/slices/history.ts` — new slice.
- `src/store/index.ts` — compose the slice.
- `src/panels/HistoryControls.tsx` + `src/panels/HistoryControls.test.tsx` — new island.
- `index.html` — mount point in `toolbar-actions`.
- `src/editor.ts` — remove `history()` + `historyKeymap`.
- `src/ide.tsx` — construct + wire the controller, keymap, noteEdit calls, resets, mount.
