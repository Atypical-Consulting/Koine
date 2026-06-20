# Remove single-file "scratch mode" from Koine Studio

- **Date:** 2026-06-20
- **Status:** Approved (design)
- **Component:** `tooling/koine-studio` (browser + Tauri desktop hosts)
- **Motivation:** The dual-mode (scratch ↔ folder) state machine in the Studio IDE is a
  recurring source of bugs and is YAGNI now that multi-file workspaces exist. Collapse it to a
  single workspace mode.

## Problem

Koine Studio currently runs in one of two modes:

1. **Scratch mode** (`folderMode === false`) — the default boot state on *both* hosts. A single
   in-memory buffer at `SCRATCH_URI` (`file:///model.koi`) with `path: null`, no file explorer,
   auto-persisted to `localStorage` (`koine.studio.scratch`). Also the fallback whenever a real
   workspace cannot be materialized.
2. **Workspace mode** (`folderMode === true`) — a real filesystem root (`folderRootToken`). The
   populated explorer and every create/rename/delete/move operation key off opaque **fs tokens**.
   `renderTree()` early-returns when there is no real root (`folderRootToken == null`), so the
   explorer cannot render without a materialized filesystem.

The two modes, plus a third degraded "in-memory workspace" sub-state (`folderMode === true` but
`folderRootToken == null`, used when `materializeWorkspace` is unavailable), produce a tangle of
branches (`if (!folderMode)`, `folderMode ? … : …`, the `saveScratchAs` promote dance, dual
confirmation strings, asymmetric persistence) that is hard to keep correct.

## Goal

**One mode.** Studio always has a real, filesystem-backed workspace open and the explorer is always
present. "Just start typing" is preserved: boot lands the user in a **1-file workspace** containing a
seeded `model.koi`. `folderMode` (the flag) and the entire scratch code path are deleted.

### Non-goals

- The assistant/MCP **single-`source` tool wrapper** (`assistantTools.ts`, `host/tauri.ts`,
  `host/browser/tools.ts`) is a compiler-tool-call convenience, not the editor mode. It stays.
- No change to real-folder workspaces (Open folder…), the LSP, the compiler, or any other host.
- No new explorer rendering path: we deliberately do **not** teach the explorer to render from
  in-memory buffers (that would mean refactoring every fs-token CRUD handler — high-risk new code,
  the opposite of the bug-reduction goal).

## Design

Everything routes through the existing `materializeWorkspace()` → `openFolderPath()` path, which
already "reuses the ENTIRE folder-mode path with no special-casing" (`fs.ts:147-150`). The only new
concept is a **default workspace**: a persistent, host-backed folder that boot opens or creates.

### Browser host — persistent OPFS default workspace

Today `materializeWorkspace` (`host/browser/fs.ts:166`) writes into OPFS
(`navigator.storage.getDirectory()`), but it (a) wipes the dir on every open and (b) registers an
**ephemeral, non-persisted** token — fine for examples, wrong for a default workspace.

Add a sibling that backs the default workspace:

- A **fixed** OPFS directory (e.g. `default/`), **not** wiped on open.
- On boot it is **re-resolved** (re-opened) so files survive a reload — this replaces the
  `localStorage` scratch persistence.
- If the directory does not yet exist, create it and seed `model.koi` with `SEED`.

OPFS is available in all modern browsers (Chrome/Edge 86+, Firefox 111+, Safari 15.2+), i.e. a strict
superset of the Chromium-only `showDirectoryPicker` that gates real-folder open today.

### Desktop host (Tauri) — app-data default workspace

`TauriPlatform` does **not** implement `materializeWorkspace` today (it is optional in the `Platform`
interface). Implement it as a thin TS wrapper over existing Rust commands:

- Resolve `app_data_dir()` (via `@tauri-apps/api/path` or a tiny `app_data_dir` command).
- Ensure `<app_data>/Untitled/` exists; seed `model.koi` if missing
  (reuse `create_file` / `write_text_file` — `lib.rs:485` / `:367`, both already `create_dir_all`).
- Return the folder path as the token (Tauri tokens are absolute paths).

The folder persists naturally on disk.

### Boot flow (host-agnostic, in `ide.ts`)

```
1. shared link in URL hash?
   - kind:'workspace' → materialize → openFolderPath  (unchanged)
   - kind:'single'    → materialize a 1-file workspace from the text  (was: openScratchWith)
2. else → open-or-create the default workspace → openFolderPath.
   - When CREATING it fresh, seed model.koi from the one-time migration source if present
     (legacy localStorage `koine.studio.scratch`), else from SEED; then clear the legacy key.
   - When the default workspace ALREADY exists (returning user), open it as-is — never overwrite
     its files with stale legacy scratch content.
3. if materializeWorkspace returns null → explicit "couldn't initialize a workspace" error state
   (see Error handling). No scratch fallback.
```

## What gets deleted

- `SCRATCH_URI` (`lsp.ts:239`) and every reference.
- The seeded scratch `Buffer` (`ide.ts:452-459`) and `scheduleScratchSave` (`ide.ts:463-470`); the
  scratch-persist branch in `onChange` (`ide.ts:308-309`).
- `store.ts` scratch persistence: delete `saveScratch` and the `SCRATCH_KEY` *writes*. Keep a single
  read-and-clear helper (`takeLegacyScratch()`) used only by the boot migration; `loadScratch` /
  `clearScratch` collapse into it. After the migration window this helper is the only remaining
  reference to `SCRATCH_KEY` (`store.ts:79,302-319`).
