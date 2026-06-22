# Studio "Save to disk" — Reopenable On-Disk Projects — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a **Save to disk…** action that writes the current Koine Studio workspace into a real, user-picked folder `<root>/<name>/`, registers it in Recent, and makes it reopenable across reloads — plus harden the reopen-from-Recent path so a missing folder no longer strands the user.

**Architecture:** One new host capability (`saveProjectToRoot`) persists a picked-once workspace **root** handle in IndexedDB and writes a named project under it, then registers that directory exactly like a folder opened via "Open folder…". A thin `saveProjectToDisk()` orchestration in `ide.tsx` collects the open buffers, prompts for a name, calls the host, and hands the returned token to the existing `openFolderPath`. Everything downstream (Save, explorer, reopen) reuses proven folder-mode machinery.

**Tech Stack:** TypeScript, Vite, Preact (panels), CodeMirror, vitest. Browser host uses the File System Access API + IndexedDB. No .NET/compiler changes.

**Spec:** [`docs/superpowers/specs/2026-06-22-studio-save-project-to-disk-design.md`](../specs/2026-06-22-studio-save-project-to-disk-design.md)

## Global Constraints

- **Work in** `tooling/koine-studio/`. All paths below are relative to that directory unless noted.
- **Tests are vitest only** (`npm run test`, i.e. `vitest run`). No Roslyn/Verify — those guard the C# emitter, not this TS tier.
- **Browser-first.** The Tauri desktop host gets `canSaveProjects = false` and stub methods; the feature is hidden there. The Platform seam stays host-agnostic.
- **Reuse existing primitives:** `window.prompt` for naming (already used at `src/ide.tsx:703`), `confirmDialog.ask({title,message,confirmLabel,danger})` from `src/overlay.ts`, the `el<T>(id)` lookup helper (`src/ide.tsx:210`), and `setStatus(text, 'green'|'error'|'connecting')` (`src/ide.tsx:367`).
- **Browser folder tokens are opaque** (a folder name, `~n`-suffixed for uniqueness). Never parse them in the UI.
- **Commit identity (repo rule):** every commit uses
  `git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "…"`.
- **CI format gate:** before the final readiness, run `dotnet format --verify-no-changes` is for the .NET tree; for this TS work run the Studio build (`npm run build`, which runs `tsc`) and `npm run test` green.
- Run `npm install` once if `node_modules` is absent.

---

### Task 1: `fs.ts` — workspace-root persistence + `saveProjectToRoot` + `workspaceRootName`

**Files:**
- Modify: `src/host/browser/fs.ts` (add module state near `DEFAULT_WS_TOKEN` ~line 200; new exports; extend `__resetFsForTest` ~line 715)
- Test: `src/host/browser/fs.test.ts`

**Interfaces:**
- Consumes: existing `fs.ts` internals — `fsWin.showDirectoryPicker`, `idbGet`/`idbPut` (best-effort, swallow when IndexedDB is absent), `uniqueToken`, `entryExists`, `assertName`, `assertRelPath`, `createFile`, and the `folders`/`folderNames`/`dirHandles` registries.
- Produces:
  - `export function supported(): boolean` (already exists — reused as the `canSaveProjects` source).
  - `export async function saveProjectToRoot(name: string, files: { relPath: string; contents: string }[]): Promise<string | null>` — creates `<root>/<name>/`, writes `files`, registers it like an opened folder, returns its token; `null` when the root picker is dismissed; throws `Error('already exists: …')` on collision.
  - `export async function workspaceRootName(): Promise<string | null>` — the remembered root's display name, or `null`.

- [ ] **Step 1: Write the failing tests**

Add to `src/host/browser/fs.test.ts` (imports at top: add `saveProjectToRoot`, `workspaceRootName` to the existing `from './fs'` import; the file already imports `__resetFsForTest`, `MockDir`/`MockFile` helpers, `describe/it/expect/beforeEach/afterEach`):

