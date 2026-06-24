// Tests for the workspaceController — the buffers + open/save/dirty lifecycle extracted from
// ide.ts's init() (Task 5 of the ide.ts decomposition, issue #180). These assert OBSERVABLE
// behavior (per the Task 5 brief): opening a folder populates `buffers` + sets `activeUri`;
// `activateFile` flushes-then-swaps the editor doc and fires onActiveChanged; `saveActive` formats
// then writes and clears `dirty`; `saveAllDirty` writes every dirty buffer, leaves a failed write
// dirty, and reports the count (leaning on dirty.ts); the saveQueued / saveAllQueued re-entrancy
// guards drop a concurrent second call; and `applyWorkspaceEdit` edits the active buffer via the
// editor handle while patching non-active buffers and pushing them with lsp.syncDoc.
//
// The controller is driven with a fake `Platform` + an `lsp`/`editor` spy and a tiny seeded DOM,
// mirroring the in-memory fakes ide.test.ts / editorSession.test.ts use. The diagnostics accessors
// (showDiagnostics / dropDiagnostics / renameDiagnostics / clearDiagnostics) are spies — the
// controller calls them but does not own the cache (it lives in editorSession).
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import { createWorkspaceController, type WorkspaceControllerDeps } from '@/shell/workspaceController';
import { pathToFileUri } from '@/shell/ideUtils';
import type { FsEntry, KoiFile, Platform, SourceDoc } from '@/host/types';
import type { TextEdit, WorkspaceEdit } from '@/lsp/lsp';

// --- in-memory Platform ------------------------------------------------------
// A browser-like host backed by a Map<relPath, contents> under a single workspace folder. Implements
// exactly the surface the workspace open/save/mutation paths touch; unexercised desktop-only ops are
// left as harmless stubs. Tokens are `${ROOT}/${relPath}` so relOf round-trips them.
const ROOT = 'mem://workspace';

/** The file:// uri the controller keys a relPath under — via the SAME helper production uses, so the
 *  test never hand-rolls an encoding (pathToFileUri percent-encodes the token's characters). */
function uriOf(relPath: string): string {
  return pathToFileUri(`${ROOT}/${relPath}`);
}

class FakePlatform implements Platform {
  readonly kind = 'browser' as const;
  readonly canOpenFolders = true;
  readonly canSaveProjects = true;
  readonly persistsWorkspace = true;

  /** relPath (forward-slashed) -> UTF-8 contents. */
  files = new Map<string, string>();
  /** Paths whose writeTextFile must reject, to exercise the failed-write path of Save all. */
  failWrites = new Set<string>();
  writes: { path: string; contents: string }[] = [];

  private tokenFor(relPath: string): string {
    return `${ROOT}/${relPath}`;
  }
  private relOf(token: string): string {
    return token.startsWith(ROOT + '/') ? token.slice(ROOT.length + 1) : token;
  }

