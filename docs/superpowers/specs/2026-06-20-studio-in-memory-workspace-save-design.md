# Koine Studio — coherent dirty + save for the in-memory shared workspace

**Date:** 2026-06-20
**Scope:** frontend-only (`tooling/koine-studio/src/`). `Ast/` and the compiler are untouched.

## Problem

`importSharedWorkspace` in `ide.ts` has a fallback path taken when `platform.materializeWorkspace`
is absent or returns null. It builds an **in-memory multi-buffer workspace**: `folderMode = true`,
`folderRootToken = null`, every buffer `path: null`.

Two deferred limitations (PR #116 review):

1. **Edits never mark dirty / lost-work risk.** `onChange` gates dirty tracking on `buf.path != null`.
   Fallback buffers are `path: null`, so editing never sets `buf.dirty`; `anyDirty()`/`hasUnsavedWork()`
   stay false and the `beforeunload` guard, the Tauri close guard, and `confirmReplaceWork` (New /
   Open folder / Open example) all skip their "unsaved changes will be lost" prompt. Edits to an
   imported shared workspace can be discarded with no warning.
2. **Save routes through scratch save-as.** `saveActive` sends a `path: null` buffer through
   `saveScratchAs` (promotes only the active buffer, clears scratch); `saveAllDirtyBuffers` would
   fire one save-as dialog per dirty path-null buffer.

### Key finding that reframes the task

The Tauri (desktop) host does **not** implement the optional `materializeWorkspace` seam. So the
in-memory fallback is the path taken for **every** shared-workspace link opened on the desktop — not
a rare browser edge case. Consequently option (a)'s literal "reuse `platform.materializeWorkspace`"
cannot be the save mechanism on desktop. The universal seam that works on both desktop and Chromium
is `pickFolder` + `createFile` + `openFolderPath`.

## Decision

**Full save-to-folder** (chosen over a safety-net-only fix): fix dirty tracking so every guard warns,
AND add a real persist-to-disk action that materializes the in-memory workspace into a user-picked
folder and re-enters normal folder mode.

## Design

### Discriminator

The in-memory workspace is already uniquely identifiable from existing state:

```ts
// folder mode with no host folder behind it ⇒ the in-memory shared import.
function isInMemoryWorkspace(): boolean { return folderMode && folderRootToken == null; }
```

(Real folder mode has a non-null `folderRootToken`; scratch mode has `folderMode === false`.)

### 1. Dirty tracking (fixes limitation 1)

`onChange` becomes trackable when `buf.path != null || isInMemoryWorkspace()`. This keeps the scratch
buffer (auto-persisted to localStorage) clean while letting in-memory shared buffers go dirty. That
one change makes every existing guard fire for free: `anyDirty()`/`dirtyCount` (beforeunload + Tauri
close), `hasUnsavedWork()`'s folder branch (`confirmReplaceWork`), the title dot, and the "N unsaved"
pill. The `folderMode && becameDirty → renderTree()` path also refreshes the indicator.

### 2. `saveSharedWorkspaceToFolder()`

1. If `!platform.canOpenFolders` (non-Chromium browser) → status message steering to the existing
   **Export .koi (.zip)** command, and return. The guard already warned, so no silent loss.
2. Flush the active editor text into its buffer.
3. `pickFolder('Save shared workspace to a folder')`; cancel → return silently.
4. Snapshot every buffer's `{relPath, text}` and the active `relPath`.
5. Collision pre-check via `listKoiFiles(folder)` + `clashingRelPaths(...)`: if any target relPath
   already exists, error ("folder already contains …, choose an empty folder") and write **nothing**
   (atomic; respects the never-clobber invariant `createFile` enforces).
6. `createFile(folder, relPath, text)` for each buffer.
7. `openFolderPath(folder)` → real folder mode (real paths, clean buffers, explorer tree); then
   re-activate the previously active file by relPath. Success status.

### 3. Route the existing save entrypoints

- **Cmd-S** (`saveActive`): a path-null buffer branches — `isInMemoryWorkspace()` →
  `saveSharedWorkspaceToFolder()`; else (scratch) → `saveScratchAs` (unchanged).
- **Cmd-Alt-S / pill** (`saveAllDirty`): when `isInMemoryWorkspace()` and dirty work exists →
  `saveSharedWorkspaceToFolder()` (one action saves all), instead of one save-as dialog per buffer.

### 4. Clearer warnings

Add an in-memory branch to `confirmReplaceWork` and the Tauri close-guard message: *"This shared
workspace lives only in memory — save it to a folder first to keep your changes."*

### 5. Tests (focused, pure — matches the extract-then-test pattern)

New `src/sharedWorkspace.ts` + `sharedWorkspace.test.ts`:

- `isDirtyTrackable(buf, inMemoryWorkspace)` — pins the rule (in-memory ⇒ trackable, scratch ⇒ not).
- `clashingRelPaths(targets, existing)` — the collision pre-check; `ide.ts` consumes it.

## Non-goals / accepted trade-offs

- Save-to-folder is unavailable on non-Chromium browsers (no `canOpenFolders`); those get the guard
  warning + a steer to the .zip export. Acceptable: a workspace share reaching such a browser is rare.
- If the picked folder already contains unrelated (non-clashing) `.koi` files, `openFolderPath`
  absorbs them into the resulting workspace. Acceptable: the user chose that folder.
- The file-tree explorer renders no rows in-memory (it needs a host `folderRootToken`); the global
  pill + title dot + guards carry the unsaved-work signal. Pre-existing behavior, unchanged.