```ts
describe('saveProjectToRoot / workspace root', () => {
  afterEach(() => {
    __resetFsForTest();
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });

  it('picks a root once, writes files under <root>/<name>/, and reuses the root', async () => {
    const root = new MockDir('koine');
    let pickCount = 0;
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => {
      pickCount++;
      return root as unknown;
    };

    const files = [
      { relPath: 'a.koi', contents: 'context A {}' },
      { relPath: 'sub/b.koi', contents: 'context B {}' },
    ];
    const token = await saveProjectToRoot('my-pizzeria', files);

    expect(token).toBe('my-pizzeria');
    const proj = root.entries.get('my-pizzeria') as MockDir;
    expect((proj.entries.get('a.koi') as MockFile).contents).toBe('context A {}');
    const sub = proj.entries.get('sub') as MockDir;
    expect((sub.entries.get('b.koi') as MockFile).contents).toBe('context B {}');

    await saveProjectToRoot('second', [{ relPath: 'c.koi', contents: '' }]);
    expect(pickCount).toBe(1); // root remembered, not re-picked
  });

  it('rejects a name that already exists under the root and writes nothing new', async () => {
    const root = new MockDir('koine');
    root.entries.set('dup', new MockDir('dup'));
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => root as unknown;

    await expect(saveProjectToRoot('dup', [{ relPath: 'a.koi', contents: 'x' }])).rejects.toThrow(/already exists/);
    expect((root.entries.get('dup') as MockDir).entries.size).toBe(0);
  });

  it('returns null when the root picker is dismissed', async () => {
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => {
      throw new DOMException('aborted', 'AbortError');
    };
    expect(await saveProjectToRoot('x', [{ relPath: 'a.koi', contents: '' }])).toBeNull();
  });

  it('reports the workspace root name once picked, null before', async () => {
    expect(await workspaceRootName()).toBeNull();
    const root = new MockDir('koine');
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => root as unknown;
    await saveProjectToRoot('p', [{ relPath: 'a.koi', contents: '' }]);
    expect(await workspaceRootName()).toBe('koine');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- src/host/browser/fs.test.ts`
Expected: FAIL — `saveProjectToRoot`/`workspaceRootName` are not exported.

- [ ] **Step 3: Implement the root persistence + save**

In `src/host/browser/fs.ts`, just below the `DEFAULT_WS_TOKEN` constant block (~line 201), add:

```ts
// The picked-once workspace root: a single directory handle (e.g. ~/koine) under which "Save to disk"
// writes named projects. Persisted in IndexedDB under a reserved key (parens can't appear in a real
// picked-folder name, so it never collides with a folder-name token — same trick as DEFAULT_WS_TOKEN).
const WORKSPACE_ROOT_KEY = '(workspace-root)';
let workspaceRoot: FsDirHandle | null = null;

/**
 * Resolve the remembered workspace root: the in-memory handle, else the IndexedDB-persisted handle
 * (re-granting permission under the calling click), else a one-time `showDirectoryPicker`. Returns
 * null only when the user dismisses that picker (or the API is unavailable).
 */
async function resolveWorkspaceRoot(): Promise<FsDirHandle | null> {
  if (workspaceRoot) return workspaceRoot;
  const stored = await idbGet(WORKSPACE_ROOT_KEY);
  if (stored) {
    const granted = stored.queryPermission
      ? (await stored.queryPermission({ mode: 'readwrite' })) === 'granted'
      : false;
    if (granted || !stored.requestPermission || (await stored.requestPermission({ mode: 'readwrite' })) === 'granted') {
      workspaceRoot = stored;
      return stored;
    }
    // Permission on the stored root was denied — fall through to let the user pick again.
  }
  if (!fsWin.showDirectoryPicker) return null;
  let dir: FsDirHandle;
  try {
    dir = await fsWin.showDirectoryPicker({ mode: 'readwrite' });
  } catch {
    return null; // user dismissed the picker
  }
  workspaceRoot = dir;
  await idbPut(WORKSPACE_ROOT_KEY, dir);
  return dir;
}

/** The remembered workspace root's display name (for Settings), or null before one is picked. */
export async function workspaceRootName(): Promise<string | null> {
  const root = workspaceRoot ?? (await idbGet(WORKSPACE_ROOT_KEY));
  return root ? root.name || null : null;
}

/**
 * Create `<root>/<name>/`, write `files` into it, and register it exactly like a folder opened via
 * the picker (token minted, handle persisted to IndexedDB) so it reopens through the normal
 * resolveFolder path and shows up reopenable in Recent. Returns the new folder token, or null when
 * the user dismissed the root picker. Throws `already exists` (writing nothing) on a name collision.
 */
export async function saveProjectToRoot(
  name: string,
  files: { relPath: string; contents: string }[],
): Promise<string | null> {
  assertName(name);
  const root = await resolveWorkspaceRoot();
  if (!root) return null;
  if (await entryExists(root, name)) throw new Error('already exists: ' + name);
  const projectDir = await root.getDirectoryHandle(name, { create: true });
  const token = await uniqueToken(name);
  folders.set(token, projectDir);
  folderNames.set(token, name);
  dirHandles.set(token, projectDir);
  for (const f of files) await createFile(token, f.relPath, f.contents);
  await idbPut(token, projectDir);
  return token;
}
```