  createLspTransport(): never {
    throw new Error('not used');
  }
  appVersion(): Promise<string> {
    return Promise.resolve('0.0.0-test');
  }
  mcpEndpoint(): Promise<string | null> {
    return Promise.resolve(null);
  }
  mcpStop(): Promise<void> {
    return Promise.resolve();
  }
  openExternal(): void {}
  pickFolder(): Promise<string | null> {
    return Promise.resolve(null);
  }
  saveProjectToRoot(_name: string, _files: { relPath: string; contents: string }[]): Promise<string | null> {
    return Promise.resolve(null);
  }
  workspaceRootName(): Promise<string | null> {
    return Promise.resolve(null);
  }
  pickWorkspaceRoot(): Promise<string | null> {
    return Promise.resolve(null);
  }
  materializeWorkspace(_name: string, files: { relPath: string; contents: string }[]): Promise<string | null> {
    this.files.clear();
    for (const f of files) this.files.set(f.relPath, f.contents);
    return Promise.resolve(ROOT);
  }
  defaultWorkspace(seed: string): Promise<string | null> {
    if (this.files.size === 0) this.files.set('model.koi', seed);
    return Promise.resolve(ROOT);
  }
  folderName(): string {
    return 'workspace';
  }
  listKoiFiles(): Promise<KoiFile[]> {
    const out: KoiFile[] = [];
    for (const relPath of this.files.keys()) {
      if (!relPath.toLowerCase().endsWith('.koi')) continue;
      out.push({ path: this.tokenFor(relPath), name: relPath.split('/').pop()!, relPath });
    }
    out.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return Promise.resolve(out);
  }
  readTextFile(path: string): Promise<string> {
    const rel = this.relOf(path);
    if (!this.files.has(rel)) return Promise.reject(new Error(`no such file: ${path}`));
    return Promise.resolve(this.files.get(rel)!);
  }
  writeTextFile(path: string, contents: string): Promise<void> {
    if (this.failWrites.has(this.relOf(path))) return Promise.reject(new Error(`write failed: ${path}`));
    this.files.set(this.relOf(path), contents);
    this.writes.push({ path, contents });
    return Promise.resolve();
  }
  saveZip(): Promise<boolean> {
    return Promise.resolve(true);
  }
  readFolderSources(): Promise<SourceDoc[]> {
    return Promise.resolve([]);
  }
  listEntries(): Promise<FsEntry[]> {
    const out: FsEntry[] = [];
    for (const relPath of this.files.keys()) {
      if (!relPath.toLowerCase().endsWith('.koi')) continue;
      out.push({ token: this.tokenFor(relPath), name: relPath.split('/').pop()!, relPath, kind: 'file' });
    }
    out.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return Promise.resolve(out);
  }
  listDir(): Promise<FsEntry[]> {
    return Promise.reject(new Error('listDir not used'));
  }
  createFile(_folderToken: string, relPath: string, contents = ''): Promise<string> {
    this.files.set(relPath, contents);
    return Promise.resolve(this.tokenFor(relPath));
  }
  createFolder(_folderToken: string, relPath: string): Promise<string> {
    return Promise.resolve(this.tokenFor(relPath));
  }
  renameEntry(token: string, newName: string): Promise<string> {
    const rel = this.relOf(token);
    const text = this.files.get(rel);
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
    const newRel = parent + newName;
    if (text != null) {
      this.files.delete(rel);
      this.files.set(newRel, text);
    }
    return Promise.resolve(this.tokenFor(newRel));
  }
  deleteEntry(token: string): Promise<void> {
    this.files.delete(this.relOf(token));
    return Promise.resolve();
  }
  moveEntry(): Promise<string> {
    return Promise.reject(new Error('moveEntry not used'));
  }
}

// --- LSP spy -----------------------------------------------------------------
// Records the order of flush vs the editor doc swap (the behaviour-critical activateFile ordering)
// and the sync/open/close traffic the workspace lifecycle drives.
function makeLsp(trace: string[]) {
  return {
    openDoc: vi.fn((_uri: string, _text: string) => {}),
    closeDoc: vi.fn((_uri: string) => {}),
    changeDoc: vi.fn((_uri: string, _text: string) => {}),
    syncDoc: vi.fn((_uri: string, _text: string) => {}),
    setActive: vi.fn((_uri: string) => {}),
    flush: vi.fn(() => trace.push('flush')),
    didSave: vi.fn(() => {}),
    format: vi.fn(async (): Promise<TextEdit[]> => []),
  };
}
type Lsp = ReturnType<typeof makeLsp>;

// --- editor handle spy -------------------------------------------------------
// A minimal stand-in for the KoineEditor handle the workspace drives (setDoc/getDoc/applyEdits).
// getDoc returns the last setDoc value so activateFile's "save the leaving buffer's text" works.
function makeEditor(trace: string[]) {
  let doc = '';
  return {
    getDoc: vi.fn(() => doc),
    setDoc: vi.fn((d: string) => {
      doc = d;
      trace.push('setDoc');
    }),
    applyEdits: vi.fn((_edits: TextEdit[]) => {}),
  };
}
type Editor = ReturnType<typeof makeEditor>;

