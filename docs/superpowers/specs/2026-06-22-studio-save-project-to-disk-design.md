# Save a Koine Studio workspace as a real, reopenable on-disk project

- **Date:** 2026-06-22
- **Status:** Approved (design)
- **Component:** `tooling/koine-studio` (browser host; Tauri desktop is a noted follow-up)
- **Motivation:** Today there is no way to keep work done in the Studio. Examples and the default
  workspace live in **ephemeral** storage and never enter the recent-projects + persisted-handle
  path, so "load an example → save → reload → reopen it" silently loses everything. This feature adds
  a **Save to disk…** action that promotes the current workspace into a real, named folder the user
  picks, registers it in Recent, and makes it reopenable across reloads — the foundation for a future
  git-repository feature (which needs real on-disk repos).

## Problem (reproduced 2026-06-22 via chrome-devtools MCP)

The recents + persisted-handle machinery — IndexedDB directory handles in the browser
([`fs.ts`](../../../tooling/koine-studio/src/host/browser/fs.ts) `pickFolder` → `idbPut` →
`pushRecentFolder`) — is **only ever exercised by the "Open folder…" picker**. Examples and the
default workspace are materialized in ephemeral storage (browser OPFS `example-<id>` / desktop
`<appData>/workspaces/<id>`) and opened with `recent: false`, so they never become re-openable
projects. Concretely, against the pizzeria example:

- **B1.** Clicking a Recent whose live handle isn't in IndexedDB shows status **"could not read
  folder"** (console: `listKoiFiles failed: this folder is no longer available`) **and** dismisses
  the start screen, stranding the user on an unrelated model. `openFolderPath` calls `hideWelcome()`
  at the top, *before* the read that fails
  ([`workspaceController.ts:362`](../../../tooling/koine-studio/src/workspaceController.ts)).
- **B2.** Opening an example never adds it to Recent (`openFolderPath(token,{recent:false})`,
  [`ide.tsx:935`](../../../tooling/koine-studio/src/ide.tsx); gate at `workspaceController.ts:414`).
- **B3.** Save / Save-all write back into the **ephemeral** OPFS example dir
  ([`workspaceController.ts:683`](../../../tooling/koine-studio/src/workspaceController.ts)). The
  *next* "open example" wipes + reseeds that dir
  ([`fs.ts:176`](../../../tooling/koine-studio/src/host/browser/fs.ts)
  `removeEntry(dirName,{recursive})`), destroying the saved edits. Verified: an `EDIT-MARKER` typed,
  saved (confirmed on OPFS), then gone after re-opening the example.
- **B4.** Reload restores only the default `Untitled` workspace; the example you saved is orphaned in
  OPFS and surfaced nowhere.
- **B5.** No "Save As / Save project to a named folder" exists on either host; the `~/koine/<name>/`
  convention is unimplemented.

## Goal

A dedicated **Save to disk…** action that promotes the current (typically ephemeral) workspace into a
real folder `<root>/<name>/` the user picks once, writes every open file there, registers it in
Recent, and makes the workspace *become* that folder so subsequent saves and reloads work. The
reopen-from-Recent path is hardened so the end-to-end promise actually holds.

The acceptance scenario (the exact repro that motivated this): **load pizzeria → Save to disk… as
`my-pizzeria` → `<root>/my-pizzeria/` written → reload → `my-pizzeria` in Recent → click → reopens
from disk with content intact.**

### Non-goals (YAGNI)

- **Desktop/Tauri** implementation. Browser-first: `canSaveProjects = false` on desktop for now
  (desktop keeps "Open folder…"); the `~/koine`-style root there is a noted follow-up. The Platform
  seam is host-agnostic so it drops in later.
- Migrating the existing default `Untitled` workspace or the leftover OPFS `example-<id>` dir — the
  abandoned example dir is wiped on the next example-open anyway.
- Overwrite/merge into an existing project folder; auto-pruning Recent entries.
- Any change to the Ast/compiler/emitter layers. This is purely the Studio host/UI tier.

## Approach (chosen: promote into the existing folder-mode path)