Then extend `__resetFsForTest` (~line 715) to clear the cached root — add this line inside it:

```ts
  workspaceRoot = null;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/host/browser/fs.test.ts`
Expected: PASS (all four new tests + the existing suite).

- [ ] **Step 5: Commit**

```bash
git add src/host/browser/fs.ts src/host/browser/fs.test.ts
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "feat(studio): saveProjectToRoot — write a named project under a picked-once workspace root"
```

---

### Task 2: Platform surface — `types.ts`, browser wiring, Tauri stub

**Files:**
- Modify: `src/host/types.ts` (add 3 members to `interface Platform`, after `pickFolder` ~line 109)
- Modify: `src/host/browser/index.ts` (delegate to `fs.ts`)
- Modify: `src/host/tauri.ts` (stub: capability off)

**Interfaces:**
- Consumes: `fs.saveProjectToRoot`, `fs.workspaceRootName`, `fs.supported` from Task 1.
- Produces (on `interface Platform`):
  - `readonly canSaveProjects: boolean`
  - `saveProjectToRoot(name: string, files: { relPath: string; contents: string }[]): Promise<string | null>`
  - `workspaceRootName(): Promise<string | null>`

- [ ] **Step 1: Add the interface members**

In `src/host/types.ts`, immediately after the `pickFolder` declaration (~line 109), add:

```ts
  /**
   * Whether the host can save the current workspace as a real, reopenable on-disk project. True in
   * the browser when the File System Access API is present; false on the Tauri desktop for now.
   */
  readonly canSaveProjects: boolean;

  /**
   * Write the given files as a named project under the host's workspace root (picked once and
   * remembered), registering the new folder so it reopens like any opened folder. Returns the new
   * folder token, null when the user dismisses the root picker, and throws `already exists` on a
   * name collision. Browser-only today; the desktop stub returns null.
   */
  saveProjectToRoot(name: string, files: { relPath: string; contents: string }[]): Promise<string | null>;

  /** The remembered workspace root's display name (for Settings), or null before one is picked. */
  workspaceRootName(): Promise<string | null>;
```

- [ ] **Step 2: Wire the browser host**

In `src/host/browser/index.ts`, add `readonly canSaveProjects = fs.supported();` next to the existing `readonly canOpenFolders = fs.supported();` (~line 13), and add these methods (next to `pickFolder`, ~line 49):

```ts
  saveProjectToRoot(name: string, files: { relPath: string; contents: string }[]): Promise<string | null> {
    return fs.saveProjectToRoot(name, files);
  }

  workspaceRootName(): Promise<string | null> {
    return fs.workspaceRootName();
  }
```

- [ ] **Step 3: Stub the desktop host**

In `src/host/tauri.ts`, add `readonly canSaveProjects = false;` next to the other `readonly` capability flags, and add (near `pickFolder`, ~line 123):

```ts
  // Browser-first: desktop keeps "Open folder…". A ~/koine-style root here is a follow-up.
  saveProjectToRoot(): Promise<string | null> {
    return Promise.resolve(null);
  }

  workspaceRootName(): Promise<string | null> {
    return Promise.resolve(null);
  }
```

- [ ] **Step 4: Verify it compiles**

Run: `npm run build`
Expected: `tsc` passes (no missing-member errors on either Platform implementation), Vite build completes.

- [ ] **Step 5: Commit**

```bash
git add src/host/types.ts src/host/browser/index.ts src/host/tauri.ts
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "feat(studio): add canSaveProjects/saveProjectToRoot/workspaceRootName to the Platform seam"
```

---

### Task 3: `saveProjectToDisk()` orchestration + toolbar button + palette command

**Files:**
- Modify: `index.html` (add the toolbar button after `btn-generate-project`, ~line 40)
- Modify: `src/ide.tsx` (add `saveProjectToDisk()`; wire the button + palette command; hide when unsupported)
- Test: `src/ide.test.ts` (extend `APP_HTML`; add the fake-platform members; two tests)

**Interfaces:**
- Consumes: `platform.canSaveProjects`, `platform.saveProjectToRoot` (Task 2); `workspace.buffers` (a `Map<string, { relPath: string; text: string }>`), `workspace.syncActiveBuffer(doc)`, `workspace.openFolderPath(token, {recent})`; `editor.getDoc()`; `setStatus`; `el<T>(id)`.
- Produces: a `saveProjectToDisk(): Promise<void>` orchestration and a `save-project-to-disk` palette command.