function makeDeps(
  platform: FakePlatform,
  lsp: Lsp,
  editor: Editor,
  overrides: Partial<WorkspaceControllerDeps> = {},
): WorkspaceControllerDeps {
  return {
    platform: platform as unknown as Platform,
    lsp: lsp as unknown as WorkspaceControllerDeps['lsp'],
    editor: editor as unknown as WorkspaceControllerDeps['editor'],
    explorer: { render: vi.fn() },
    setStatus: vi.fn(),
    refreshDirtyIndicator: vi.fn(),
    showDiagnostics: vi.fn(),
    invalidateDocViews: vi.fn(),
    dropDiagnostics: vi.fn(),
    renameDiagnostics: vi.fn(),
    clearDiagnostics: vi.fn(),
    getFormatOnSave: () => false,
    onFolderOpened: vi.fn(),
    onWorkspaceEmptied: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('createWorkspaceController — opening a folder', () => {
  test('populates buffers + opens the LSP docs + activates the first file', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    platform.files.set('b.koi', 'context B {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const onFolderOpened = vi.fn();
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor, { onFolderOpened }));

    await ws.openFolderPath(ROOT, { recent: false });

    // Both files became open buffers, keyed by their file:// uri.
    expect(ws.buffers.size).toBe(2);
    // The first file by relPath ('a.koi') is the active one and seeded into the editor.
    expect(ws.activeUri()).toBe(uriOf('a.koi'));
    expect(editor.setDoc).toHaveBeenCalledWith('context A {}\n');
    // Each file was opened on the LSP so cross-file refs resolve.
    expect(lsp.openDoc).toHaveBeenCalledTimes(2);
    expect(lsp.setActive).toHaveBeenCalledWith(uriOf('a.koi'));
    // The folder-opened hook fired so ide.ts can restore context / refresh surfaces.
    expect(onFolderOpened).toHaveBeenCalledTimes(1);
  });

  it('returns ok and hides the welcome only after a successful open', async () => {
    const hideWelcome = vi.fn();
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor, { hideWelcome }));
    const result = await ws.openFolderPath(ROOT, { recent: false });
    expect(result).toEqual({ ok: true });
    expect(hideWelcome).toHaveBeenCalledTimes(1);
  });

  it('reports an unreadable folder and does NOT hide the welcome', async () => {
    const hideWelcome = vi.fn();
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    platform.listKoiFiles = vi.fn(async () => {
      throw new Error('this folder is no longer available — open it again');
    });
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor, { hideWelcome }));
    const result = await ws.openFolderPath(ROOT);
    expect(result).toEqual({ ok: false, reason: 'unreadable' });
    expect(hideWelcome).not.toHaveBeenCalled();
  });

  it('reports an empty folder and does NOT hide the welcome', async () => {
    const hideWelcome = vi.fn();
    const platform = new FakePlatform();
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    platform.listKoiFiles = vi.fn(async () => []);
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor, { hideWelcome }));
    const result = await ws.openFolderPath(ROOT, { recent: false });
    expect(result).toEqual({ ok: false, reason: 'empty' });
    expect(hideWelcome).not.toHaveBeenCalled();
  });

  test('openWorkspaceWith1File materializes a 1-file workspace and opens it', async () => {
    const platform = new FakePlatform();
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor));

    await ws.openWorkspaceWith1File('context Shared {}\n');

    expect(platform.files.get('model.koi')).toBe('context Shared {}\n');
    expect(ws.buffers.size).toBe(1);
    expect(editor.setDoc).toHaveBeenCalledWith('context Shared {}\n');
  });
});