Rejected alternatives: a dual OPFS-working-copy-synced-to-disk model (two sources of truth, no
benefit) and named projects kept inside OPFS/IndexedDB (invisible to the OS and to git — fails the
real-disk requirement).

The chosen approach adds **one host capability** and a thin orchestration in `ide.ts`; everything
downstream (save, explorer tree, reopen) reuses the proven folder-mode machinery, because the saved
project is registered exactly like a folder opened via "Open folder…".

## Architecture

### New Platform surface (`src/host/types.ts`)

- `canSaveProjects: boolean` — capability flag (browser: File System Access present; desktop: `false`
  for now).
- `saveProjectToRoot(name: string, files: { relPath: string; contents: string }[]): Promise<string | null>`
  — ensures the remembered workspace **root**, creates `<root>/<name>/`, writes `files`, registers
  the new directory like an opened folder, and returns its **token**. Returns `null` if the user
  dismissed the root picker. Throws `already exists` on collision.
- `workspaceRootName(): Promise<string | null>` — the remembered root's display name for Settings;
  `null` before any root is picked.

### Browser implementation (`src/host/browser/fs.ts`)

- The workspace **root handle** is picked once via `showDirectoryPicker({ mode: 'readwrite' })` and
  persisted in IndexedDB under a **reserved key** `(workspace-root)` (parentheses keep it from
  colliding with folder-name tokens — the same trick `(default)` uses).
- `saveProjectToRoot`:
  1. **Resolve root:** `idbGet('(workspace-root)')`; if missing, or `queryPermission`/`requestPermission`
     isn't `granted`, call `showDirectoryPicker` (the "pick a root once" moment) and `idbPut` it.
     Permission re-grant happens under the click gesture, mirroring the existing `resolveFolder` dance.
  2. **Collision check:** `root.getDirectoryHandle(name)` succeeds → throw `already exists` (write
     nothing).
  3. **Create + write:** `getDirectoryHandle(name, { create: true })`, then write each file (creating
     subdirs) — reusing the existing `createFile`/write helpers.
  4. **Register:** mint a token via `uniqueToken(name)`, `folders.set(token, projectDir)`,
     `idbPut(token, projectDir)` — identical to what `pickFolder` does, so the project is
     indistinguishable from an opened folder and reopens via the same `resolveFolder` path.
  5. Return the token.
- `workspaceRootName` reads the reserved key's handle name.
- Wired through `BrowserPlatform` (`src/host/browser/index.ts`).

### Desktop stub (`src/host/tauri.ts`)

`canSaveProjects = false`; `saveProjectToRoot`/`workspaceRootName` return `null`/throw `unsupported`.
The action is hidden on desktop.

### Orchestration (`src/ide.tsx`)

`saveProjectToDisk()`:
1. Snapshot `workspace.buffers` → `files: { relPath, contents }[]` (the whole open workspace; subfolder
   structure preserved).
2. Prompt for a project name (text-input dialog), default = current workspace title; validate with the
   existing name rule (non-empty; no `/ \ . ..`).
3. `await platform.saveProjectToRoot(name, files)`.
4. On a token → `await workspace.openFolderPath(token, { recent: true })` (re-reads from disk, pushes
   Recent, sets title, renders the tree); `setStatus('Project saved ✓', 'green')`.

Exposed as a `save-project-to-disk` command-palette entry, a toolbar affordance (next to **Generate**),
and an action on the example/Untitled empty-state. Hidden/disabled when `!canSaveProjects` (Firefox),
with a tooltip pointing to **Export .koi source (.zip)**.

## Data flow

**Save to disk (happy path):** click → collect buffers → name prompt → `saveProjectToRoot`
(resolve/pick root → collision check → create+write → register+`idbPut` → token) →
`openFolderPath(token,{recent:true})` → workspace title flips to the project; it now *is* the on-disk
folder. Plain Save (⌘S) thereafter writes into `<root>/<name>/`.

**Reopen from Recent (after reload):** unchanged existing path — click Recent → `openFolderPath(token)`
→ `resolveFolder` → `idbGet(token)` → `requestPermission` → walk → open. Now works because the handle
was `idbPut` at save time.