- [ ] **Step 1: Write the failing tests**

In `src/ide.test.ts`:

(a) Add the button to the `APP_HTML` toolbar (the `tb-group` containing `btn-generate-project`, ~line 233):

```html
            <button type="button" id="btn-save-project">Save to disk</button>
```

(b) The in-memory fake Platform in this file must gain the new members. Find the fake-platform factory (the object implementing `Platform` that backs `fakePlatform.current`) and add:

```ts
    canSaveProjects: true,
    saveProjectToRoot: vi.fn(async (name: string, files: { relPath: string; contents: string }[]) => {
      // Seed the fake FS so the follow-up openFolderPath(token) reads the written files back.
      for (const f of files) store.set(`${name}/${f.relPath}`, f.contents);
      return name;
    }),
    workspaceRootName: vi.fn(async () => 'koine'),
```

(where `store` is the existing `Map<string,string>` the fake reads in `listKoiFiles`/`readTextFile`; if the fake's `listKoiFiles` derives entries from `store` keys prefixed by the folder token, the seeded `name/<relPath>` keys make the project openable. Match the file's existing fake shape.)

(c) Add the tests:

```ts
test('Save to disk writes the open buffers as a named project', async () => {
  await bootDefault(); // the file's existing helper that runs init() with a seeded default workspace
  const saveSpy = fakePlatform.current.saveProjectToRoot as ReturnType<typeof vi.fn>;
  vi.stubGlobal('prompt', vi.fn(() => 'my-pizzeria'));

  (document.getElementById('btn-save-project') as HTMLButtonElement).click();
  await flushAsync(); // the file's existing microtask-drain helper

  expect(saveSpy).toHaveBeenCalledTimes(1);
  const [name, files] = saveSpy.mock.calls[0];
  expect(name).toBe('my-pizzeria');
  expect(files.some((f: { relPath: string }) => f.relPath === 'model.koi')).toBe(true);
});

test('Save to disk does nothing when the name prompt is cancelled', async () => {
  await bootDefault();
  const saveSpy = fakePlatform.current.saveProjectToRoot as ReturnType<typeof vi.fn>;
  vi.stubGlobal('prompt', vi.fn(() => null));

  (document.getElementById('btn-save-project') as HTMLButtonElement).click();
  await flushAsync();

  expect(saveSpy).not.toHaveBeenCalled();
});

test('Save to disk button is hidden when the host cannot save projects', async () => {
  fakePlatform.current = { ...fakePlatform.current, canSaveProjects: false };
  await bootDefault();
  expect((document.getElementById('btn-save-project') as HTMLButtonElement).hidden).toBe(true);
});
```

> If `bootDefault`/`flushAsync` are named differently in this file, use the file's existing equivalents (it already boots `init()` and drains microtasks for other tests).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- src/ide.test.ts`
Expected: FAIL — no `btn-save-project` handler / `saveProjectToDisk` not wired.

- [ ] **Step 3: Add the toolbar button (production HTML)**

In `index.html`, inside the `tb-group` holding `btn-generate-project` (after line 40, before the closing `</div>` at line 41), add:

```html
            <button type="button" id="btn-save-project" title="Save this workspace as a project on disk">
              <svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3h7l3 3v7H3zM5 3v3h5M5 13v-4h6v4" /></svg>
              Save to disk
            </button>
```

- [ ] **Step 4: Implement `saveProjectToDisk()` and wire it**

In `src/ide.tsx`, add this function near `exportSourceZip` (~line 1127):

```ts
  // Save the current workspace as a real, reopenable on-disk project (browser host only). Promotes an
  // ephemeral example/Untitled workspace into <root>/<name>/, registers it in Recent, and reopens it
  // from disk so the workspace now IS that folder (further ⌘S writes there).
  async function saveProjectToDisk(): Promise<void> {
    if (!platform.canSaveProjects) return;
    // Flush the active editor's debounced text into its buffer so the snapshot is current.
    workspace.syncActiveBuffer(editor.getDoc());
    const files = [...workspace.buffers.values()].map((b) => ({ relPath: b.relPath, contents: b.text }));
    if (files.length === 0) {
      setStatus('nothing to save', 'error');
      return;
    }
    const suggested = workspace.folderRootToken() ? platform.folderName(workspace.folderRootToken()) : 'my-project';
    for (;;) {
      const name = window.prompt('Save project as:', suggested)?.trim();
      if (!name) return; // cancelled / empty
      try {
        const token = await platform.saveProjectToRoot(name, files);
        if (!token) return; // root picker dismissed
        await workspace.openFolderPath(token, { recent: true });
        setStatus('Project saved ✓', 'green');
        return;
      } catch (e) {
        if (String(e instanceof Error ? e.message : e).includes('already exists')) {
          window.alert(`A project named “${name}” already exists — choose another name.`);
          continue; // re-prompt
        }
        setStatus('save to disk failed', 'error');
        console.error('saveProjectToDisk failed:', e);
        return;
      }
    }
  }
```