describe('createWorkspaceController — reset', () => {
  test('closes every open doc, clears buffers + the diagnostics cache, and does NOT re-open', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    platform.files.set('b.koi', 'context B {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const deps = makeDeps(platform, lsp, editor);
    const ws = createWorkspaceController(deps);
    await ws.openFolderPath(ROOT, { recent: false });
    expect(ws.buffers.size).toBe(2);
    const openedUris = Array.from(ws.buffers.keys());
    lsp.closeDoc.mockClear();

    ws.reset();

    // Buffers + diagnostics are torn down unconditionally — even though no new workspace was opened.
    // This is the New-model invariant the old ide.ts enforced inline before openFolderPath: stale
    // buffers/diagnostics cannot survive a subsequent open that early-returns on an empty folder.
    expect(ws.buffers.size).toBe(0);
    for (const uri of openedUris) expect(lsp.closeDoc).toHaveBeenCalledWith(uri);
    expect(deps.clearDiagnostics).toHaveBeenCalled();
  });
});

describe('createWorkspaceController — activateFile', () => {
  test('flushes the leaving file BEFORE swapping the doc, then fires onActiveChanged', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    platform.files.set('b.koi', 'context B {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor));
    const active: string[] = [];
    ws.onActiveChanged((uri) => active.push(uri));

    await ws.openFolderPath(ROOT, { recent: false });
    const bUri = uriOf('b.koi');
    // Clear the boot-time setDoc so the trace below captures only the switch.
    trace.length = 0;
    ws.activateFile(bUri);

    expect(ws.activeUri()).toBe(bUri);
    // flush() must run before the editor doc swap (the leaving file's debounced edits are sent first).
    expect(trace).toEqual(['flush', 'setDoc']);
    expect(editor.setDoc).toHaveBeenLastCalledWith('context B {}\n');
    // The active-changed seam fired with the new uri (ide.ts wires showDiagnostics + doc-view refresh).
    expect(active).toEqual([bUri]);
  });

  test('activating the already-active file is a no-op', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor));
    await ws.openFolderPath(ROOT, { recent: false });
    const active: string[] = [];
    ws.onActiveChanged((uri) => active.push(uri));

    ws.activateFile(ws.activeUri());

    expect(active).toEqual([]);
    expect(lsp.flush).not.toHaveBeenCalled();
  });
});

describe('createWorkspaceController — saveActive', () => {
  test('formats then writes the active buffer to disk and clears its dirty flag', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const formatEdit: TextEdit[] = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '' },
    ];
    lsp.format.mockResolvedValue(formatEdit);
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor, { getFormatOnSave: () => true }));
    await ws.openFolderPath(ROOT, { recent: false });

    // Dirty the active buffer (mirrors an edit having flowed through syncActiveBuffer).
    editor.setDoc('context A { value V { x: Int } }\n');
    ws.syncActiveBuffer('context A { value V { x: Int } }\n');
    expect(ws.anyDirty()).toBe(true);

    await ws.saveActive();

    // Format-on-save ran (edits applied through the editor) then the post-format text was written.
    expect(lsp.format).toHaveBeenCalledTimes(1);
    expect(editor.applyEdits).toHaveBeenCalledWith(formatEdit);
    expect(platform.writes[platform.writes.length - 1].contents).toBe('context A { value V { x: Int } }\n');
    // The buffer is clean again and the server was told it saved.
    expect(ws.anyDirty()).toBe(false);
    expect(lsp.didSave).toHaveBeenCalled();
  });

  test('the saveQueued guard drops a concurrent second call', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    // A slow format keeps the first saveActive in flight so the second call overlaps it.
    let releaseFormat!: () => void;
    lsp.format.mockReturnValue(new Promise<TextEdit[]>((res) => (releaseFormat = () => res([]))));
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor, { getFormatOnSave: () => true }));
    await ws.openFolderPath(ROOT, { recent: false });

    const first = ws.saveActive();
    const second = ws.saveActive(); // re-enters while the first is awaiting format → dropped
    releaseFormat();
    await Promise.all([first, second]);

    // Exactly one save ran (one format, one write), proving the second call was dropped.
    expect(lsp.format).toHaveBeenCalledTimes(1);
    expect(platform.writes.length).toBe(1);
  });
});