## Error handling

- **Root picker dismissed** → `saveProjectToRoot` returns `null` → abort silently (cancel ≠ error).
- **Name collision** → catch `already exists` → re-prompt: "A project named *X* already exists — choose
  another name." No overwrite.
- **`!canSaveProjects`** → action hidden/disabled; steer to the `.koi` zip export.
- **Write failure mid-way** → report via status; the partial dir is left (user retries with another
  name). Acceptable — no rollback.

### Reopen robustness fixes (folded in)

- **Fix 1 — failed reopen no longer strands you.** Move `hideWelcome()` from the top of
  `openFolderPath` to the **success point** (just before `folderRoot = folder` is committed, after
  files are read and buffers populated). Any early-return failure (could-not-read, no `.koi`, all
  reads failed) leaves the welcome up so the user lands back where they clicked. Normal callers
  (`openExample`, recent click, share import) still get the welcome hidden because they reach success.
- **Fix 2 — a Recent whose folder/handle is gone is recoverable.** `openFolderPath` reports the
  failure *kind* (a typed result/callback, not `String(e).includes(...)`) so `ide.ts` can distinguish
  "handle gone / permission denied" from "present but empty/unreadable". For the former it keeps the
  start screen visible, shows **"'pizzeria' is no longer available."**, and offers a one-click
  **Remove from Recent** (`removeRecentFolder(path)`). No silent auto-pruning — a denied permission is
  often recoverable by re-granting.

## Testing (vitest only — this is the Studio TS tier; no Roslyn/Verify)

**`host/browser/fs.test.ts`** (existing mocked FS-Access handles + `__setFolderForTest` /
`__resetFsForTest`):

- `saveProjectToRoot` writes all files under `<root>/<name>/`, structure preserved.
- Root picked **once**: first call invokes mock `showDirectoryPicker`; second call reuses the
  persisted root (picker not called again).
- Collision: pre-existing `<root>/<name>/` → throws `already exists`, nothing written.
- Registration: after success the token resolves via `resolveFolder` and its handle is in mocked
  IndexedDB (a fresh-registries "reload" can reopen it).
- Root picker dismissed → returns `null`, no write.
- `workspaceRootName()` reflects the picked root / `null` before any pick.

**`workspaceController.test.ts`**:

- `openFolderPath` calls `hideWelcome` **only on success**, not when `listKoiFiles` throws / folder is
  empty (Fix 1).
- Failure-kind classification distinguishes "handle gone/denied" from "empty/unreadable" (Fix 2 seam).

**`ide.test.ts`** (spy platform):

- `saveProjectToDisk` collects buffers, prompts the name, calls `saveProjectToRoot`, then
  `openFolderPath(token,{recent:true})`.
- Collision → re-prompt; cancel → silent abort.
- `!canSaveProjects` → command hidden/disabled.
- A failed recent reopen keeps the welcome up and offers Remove-from-Recent (Fix 2).

**Manual/browser acceptance** (chrome-devtools MCP): re-run the motivating repro end-to-end (load
pizzeria → Save to disk… as `my-pizzeria` → verify `<root>/my-pizzeria/` on disk → reload → in Recent
→ click → reopens with content intact).

## Files touched

- `src/host/types.ts` — Platform surface (`canSaveProjects`, `saveProjectToRoot`, `workspaceRootName`).
- `src/host/browser/fs.ts` — root-handle persistence + `saveProjectToRoot` + `workspaceRootName`.
- `src/host/browser/index.ts` — `BrowserPlatform` wiring.
- `src/host/tauri.ts` — desktop stub (capability off).
- `src/ide.tsx` — `saveProjectToDisk` orchestration, command/toolbar/empty-state wiring; reopen-failure
  UX (Fix 2).
- `src/workspaceController.ts` — `hideWelcome` move (Fix 1) + failure-kind reporting (Fix 2 seam).
- Settings surface — "Workspace root: … · Change…" (reads `workspaceRootName`, re-picks the root).
- Tests: `fs.test.ts`, `workspaceController.test.ts`, `ide.test.ts`.