Wire the toolbar button next to the `btn-generate-project` listener (~line 1178), and hide it when unsupported:

```ts
  const saveProjectBtn = el<HTMLButtonElement>('btn-save-project');
  saveProjectBtn.addEventListener('click', () => void saveProjectToDisk());
  if (!platform.canSaveProjects) saveProjectBtn.hidden = true;
```

Add the palette command to the `File` group in `getCommands()` (after the `export-source-zip` entry, ~line 1207) — gated so it doesn't appear on unsupported hosts:

```ts
      ...(platform.canSaveProjects
        ? [{ id: 'save-project-to-disk', title: 'Save to disk…', group: 'File', run: () => void saveProjectToDisk() } as Command]
        : []),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -- src/ide.test.ts`
Expected: PASS (the three new tests + the existing characterization suite stays green).

- [ ] **Step 6: Commit**

```bash
git add index.html src/ide.tsx src/ide.test.ts
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "feat(studio): Save to disk — promote the workspace to a named on-disk project"
```

---

### Task 4: `openFolderPath` returns a result + hides the welcome only on success (Fix 1)

**Files:**
- Modify: `src/workspaceController.ts` (the `WorkspaceController.openFolderPath` type ~line 120; the impl ~line 361)
- Test: `src/workspaceController.test.ts`

**Interfaces:**
- Produces: `type OpenResult = { ok: true } | { ok: false; reason: 'unreadable' | 'empty' }`, and `openFolderPath(folder, opts?): Promise<OpenResult>`.
- Consumes: the existing `deps.hideWelcome?.()`, `deps.setStatus`, `platform.listKoiFiles`.

**Note:** the welcome's recent-row click hides the start screen eagerly (`src/welcome.ts:354`), so this Fix-1 change alone does NOT keep the welcome up for a failed *recent* open — that recovery is Task 5. Fix 1 still matters: it stops the non-recent programmatic callers (`openExample`, share import, default boot) from flashing the editor on a failed open, and it gives Task 5 the typed `reason` it branches on.

- [ ] **Step 1: Write the failing tests**

In `src/workspaceController.test.ts`, inside the existing `describe('createWorkspaceController — opening a folder', …)` block, add (the file already builds a controller via `makeDeps(platform, lsp, editor, overrides)` and a fake `platform`):

```ts
  it('returns ok and hides the welcome only after a successful open', async () => {
    const hideWelcome = vi.fn();
    const platform = makePlatform(); // existing helper that lists/read ROOT's .koi files
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor, { hideWelcome }));
    const result = await ws.openFolderPath(ROOT, { recent: false });
    expect(result).toEqual({ ok: true });
    expect(hideWelcome).toHaveBeenCalledTimes(1);
  });

  it('reports an unreadable folder and does NOT hide the welcome', async () => {
    const hideWelcome = vi.fn();
    const platform = makePlatform();
    platform.listKoiFiles = vi.fn(async () => {
      throw new Error('this folder is no longer available — open it again');
    });
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor, { hideWelcome }));
    const result = await ws.openFolderPath(ROOT);
    expect(result).toEqual({ ok: false, reason: 'unreadable' });
    expect(hideWelcome).not.toHaveBeenCalled();
  });
```

> If `makeDeps` doesn't yet accept a `hideWelcome` override, add it to the overrides object it spreads (it already injects `onFolderOpened` the same way). If there's no `makePlatform` helper, build the fake inline mirroring the existing opening-a-folder test at line 207.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- src/workspaceController.test.ts`
Expected: FAIL — `openFolderPath` returns `undefined` (currently `Promise<void>`) and `hideWelcome` is called before the read.

- [ ] **Step 3: Change the type and the implementation**

In `src/workspaceController.ts`, add the result type near the top exports (after the `Buffer` interface ~line 33):

```ts
/** Outcome of an openFolderPath attempt, so callers (recent-open recovery) can react to a failure. */
export type OpenResult = { ok: true } | { ok: false; reason: 'unreadable' | 'empty' };
```

Update the interface member (~line 120):

```ts
  openFolderPath(folder: string, opts?: { recent?: boolean }): Promise<OpenResult>;