- `saveScratchAs` and its "promote scratch → real file" dance (`ide.ts:1479-1517`); `saveActive`'s
  path-less branch (`ide.ts:1441-1473`) collapses to a plain file write.
- `newScratch`'s scratch branch (`ide.ts:1582-1590`); `openScratchWith` (`ide.ts:1654-1683`) is
  replaced by "materialize a 1-file workspace".
- Every `if (!folderMode)` / `folderMode ? … : …` branch, the dual confirmation strings
  (`ide.ts:1638,1843`), `hideFileTreeChrome` (`ide.ts:419-423`), the `toggleFileTree` /
  `Mod+B` / palette go-to-file `folderMode` guards (`ide.ts:425,2052-2058,2105`).
- The dead `folderRootToken == null` in-memory-workspace fallback in `importSharedWorkspace`
  (`ide.ts:1710-1787`) and the `renderTree` guard (`ide.ts:562`) — `materializeWorkspace` is now
  always available, so `folderRootToken` is always set.
- The `folderMode` flag itself.

## Behaviour mapping

| Action | Today (scratch) | After |
|---|---|---|
| Boot, no link/folder | seed buffer, no explorer | open-or-create default workspace, explorer shown |
| Reload restores work | `localStorage` scratch | OPFS / app-data files |
| Mod+S | `saveScratchAs` when path-less | plain file write (always has a path) |
| "New" | new scratch buffer | reset default workspace to one seeded `model.koi` (dirty-confirm); relabel **New scratch model → New model** |
| Single-file share link (`kind:'single'`) | `openScratchWith` | materialize a 1-file workspace |
| Single-source example | scratch buffer | materialize a 1-file workspace |
| Welcome overlay | shows in untouched scratch | shows when default workspace is pristine (`model.koi === SEED`, no other files); dismissed on first edit |
| Existing `koine.studio.scratch` | — | one-time migration into default `model.koi`, then key cleared |

`welcome.ts`: `onNewScratch` → `onNewModel` (label "New model"); the other callbacks
(`onOpenFolder`, `onOpenRecent`, `onOpenExample`) are unchanged.

`share.ts`: the `SharePayload` `kind:'single'` variant stays (old links keep working) but is
**imported** by materializing a 1-file workspace. Whether new one-file shares still emit `kind:'single'`
or always `kind:'workspace'` is an implementation detail; either is acceptable.

## Error handling

If `materializeWorkspace` returns `null` (no OPFS in a pre-OPFS browser, or an app-data write
failure), Studio shows an explicit **"couldn't initialize a workspace"** state instead of silently
resurrecting a scratch buffer. This is the one deliberate functionality trade-off: we drop the
degraded no-filesystem fallback in exchange for deleting the dual-mode complexity. Accepted by the
maintainer (pre-OPFS browsers are out of support).

## Testing

- Update `dirty.test.ts`, `store.test.ts`, `share.test.ts`, `explorer.test.ts` to drop scratch
  assertions (e.g. the "routes a path-less (scratch) dirty buffer through saveScratch" test).
- Add coverage:
  - boot **creates** the default workspace when none exists (seeded `model.koi`), and **restores**
    it on a second boot (files survive).
  - the `localStorage` `koine.studio.scratch` → default-workspace **migration** (and key cleared).
  - **"New"** resets the default workspace to one seeded `model.koi` (with the dirty-confirm).
  - single-file **share link** and single-source **example** each open as a 1-file workspace.
  - the **no-OPFS** path surfaces the error state (mock `canMaterializeWorkspace` → false).
- Browser `fs.test.ts`: the persistent default OPFS workspace is not wiped on re-open.
- Desktop: `materializeWorkspace` wrapper unit-tested where practical; Rust `create_file` path is
  already covered.

## Key source references (for the implementation plan)

- State/model: `ide.ts` Buffer `~45-53`, `buffers/activeUri/folderMode ~384-399`, seed `~452-459`.
- Mode chrome: `ide.ts:406-433` (`showFileTreeChrome`/`hideFileTreeChrome`/`toggleFileTree`),
  `renderTree ~557-563`, diagnostics `renderTree(folderMode)` `:535`.
- Save: `saveActive ~1441-1473`, `saveScratchAs ~1479-1517`, save-all `~1526-1573`.
- New / open: `newScratch ~1582-1590`, `requestNewScratch ~1648-1650`, `openScratchWith ~1654-1683`,
  `openExample ~1690-1703`, `importSharedWorkspace ~1710-1787`, `openFolder/openFolderPath ~1287-1400`.
- Persistence: `store.ts:79,298-319`; `lsp.ts:239` `SCRATCH_URI`.
- Hosts: `host/types.ts:118` (`materializeWorkspace?`), `host/browser/fs.ts:45-47,156-195`
  (`supported`/`opfsRoot`/`canMaterializeWorkspace`/`materializeWorkspace`),
  `host/browser/index.ts:14,51-53`, `host/tauri.ts:65-67,122` (no `materializeWorkspace`).
- Rust: `src-tauri/src/lib.rs:485` `create_file`, `:505` `create_folder`, `:367` `write_text_file`,
  `:477` `list_entries`.
- Welcome / examples / share: `welcome.ts`, `examples.ts`, `share.ts`.
- Docs to update: `website/src/content/docs/guides/koine-studio.md`.
