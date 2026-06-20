# Remove Studio scratch mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete Koine Studio's single-file "scratch mode" and make a real, filesystem-backed workspace the only mode — both hosts boot into a persistent 1-file workspace.

**Architecture:** A new **default workspace** (browser: a persistent OPFS directory; desktop: a folder under the Tauri app-data dir) is opened-or-created on boot and fed through the *existing* `openFolderPath()` folder-mode path. Every scratch branch (`SCRATCH_URI`, the `folderMode` flag, `saveScratchAs`, the `localStorage` scratch buffer, the in-memory-workspace fallback) is then removed. Single-file share links and single-source examples open by materializing a 1-file workspace.

**Tech Stack:** TypeScript + Vite, Vitest (`npm test` → `vitest run`), CodeMirror editor, File System Access API / OPFS (browser host), Tauri v2 + Rust commands (desktop host). All Studio code lives in `tooling/koine-studio/`.

## Global Constraints

- All paths below are relative to `tooling/koine-studio/` unless noted. Run all `npm`/`vitest` commands from `tooling/koine-studio/`.
- Test runner: **Vitest**. Run one file: `npm test -- src/<file>.test.ts`. Run all: `npm test`.
- Assertions use Vitest's `expect().toBe/.toEqual/.not.toBeNull` (NOT Shouldly — that's the .NET suite).
- TypeScript is strict (`Nullable`/`noImplicitAny` equivalent on); the build is `tsc && vite build`. A type error fails the build — keep `npm run build` green.
- The CI format gate (`dotnet format`) does **not** cover this TS project; there is no Prettier gate either. Match the surrounding code style (2-space indent, single quotes, trailing commas) by hand.
- Commit identity (workspace rule): `git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "..."`.
- `SEED` and `BLANK` are existing `const` strings in `src/ide.ts` (the Billing seed model and the empty-context stub). Reuse them; do not redefine.
- "Out of scope" (do NOT touch): the assistant/MCP single-`source` tool wrapper in `src/assistantTools.ts`, `src/host/tauri.ts` (`runCompilerTool`), `src/host/browser/tools.ts`.

## File structure (what each task touches)

- `src/host/types.ts` — `Platform` interface: add `defaultWorkspace`, make `materializeWorkspace` required. (Task 1)
- `src/host/browser/fs.ts` — add `openDefaultWorkspace()` (persistent OPFS). (Task 1)
- `src/host/browser/index.ts` — `BrowserPlatform.defaultWorkspace()`. (Task 1)
- `src/host/tauri.ts` — `TauriPlatform.materializeWorkspace()` + `.defaultWorkspace()`. (Task 1)
- `src/host/browser/fs.test.ts` — default-workspace unit tests. (Task 1)
- `src/ide.ts` — boot rewrite, save collapse, New/example/share rewrite, flag removal. (Tasks 2–5)
- `src/dirty.ts` + `src/dirty.test.ts` — drop the scratch (`path: null`) routing. (Task 3)
- `src/store.ts` + `src/store.test.ts` — replace scratch persistence with a one-time `takeLegacyScratch()`. (Task 5)
- `src/welcome.ts` — relabel "New scratch model" → "New model"; callback rename. (Task 5)
- `src/lsp.ts` — delete `SCRATCH_URI`. (Task 5)
- `website/src/content/docs/guides/koine-studio.md` — doc wording. (Task 6)

---

### Task 1: Default-workspace capability on both hosts (additive)

Add the host capability to open-or-create a persistent default workspace, and guarantee `materializeWorkspace` on both hosts. Purely additive — scratch mode still works after this task; nothing calls the new code yet.

**Files:**
- Modify: `src/host/types.ts` (Platform interface)
- Modify: `src/host/browser/fs.ts` (add `openDefaultWorkspace`, `hasAnyKoi`)
- Modify: `src/host/browser/index.ts` (`BrowserPlatform.defaultWorkspace`)
- Modify: `src/host/tauri.ts` (`TauriPlatform.materializeWorkspace`, `.defaultWorkspace`, import `appDataDir`/`join`)
- Test: `src/host/browser/fs.test.ts`

**Interfaces:**
- Produces: `Platform.defaultWorkspace(seed: string): Promise<string | null>` — resolves a folder token for a persistent default workspace, seeding a single `model.koi` with `seed` only when the workspace is created fresh (never clobbers existing files); `null` when the host can't back one (no OPFS).
- Produces: `Platform.materializeWorkspace(name, files): Promise<string | null>` — now **required** (both hosts implement it).
- Produces (fs.ts): `openDefaultWorkspace(seed: string): Promise<string | null>`.