```

Rewrite the body of `openFolderPath` (~line 361). Specifically:
- **delete** the `deps.hideWelcome?.()` call at the very top (currently the first line, ~line 362),
- return a failure result at each early-return,
- hide the welcome and return success at the end.

```ts
  async function openFolderPath(folder: string, opts: { recent?: boolean } = {}): Promise<OpenResult> {
    let files: KoiFile[];
    try {
      files = await platform.listKoiFiles(folder);
    } catch (e) {
      deps.setStatus('could not read folder', 'error');
      console.error('listKoiFiles failed:', e);
      return { ok: false, reason: 'unreadable' };
    }
    if (!files.length) {
      deps.setStatus('no .koi files in folder', 'error');
      return { ok: false, reason: 'empty' };
    }

    // Re-opening a folder: close every previously open file first.
    for (const uri of Array.from(buffers.keys())) {
      lsp.closeDoc(uri);
    }
    buffers.clear();
    deps.clearDiagnostics();

    const records: { path: string; relPath: string; name: string; text: string }[] = [];
    for (const f of files) {
      let text: string;
      try {
        text = await platform.readTextFile(f.path);
      } catch (e) {
        console.error('readTextFile failed for', f.path, e);
        continue;
      }
      records.push({ path: f.path, relPath: f.relPath, name: f.name, text });
    }
    populateBuffers(records);

    if (buffers.size === 0) {
      deps.setStatus('could not read any files in folder', 'error');
      return { ok: false, reason: 'unreadable' };
    }

    folderRoot = folder;
    const first = Array.from(buffers.values()).sort((a, b) => a.relPath.localeCompare(b.relPath))[0];
    activeUriValue = first.uri;
    lsp.setActive(first.uri);
    editor.setDoc(first.text);
    deps.hideWelcome?.(); // dismiss the start screen only now that the open has succeeded
    deps.setFolderTitle?.(platform.folderName(folder));
    deps.showFileTreeChrome?.();
    if (opts.recent ?? true) deps.pushRecentFolder?.(folder);
    deps.onFolderOpened(folder, { recent: opts.recent ?? true });
    await refreshEntries();
    return { ok: true };
  }
```

> Leave `openDefaultWorkspaceFlow`, `openWorkspaceWith1File`, `openExample`, `importSharedWorkspace`, and the toolbar `openFolder` callers unchanged — they `await openFolderPath(...)` and ignore the return; TypeScript accepts the wider return type.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/workspaceController.test.ts`
Then the full build to confirm no caller broke on the type change: `npm run build`
Expected: PASS; build green.

- [ ] **Step 5: Commit**

```bash
git add src/workspaceController.ts src/workspaceController.test.ts
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "fix(studio): openFolderPath returns a result and hides the welcome only on success"
```

---

### Task 5: Recent-open recovery — re-show the welcome and offer Remove from Recent (Fix 2)

**Files:**
- Modify: `src/ide.tsx` (new `openRecentFolder`; rewire `onOpenRecent`; import `removeRecentFolder`)
- Test: `src/ide.test.ts`

**Interfaces:**
- Consumes: `workspace.openFolderPath` → `OpenResult` (Task 4); `welcome.show()`; `confirmDialog.ask`; `removeRecentFolder(path)` from `./store`; `platform.folderName(path)`.

- [ ] **Step 1: Write the failing test**

In `src/ide.test.ts` add:

```ts
test('clicking a Recent whose folder is gone keeps the start screen up and offers removal', async () => {
  // Seed one recent, then make its open fail as "unreadable".
  localStorage.setItem('koine.studio.recentFolders', JSON.stringify(['ghost']));
  fakePlatform.current = {
    ...fakePlatform.current,
    listKoiFiles: vi.fn(async () => {
      throw new Error('this folder is no longer available — open it again');
    }),
  };
  // Auto-confirm the "remove from Recent?" dialog.
  vi.stubGlobal('confirm', vi.fn(() => true)); // if confirmDialog is DOM-driven, click its OK via the helper the file uses

  await bootHome(); // existing helper that runs init() and shows the welcome; else init() then welcome.show()
  (document.querySelector('.koi-welcome-recent-open') as HTMLButtonElement).click();
  await flushAsync();

  // Start screen still present, and the dead recent was removed.
  expect(document.querySelector('.koi-welcome-recent')).not.toBeNull();
  expect(localStorage.getItem('koine.studio.recentFolders')).not.toContain('ghost');
});
```