describe('createWorkspaceController — saveAllDirty', () => {
  test('writes every dirty buffer, leaves a failed write dirty, and reports the count', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    platform.files.set('b.koi', 'context B {}\n');
    platform.files.set('c.koi', 'context C {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const setStatus = vi.fn();
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor, { setStatus }));
    await ws.openFolderPath(ROOT, { recent: false });

    // Dirty b and c (a stays clean); make c's write fail.
    const bUri = uriOf('b.koi');
    const cUri = uriOf('c.koi');
    ws.buffers.get(bUri)!.dirty = true;
    ws.buffers.get(cUri)!.dirty = true;
    platform.failWrites.add('c.koi');

    await ws.saveAllDirty();

    // b saved (clean now); c's write failed so it stays dirty; the status reports the failure count.
    expect(ws.buffers.get(bUri)!.dirty).toBe(false);
    expect(ws.buffers.get(cUri)!.dirty).toBe(true);
    expect(setStatus).toHaveBeenCalledWith(expect.stringContaining('Save failed for 1 file'), 'error');
  });

  test('the saveAllQueued guard drops a concurrent second call', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    let releaseFormat!: () => void;
    lsp.format.mockReturnValue(new Promise<TextEdit[]>((res) => (releaseFormat = () => res([]))));
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor, { getFormatOnSave: () => true }));
    await ws.openFolderPath(ROOT, { recent: false });
    ws.buffers.get(ws.activeUri())!.dirty = true;

    const first = ws.saveAllDirty();
    const second = ws.saveAllDirty();
    releaseFormat();
    await Promise.all([first, second]);

    expect(lsp.format).toHaveBeenCalledTimes(1);
    expect(platform.writes.length).toBe(1);
  });
});

describe('createWorkspaceController — applyWorkspaceEdit', () => {
  test('edits the active buffer via the editor handle and patches non-active buffers + lsp.syncDoc', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'AAAA\n');
    platform.files.set('b.koi', 'BBBB\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor));
    await ws.openFolderPath(ROOT, { recent: false });

    const aUri = uriOf('a.koi');
    const bUri = uriOf('b.koi');
    expect(ws.activeUri()).toBe(aUri);

    const activeEdits: TextEdit[] = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'X' },
    ];
    const otherEdits: TextEdit[] = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'Y' },
    ];
    const edit: WorkspaceEdit = { changes: { [aUri]: activeEdits, [bUri]: otherEdits } };
    ws.applyWorkspaceEdit(edit);

    // The active file is edited through the editor (undo history + the onChange sync path).
    expect(editor.applyEdits).toHaveBeenCalledWith(activeEdits);
    // The non-active file is patched in place and pushed to the server immediately.
    const bBuf = ws.buffers.get(bUri)!;
    expect(bBuf.text).toBe('YBBB\n');
    expect(bBuf.dirty).toBe(true);
    expect(lsp.syncDoc).toHaveBeenCalledWith(bUri, 'YBBB\n');
  });
});