- [ ] **Step 1: Write the failing test** (append to `src/host/browser/fs.test.ts`, inside the existing top-level `describe` or a new one; reuse the file's `MockDir`/`MockFile`)

```ts
import {
  __setFolderForTest,
  __resetFsForTest,
  listEntries,
  createFile,
  createFolder,
  deleteEntry,
  renameEntry,
  moveEntry,
  openDefaultWorkspace, // NEW
  readTextFile,         // NEW
  writeTextFile,        // NEW
} from './fs';

describe('default workspace (OPFS)', () => {
  function mockOpfs(root: MockDir): void {
    (navigator as unknown as { storage: { getDirectory(): Promise<unknown> } }).storage = {
      getDirectory: async () => root as never,
    };
  }

  it('seeds model.koi on first open and preserves edits on reopen', async () => {
    __resetFsForTest();
    mockOpfs(new MockDir('opfs-root'));

    const token = await openDefaultWorkspace('context Seed {}');
    expect(token).not.toBeNull();

    const entries = await listEntries(token as string);
    expect(entries.map((e) => e.name)).toEqual(['model.koi']);
    expect(await readTextFile(`${token as string}/model.koi`)).toBe('context Seed {}');

    // Edit, then reopen with a different seed: the existing file must win (no clobber).
    await writeTextFile(`${token as string}/model.koi`, 'context Edited {}');
    const token2 = await openDefaultWorkspace('context Other {}');
    expect(await readTextFile(`${token2 as string}/model.koi`)).toBe('context Edited {}');
  });

  it('returns null when OPFS is unavailable', async () => {
    __resetFsForTest();
    delete (navigator as unknown as { storage?: unknown }).storage;
    expect(await openDefaultWorkspace('x')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/host/browser/fs.test.ts`
Expected: FAIL — `openDefaultWorkspace` is not exported.

- [ ] **Step 3: Implement `openDefaultWorkspace` + `hasAnyKoi` in `src/host/browser/fs.ts`**

Add after `materializeWorkspace` (around line 195), reusing the module's `opfsRoot`, `folders`, `folderNames`, `dirHandles`, `SKIP_DIRS`:

```ts
// The persistent default workspace: a fixed OPFS directory, opened (not wiped) on every boot so the
// user's single model survives a reload. Replaces the old localStorage scratch buffer. The token is a
// reserved sentinel (parentheses can't appear in a real picked-folder name) so it never collides.
const DEFAULT_WS_DIR = 'default-workspace';
const DEFAULT_WS_TOKEN = '(default)';

async function hasAnyKoi(dir: FsDirHandle): Promise<boolean> {
  for await (const entry of dir.values()) {
    if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.koi')) return true;
    if (entry.kind === 'directory' && !SKIP_DIRS.has(entry.name) && (await hasAnyKoi(entry))) return true;
  }
  return false;
}

/**
 * Open the persistent default OPFS workspace, creating + seeding `model.koi` with `seed` the first
 * time (i.e. when it holds no `.koi` yet). Registers it like any opened folder so the explorer + file
 * mutations reuse the folder-mode path. Returns its token, or null when OPFS is unavailable.
 */
export async function openDefaultWorkspace(seed: string): Promise<string | null> {
  const rootPromise = opfsRoot();
  if (!rootPromise) return null;
  const root = await rootPromise;
  const dir = await root.getDirectoryHandle(DEFAULT_WS_DIR, { create: true });
  if (!(await hasAnyKoi(dir))) {
    const handle = await dir.getFileHandle('model.koi', { create: true });
    const writable = await handle.createWritable();
    await writable.write(seed);
    await writable.close();
  }
  folders.set(DEFAULT_WS_TOKEN, dir);
  folderNames.set(DEFAULT_WS_TOKEN, 'Untitled');
  dirHandles.set(DEFAULT_WS_TOKEN, dir);
  return DEFAULT_WS_TOKEN;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/host/browser/fs.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the hosts + interface**

In `src/host/types.ts`, make `materializeWorkspace` required (remove the `?` and the "Optional…" sentence) and add below it:

```ts
  /**
   * Open (or first-time create + seed) the host's persistent default workspace — the single-model
   * workspace Studio boots into when no folder/share is opened. Seeds one `model.koi` with `seed`
   * only on first creation; never clobbers existing files. Returns its token (opened via the normal
   * folder-mode path), or null when the host can't back one (e.g. no OPFS in the browser).
   */
  defaultWorkspace(seed: string): Promise<string | null>;
```

In `src/host/browser/index.ts`, add a method to `BrowserPlatform` (next to `materializeWorkspace`):

```ts
  defaultWorkspace(seed: string): Promise<string | null> {
    return fs.openDefaultWorkspace(seed);
  }
```

In `src/host/tauri.ts`, add the path import at the top with the other `@tauri-apps/api` imports:

```ts
import { appDataDir, join } from '@tauri-apps/api/path';
```

and add two methods to `TauriPlatform` (after `pickFolder`):

```ts
  // Materialize a synthetic workspace under the app-data dir, fresh each open (mirrors the browser's
  // OPFS example semantics). Used by multi-file examples and shared-workspace links on the desktop.
  async materializeWorkspace(
    name: string,
    files: { relPath: string; contents: string }[],
  ): Promise<string | null> {
    const dir = await join(await appDataDir(), 'workspaces', name);
    try {
      await invoke('delete_entry', { token: dir }); // discard a previous copy
    } catch {
      // not present — nothing to clear
    }
    for (const f of files) await this.createFile(dir, f.relPath, f.contents);
    return dir;
  }

  // The persistent default workspace: <appData>/Untitled. Seed model.koi only when the folder holds
  // no .koi yet, so a reload restores the user's model instead of overwriting it.
  async defaultWorkspace(seed: string): Promise<string | null> {
    const dir = await join(await appDataDir(), 'Untitled');
    const existing = await this.listKoiFiles(dir).catch(() => [] as KoiFile[]);
    if (existing.length === 0) await this.createFile(dir, 'model.koi', seed);
    return dir;
  }
```

- [ ] **Step 6: Verify the build + full suite still green**

Run: `npm run build && npm test`
Expected: PASS (additive change; nothing else references the new methods yet).

- [ ] **Step 7: Commit**

```bash
git add src/host/types.ts src/host/browser/fs.ts src/host/browser/index.ts src/host/tauri.ts src/host/browser/fs.test.ts
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "feat(studio): host default-workspace capability (OPFS + app-data), require materializeWorkspace"
```

---

### Task 2: Boot into the default workspace; migrate legacy scratch

Rewire `init()` so boot opens-or-creates the default workspace instead of seeding a scratch buffer. Single-file share links materialize a transient 1-file workspace. The legacy `localStorage` scratch buffer is migrated into the default workspace once. `folderMode` is left in place (always becomes true) and is removed in Task 5.

**Files:**
- Modify: `src/ide.ts` — the boot region (~284–290, ~451–470, ~308–309, ~2112–2158); add two boot helpers.

**Interfaces:**
- Consumes: `platform.defaultWorkspace`, `platform.materializeWorkspace` (Task 1); existing `openFolderPath`, `populateBuffers`, `SEED`, `editor`, `welcome`, `buffers`, `activeUri`.
- Produces: `openDefaultWorkspaceFlow(seed: string): Promise<void>` and `openWorkspaceWith1File(text: string): Promise<void>` (used only inside `init`).

- [ ] **Step 1: Add `recent` opt to `openFolderPath`** so synthetic/default workspaces don't pollute the recent-folders list.

Change the signature at `src/ide.ts:1324`:

```ts
  async function openFolderPath(folder: string, opts: { recent?: boolean } = {}): Promise<void> {
```

and guard the `pushRecentFolder(folder)` call (currently line ~1395):

```ts
    if (opts.recent ?? true) pushRecentFolder(folder);
```

- [ ] **Step 2: Replace the boot doc-seed + share handling.**

Replace the boot block at `src/ide.ts:284–290`:

```ts
  const shared = readModelFromHash();
  const singleShared = shared?.kind === 'single' ? shared.text : null;
  const restoredScratch = loadScratch();
  const initialDoc = singleShared ?? restoredScratch ?? SEED;
```

with (note `takeLegacyScratch` lands in Task 5; for now read+clear inline so migration works immediately):

```ts
  const shared = readModelFromHash();
  // One-time migration of the legacy single-file scratch buffer (pre-workspace Studio) into the
  // default workspace's model.koi. Read+clear here so it is applied at most once.
  const legacyScratch = loadScratch();
  if (legacyScratch !== null) clearScratch();
  // First paint before the workspace opens; openFolderPath replaces it with the active file's text.
  const initialDoc = (shared?.kind === 'single' ? shared.text : null) ?? legacyScratch ?? SEED;
```

- [ ] **Step 3: Stop seeding the scratch buffer.** Delete the `buffers.set(SCRATCH_URI, {...})` block at `src/ide.ts:451–459` and the debounced scratch-save in `onChange` at `src/ide.ts:308–309`:

```ts
      // Persist the scratch buffer (debounced) so a reload restores it.
      if (!folderMode && activeUri === SCRATCH_URI) scheduleScratchSave(doc);
```

Leave `scheduleScratchSave` defined for now (removed in Task 5) — it simply has no caller after this.

- [ ] **Step 4: Add the two boot helpers** (place them near `openFolderPath`, after it):

```ts
  // Boot/empty-state: open the host's persistent default workspace (creating + seeding it the first
  // time), then surface the welcome overlay only when it is pristine (a single untouched SEED model).
  async function openDefaultWorkspaceFlow(seed: string): Promise<void> {
    const token = await platform.defaultWorkspace(seed);
    if (!token) {
      setStatus("couldn't initialize a workspace", 'error');
      output.setContent('// Koine Studio needs OPFS (a modern browser) to store your model.', 'plain');
      return;
    }
    await openFolderPath(token, { recent: false });
    const only = buffers.size === 1 ? Array.from(buffers.values())[0] : null;
    if (only && only.text === SEED) welcome.show();
  }

  // Open one shared model as a transient 1-file workspace (non-destructive: it does not touch the
  // user's default workspace). The hash is cleared by the caller so a reload returns home.
  async function openWorkspaceWith1File(text: string): Promise<void> {
    const token = await platform.materializeWorkspace('shared', [{ relPath: 'model.koi', contents: text }]);
    if (!token) {
      setStatus('could not open shared model', 'error');
      return;
    }
    await openFolderPath(token, { recent: false });
  }
```

- [ ] **Step 5: Rewrite the boot welcome/open block + the `lsp.start` callback.**

Replace `src/ide.ts:2112–2125` (the `if (shared?.kind === 'single') saveScratch… else if … welcome.show()` block) with nothing — boot decisions now live in the `lsp.start` callback. Then replace the callback body at `src/ide.ts:2136–2152`:

```ts
    .then(async () => {
      // The workspace opens once the server is up so each file's didOpen resolves cross-file refs.
      // Isolated try/finally per branch: an open failure must not masquerade as a connection failure,
      // and any model hash is cleared so a reload doesn't re-trigger a failing import.
      if (shared?.kind === 'workspace') {
        try {
          await importSharedWorkspace(shared.files, shared.active);
        } catch (e) {
          console.error('importing shared workspace failed:', e);
          setStatus('could not open shared workspace', 'error');
        } finally {
          clearModelHash();
        }
      } else if (shared?.kind === 'single') {
        try {
          await openWorkspaceWith1File(shared.text);
        } catch (e) {
          console.error('opening shared model failed:', e);
          setStatus('could not open shared model', 'error');
        } finally {
          clearModelHash();
        }
      } else {
        await openDefaultWorkspaceFlow(legacyScratch ?? SEED);
      }
    })
```

- [ ] **Step 6: Build + run the suite.**

Run: `npm run build && npm test`
Expected: PASS. (Some scratch-specific tests still pass because the scratch code still exists; they are updated in Tasks 3/5.) If `tsc` complains that `scheduleScratchSave`/`saveScratch` are unused, that is fine — they are not errors; they are removed in Task 5.

- [ ] **Step 7: Manual smoke (browser).**

Run: `npm run dev:web`, open the served URL. Expected: the app boots showing the welcome overlay over a seeded `model.koi` **with the file explorer visible** (one file). Type something, reload — your text is restored from OPFS. Stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add src/ide.ts
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "feat(studio): boot into the default workspace; migrate legacy scratch; share→1-file workspace"
```

---

### Task 3: Collapse save — every buffer has a path now

After Task 2 every open buffer is a real file, so the path-less (scratch) save branch is dead. Remove `saveScratchAs`, simplify `saveActive`/`saveAllDirty`, and drop the scratch routing from `dirty.ts`.

**Files:**
- Modify: `src/dirty.ts`, `src/dirty.test.ts`
- Modify: `src/ide.ts` (`saveActive` ~1441, `saveScratchAs` ~1479, `saveAllDirty` ~1543–1555)

**Interfaces:**
- Produces: `SaveableBuffer.path: string` (was `string | null`); `SaveAllDeps` loses `saveScratch`.

- [ ] **Step 1: Update the failing test first** — edit `src/dirty.test.ts`: delete the test `'routes a path-less (scratch) dirty buffer through saveScratch, not write'` (lines 64–80), and in the two remaining `saveAllDirtyBuffers` tests remove the `saveScratch: async () => { throw … }` property from the deps object.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/dirty.test.ts`
Expected: FAIL — `saveAllDirtyBuffers` deps type still requires `saveScratch` (or the import surface changed). This confirms the test now targets the new shape.

- [ ] **Step 3: Simplify `src/dirty.ts`.** Change `SaveableBuffer.path` to `string`, drop `saveScratch` from `SaveAllDeps`, and remove the `path == null` branch:

```ts
/** A persistable buffer: a real `path` is written to disk. */
export interface SaveableBuffer extends DirtyLike {
  path: string;
}

/** The side effects `saveAllDirtyBuffers` delegates to, so the iteration itself stays pure. */
export interface SaveAllDeps<T extends SaveableBuffer> {
  /** Persist a buffer; may reject (e.g. the disk write fails). */
  write(buffer: T): Promise<void>;
  /** Report a failed `write`; the buffer is left dirty and the remaining buffers still save. */
  onError(buffer: T, error: unknown): void;
}

/**
 * Save every dirty buffer via `write`, marking each clean. A failed `write` keeps that buffer dirty,
 * is reported via `onError`, and does not stop the others. Returns the count successfully written.
 */
export async function saveAllDirtyBuffers<T extends SaveableBuffer>(
  buffers: Map<string, T>,
  deps: SaveAllDeps<T>,
): Promise<number> {
  let saved = 0;
  for (const buffer of dirtyBuffers(buffers)) {
    try {
      await deps.write(buffer);
      buffer.dirty = false;
      saved++;
    } catch (error) {
      deps.onError(buffer, error);
    }
  }
  return saved;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/dirty.test.ts`
Expected: PASS.

- [ ] **Step 5: Simplify `saveActive` in `src/ide.ts`** — remove the path-less branch (lines 1458–1462) so the body after `buf.text = …; lsp.changeDoc(…)` is just:

```ts
      try {
        await platform.writeTextFile(buf.path, buf.text);
        buf.dirty = false;
        lsp.didSave();
        renderTree();
      } catch (e) {
        setStatus('save failed', 'error');
        console.error('writeTextFile failed:', e);
      }
```

(`ide.ts`'s `Buffer.path` is still typed `string | null` until Task 5 narrows it, so write `buf.path as string` here — every buffer is a real file now, so the cast is sound. Task 5 Step 8 removes the cast when it narrows the type.)

- [ ] **Step 6: Delete `saveScratchAs`** (`src/ide.ts:1477–1517`) entirely.

- [ ] **Step 7: Simplify `saveAllDirty`** — replace the "nothing dirty" block (lines 1543–1550) and the `saveAllDirtyBuffers` deps (1553–1560):

```ts
      if (dirtyCount(buffers) === 0) {
        setStatus('No unsaved changes', 'green');
        return;
      }

      let failures = 0;
      const saved = await saveAllDirtyBuffers(buffers, {
        write: (buf) => platform.writeTextFile(buf.path as string, buf.text),
        onError: (buf, err) => {
          failures++;
          console.error('writeTextFile failed for', buf.path, err);
        },
      });
```

Also delete the now-unused `hasUnsavedWork()`'s scratch branch reference if `saveAllDirty` was its only path-less consumer — leave `hasUnsavedWork` itself (still used by `confirmReplaceWork`); it is simplified in Task 5.

- [ ] **Step 8: Build + suite.**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/dirty.ts src/dirty.test.ts src/ide.ts
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "refactor(studio): collapse save paths — every buffer is a real file"
```

---

### Task 4: New / examples / shared-workspace → always a real workspace

Rewrite `newScratch` → `newModel` (reset the default workspace), make `openExample` always materialize, and drop the in-memory fallback from `importSharedWorkspace`. Delete `openScratchWith`.

**Files:**
- Modify: `src/ide.ts` (`newScratch` ~1580, `openScratchWith` ~1654, `openExample` ~1690, `importSharedWorkspace` ~1710)

**Interfaces:**
- Consumes: `platform.defaultWorkspace`, `platform.materializeWorkspace`, `openFolderPath`, `BLANK`.
- Produces: `newModel(): Promise<void>` (replaces `newScratch`).

- [ ] **Step 1: Replace `newScratch()` (`src/ide.ts:1580–1618`) with `newModel()`** — reset the default workspace to a single `BLANK` `model.koi` by emptying it (delete every entry, recreate `model.koi`), then reopen it. This works identically on both hosts because it uses only the `Platform` file ops the explorer already relies on (`listEntries`/`deleteEntry`/`createFile`, all token-addressed); `openFolderPath` then loads the blank model:

```ts
  // Reset the default workspace to a single untouched BLANK model: empty it on disk, recreate
  // model.koi, close every open doc, and reopen. The raw reset with no confirmation; user-initiated
  // New goes through requestNewModel() (below), which guards unsaved work first.
  async function newModel(): Promise<void> {
    const token = await platform.defaultWorkspace(BLANK);
    if (!token) {
      setStatus("couldn't initialize a workspace", 'error');
      return;
    }
    try {
      for (const entry of await platform.listEntries(token)) await platform.deleteEntry(entry.token);
      await platform.createFile(token, 'model.koi', BLANK);
    } catch (e) {
      console.error('resetting the default workspace failed:', e);
    }
    for (const uri of Array.from(buffers.keys())) lsp.closeDoc(uri);
    buffers.clear();
    diagnosticsByUri.clear();
    await openFolderPath(token, { recent: false }); // activates model.koi (= BLANK) and renders the tree
    welcome.hide();
  }
```

- [ ] **Step 2: Rename the New entry points.** Rename `requestNewScratch` → `requestNewModel` and have it call `newModel`:

```ts
  async function requestNewModel(): Promise<void> {
    if (await confirmReplaceWork('Start a new model?', 'Discard & start new')) await newModel();
  }
```

Update its three callers — the welcome callback (line 1808), the toolbar button (line 2004), and the `mod+N` handler (line 2084) — from `requestNewScratch` to `requestNewModel`. (The welcome callback prop is renamed in Task 5.)

- [ ] **Step 3: Delete `openScratchWith` (`src/ide.ts:1652–1683`).** Then make `openExample` always materialize:

```ts
  // Open a starter example as a real workspace: multi-file examples materialize all their files; a
  // single-source example materializes a 1-file workspace. Both reuse the folder-mode path.
  async function openExample(example: Example): Promise<void> {
    const files = example.files?.length
      ? example.files
      : [{ relPath: 'model.koi', contents: example.source }];
    const token = await platform.materializeWorkspace(example.id, files);
    if (!token) {
      setStatus('could not open example', 'error');
      return;
    }
    await openFolderPath(token, { recent: false });
  }
```

- [ ] **Step 4: Drop the in-memory fallback from `importSharedWorkspace` (`src/ide.ts:1741–1792`).** Keep only the materialize path; on failure, surface an error:

```ts
    // Materialize a real workspace and open it in folder mode (mirrors openExample).
    const token = await platform.materializeWorkspace(
      'shared-workspace',
      safeFiles.map((f) => ({ relPath: f.relPath, contents: f.text })),
    );
    if (!token) {
      setStatus('could not open shared workspace', 'error');
      return;
    }
    await openFolderPath(token, { recent: false });
    // openFolderPath activates the first file by relPath; honour the share's `active` when present.
    if (active) {
      const target = Array.from(buffers.values()).find((b) => b.relPath === active);
      if (target) activateFile(target.uri);
    }
```

(Delete everything from the old `if (platform.materializeWorkspace) { try { … } catch … }` wrapper and the entire fallback block below it. `materializeWorkspace` is required now, so no existence check.)

- [ ] **Step 5: Build + suite + smoke.**

Run: `npm run build && npm test`
Expected: PASS.
Then `npm run dev:web`: open an example from the welcome gallery → it opens with the explorer; click "New model" → editor resets to the blank stub; reload → blank stub restored. Stop the server.

- [ ] **Step 6: Commit**

```bash
git add src/ide.ts
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "refactor(studio): New/examples/shares always open a real workspace; drop in-memory fallback"
```

---

### Task 5: Delete the scratch surface — flag, SCRATCH_URI, store, labels

The mechanical removal pass. After Tasks 2–4, `folderMode` is always true and the scratch helpers have no callers. Delete them and re-label the UI.

**Files:**
- Modify: `src/ide.ts` (flag + branches + chrome + labels), `src/lsp.ts` (SCRATCH_URI), `src/store.ts` + `src/store.test.ts` (scratch persistence), `src/welcome.ts` (labels/callback)

- [ ] **Step 1: `src/store.ts` — replace scratch persistence with a one-time migration reader.** Delete `loadScratch`, `saveScratch`, `clearScratch` (lines 302–319) and add:

```ts
/**
 * One-time read+clear of the legacy single-file scratch buffer (pre-workspace Studio), used by the
 * boot migration into the default workspace. Returns the text once, then forgets it.
 */
export function takeLegacyScratch(): string | null {
  const text = readRaw(SCRATCH_KEY);
  if (text !== null) {
    try {
      localStorage.removeItem(SCRATCH_KEY);
    } catch {
      // storage unavailable — nothing to clear
    }
  }
  return text;
}
```

Update `src/ide.ts:284–290` boot migration to use it (replaces the inline `loadScratch()`/`clearScratch()`):

```ts
  const legacyScratch = takeLegacyScratch();
```

(remove the separate `if (legacyScratch !== null) clearScratch();` line added in Task 2).

- [ ] **Step 2: `src/store.test.ts`** — delete the tests covering `loadScratch`/`saveScratch`/`clearScratch`; add:

```ts
test('takeLegacyScratch returns the stored value once, then clears it', () => {
  localStorage.setItem('koine.studio.scratch', 'context Legacy {}');
  expect(takeLegacyScratch()).toBe('context Legacy {}');
  expect(takeLegacyScratch()).toBeNull(); // cleared after the first read
});
```

(Add `takeLegacyScratch` to the import from `./store`; remove `loadScratch`/`saveScratch`/`clearScratch` from it.)

- [ ] **Step 3: Run the store tests**

Run: `npm test -- src/store.test.ts`
Expected: PASS.

- [ ] **Step 4: `src/ide.ts` — delete `scheduleScratchSave` (~461–470)** and its `scratchSaveTimer`. Delete any remaining `saveScratch`/`loadScratch`/`clearScratch`/`restoredScratch` references (the build will point them out).

- [ ] **Step 5: Remove the `folderMode` flag and its branches.** Delete the `let folderMode = false;` declaration (~393). Then resolve each reference by taking the folder-mode (true) branch:
  - `onChange` (~311): keep the `if (becameDirty) renderTree-on-dirty` path; remove the `!folderMode` scratch persistence (already gone in Task 2).
  - `toggleFileTree` (~425): delete `if (!folderMode) return;`.
  - diagnostics handler (~535): `renderTree()` unconditionally (drop `if (folderMode)`).
  - `renderTree` (~562): drop the `!folderMode ||` part — keep `if (folderRootToken == null) return;` **only** if any token can still be null. After Task 4 every workspace has a real root, so delete the early return entirely and always `explorer.render(entriesCache, folderRootToken)` (narrow `folderRootToken` to `string`).
  - `openFolderPath` (~1340–1351): the workspace is always reopened — keep only the "close every previously open file" branch; delete the `if (!folderMode) { close SCRATCH_URI }` arm and the empty-folder scratch fallback (~1372–1384) — replace the latter with: on total read failure, `setStatus('could not read any files in folder', 'error'); return;`.
  - `openFolderPath` success (~1386): delete `folderMode = true;` (flag gone); keep `folderRootToken = folder;`.
  - `confirmReplaceWork` (~1638) and `onCloseRequested` (~1843): collapse the `folderMode ? A : B` messages to just `A` (the folder-mode string).
  - `hasUnsavedWork` (~1624): replace the whole body with `return Array.from(buffers.values()).some((b) => b.dirty);`.
  - `copyShareLink` (~1912): the workspace branch is the only one now — always share the workspace; delete the `else` single-string branch and the `if (folderMode)` wrapper.
  - `exportSourceZip` (~1940): `platform.folderName(folderRootToken as string)` unconditionally (root always present).
  - palette `getCommands` (~2052): drop the `if (folderMode)` wrapper around the "Go to File" loop and the `.filter((b) => b.uri !== SCRATCH_URI)` (no scratch uri now).
  - `mod+B` handler (~2103–2108): drop the `if (folderMode)` guard.

- [ ] **Step 6: Delete `SCRATCH_URI`.** Remove its declaration + JSDoc in `src/lsp.ts` (~239–240) and delete every remaining `SCRATCH_URI` reference in `src/ide.ts` (the build lists them; all should already be gone except imports). Remove the now-unused import.

- [ ] **Step 7: Delete `hideFileTreeChrome`** (`src/ide.ts:419–423`) — the tree chrome is always shown now; verify `showFileTreeChrome()` is the only remaining caller path and no code calls `hideFileTreeChrome`.

- [ ] **Step 8: Re-label the UI.** In `src/welcome.ts`: rename the `WelcomeCallbacks.onNewScratch` field to `onNewModel`, the button text `'New scratch model'` → `'New model'`, and the JSDoc "Open one of the starter examples as a scratch model." → "Open one of the starter examples." In `src/ide.ts`: the welcome wiring (`onNewScratch:` → `onNewModel:`), `helpRows()` line `'New scratch model'` → `'New model'` and `'Toggle file tree (folder mode)'` → `'Toggle file tree'`, palette command `title: 'New scratch model'` → `'New model'`. Update the `Buffer.path` type to `string` (drop `| null`) and `populateBuffers`'s param to `path: string` (the in-memory `path: null` caller is gone); fix `pathToFileUri` call sites accordingly.

- [ ] **Step 9: Build + full suite.**

Run: `npm run build && npm test`
Expected: PASS, with zero references to `folderMode`, `SCRATCH_URI`, `scratch` remaining. Verify:

Run: `rg -n "folderMode|SCRATCH_URI|scheduleScratchSave|saveScratch|openScratchWith" src` (from `tooling/koine-studio/`)
Expected: no matches (except `takeLegacyScratch` in store.ts and the SCRATCH_KEY string literal).

- [ ] **Step 10: Commit**

```bash
git add src/ide.ts src/lsp.ts src/store.ts src/store.test.ts src/welcome.ts
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "refactor(studio): delete scratch mode — folderMode flag, SCRATCH_URI, scratch persistence, labels"
```

---

### Task 6: Docs + final verification

**Files:**
- Modify: `website/src/content/docs/guides/koine-studio.md`
- Verify: `src/explorer.test.ts`, `src/share.test.ts` (and any other suite) for stale scratch assertions.

- [ ] **Step 1: Scan the docs guide** for "scratch": `rg -n "scratch" website/src/content/docs/guides/koine-studio.md`. Reword any "scratch model" / "single-file" mention to describe the single workspace mode (e.g. "Studio opens a workspace containing one `model.koi`; open a folder to work across files"). Keep it accurate to the new boot behavior.

- [ ] **Step 2: Scan remaining tests** for scratch assumptions: `rg -ln "scratch|SCRATCH" src/*.test.ts src/**/*.test.ts`. For each hit, update or delete the assertion so it reflects workspace-only behavior. Re-run `npm test` until green.

- [ ] **Step 3: Full build + test + desktop sanity.**

Run (from `tooling/koine-studio/`): `npm run build && npm test`
Expected: PASS.
If a desktop build is feasible in the environment: `npm run tauri build` (or `tauri dev`) and confirm the app boots into the `<appData>/Untitled` workspace with the explorer. (If Tauri toolchain is unavailable, note it and rely on the browser smoke + unit tests.)

- [ ] **Step 4: Commit**

```bash
git add website/src/content/docs/guides/koine-studio.md src
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "docs(studio): describe the single workspace mode; drop scratch wording"
```

---

## Notes / intentional behavior changes

- **Single-file share links** now open as a *transient* 1-file workspace and the hash is cleared, so a reload returns to your own default workspace (it no longer silently overwrites your work the way the old `saveScratch` path did). This is the §-share decision from the spec.
- **No-OPFS browsers** show a "couldn't initialize a workspace" status instead of a scratch fallback (spec §5, accepted).
- **Recent folders** no longer accumulate synthetic tokens (default workspace, examples, shares) — `openFolderPath(token, { recent: false })`.
- The assistant/MCP single-`source` tool wrapper is deliberately untouched (spec §6).