> The confirm dialog in `overlay.ts` is DOM-driven, not `window.confirm`. Use whatever this file already does to resolve a `confirmDialog.ask(...)` (e.g. click the `.koi-confirm-btn` OK button after the click). If the file has no such helper, drive it: after the recent click and a microtask drain, `(document.querySelector('.koi-modal-footer button:last-child') as HTMLButtonElement).click()` to confirm, then drain again.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/ide.test.ts`
Expected: FAIL — today the recent open dismisses the welcome and never offers removal.

- [ ] **Step 3: Implement the recovery**

In `src/ide.tsx`, add `removeRecentFolder` to the existing `./store` import (it already imports `pushRecentFolder` at line 31):

```ts
  pushRecentFolder,
  removeRecentFolder,
```

Add the recovery function near `leaveHomeFor` (~line 978):

```ts
  // Open a folder from the Recent list, recovering gracefully when it's gone. The welcome's recent
  // row hides the start screen on click, so on failure we re-show it (never strand the user) and, for
  // a vanished folder/handle, offer to forget the entry.
  async function openRecentFolder(path: string): Promise<void> {
    const result = await workspace.openFolderPath(path);
    if (result.ok) return;
    welcome.show();
    if (result.reason === 'unreadable') {
      const forget = await confirmDialog.ask({
        title: `“${platform.folderName(path)}” is no longer available`,
        message: 'Its folder may have moved, been deleted, or had its permission revoked. Remove it from Recent?',
        confirmLabel: 'Remove from Recent',
        danger: true,
      });
      if (forget) {
        removeRecentFolder(path);
        welcome.show(); // rebuild the recent list without the removed entry
      }
    }
  }
```

Rewire the welcome callback (~line 985):

```ts
    onOpenRecent: (path) => void leaveHomeFor('Open this folder?', () => openRecentFolder(path)),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- src/ide.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ide.tsx src/ide.test.ts
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "fix(studio): recover from a dead Recent — keep the start screen and offer removal"
```

---

### Task 6: Settings — show the workspace root with a Change… action

**Files:**
- Modify: `src/host/types.ts`, `src/host/browser/index.ts`, `src/host/browser/fs.ts`, `src/host/tauri.ts` (a small `pickWorkspaceRoot` to re-pick)
- Modify: `src/prefs.ts` (a read row + Change button in Settings)
- Test: `src/host/browser/fs.test.ts`

**Interfaces:**
- Produces: `fs.pickWorkspaceRoot(): Promise<string | null>` (always prompts, sets + persists the root, returns its name) and the matching `Platform.pickWorkspaceRoot`.
- Consumes: `platform.workspaceRootName()` (Task 2), `platform.canSaveProjects`.

- [ ] **Step 1: Write the failing test**

In `src/host/browser/fs.test.ts`, add to the `describe('saveProjectToRoot / workspace root', …)` block:

```ts
  it('pickWorkspaceRoot re-prompts and updates the remembered root', async () => {
    const first = new MockDir('koine');
    const second = new MockDir('work');
    let pick = 0;
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => {
      pick++;
      return (pick === 1 ? first : second) as unknown;
    };
    await saveProjectToRoot('p', [{ relPath: 'a.koi', contents: '' }]); // picks `first`
    const name = await pickWorkspaceRoot(); // forces a re-pick → `second`
    expect(name).toBe('work');
    expect(await workspaceRootName()).toBe('work');
  });
```

(add `pickWorkspaceRoot` to the `from './fs'` import).

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/host/browser/fs.test.ts`
Expected: FAIL — `pickWorkspaceRoot` not exported.

- [ ] **Step 3: Implement `pickWorkspaceRoot` and surface it**

In `src/host/browser/fs.ts`, add after `workspaceRootName`:

```ts
/** Always prompt for a new workspace root, persist it, and return its name (null if dismissed). */
export async function pickWorkspaceRoot(): Promise<string | null> {
  if (!fsWin.showDirectoryPicker) return null;
  let dir: FsDirHandle;
  try {
    dir = await fsWin.showDirectoryPicker({ mode: 'readwrite' });
  } catch {
    return null;
  }
  workspaceRoot = dir;
  await idbPut(WORKSPACE_ROOT_KEY, dir);
  return dir.name || null;
}
```

Add to `Platform` (`types.ts`, after `workspaceRootName`):

```ts
  /** Re-pick the workspace root (Settings → Change…); returns its name, or null if dismissed/unsupported. */
  pickWorkspaceRoot(): Promise<string | null>;
```