describe('createWorkspaceController — handleDelete', () => {
  test('closing the active file falls back to another open buffer (showDiagnostics + invalidateDocViews, no onActiveChanged)', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    platform.files.set('b.koi', 'context B {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const showDiagnostics = vi.fn();
    const invalidateDocViews = vi.fn();
    const dropDiagnostics = vi.fn();
    const ws = createWorkspaceController(
      makeDeps(platform, lsp, editor, { showDiagnostics, invalidateDocViews, dropDiagnostics }),
    );
    await ws.openFolderPath(ROOT, { recent: false });
    // a.koi is active; track onActiveChanged so we can prove the fallback does NOT fire it.
    const active: string[] = [];
    ws.onActiveChanged((uri) => active.push(uri));
    showDiagnostics.mockClear();
    invalidateDocViews.mockClear();

    const aUri = uriOf('a.koi');
    const bUri = uriOf('b.koi');
    await ws.handleDelete({ token: `${ROOT}/a.koi`, name: 'a.koi', relPath: 'a.koi', kind: 'file' });

    // a.koi's buffer + diagnostics are dropped; b.koi is the new active file.
    expect(ws.buffers.has(aUri)).toBe(false);
    expect(dropDiagnostics).toHaveBeenCalledWith(aUri);
    expect(ws.activeUri()).toBe(bUri);
    // The fallback repaints via showDiagnostics + invalidateDocViews, and deliberately does NOT fire
    // the heavier onActiveChanged seam (no followActiveFileContext) — matching the old activateFallback.
    expect(showDiagnostics).toHaveBeenCalledWith(bUri);
    expect(invalidateDocViews).toHaveBeenCalled();
    expect(active).toEqual([]);
  });

  test('deleting the last file empties the workspace and asks ide.ts for a new model', async () => {
    const platform = new FakePlatform();
    platform.files.set('only.koi', 'context Only {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const onWorkspaceEmptied = vi.fn();
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor, { onWorkspaceEmptied }));
    await ws.openFolderPath(ROOT, { recent: false });

    await ws.handleDelete({ token: `${ROOT}/only.koi`, name: 'only.koi', relPath: 'only.koi', kind: 'file' });

    expect(ws.buffers.size).toBe(0);
    expect(onWorkspaceEmptied).toHaveBeenCalledTimes(1);
  });
});

describe('createWorkspaceController — anyDirty', () => {
  test('reflects whether any open buffer is dirty', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor));
    await ws.openFolderPath(ROOT, { recent: false });

    expect(ws.anyDirty()).toBe(false);
    ws.buffers.get(ws.activeUri())!.dirty = true;
    expect(ws.anyDirty()).toBe(true);
  });
});

describe('createWorkspaceController — listWorkspaceFiles', () => {
  // Make the host walk apply fs.ts's SKIP_DIRS, so the test proves listWorkspaceFiles surfaces a
  // skip-list-filtered walk (the controller delegates the skip-list to the host, like listKoiFiles).
  function withSkipList(platform: FakePlatform): void {
    const SKIP = ['bin', 'obj', '.git', 'node_modules'];
    platform.listKoiFiles = vi.fn(async () => {
      const out: KoiFile[] = [];
      for (const rel of platform.files.keys()) {
        if (!rel.toLowerCase().endsWith('.koi')) continue;
        if (rel.split('/').some((seg) => SKIP.includes(seg))) continue;
        out.push({ path: `${ROOT}/${rel}`, name: rel.split('/').pop()!, relPath: rel });
      }
      out.sort((a, b) => a.relPath.localeCompare(b.relPath));
      return out;
    });
  }

  test('returns the .koi uris under the open folder, excluding skip-list dirs', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    platform.files.set('sub/b.koi', 'context B {}\n');
    platform.files.set('.git/c.koi', 'context C {}\n'); // VCS dir — skipped
    platform.files.set('bin/d.koi', 'context D {}\n'); // build dir — skipped
    withSkipList(platform);
    const ws = createWorkspaceController(makeDeps(platform, makeLsp([]), makeEditor([])));
    await ws.openFolderPath(ROOT, { recent: false });

    expect(await ws.listWorkspaceFiles()).toEqual([uriOf('a.koi'), uriOf('sub/b.koi')]);
  });

  test('returns [] when no folder is open', async () => {
    const platform = new FakePlatform();
    const ws = createWorkspaceController(makeDeps(platform, makeLsp([]), makeEditor([])));
    expect(await ws.listWorkspaceFiles()).toEqual([]);
  });

  test('an include glob narrows the result to matching paths', async () => {
    const platform = new FakePlatform();
    platform.files.set('src/order.koi', 'x');
    platform.files.set('docs/notes.koi', 'x');
    withSkipList(platform);
    const ws = createWorkspaceController(makeDeps(platform, makeLsp([]), makeEditor([])));
    await ws.openFolderPath(ROOT, { recent: false });

    expect(await ws.listWorkspaceFiles('src/*.koi')).toEqual([uriOf('src/order.koi')]);
  });
});