Wire `BrowserPlatform` (`index.ts`): `pickWorkspaceRoot() { return fs.pickWorkspaceRoot(); }`.
Stub `TauriPlatform` (`tauri.ts`): `pickWorkspaceRoot(): Promise<string | null> { return Promise.resolve(null); }`.

In `src/prefs.ts`, in the Settings panel where host-dependent rows live (follow the existing MCP-row pattern that keys off a platform capability), add a row shown only when `platform.canSaveProjects`:
- a label "Workspace root" and a value populated from `await platform.workspaceRootName()` (or "Not set yet"),
- a "Change…" button calling `await platform.pickWorkspaceRoot()` and re-rendering the value.

Match the existing prefs row construction (the file already builds labelled rows with buttons for the MCP section). Keep it to a labelled value + one button.

- [ ] **Step 4: Run tests + build**

Run: `npm run test -- src/host/browser/fs.test.ts && npm run build`
Expected: PASS; build green (both Platform impls satisfy the new member).

- [ ] **Step 5: Commit**

```bash
git add src/host/types.ts src/host/browser/fs.ts src/host/browser/index.ts src/host/tauri.ts src/host/browser/fs.test.ts src/prefs.ts
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "feat(studio): show + change the workspace root in Settings"
```

---

### Task 7: Full-suite gate + browser-MCP acceptance

**Files:** none (verification only).

- [ ] **Step 1: Run the whole Studio test suite + build**

Run: `npm run test && npm run build`
Expected: all vitest suites PASS; `tsc` + Vite build succeed.

- [ ] **Step 2: Drive the motivating scenario in a real browser**

Start the dev server (WASM bundle already built): `npx vite --mode web` and open the served URL.
Then, with the browser MCP, walk the exact repro that started this work:
1. **Start from an example → Intermediate → Pizzeria.**
2. Click **Save to disk…**; at the picker choose/create a workspace-root folder; name the project `my-pizzeria`.
3. Confirm on disk: `<root>/my-pizzeria/` contains the 7 `.koi` files. Confirm the FILES title is now `my-pizzeria` and the status shows "Project saved ✓".
4. Edit a file, **⌘S**, confirm it writes into `<root>/my-pizzeria/` (not OPFS).
5. **Reload.** Open the start screen → `my-pizzeria` is in **Recent**.
6. Click it → it reopens from disk with the edit intact (browser may prompt to re-grant folder permission — that's expected).
7. **Dead-recent recovery:** with a recent present, revoke/move its folder (or clear the IndexedDB handle) and click it → the start screen stays up and offers **Remove from Recent**.

Expected: every step behaves as described — the original B1–B4 symptoms are gone.

- [ ] **Step 3: Final commit (if any verification-only doc/notes changed)**

No code change expected here. If the acceptance surfaced a fix, loop back to the relevant task rather than patching blindly.

---

## Self-Review

**Spec coverage:**
- New Platform surface (`canSaveProjects`, `saveProjectToRoot`, `workspaceRootName`) → Tasks 1–2. ✓
- Browser root persistence (reserved IndexedDB key, pick-once, permission re-grant) → Task 1. ✓
- Desktop stub (capability off) → Tasks 2, 6. ✓
- `saveProjectToDisk` orchestration, name prompt, collision re-prompt, `!canSaveProjects` hidden, toolbar + palette → Task 3. ✓
- Reopen Fix 1 (hide-on-success + typed result) → Task 4. ✓
- Reopen Fix 2 (re-show welcome + Remove from Recent; corrected for the welcome's eager hide) → Task 5. ✓
- Settings workspace-root surface → Task 6. ✓
- vitest coverage across fs/workspaceController/ide + browser-MCP acceptance → Tasks 1,3,4,5,6,7. ✓

**Placeholder scan:** no TBD/TODO; each code step carries real code. The two places that defer to "the file's existing helper" (`bootDefault`/`flushAsync`/`makePlatform`) name the concrete behavior to match and point at the existing test that demonstrates it — not open-ended placeholders.

**Type consistency:** `saveProjectToRoot(name, files: {relPath,contents}[]) → Promise<string|null>`, `workspaceRootName() → Promise<string|null>`, `pickWorkspaceRoot() → Promise<string|null>`, and `OpenResult = {ok:true}|{ok:false; reason:'unreadable'|'empty'}` are used identically across `fs.ts`, `types.ts`, both host impls, `workspaceController.ts`, and `ide.tsx`. `folderRootToken()`/`folderName()`/`openFolderPath()` names match their existing definitions.
