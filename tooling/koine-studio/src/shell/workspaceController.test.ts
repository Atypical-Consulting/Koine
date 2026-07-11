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
import {
  createWorkspaceController,
  type Buffer,
  type WorkspaceController,
  type WorkspaceControllerDeps,
} from '@/shell/workspaceController';
import { createAppStore } from '@/store/index';
import { pathToFileUri } from '@/shell/ideUtils';
import { newFileKey } from '@/ai/editSession';
import { getLastSession, setLastSession, getRecentFolders, pushRecentFolder, removeRecentFolder } from '@/settings/persistence';
import type { FsEntry, GitLogEntry, GitNumstatEntry, GitStatus, KoiFile, McpEndpoint, Platform, SourceDoc } from '@/host/types';
import type { TextEdit, WorkspaceEdit } from '@/lsp/lsp';

// --- in-memory Platform ------------------------------------------------------
// A browser-like host backed by a per-root Map<relPath, contents>. Implements exactly the surface the
// workspace open/save/mutation paths touch; unexercised desktop-only ops are left as harmless stubs.
// Tokens are `${root}/${relPath}` so relOf round-trips them.
//
// The fake is ROOT-AWARE so the multi-root tests (addRoot / removeRoot) can open TWO distinct roots and
// prove buffers stay namespaced per root. For backward compatibility with the original single-root
// tests, `files` is a live alias of the primary `ROOT` bucket: `platform.files.set('a.koi', …)` seeds
// `ROOT` exactly as before, and every op resolves a token's owning root by longest matching prefix.
const ROOT = 'mem://workspace';
const ROOT_A = 'mem://wsA';
const ROOT_B = 'mem://wsB';

/** The file:// uri the controller keys a relPath under, under the primary ROOT — via the SAME helper
 *  production uses, so the test never hand-rolls an encoding (pathToFileUri percent-encodes the token). */
function uriOf(relPath: string): string {
  return pathToFileUri(`${ROOT}/${relPath}`);
}

/** The file:// uri for a relPath under an arbitrary root token (for the multi-root tests). */
function uriUnder(root: string, relPath: string): string {
  return pathToFileUri(`${root}/${relPath}`);
}

class FakePlatform implements Platform {
  readonly kind = 'browser' as const;
  readonly canHostMcp = false;
  readonly compatNeedsInProcessSources = true;
  readonly usesServiceWorker = true;
  readonly canOpenFolders = true;
  readonly canSaveProjects = true;
  readonly canRunShell = false;
  // Declared `boolean` (not the `false` literal) so the GitCapablePlatform subclass below can override it
  // to `true` for the #1016 branch-capture tests without a TS2416 literal-narrowing mismatch.
  readonly canUseGit: boolean = false;
  readonly canRevealInFileManager = false;
  readonly persistsWorkspace = true;

  /** Per-root store: rootToken -> (relPath -> UTF-8 contents). */
  roots = new Map<string, Map<string, string>>();
  /** Live alias of the primary ROOT bucket so existing tests' `platform.files.set('a.koi', …)` work. */
  readonly files: Map<string, string>;
  /** relPaths (under ROOT) whose writeTextFile must reject, to exercise Save all's failed-write path. */
  failWrites = new Set<string>();
  writes: { path: string; contents: string }[] = [];

  constructor() {
    const primary = new Map<string, string>();
    this.roots.set(ROOT, primary);
    this.files = primary;
  }

  /** Seed a (root, relPath) entry — the multi-root tests use this to populate ROOT_A / ROOT_B. */
  seed(root: string, relPath: string, contents: string): void {
    let bucket = this.roots.get(root);
    if (!bucket) {
      bucket = new Map<string, string>();
      this.roots.set(root, bucket);
    }
    bucket.set(relPath, contents);
  }

  /** The root token a path lives under (longest matching prefix), defaulting to ROOT for a bare relPath. */
  private rootOf(token: string): string {
    let best = '';
    for (const root of this.roots.keys()) {
      if ((token === root || token.startsWith(root + '/')) && root.length > best.length) best = root;
    }
    return best || ROOT;
  }
  private relOf(token: string): string {
    const root = this.rootOf(token);
    return token.startsWith(root + '/') ? token.slice(root.length + 1) : token;
  }

  createLspTransport(): never {
    throw new Error('not used');
  }
  appVersion(): Promise<string> {
    return Promise.resolve('0.0.0-test');
  }
  mcpEndpoint(): Promise<McpEndpoint | null> {
    return Promise.resolve(null);
  }
  mcpStop(): Promise<void> {
    return Promise.resolve();
  }
  openExternal(): void {}
  revealPath(): Promise<void> {
    return Promise.resolve();
  }
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
  isAutoRestorableToken(token: string): Promise<boolean> {
    return Promise.resolve(token === '(default)' || token.startsWith('example-'));
  }
  folderName(token?: string): string {
    return token ? token.split('/').pop()! : 'workspace';
  }
  listKoiFiles(folder: string): Promise<KoiFile[]> {
    const bucket = this.roots.get(folder);
    const out: KoiFile[] = [];
    if (bucket) {
      for (const relPath of bucket.keys()) {
        if (!relPath.toLowerCase().endsWith('.koi')) continue;
        out.push({ path: `${folder}/${relPath}`, name: relPath.split('/').pop()!, relPath });
      }
    }
    out.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return Promise.resolve(out);
  }
  readTextFile(path: string): Promise<string> {
    const root = this.rootOf(path);
    const rel = this.relOf(path);
    const bucket = this.roots.get(root);
    if (!bucket || !bucket.has(rel)) return Promise.reject(new Error(`no such file: ${path}`));
    return Promise.resolve(bucket.get(rel)!);
  }
  gitLogForRange(): Promise<null> {
    return Promise.resolve(null);
  }
  // git is a desktop-only capability (#272); this browser-like fake reports canUseGit=false, so the
  // source-control methods are never reached. They reject so a test that forgot to guard fails loudly.
  private gitUnavailable(): Promise<never> {
    return Promise.reject(new Error('git is unavailable in this fake host'));
  }
  gitStatus(_folder: string): Promise<GitStatus> {
    return this.gitUnavailable();
  }
  gitDiff(): Promise<string> {
    return this.gitUnavailable();
  }
  gitNumstat(): Promise<GitNumstatEntry[]> {
    return this.gitUnavailable();
  }
  gitStage(): Promise<void> {
    return this.gitUnavailable();
  }
  gitUnstage(): Promise<void> {
    return this.gitUnavailable();
  }
  gitDiscard(): Promise<void> {
    return this.gitUnavailable();
  }
  gitCommit(): Promise<void> {
    return this.gitUnavailable();
  }
  gitPush(): Promise<void> {
    return this.gitUnavailable();
  }
  gitFetch(): Promise<void> {
    return this.gitUnavailable();
  }
  gitPull(): Promise<void> {
    return this.gitUnavailable();
  }
  gitRevert(): Promise<void> {
    return this.gitUnavailable();
  }
  gitBranches(): Promise<string[]> {
    return this.gitUnavailable();
  }
  gitCheckout(): Promise<void> {
    return this.gitUnavailable();
  }
  gitLog(): Promise<GitLogEntry[]> {
    return this.gitUnavailable();
  }
  gitInit(): Promise<void> {
    return this.gitUnavailable();
  }
  gitClone(): Promise<string> {
    return this.gitUnavailable();
  }
  writeTextFile(path: string, contents: string): Promise<void> {
    const rel = this.relOf(path);
    if (this.failWrites.has(rel)) return Promise.reject(new Error(`write failed: ${path}`));
    const bucket = this.roots.get(this.rootOf(path))!;
    bucket.set(rel, contents);
    this.writes.push({ path, contents });
    return Promise.resolve();
  }
  saveZip(): Promise<boolean> {
    return Promise.resolve(true);
  }
  readFolderSources(): Promise<SourceDoc[]> {
    return Promise.resolve([]);
  }
  listEntries(folder: string): Promise<FsEntry[]> {
    const bucket = this.roots.get(folder);
    const out: FsEntry[] = [];
    if (bucket) {
      for (const relPath of bucket.keys()) {
        if (!relPath.toLowerCase().endsWith('.koi')) continue;
        out.push({ token: `${folder}/${relPath}`, name: relPath.split('/').pop()!, relPath, kind: 'file' });
      }
    }
    out.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return Promise.resolve(out);
  }
  listDir(): Promise<FsEntry[]> {
    return Promise.reject(new Error('listDir not used'));
  }
  createFile(folderToken: string, relPath: string, contents = ''): Promise<string> {
    (this.roots.get(folderToken) ?? this.files).set(relPath, contents);
    return Promise.resolve(`${folderToken}/${relPath}`);
  }
  createFolder(folderToken: string, relPath: string): Promise<string> {
    return Promise.resolve(`${folderToken}/${relPath}`);
  }
  renameEntry(token: string, newName: string): Promise<string> {
    const root = this.rootOf(token);
    const bucket = this.roots.get(root)!;
    const rel = this.relOf(token);
    const text = bucket.get(rel);
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
    const newRel = parent + newName;
    if (text != null) {
      bucket.delete(rel);
      bucket.set(newRel, text);
    }
    return Promise.resolve(`${root}/${newRel}`);
  }
  deleteEntry(token: string): Promise<void> {
    this.roots.get(this.rootOf(token))!.delete(this.relOf(token));
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
    explorer: { renderRoots: vi.fn() },
    setStatus: vi.fn(),
    // #982: the controller writes workspace state THROUGH the store (its single owner). Each test gets a
    // fresh vanilla store; the parity test passes its own via `overrides.store` so it can read it back.
    store: createAppStore(),
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

// Test-only helper: `ws.buffers` is read-only (#1010) — write a buffer's fields the same way
// production code must (ide.tsx's `writeBuffer` wiring), through the store's `upsertBuffer`, never by
// mutating the Map's Buffer objects in place. `deps` is the same object passed to
// `createWorkspaceController`, so its `store` is the one `ws` actually reads/writes.
function writeBuffer(
  deps: WorkspaceControllerDeps,
  ws: WorkspaceController,
  uri: string,
  patch: Partial<Pick<Buffer, 'text' | 'dirty'>>,
): void {
  const buf = ws.buffers.get(uri);
  if (buf) deps.store.getState().upsertBuffer({ ...buf, ...patch });
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
    // openFolderPath catches the injected listKoiFiles rejection and logs it; silence the expected error.
    vi.spyOn(console, 'error').mockImplementation(() => {});
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

  it('an empty folder STILL raises the red error when no workspace is loaded (#627)', async () => {
    const platform = new FakePlatform();
    const setStatus = vi.fn();
    platform.listKoiFiles = vi.fn(async () => []);
    const ws = createWorkspaceController(makeDeps(platform, makeLsp([]), makeEditor([]), { setStatus }));
    const result = await ws.openFolderPath(ROOT, { recent: false });
    // Cold/empty workspace (buffers.size === 0): the genuine "you picked an empty folder" error stays.
    expect(result).toEqual({ ok: false, reason: 'empty' });
    expect(setStatus).toHaveBeenCalledWith('no .koi files in folder', 'error');
  });

  it('an empty re-scan does NOT clobber the status of an already-loaded workspace (#627)', async () => {
    const platform = new FakePlatform();
    platform.seed(ROOT_A, 'a.koi', 'context A {}\n');
    const setStatus = vi.fn();
    const ws = createWorkspaceController(makeDeps(platform, makeLsp([]), makeEditor([]), { setStatus }));
    await ws.openFolderPath(ROOT_A, { recent: false }); // a healthy workspace is loaded (buffers.size === 1)
    expect(ws.buffers.size).toBe(1);
    setStatus.mockClear();

    // A late/empty folder listing returns zero .koi files while the clean workspace is still loaded —
    // exactly the materialized-example race in #627 (compile-green renders, then an empty scan arrives).
    platform.listKoiFiles = vi.fn(async () => []);
    const result = await ws.openFolderPath(ROOT, { recent: false });

    // The caller still learns the listing was empty, but the global red status is NOT raised: the
    // loaded workspace's healthy status must survive (no false "no .koi files in folder" clobber).
    expect(result).toEqual({ ok: false, reason: 'empty' });
    expect(setStatus).not.toHaveBeenCalledWith('no .koi files in folder', 'error');
    // And the loaded workspace is untouched — the empty branch returns before the reset/clear.
    expect(ws.buffers.size).toBe(1);
  });

  it('user-initiated open of an empty folder with a workspace loaded calls the notify dep and returns reason:empty (#817)', async () => {
    const platform = new FakePlatform();
    platform.seed(ROOT_A, 'a.koi', 'context A {}\n');
    const notify = vi.fn();
    const setStatus = vi.fn();
    const ws = createWorkspaceController(makeDeps(platform, makeLsp([]), makeEditor([]), { setStatus, notify }));
    await ws.openFolderPath(ROOT_A, { recent: false }); // load a healthy workspace (buffers.size === 1)
    expect(ws.buffers.size).toBe(1);
    setStatus.mockClear();

    // The user explicitly picks a folder that happens to contain no .koi files.
    platform.listKoiFiles = vi.fn(async () => []);
    const result = await ws.openFolderPath(ROOT, { recent: false, userInitiated: true });

    expect(result).toEqual({ ok: false, reason: 'empty' });
    // The notify dep was called so the user gets non-clobbering feedback.
    expect(notify).toHaveBeenCalledWith('no .koi files in folder');
    // The global red setStatus must NOT fire (it would clobber the healthy compiled status).
    expect(setStatus).not.toHaveBeenCalledWith('no .koi files in folder', 'error');
    // The loaded workspace is untouched — the empty branch returns before the reset/clear.
    expect(ws.buffers.size).toBe(1);
  });

  it('non-user-initiated empty open with a workspace loaded emits NO notification (the #627 silent path preserved, #817)', async () => {
    const platform = new FakePlatform();
    platform.seed(ROOT_A, 'a.koi', 'context A {}\n');
    const notify = vi.fn();
    const setStatus = vi.fn();
    const ws = createWorkspaceController(makeDeps(platform, makeLsp([]), makeEditor([]), { setStatus, notify }));
    await ws.openFolderPath(ROOT_A, { recent: false }); // load a healthy workspace
    setStatus.mockClear();

    // A boot/late re-scan calls openFolderPath WITHOUT userInitiated (the #627 path).
    platform.listKoiFiles = vi.fn(async () => []);
    const result = await ws.openFolderPath(ROOT, { recent: false }); // userInitiated absent/false

    expect(result).toEqual({ ok: false, reason: 'empty' });
    // Neither notify NOR the global red setStatus should fire — stay silent, as today (#627 guard).
    expect(notify).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalledWith('no .koi files in folder', 'error');
    expect(ws.buffers.size).toBe(1);
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

describe('createWorkspaceController — rememberLastWorkspace (#535)', () => {
  test('a successful openFolderPath remembers the opened token as the last workspace', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    const trace: string[] = [];
    const rememberLastWorkspace = vi.fn();
    const ws = createWorkspaceController(
      makeDeps(platform, makeLsp(trace), makeEditor(trace), { rememberLastWorkspace }),
    );

    await ws.openFolderPath(ROOT); // default opts → recent (the toolbar / recent-row / example path)

    expect(rememberLastWorkspace).toHaveBeenCalledWith(ROOT);
  });

  test('a transient openWorkspaceWith1File does NOT remember the workspace', async () => {
    const platform = new FakePlatform();
    const trace: string[] = [];
    const rememberLastWorkspace = vi.fn();
    const ws = createWorkspaceController(
      makeDeps(platform, makeLsp(trace), makeEditor(trace), { rememberLastWorkspace }),
    );

    await ws.openWorkspaceWith1File('context Shared {}\n');

    expect(rememberLastWorkspace).not.toHaveBeenCalled();
  });
});

describe('createWorkspaceController — recent-folder language tag (#1015)', () => {
  test('tags the recent with the JUST-opened folder\'s effective emit target, not the previous one', async () => {
    const platform = new FakePlatform();
    platform.seed(ROOT_A, 'a.koi', 'context A {}\n');
    platform.seed(ROOT_B, 'b.koi', 'context B {}\n');
    const trace: string[] = [];
    const store = createAppStore();
    const pushRecentFolder = vi.fn();
    // Mimics ide.tsx's real onFolderOpened: it synchronously applies the JUST-opened folder's own
    // effective previewTarget into the store (applyEffectiveScoped → setEmitTarget) BEFORE returning.
    // Folder A's workspace overrides to 'typescript'; folder B has no override (falls back to the
    // 'csharp' default) — so opening B right after A must tag B's recent 'csharp', not A's 'typescript'.
    const targetByFolder: Record<string, string> = { [ROOT_A]: 'typescript', [ROOT_B]: 'csharp' };
    const onFolderOpened = vi.fn((folder: string) => {
      store.getState().setEmitTarget(targetByFolder[folder]);
    });
    const ws = createWorkspaceController(
      makeDeps(platform, makeLsp(trace), makeEditor(trace), { store, onFolderOpened, pushRecentFolder }),
    );

    await ws.openFolderPath(ROOT_A, { recent: true });
    await ws.openFolderPath(ROOT_B, { recent: true });

    const callForB = pushRecentFolder.mock.calls.find(([folder]) => folder === ROOT_B);
    expect(callForB?.[1]).toEqual(expect.objectContaining({ language: 'csharp' }));
  });
});

// A desktop-like host that reports canUseGit=true so openFolderPath's non-blocking branch capture runs.
// `gitStatus` is overridden per-test with a controllable promise so we can resolve it AFTER a later open,
// reproducing the #1016 race (A's deferred git resolves once B is the active root).
class GitCapablePlatform extends FakePlatform {
  readonly canUseGit = true;
  // gitStatus is inherited from FakePlatform (now a 1-arg stub matching the Platform interface); each
  // test reassigns platform.gitStatus with a controllable vi.fn to drive the branch-capture race.
}

describe('createWorkspaceController — deferred branch capture guard (#1016)', () => {
  test('an async git resolve for a NO-LONGER-active root does not reorder recents or add a branch', async () => {
    localStorage.clear();
    const platform = new GitCapablePlatform();
    platform.seed(ROOT_A, 'a.koi', 'context A {}\n');
    platform.seed(ROOT_B, 'b.koi', 'context B {}\n');
    let resolveGitA!: (s: GitStatus) => void;
    const gitA = new Promise<GitStatus>((res) => {
      resolveGitA = res;
    });
    // A's git status stays pending until we release it; B's resolves immediately.
    platform.gitStatus = vi.fn((folder: string) =>
      folder === ROOT_A ? gitA : Promise.resolve({ branch: 'branchB' } as GitStatus),
    );
    // The synchronous recents write goes through the REAL pushRecentFolder so recents live in localStorage.
    const ws = createWorkspaceController(makeDeps(platform, makeLsp([]), makeEditor([]), { pushRecentFolder }));

    await ws.openFolderPath(ROOT_A, { recent: true }); // A added to recents; A's git pending
    await ws.openFolderPath(ROOT_B, { recent: true }); // B added → B is now the most-recent + active root

    // A's git status resolves LATE, after B superseded it as the active root.
    resolveGitA({ branch: 'branchA' } as GitStatus);
    await Promise.resolve();
    await Promise.resolve();

    const recents = getRecentFolders();
    // B stays first — A's late resolve must NOT float A back to the front (no reorder).
    expect(recents[0]?.path).toBe(ROOT_B);
    // And A never got its branch tag: the guard skipped it because A is no longer the active root.
    expect(recents.find((r) => r.path === ROOT_A)?.branch).toBeUndefined();
  });

  test('an async git resolve for a REMOVED entry does not resurrect it', async () => {
    localStorage.clear();
    const platform = new GitCapablePlatform();
    platform.seed(ROOT_A, 'a.koi', 'context A {}\n');
    let resolveGitA!: (s: GitStatus) => void;
    const gitA = new Promise<GitStatus>((res) => {
      resolveGitA = res;
    });
    platform.gitStatus = vi.fn(() => gitA);
    const ws = createWorkspaceController(makeDeps(platform, makeLsp([]), makeEditor([]), { pushRecentFolder }));

    await ws.openFolderPath(ROOT_A, { recent: true }); // A added; A's git pending; A is still the active root
    expect(getRecentFolders().map((r) => r.path)).toContain(ROOT_A);

    removeRecentFolder(ROOT_A); // the user removes A from Home BEFORE its git status resolves
    expect(getRecentFolders()).toEqual([]);

    resolveGitA({ branch: 'branchA' } as GitStatus); // A's git resolves late
    await Promise.resolve();
    await Promise.resolve();

    // A is still the active root (roots[0] === ROOT_A), but the metadata patch no-ops on an absent path —
    // so a just-removed entry is never re-added by the deferred enrichment.
    expect(getRecentFolders()).toEqual([]);
  });

  test('the happy path still tags the branch when the folder stays the active root', async () => {
    localStorage.clear();
    const platform = new GitCapablePlatform();
    platform.seed(ROOT_A, 'a.koi', 'context A {}\n');
    platform.gitStatus = vi.fn(() => Promise.resolve({ branch: 'main' } as GitStatus));
    const ws = createWorkspaceController(makeDeps(platform, makeLsp([]), makeEditor([]), { pushRecentFolder }));

    await ws.openFolderPath(ROOT_A, { recent: true });
    await Promise.resolve();
    await Promise.resolve();

    // The branch enrichment lands on the still-active root, and (being a metadata patch) leaves it on top.
    const recents = getRecentFolders();
    expect(recents[0]?.path).toBe(ROOT_A);
    expect(recents[0]?.branch).toBe('main');
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

describe('createWorkspaceController — bulk buffer writes are O(N) (#1012)', () => {
  test('a fresh N-file open rebuilds the buffer Map in ONE bulk write, not one copy per file', async () => {
    const store = createAppStore();
    const platform = new FakePlatform();
    for (let i = 0; i < 6; i++) platform.files.set(`f${i}.koi`, `context F${i} {}\n`);
    const ws = createWorkspaceController(makeDeps(platform, makeLsp([]), makeEditor([]), { store }));

    // Count ONLY the buffer-Map-changing notifications (isolate them from activeUri / roots / seq churn).
    let bufferNotifications = 0;
    const unsub = store.subscribe((s, prev) => {
      if (s.buffers !== prev.buffers) bufferNotifications++;
    });
    await ws.openFolderPath(ROOT, { recent: false });
    unsub();

    // Same OBSERVABLE result as the per-file path: all six files buffered, first-by-relPath active.
    expect(ws.buffers.size).toBe(6);
    expect(ws.activeUri()).toBe(uriOf('f0.koi'));
    // But the Map was replaced in a SINGLE bulk update, not six growing-Map copies (#1012): the count
    // is bounded by a small constant, NOT proportional to the file count.
    expect(bufferNotifications).toBeLessThanOrEqual(2);
  });

  test('reset clears the buffer set in ONE bulk update while still closing every LSP doc', async () => {
    const store = createAppStore();
    const platform = new FakePlatform();
    for (let i = 0; i < 6; i++) platform.files.set(`f${i}.koi`, `context F${i} {}\n`);
    const lsp = makeLsp([]);
    const ws = createWorkspaceController(makeDeps(platform, lsp, makeEditor([]), { store }));
    await ws.openFolderPath(ROOT, { recent: false });
    expect(ws.buffers.size).toBe(6);
    lsp.closeDoc.mockClear();

    let bufferNotifications = 0;
    const unsub = store.subscribe((s, prev) => {
      if (s.buffers !== prev.buffers) bufferNotifications++;
    });
    ws.reset();
    unsub();

    // Per-doc LSP didClose stays (one per file), but the buffer set empties in a SINGLE store update.
    expect(lsp.closeDoc).toHaveBeenCalledTimes(6);
    expect(ws.buffers.size).toBe(0);
    expect(bufferNotifications).toBe(1);
  });

  test('switching folders replaces the buffer set in one bulk write (old files gone, new files in)', async () => {
    const store = createAppStore();
    const platform = new FakePlatform();
    platform.seed(ROOT_A, 'a1.koi', 'context A1 {}\n');
    platform.seed(ROOT_A, 'a2.koi', 'context A2 {}\n');
    platform.seed(ROOT_B, 'b1.koi', 'context B1 {}\n');
    platform.seed(ROOT_B, 'b2.koi', 'context B2 {}\n');
    platform.seed(ROOT_B, 'b3.koi', 'context B3 {}\n');
    const ws = createWorkspaceController(makeDeps(platform, makeLsp([]), makeEditor([]), { store }));
    await ws.openFolderPath(ROOT_A, { recent: false });
    expect(ws.buffers.size).toBe(2);

    let bufferNotifications = 0;
    const unsub = store.subscribe((s, prev) => {
      if (s.buffers !== prev.buffers) bufferNotifications++;
    });
    await ws.openFolderPath(ROOT_B, { recent: false });
    unsub();

    // A clean REPLACE: ROOT_A's buffers are gone, only ROOT_B's three remain (no union with the old set).
    expect(ws.buffers.size).toBe(3);
    expect(ws.buffers.has(uriUnder(ROOT_A, 'a1.koi'))).toBe(false);
    expect(ws.buffers.has(uriUnder(ROOT_B, 'b1.koi'))).toBe(true);
    // Teardown-clear + one bulk populate — bounded, not ∝ (old N + new N).
    expect(bufferNotifications).toBeLessThanOrEqual(2);
  });
});

describe('createWorkspaceController — activateFile', () => {
  test('flushes the leaving file BEFORE swapping the doc, then bumps activationSeq (the activation seam)', async () => {
    const store = createAppStore();
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    platform.files.set('b.koi', 'context B {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor, { store }));

    await ws.openFolderPath(ROOT, { recent: false });
    const bUri = uriOf('b.koi');
    const seq0 = store.getState().activationSeq; // folder open is silent — no bump
    // Clear the boot-time setDoc so the trace below captures only the switch.
    trace.length = 0;
    ws.activateFile(bUri);

    expect(ws.activeUri()).toBe(bUri);
    // flush() must run before the editor doc swap (the leaving file's debounced edits are sent first).
    expect(trace).toEqual(['flush', 'setDoc']);
    expect(editor.setDoc).toHaveBeenLastCalledWith('context B {}\n');
    // The active-changed seam is now a slice bump: activationSeq advanced by exactly one and the slice
    // holds the new active uri (ide.ts subscribes to activationSeq → showDiagnostics + doc-view refresh).
    expect(store.getState().activationSeq).toBe(seq0 + 1);
    expect(store.getState().activeUri).toBe(bUri);
  });

  test('activating the already-active file is a no-op', async () => {
    const store = createAppStore();
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor, { store }));
    await ws.openFolderPath(ROOT, { recent: false });
    const seq0 = store.getState().activationSeq;

    ws.activateFile(ws.activeUri());

    // No switch: activationSeq is untouched and flush never ran.
    expect(store.getState().activationSeq).toBe(seq0);
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

  // Regression: lsp.format() targets the buffer active at REQUEST time, but nothing re-checked the
  // active uri when the response landed — a file switch during the round-trip applied a.koi's edits
  // into b.koi's document (positions.ts clamps them silently) and then wrote b.koi to disk, while
  // a.koi (the file the user saved) was never written.
  test('a format response landing after a file switch is discarded and the ORIGINAL buffer is saved', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    platform.files.set('b.koi', 'context B {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    let releaseFormat!: () => void;
    const staleEdits: TextEdit[] = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } }, newText: 'GARBLED' },
    ];
    lsp.format.mockReturnValue(new Promise<TextEdit[]>((res) => (releaseFormat = () => res(staleEdits))));
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor, { getFormatOnSave: () => true }));
    await ws.openFolderPath(ROOT, { recent: false });
    const aUri = ws.activeUri(); // a.koi (first by relPath)
    editor.setDoc('context A { edited }\n');
    ws.syncActiveBuffer('context A { edited }\n');

    const save = ws.saveActive();
    ws.activateFile(uriOf('b.koi')); // the user clicks b.koi while the format request is in flight
    releaseFormat();
    await save;

    // The stale edits — computed for a.koi — were NOT applied into b.koi's document…
    expect(editor.applyEdits).not.toHaveBeenCalled();
    // …and the buffer written is the one active at request time (a.koi), with ITS text; b.koi untouched.
    expect(platform.writes).toHaveLength(1);
    expect(platform.writes[0].path).toBe(`${ROOT}/a.koi`);
    expect(platform.writes[0].contents).toBe('context A { edited }\n');
    expect(ws.buffers.get(aUri)!.dirty).toBe(false);
  });

  // Regression: the dirty flag was cleared unconditionally AFTER the awaited disk write, so keystrokes
  // landing while the write was in flight were marked saved even though they never hit disk.
  test('keystrokes landing while the disk write is in flight keep the buffer dirty', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    // Gate the write so an edit can land while it is in flight.
    const origWrite = platform.writeTextFile.bind(platform);
    let releaseWrite!: () => void;
    const gate = new Promise<void>((res) => (releaseWrite = res));
    platform.writeTextFile = async (path: string, contents: string) => {
      await gate;
      return origWrite(path, contents);
    };
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor));
    await ws.openFolderPath(ROOT, { recent: false });
    const aUri = ws.activeUri();
    editor.setDoc('context A { v1 }\n');
    ws.syncActiveBuffer('context A { v1 }\n');

    const save = ws.saveActive(); // synchronous until the awaited (gated) write
    editor.setDoc('context A { v2 }\n');
    ws.syncActiveBuffer('context A { v2 }\n'); // a keystroke lands mid-write
    releaseWrite();
    await save;

    // v1 hit disk, but the buffer now holds v2 — it must still count as unsaved.
    expect(platform.writes[0].contents).toBe('context A { v1 }\n');
    expect(ws.buffers.get(aUri)!.dirty).toBe(true);
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

  // Regression (#1009): lsp.didSave() targets the LSP's *current* active doc (no uri argument), but the
  // trailing call was unconditional — a buffer switch landing during the awaited disk write made it
  // notify the server about the NEWLY-active document, not the one saveActive actually wrote.
  test('a buffer switch during the write is in flight skips didSave for the newly-active document', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    platform.files.set('b.koi', 'context B {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    // Gate the write so the active buffer can switch while it is in flight.
    const origWrite = platform.writeTextFile.bind(platform);
    let releaseWrite!: () => void;
    const gate = new Promise<void>((res) => (releaseWrite = res));
    platform.writeTextFile = async (path: string, contents: string) => {
      await gate;
      return origWrite(path, contents);
    };
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor));
    await ws.openFolderPath(ROOT, { recent: false });
    editor.setDoc('context A { edited }\n');
    ws.syncActiveBuffer('context A { edited }\n');

    const save = ws.saveActive(); // synchronous until the awaited (gated) write
    ws.activateFile(uriOf('b.koi')); // switch away from a.koi while the write is in flight
    releaseWrite();
    await save;

    // a.koi was written to disk, but the active doc moved to b.koi before didSave fired — the server
    // must not be told b.koi (which was NOT saved) is now clean.
    expect(platform.writes[0].contents).toBe('context A { edited }\n');
    expect(lsp.didSave).not.toHaveBeenCalled();
  });

  test('no buffer switch: saveActive still calls didSave for the saved document', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor));
    await ws.openFolderPath(ROOT, { recent: false });
    editor.setDoc('context A { edited }\n');
    ws.syncActiveBuffer('context A { edited }\n');

    await ws.saveActive();

    expect(lsp.didSave).toHaveBeenCalledTimes(1);
  });

  // Regression (#1009 code-review follow-up): a keystroke landing mid-write on the SAME (never
  // switched) buffer leaves it dirty again by the time the write resolves — the guard must check
  // freshness (mirrors the markSaved check just above it), not just that the uri never switched.
  test('a keystroke on the same buffer during the write skips didSave (content went stale)', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const origWrite = platform.writeTextFile.bind(platform);
    let releaseWrite!: () => void;
    const gate = new Promise<void>((res) => (releaseWrite = res));
    platform.writeTextFile = async (path: string, contents: string) => {
      await gate;
      return origWrite(path, contents);
    };
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor));
    await ws.openFolderPath(ROOT, { recent: false });
    const aUri = ws.activeUri();
    editor.setDoc('context A { v1 }\n');
    ws.syncActiveBuffer('context A { v1 }\n');

    const save = ws.saveActive(); // synchronous until the awaited (gated) write
    editor.setDoc('context A { v2 }\n');
    ws.syncActiveBuffer('context A { v2 }\n'); // a keystroke lands mid-write — no buffer switch
    releaseWrite();
    await save;

    // v1 hit disk, but the buffer now holds v2 (dirty again) — the server must not be told the
    // (now-stale) active document was just saved.
    expect(ws.buffers.get(aUri)!.dirty).toBe(true);
    expect(lsp.didSave).not.toHaveBeenCalled();
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
    const deps = makeDeps(platform, lsp, editor, { setStatus });
    const ws = createWorkspaceController(deps);
    await ws.openFolderPath(ROOT, { recent: false });

    // Dirty b and c (a stays clean); make c's write fail.
    const bUri = uriOf('b.koi');
    const cUri = uriOf('c.koi');
    writeBuffer(deps, ws, bUri, { dirty: true });
    writeBuffer(deps, ws, cUri, { dirty: true });
    platform.failWrites.add('c.koi');

    // saveAllDirty logs the injected c.koi write failure; silence the expected error.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await ws.saveAllDirty();

    // b saved (clean now); c's write failed so it stays dirty; the status reports the failure count.
    expect(ws.buffers.get(bUri)!.dirty).toBe(false);
    expect(ws.buffers.get(cUri)!.dirty).toBe(true);
    expect(setStatus).toHaveBeenCalledWith(expect.stringContaining('Save failed for 1 file'), 'error');
  });

  // Same stale-format-response regression as saveActive, on the Save-all path (which is also the
  // auto-save path): edits computed for the file active at request time must not be applied into
  // whatever document the editor shows when the response lands.
  test('a format response landing after a file switch is discarded (Save all / auto-save path)', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    platform.files.set('b.koi', 'context B {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    let releaseFormat!: () => void;
    lsp.format.mockReturnValue(
      new Promise<TextEdit[]>((res) =>
        (releaseFormat = () =>
          res([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } }, newText: 'GARBLED' }])),
      ),
    );
    const deps = makeDeps(platform, lsp, editor, { getFormatOnSave: () => true });
    const ws = createWorkspaceController(deps);
    await ws.openFolderPath(ROOT, { recent: false });
    writeBuffer(deps, ws, ws.activeUri(), { dirty: true });

    const save = ws.saveAllDirty();
    ws.activateFile(uriOf('b.koi')); // switch while the format request is in flight
    releaseFormat();
    await save;

    expect(editor.applyEdits).not.toHaveBeenCalled();
  });

  test('the saveAllQueued guard drops a concurrent second call', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    let releaseFormat!: () => void;
    lsp.format.mockReturnValue(new Promise<TextEdit[]>((res) => (releaseFormat = () => res([]))));
    const deps = makeDeps(platform, lsp, editor, { getFormatOnSave: () => true });
    const ws = createWorkspaceController(deps);
    await ws.openFolderPath(ROOT, { recent: false });
    writeBuffer(deps, ws, ws.activeUri(), { dirty: true });

    const first = ws.saveAllDirty();
    const second = ws.saveAllDirty();
    releaseFormat();
    await Promise.all([first, second]);

    expect(lsp.format).toHaveBeenCalledTimes(1);
    expect(platform.writes.length).toBe(1);
  });

  // Regression (#982): buffers are now REPLACED per edit (immutable), so a save-all loop that snapshots
  // the buffer OBJECTS up front would write stale text for a buffer edited mid-save. It must re-read each
  // buffer's LIVE text at write time (as the old in-place dirty.ts save-all helper did).
  test('persists each buffer’s LATEST text — a keystroke on a not-yet-written buffer during an earlier write is not lost', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'A0\n');
    platform.files.set('b.koi', 'B0\n');
    const trace: string[] = [];
    const editor = makeEditor(trace);
    const ws = createWorkspaceController(makeDeps(platform, makeLsp(trace), editor));
    await ws.openFolderPath(ROOT, { recent: false });
    const bUri = uriOf('b.koi');
    // Dirty the active A (via the editor) and the background B (uri-keyed sync).
    editor.setDoc('A1\n');
    ws.syncActiveBuffer('A1\n');
    ws.syncBuffer(bUri, 'B1\n');

    // Gate A's disk write (a.koi sorts first) so B can be edited while A is in flight.
    const origWrite = platform.writeTextFile.bind(platform);
    let releaseA!: () => void;
    const aGate = new Promise<void>((res) => (releaseA = res));
    platform.writeTextFile = async (path: string, contents: string) => {
      if (path === `${ROOT}/a.koi`) await aGate;
      return origWrite(path, contents);
    };

    const save = ws.saveAllDirty();
    ws.syncBuffer(bUri, 'B2\n'); // the user keeps typing in B while A's write is in flight
    releaseA();
    await save;

    // B is persisted with its LATEST text (B2), not the B1 snapshot captured when Save-all began.
    expect(platform.writes.find((w) => w.path === `${ROOT}/b.koi`)!.contents).toBe('B2\n');
  });

  // Regression (#1009): the trailing lsp.didSave() fired unconditionally once any buffer saved, even
  // though it targets the LSP's current active doc — a switch to a buffer NOT part of this save pass
  // (mid-loop, while another buffer's write is still in flight) must not tell the server that buffer
  // was saved.
  test('a buffer switch mid-loop to a non-saved buffer skips the trailing didSave', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    platform.files.set('b.koi', 'context B {}\n');
    platform.files.set('c.koi', 'context C {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    // Gate a.koi's write (it sorts first) so the active buffer can switch to c.koi — which is never
    // dirtied and so never saved this pass — while a's write is still in flight.
    const origWrite = platform.writeTextFile.bind(platform);
    let releaseA!: () => void;
    const aGate = new Promise<void>((res) => (releaseA = res));
    platform.writeTextFile = async (path: string, contents: string) => {
      if (path === `${ROOT}/a.koi`) await aGate;
      return origWrite(path, contents);
    };
    const deps = makeDeps(platform, lsp, editor);
    const ws = createWorkspaceController(deps);
    await ws.openFolderPath(ROOT, { recent: false });
    const cUri = uriOf('c.koi');
    writeBuffer(deps, ws, uriOf('b.koi'), { dirty: true });
    editor.setDoc('context A { edited }\n');
    ws.syncActiveBuffer('context A { edited }\n'); // dirties the active buffer, a.koi

    const save = ws.saveAllDirty(); // writes a.koi (gated), then b.koi
    ws.activateFile(cUri); // switch to c.koi — not part of this save pass — while a's write is in flight
    releaseA();
    await save;

    // Both dirty buffers hit disk…
    expect(platform.writes.some((w) => w.path === `${ROOT}/a.koi`)).toBe(true);
    expect(platform.writes.some((w) => w.path === `${ROOT}/b.koi`)).toBe(true);
    // …but the buffer active when the loop finished (c.koi) was never saved this pass, so the server
    // must not be told it is clean.
    expect(lsp.didSave).not.toHaveBeenCalled();
  });

  test('no buffer switch: saveAllDirty still calls didSave once for the saved buffers', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    platform.files.set('b.koi', 'context B {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const deps = makeDeps(platform, lsp, editor);
    const ws = createWorkspaceController(deps);
    await ws.openFolderPath(ROOT, { recent: false });
    writeBuffer(deps, ws, uriOf('b.koi'), { dirty: true });

    await ws.saveAllDirty();

    expect(lsp.didSave).toHaveBeenCalledTimes(1);
  });

  // Regression (#1055 — sibling gap left by #1009/#1052): the OLD `current === activeUri` fallback
  // fired didSave() whenever nothing switched during the pass, with zero regard for whether the active
  // buffer's own write (when it was itself part of this pass) actually landed. If the active buffer's
  // write throws while a different dirty buffer succeeds, and no switch occurs, the server must not be
  // told the active (still-dirty) document was saved.
  test('the active buffer failing its own write (no switch) skips the trailing didSave', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    platform.files.set('b.koi', 'context B {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const deps = makeDeps(platform, lsp, editor);
    const ws = createWorkspaceController(deps);
    await ws.openFolderPath(ROOT, { recent: false });
    const aUri = ws.activeUri(); // a.koi stays active throughout — no switch occurs
    const bUri = uriOf('b.koi');
    writeBuffer(deps, ws, aUri, { dirty: true });
    writeBuffer(deps, ws, bUri, { dirty: true });
    platform.failWrites.add('a.koi'); // the ACTIVE buffer's own write fails; b's write succeeds

    // saveAllDirty logs the injected a.koi write failure; silence the expected error.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await ws.saveAllDirty();

    expect(ws.buffers.get(aUri)!.dirty).toBe(true); // still dirty — its write failed
    expect(ws.buffers.get(bUri)!.dirty).toBe(false); // b saved fine
    expect(lsp.didSave).not.toHaveBeenCalled();
  });

  // Regression (#1009 code-review follow-up): a switch INTO a buffer that this pass wrote — but that
  // gets re-dirtied by a keystroke before its own write is confirmed — must not be treated as
  // confirmed saved just because its uri is in the written set; savedUris membership requires the
  // SAME freshness check saveActive/markSaved use, not merely "the write didn't throw".
  test('a switch to a buffer that goes stale before its write is confirmed skips didSave', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    platform.files.set('b.koi', 'context B {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    // Gate b.koi's write so the active buffer can switch to it and be re-dirtied before it resolves.
    const origWrite = platform.writeTextFile.bind(platform);
    let releaseB!: () => void;
    const bGate = new Promise<void>((res) => (releaseB = res));
    platform.writeTextFile = async (path: string, contents: string) => {
      if (path === `${ROOT}/b.koi`) await bGate;
      return origWrite(path, contents);
    };
    const deps = makeDeps(platform, lsp, editor);
    const ws = createWorkspaceController(deps);
    await ws.openFolderPath(ROOT, { recent: false });
    const bUri = uriOf('b.koi');
    writeBuffer(deps, ws, bUri, { dirty: true }); // b is dirty in the background; a (active) stays clean

    const save = ws.saveAllDirty(); // writes b.koi (gated)
    ws.activateFile(bUri); // switch to b while its write is in flight
    ws.syncBuffer(bUri, 'context B { edited again }\n'); // re-dirty b before its write resolves
    releaseB();
    await save;

    // b.koi's write DID hit disk (with the pre-edit text), but b is dirty again by the time the pass
    // finishes — the server must not be told the active (still-dirty) document was saved.
    expect(platform.writes.some((w) => w.path === `${ROOT}/b.koi`)).toBe(true);
    expect(ws.buffers.get(bUri)!.dirty).toBe(true);
    expect(lsp.didSave).not.toHaveBeenCalled();
  });

  // The two remaining cells of the didSave-eligibility table (#1055 Task 2) not otherwise pinned above:
  // the active buffer itself being part of this pass and confirmed clean (no switch) fires, and a
  // switch TO a buffer already confirmed saved earlier in the same pass still fires.
  test('the active buffer itself confirmed saved (no switch) fires the trailing didSave', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    platform.files.set('b.koi', 'context B {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const deps = makeDeps(platform, lsp, editor);
    const ws = createWorkspaceController(deps);
    await ws.openFolderPath(ROOT, { recent: false });
    const aUri = ws.activeUri(); // a.koi — active, and itself part of this pass
    writeBuffer(deps, ws, aUri, { dirty: true });
    writeBuffer(deps, ws, uriOf('b.koi'), { dirty: true });

    await ws.saveAllDirty();

    expect(ws.buffers.get(aUri)!.dirty).toBe(false); // confirmed clean
    expect(lsp.didSave).toHaveBeenCalledTimes(1);
  });

  test('a switch to a buffer confirmed saved earlier in this pass fires the trailing didSave', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    platform.files.set('b.koi', 'context B {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    // Gate b.koi's write (it sorts after a.koi) so a.koi's write can complete and be CONFIRMED saved
    // while b's write — the buffer active at request time — is still in flight.
    const origWrite = platform.writeTextFile.bind(platform);
    let releaseB!: () => void;
    const bGate = new Promise<void>((res) => (releaseB = res));
    platform.writeTextFile = async (path: string, contents: string) => {
      if (path === `${ROOT}/b.koi`) await bGate;
      return origWrite(path, contents);
    };
    const deps = makeDeps(platform, lsp, editor);
    const ws = createWorkspaceController(deps);
    await ws.openFolderPath(ROOT, { recent: false });
    const aUri = uriOf('a.koi');
    const bUri = uriOf('b.koi');
    ws.activateFile(bUri); // b.koi is active at request time
    writeBuffer(deps, ws, aUri, { dirty: true }); // background — writes and confirms fast (not gated)
    writeBuffer(deps, ws, bUri, { dirty: true }); // active — its write is gated

    const save = ws.saveAllDirty(); // writes a.koi (confirmed), then b.koi (gated)
    ws.activateFile(aUri); // switch to a.koi — already CONFIRMED saved this pass — while b's write is in flight
    releaseB();
    await save;

    expect(lsp.didSave).toHaveBeenCalledTimes(1);
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

describe('createWorkspaceController — applyFileEdit', () => {
  // Regression (#1008): the dirty flag was cleared unconditionally AFTER the awaited disk write, so a
  // keystroke landing while the assistant's apply write was in flight was marked saved even though it
  // never hit disk — mirrors the saveActive/saveAllDirty mid-write guard.
  test('a keystroke landing during the disk write keeps the buffer dirty', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    // Gate the write so a keystroke can land while it is in flight.
    const origWrite = platform.writeTextFile.bind(platform);
    let releaseWrite!: () => void;
    const gate = new Promise<void>((res) => (releaseWrite = res));
    platform.writeTextFile = async (path: string, contents: string) => {
      await gate;
      return origWrite(path, contents);
    };
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor));
    await ws.openFolderPath(ROOT, { recent: false });
    const aUri = ws.activeUri(); // a.koi (first by relPath)

    const apply = ws.applyFileEdit(aUri, 'context A { v1 }\n'); // synchronous until the awaited (gated) write
    editor.setDoc('context A { v2 }\n');
    ws.syncActiveBuffer('context A { v2 }\n'); // a keystroke lands mid-write
    releaseWrite();
    await apply;

    // v1 hit disk, but the buffer now holds v2 — it must still count as unsaved.
    expect(platform.writes[0].contents).toBe('context A { v1 }\n');
    expect(ws.buffers.get(aUri)!.dirty).toBe(true);
  });

  // Regression (#1081): markSaved correctly skipped on a mid-write keystroke (#1008), but the trailing
  // lsp.didSave() only checked activeUri — so the server was still told the (still-dirty) active
  // document had been saved, mirroring the saveActive/saveAllDirty staleness guard (#1055).
  test('a keystroke landing during the disk write also skips didSave (content went stale)', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const origWrite = platform.writeTextFile.bind(platform);
    let releaseWrite!: () => void;
    const gate = new Promise<void>((res) => (releaseWrite = res));
    platform.writeTextFile = async (path: string, contents: string) => {
      await gate;
      return origWrite(path, contents);
    };
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor));
    await ws.openFolderPath(ROOT, { recent: false });
    const aUri = ws.activeUri(); // a.koi (first by relPath)

    const apply = ws.applyFileEdit(aUri, 'v1\n'); // synchronous until the awaited (gated) write
    editor.setDoc('v2\n');
    ws.syncActiveBuffer('v2\n'); // a keystroke lands mid-write — no buffer switch
    releaseWrite();
    await apply;

    // v1 hit disk, but the buffer now holds v2 (still dirty) — the server must not be told the
    // (now-stale) active document was just saved.
    expect(platform.writes[0].contents).toBe('v1\n');
    expect(ws.buffers.get(aUri)!.dirty).toBe(true);
    expect(lsp.didSave).not.toHaveBeenCalled();
  });

  // Regression (#1089): the non-active-buffer safety-net `upsertBuffer` spread `...cur` verbatim,
  // including `cur.dirty` — so a previously-clean background buffer stayed `dirty: false` even after
  // its text was force-set to the new (unwritten) body. If the write then failed, the buffer was left
  // holding unsaved content with no dirty signal at all — a silent-data-loss path.
  test('a non-active buffer force-synced by the safety-net stays dirty when its write fails', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    platform.files.set('b.koi', 'context B {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor));
    await ws.openFolderPath(ROOT, { recent: false });
    const bUri = uriOf('b.koi'); // open but not active; clean, text matches disk
    platform.failWrites.add('b.koi');

    // applyFileEdit catches the injected b.koi write failure and logs it; silence the expected error.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(ws.applyFileEdit(bUri, 'new body\n')).resolves.toBeNull();

    expect(ws.buffers.get(bUri)!.text).toBe('new body\n');
    expect(ws.buffers.get(bUri)!.dirty).toBe(true);
  });
});

// #472 Task 3: applyFileEdit resolves by the OPAQUE session key — an open buffer's uri (unique across
// the roots of a multi-root workspace, unlike the display relPath) or a `new:<relPath>` key for a file
// that doesn't exist yet. Driven across ROOT_A/ROOT_B with a COLLIDING relPath so the by-key resolution
// is provable, plus the single-root contract: apply by uri works; an unknown key (including the legacy
// bare relPath) is null, never a guess across roots or a silent create.
describe('createWorkspaceController — applyFileEdit by key (#472 Task 3)', () => {
  test('two roots holding the same relPath: applying by root B’s uri writes only B’s buffer + file', async () => {
    const platform = new FakePlatform();
    platform.seed(ROOT_A, 'model.koi', 'context A {}\n');
    platform.seed(ROOT_B, 'model.koi', 'context B {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor));
    await ws.openFolderPath(ROOT_A, { recent: false });
    await ws.addRoot(ROOT_B);
    const aUri = uriUnder(ROOT_A, 'model.koi');
    const bUri = uriUnder(ROOT_B, 'model.koi');

    const result = await ws.applyFileEdit(bUri, 'context B { edited }\n');

    // Root B's buffer + disk file hold the new body, left clean (the write hit disk).
    expect(result).toBe(bUri);
    expect(ws.buffers.get(bUri)!.text).toBe('context B { edited }\n');
    expect(ws.buffers.get(bUri)!.dirty).toBe(false);
    expect(platform.roots.get(ROOT_B)!.get('model.koi')).toBe('context B { edited }\n');
    expect(lsp.changeDoc).toHaveBeenCalledWith(bUri, 'context B { edited }\n');
    // Root A's same-relPath buffer and file are untouched — exactly one write, to B's path.
    expect(ws.buffers.get(aUri)!.text).toBe('context A {}\n');
    expect(platform.roots.get(ROOT_A)!.get('model.koi')).toBe('context A {}\n');
    expect(platform.writes).toEqual([{ path: `${ROOT_B}/model.koi`, contents: 'context B { edited }\n' }]);
  });

  test('a new-file key creates the file under the PRIMARY root and opens its buffer', async () => {
    const platform = new FakePlatform();
    platform.seed(ROOT_A, 'a.koi', 'context A {}\n');
    platform.seed(ROOT_B, 'b.koi', 'context B {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor));
    await ws.openFolderPath(ROOT_A, { recent: false });
    await ws.addRoot(ROOT_B);

    const result = await ws.applyFileEdit(newFileKey('flows/fresh.koi'), 'context Fresh {}\n');

    // Created under roots[0] (ROOT_A, the primary root) — not under B — and registered as a real
    // buffer keyed by its file uri, carrying the proper relPath/rootToken, opened on the LSP.
    const freshUri = uriUnder(ROOT_A, 'flows/fresh.koi');
    expect(result).toBe(freshUri);
    expect(platform.roots.get(ROOT_A)!.get('flows/fresh.koi')).toBe('context Fresh {}\n');
    expect(platform.roots.get(ROOT_B)!.has('flows/fresh.koi')).toBe(false);
    const buf = ws.buffers.get(freshUri)!;
    expect(buf.relPath).toBe('flows/fresh.koi');
    expect(buf.rootToken).toBe(ROOT_A);
    expect(buf.dirty).toBe(false);
    expect(lsp.openDoc).toHaveBeenCalledWith(freshUri, 'context Fresh {}\n');
  });

  test('single-root: apply by uri updates the buffer; an unknown key is null (no silent create)', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    platform.files.set('b.koi', 'context B {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor));
    await ws.openFolderPath(ROOT, { recent: false });

    // Apply to the non-active b.koi by its uri — the single-root path, keyed exactly like multi-root.
    const bUri = uriOf('b.koi');
    await expect(ws.applyFileEdit(bUri, 'context B { v2 }\n')).resolves.toBe(bUri);
    expect(ws.buffers.get(bUri)!.text).toBe('context B { v2 }\n');
    expect(platform.files.get('b.koi')).toBe('context B { v2 }\n');

    // A bare relPath is NOT a key (and not a new-file key): null, and nothing is written or created.
    const writesBefore = platform.writes.length;
    await expect(ws.applyFileEdit('a.koi', 'clobber\n')).resolves.toBeNull();
    expect(ws.buffers.get(uriOf('a.koi'))!.text).toBe('context A {}\n');
    expect(platform.files.get('a.koi')).toBe('context A {}\n');
    expect(platform.writes.length).toBe(writesBefore);
    // An unknown uri (no such buffer) is null too.
    await expect(ws.applyFileEdit(uriOf('missing.koi'), 'x\n')).resolves.toBeNull();
    expect(platform.files.has('missing.koi')).toBe(false);
  });
});

describe('createWorkspaceController — handleDelete', () => {
  test('closing the active file falls back to another open buffer (showDiagnostics + invalidateDocViews, no activationSeq bump)', async () => {
    const store = createAppStore();
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
      makeDeps(platform, lsp, editor, { store, showDiagnostics, invalidateDocViews, dropDiagnostics }),
    );
    await ws.openFolderPath(ROOT, { recent: false });
    // a.koi is active; capture activationSeq so we can prove the fallback does NOT bump it.
    const seq0 = store.getState().activationSeq;
    showDiagnostics.mockClear();
    invalidateDocViews.mockClear();

    const aUri = uriOf('a.koi');
    const bUri = uriOf('b.koi');
    await ws.handleDelete({ token: `${ROOT}/a.koi`, name: 'a.koi', relPath: 'a.koi', kind: 'file' });

    // a.koi's buffer + diagnostics are dropped; b.koi is the new active file.
    expect(ws.buffers.has(aUri)).toBe(false);
    expect(dropDiagnostics).toHaveBeenCalledWith(aUri);
    expect(ws.activeUri()).toBe(bUri);
    // The fallback repaints via showDiagnostics + invalidateDocViews, and re-points SILENTLY — no
    // activationSeq bump (so ide.ts's activation subscriber, incl. followActiveFileContext, does not run),
    // matching the old activateFallback narrow-effect contract.
    expect(showDiagnostics).toHaveBeenCalledWith(bUri);
    expect(invalidateDocViews).toHaveBeenCalled();
    expect(store.getState().activationSeq).toBe(seq0);
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
    const deps = makeDeps(platform, lsp, editor);
    const ws = createWorkspaceController(deps);
    await ws.openFolderPath(ROOT, { recent: false });

    expect(ws.anyDirty()).toBe(false);
    writeBuffer(deps, ws, ws.activeUri(), { dirty: true });
    expect(ws.anyDirty()).toBe(true);
  });
});

describe('createWorkspaceController — syncBuffer (uri-keyed; group-B safety, #265)', () => {
  test('syncBuffer(uriB, text) touches ONLY uriB and leaves the active buffer untouched', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    platform.files.set('b.koi', 'context B {}\n');
    const trace: string[] = [];
    const ws = createWorkspaceController(makeDeps(platform, makeLsp(trace), makeEditor(trace)));
    await ws.openFolderPath(ROOT, { recent: false });

    const aUri = uriOf('a.koi'); // the active buffer (first by relPath)
    const bUri = uriOf('b.koi');
    expect(ws.activeUri()).toBe(aUri);

    // Edit B's buffer through the uri-keyed sync (the path group B's onChange takes in ide.tsx).
    const becameDirty = ws.syncBuffer(bUri, 'context B { value V {} }\n');

    // B's dirty dot just appeared, and B holds the new text…
    expect(becameDirty).toBe(true);
    expect(ws.buffers.get(bUri)!.dirty).toBe(true);
    expect(ws.buffers.get(bUri)!.text).toBe('context B { value V {} }\n');
    // …while the ACTIVE (group-A) buffer is completely untouched — no text change, not marked dirty.
    expect(ws.buffers.get(aUri)!.text).toBe('context A {}\n');
    expect(ws.buffers.get(aUri)!.dirty).toBe(false);
  });

  test('syncActiveBuffer delegates to syncBuffer(activeUri) — unchanged active-buffer behavior', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    const trace: string[] = [];
    const ws = createWorkspaceController(makeDeps(platform, makeLsp(trace), makeEditor(trace)));
    await ws.openFolderPath(ROOT, { recent: false });
    const aUri = ws.activeUri();

    const becameDirty = ws.syncActiveBuffer('context A { entity E {} }\n');

    expect(becameDirty).toBe(true);
    expect(ws.buffers.get(aUri)!.text).toBe('context A { entity E {} }\n');
    expect(ws.buffers.get(aUri)!.dirty).toBe(true);
    // A second sync with no change does not re-flip / re-report dirty.
    expect(ws.syncActiveBuffer('context A { entity E {} }\n')).toBe(false);
  });

  test('syncBuffer for an unknown uri is a safe no-op (returns false, mutates nothing)', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    const trace: string[] = [];
    const ws = createWorkspaceController(makeDeps(platform, makeLsp(trace), makeEditor(trace)));
    await ws.openFolderPath(ROOT, { recent: false });
    const aUri = ws.activeUri();

    expect(ws.syncBuffer(uriOf('ghost.koi'), 'nope')).toBe(false);
    // The active buffer is untouched by a write to a uri that isn't open.
    expect(ws.buffers.get(aUri)!.text).toBe('context A {}\n');
    expect(ws.buffers.get(aUri)!.dirty).toBe(false);
  });
});

describe('createWorkspaceController — resume-card snapshot semantics (#1018)', () => {
  test('a background group-B dirty change records the ACTIVE (group-A) file — deliberately (Option A)', async () => {
    setLastSession(null); // start from a clean snapshot (localStorage persists across tests in this file)
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n'); // group A — active (first by relPath)
    platform.files.set('b.koi', 'context B {}\n'); // group B — a background split-view buffer
    const ws = createWorkspaceController(makeDeps(platform, makeLsp([]), makeEditor([])));
    await ws.openFolderPath(ROOT, { recent: false });
    const aUri = uriOf('a.koi');
    const bUri = uriOf('b.koi');
    expect(ws.activeUri()).toBe(aUri);

    // Dirty ONLY the background group-B buffer (uri !== activeUri) — the split-view path ide.tsx routes
    // group B's onChange through. This fires the snapshot via the syncBuffer facade's becameDirty hook.
    const becameDirty = ws.syncBuffer(bUri, 'context B { value V {} }\n');
    expect(becameDirty).toBe(true);

    // Pin the deliberate choice (#1018 Option A): the resume snapshot records the ACTIVE (group-A) file,
    // NOT the group-B file that actually changed. The card answers "where you were", not "what last
    // changed", so a background edit must not repoint `file` at the background buffer. (Guards against an
    // accidental switch to Option B — threading the changed uri — which would make this 'b.koi'.)
    const snapshot = getLastSession();
    expect(snapshot?.file).toBe('a.koi');
    expect(snapshot?.file).not.toBe('b.koi');
    // The dirty count still reflects the real edit (group-B is now unsaved).
    expect(snapshot?.unsavedCount).toBe(1);
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

// Idle auto-save (#268): when enabled, an edit arms a ~1000ms debounce; on fire it reuses the exact
// saveAllDirty path (format-on-save → write every dirty buffer → didSave → tree refresh). Driven with
// fake timers + the FakePlatform write spy, mirroring historyController.test.ts's debounce style.
//
// #982 Task 3 audit (2026-07): this suite ALREADY pins every autosave scenario the ownership inversion
// must preserve — debounce re-arm ('the idle timer resets on each edit'), cancel-on-disable ('disabling
// auto-save cancels a pending persist'), yield-to-manual-save ('a manual save cancels a pending
// auto-save'), no-arm-when-clean ('does not arm when nothing is dirty'), and cancel-on-reopen
// ('reopening a folder cancels a pending auto-save'). No gap was found, so no new autosave test is added;
// these describes are the regression bar for the state that moves into workspaceSave.ts (#982 Task 5).
describe('createWorkspaceController — idle auto-save', () => {
  test('writes dirty buffers after the idle delay, skips clean ones, fires didSave', async () => {
    vi.useFakeTimers();
    try {
      const platform = new FakePlatform();
      platform.files.set('a.koi', 'context A {}\n');
      platform.files.set('b.koi', 'context B {}\n');
      const trace: string[] = [];
      const lsp = makeLsp(trace);
      const editor = makeEditor(trace);
      const deps = makeDeps(platform, lsp, editor);
      const ws = createWorkspaceController(deps);
      await ws.openFolderPath(ROOT, { recent: false });

      // a.koi is the active buffer and clean; dirty the non-active b.koi only.
      writeBuffer(deps, ws, uriOf('b.koi'), { dirty: true, text: 'context B { value V {} }\n' });

      ws.setAutoSave(true);
      ws.scheduleAutoSave();
      expect(platform.writes).toHaveLength(0); // still inside the idle window — nothing yet

      await vi.advanceTimersByTimeAsync(1000);

      expect(platform.writes.map((w) => w.path)).toContain(`${ROOT}/b.koi`);
      expect(platform.writes.map((w) => w.path)).not.toContain(`${ROOT}/a.koi`); // clean, skipped
      // Re-read from the store: markSaved replaces the buffer object (immutable owner, #982), so the
      // `b` captured before the save is stale — the assertion (b is clean after autosave) is unchanged.
      expect(ws.buffers.get(uriOf('b.koi'))!.dirty).toBe(false);
      expect(lsp.didSave).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('runs format-on-save before persisting when enabled', async () => {
    vi.useFakeTimers();
    try {
      const platform = new FakePlatform();
      platform.files.set('a.koi', 'context A {}\n');
      const trace: string[] = [];
      const lsp = makeLsp(trace);
      const editor = makeEditor(trace);
      const order: string[] = [];
      lsp.format.mockImplementation(async () => (order.push('format'), []));
      const origWrite = platform.writeTextFile.bind(platform);
      platform.writeTextFile = vi.fn((path: string, contents: string) => (order.push('write'), origWrite(path, contents)));
      const deps = makeDeps(platform, lsp, editor, { getFormatOnSave: () => true });
      const ws = createWorkspaceController(deps);
      await ws.openFolderPath(ROOT, { recent: false });
      writeBuffer(deps, ws, ws.activeUri(), { dirty: true });

      ws.setAutoSave(true);
      ws.scheduleAutoSave();
      await vi.advanceTimersByTimeAsync(1000);

      expect(order).toEqual(['format', 'write']); // format first, then the disk write
      expect(editor.applyEdits).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not auto-save when the setting is off', async () => {
    vi.useFakeTimers();
    try {
      const platform = new FakePlatform();
      platform.files.set('a.koi', 'context A {}\n');
      const trace: string[] = [];
      const lsp = makeLsp(trace);
      const editor = makeEditor(trace);
      const deps = makeDeps(platform, lsp, editor);
      const ws = createWorkspaceController(deps);
      await ws.openFolderPath(ROOT, { recent: false });
      writeBuffer(deps, ws, ws.activeUri(), { dirty: true });

      ws.scheduleAutoSave(); // auto-save never enabled
      await vi.advanceTimersByTimeAsync(5000);

      expect(platform.writes).toHaveLength(0);
      expect(lsp.didSave).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('the idle timer resets on each edit (debounce coalesces a burst)', async () => {
    vi.useFakeTimers();
    try {
      const platform = new FakePlatform();
      platform.files.set('a.koi', 'context A {}\n');
      const trace: string[] = [];
      const lsp = makeLsp(trace);
      const editor = makeEditor(trace);
      const deps = makeDeps(platform, lsp, editor);
      const ws = createWorkspaceController(deps);
      await ws.openFolderPath(ROOT, { recent: false });
      writeBuffer(deps, ws, ws.activeUri(), { dirty: true });
      ws.setAutoSave(true);

      ws.scheduleAutoSave();
      await vi.advanceTimersByTimeAsync(600);
      ws.scheduleAutoSave(); // a fresh edit resets the timer
      await vi.advanceTimersByTimeAsync(600); // 1200ms elapsed overall, but only 600 since the reset
      expect(platform.writes).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(400); // now 1000ms idle since the last edit
      expect(platform.writes.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('disabling auto-save cancels a pending persist', async () => {
    vi.useFakeTimers();
    try {
      const platform = new FakePlatform();
      platform.files.set('a.koi', 'context A {}\n');
      const trace: string[] = [];
      const lsp = makeLsp(trace);
      const editor = makeEditor(trace);
      const deps = makeDeps(platform, lsp, editor);
      const ws = createWorkspaceController(deps);
      await ws.openFolderPath(ROOT, { recent: false });
      writeBuffer(deps, ws, ws.activeUri(), { dirty: true });
      ws.setAutoSave(true);
      ws.scheduleAutoSave();

      ws.setAutoSave(false); // cancels the armed timer
      await vi.advanceTimersByTimeAsync(2000);

      expect(platform.writes).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not arm when nothing is dirty (a clean doc swap fires onChange but dirties nothing)', async () => {
    vi.useFakeTimers();
    try {
      const platform = new FakePlatform();
      platform.files.set('a.koi', 'context A {}\n');
      const trace: string[] = [];
      const lsp = makeLsp(trace);
      const editor = makeEditor(trace);
      const setStatus = vi.fn();
      const ws = createWorkspaceController(makeDeps(platform, lsp, editor, { setStatus }));
      await ws.openFolderPath(ROOT, { recent: false });
      // a.koi is active and clean (a file switch / restore fires onChange without dirtying anything).
      ws.setAutoSave(true);
      ws.scheduleAutoSave();
      await vi.advanceTimersByTimeAsync(2000);

      expect(platform.writes).toHaveLength(0);
      expect(lsp.didSave).not.toHaveBeenCalled();
      // No timer ever fired, so the status pill is never touched.
      expect(setStatus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('reopening a folder cancels a pending auto-save (no stale fire against the new workspace)', async () => {
    vi.useFakeTimers();
    try {
      const platform = new FakePlatform();
      platform.files.set('a.koi', 'context A {}\n');
      const trace: string[] = [];
      const lsp = makeLsp(trace);
      const editor = makeEditor(trace);
      // format-on-save on so a stale fire would run lsp.format() against the new active buffer.
      const deps = makeDeps(platform, lsp, editor, { getFormatOnSave: () => true });
      const ws = createWorkspaceController(deps);
      await ws.openFolderPath(ROOT, { recent: false });
      writeBuffer(deps, ws, ws.activeUri(), { dirty: true });
      ws.setAutoSave(true);
      ws.scheduleAutoSave(); // armed against this workspace

      await ws.openFolderPath(ROOT, { recent: false }); // swap workspaces before the idle delay elapses
      await vi.advanceTimersByTimeAsync(2000);

      expect(lsp.format).not.toHaveBeenCalled(); // the stale timer never fired into the reopened workspace
      expect(platform.writes).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a manual save cancels a pending auto-save (no second write / status churn after)', async () => {
    vi.useFakeTimers();
    try {
      const platform = new FakePlatform();
      platform.files.set('a.koi', 'context A {}\n');
      const trace: string[] = [];
      const lsp = makeLsp(trace);
      const editor = makeEditor(trace);
      const deps = makeDeps(platform, lsp, editor);
      const ws = createWorkspaceController(deps);
      await ws.openFolderPath(ROOT, { recent: false });
      writeBuffer(deps, ws, ws.activeUri(), { dirty: true });
      ws.setAutoSave(true);
      ws.scheduleAutoSave(); // armed

      await ws.saveActive(); // explicit save subsumes the pending auto-save
      const writesAfterManual = platform.writes.length;
      await vi.advanceTimersByTimeAsync(2000);

      expect(platform.writes.length).toBe(writesAfterManual); // the armed timer was cancelled — no extra write
    } finally {
      vi.useRealTimers();
    }
  });
});

// Multi-root workspace (Task 2): the controller owns an ORDERED LIST of roots. `rootsList()` exposes
// them (a copy); `addRoot` unions a folder's .koi buffers WITHOUT closing/touching the existing ones;
// `removeRoot` closes ONLY that root's buffers (dropping their diagnostics), splices it out, and falls
// back / empties via the existing activateFallback. Driven across TWO distinct roots so per-root
// namespacing is provable: ROOT (the existing single-root path) plus ROOT_A / ROOT_B.
describe('createWorkspaceController — multi-root', () => {
  test('opening one folder yields a rootsList of length 1 (the opened folder is the primary root)', async () => {
    const platform = new FakePlatform();
    platform.seed(ROOT_A, 'a.koi', 'context A {}\n');
    const ws = createWorkspaceController(makeDeps(platform, makeLsp([]), makeEditor([])));
    await ws.openFolderPath(ROOT_A, { recent: false });

    expect(ws.rootsList()).toEqual([ROOT_A]);
    expect(ws.folderRootToken()).toBe(ROOT_A); // back-compat: primary root === folderRootToken
  });

  // Regression (#982): the reset must not publish an intermediate folderRootToken='' when switching
  // folders — the folder-derived <DocsPanelHost> subscribes only to folderRootToken, so an A→''→B flash
  // would clear it through an empty key. The switch must be a single A→B transition.
  test('switching folders publishes folderRootToken as a single old→new transition (no "" flash)', async () => {
    const store = createAppStore();
    const platform = new FakePlatform();
    platform.seed(ROOT_A, 'a.koi', 'context A {}\n');
    platform.seed(ROOT_B, 'b.koi', 'context B {}\n');
    const ws = createWorkspaceController(makeDeps(platform, makeLsp([]), makeEditor([]), { store }));
    await ws.openFolderPath(ROOT_A, { recent: false });
    expect(store.getState().folderRootToken).toBe(ROOT_A);

    const seen: string[] = [];
    const unsub = store.subscribe((s, prev) => {
      if (s.folderRootToken !== prev.folderRootToken) seen.push(s.folderRootToken);
    });
    await ws.openFolderPath(ROOT_B, { recent: false });
    unsub();

    expect(seen).toEqual([ROOT_B]); // straight A→B — no transient ''
    expect(store.getState().folderRootToken).toBe(ROOT_B);
  });

  test('addRoot unions a second folder’s .koi buffers without closing the first', async () => {
    const platform = new FakePlatform();
    platform.seed(ROOT_A, 'a.koi', 'context A {}\n');
    platform.seed(ROOT_B, 'b1.koi', 'context B1 {}\n');
    platform.seed(ROOT_B, 'b2.koi', 'context B2 {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor));
    await ws.openFolderPath(ROOT_A, { recent: false });

    const aUri = uriUnder(ROOT_A, 'a.koi');
    expect(ws.buffers.size).toBe(1);
    expect(ws.activeUri()).toBe(aUri);
    lsp.closeDoc.mockClear();
    lsp.openDoc.mockClear();

    const result = await ws.addRoot(ROOT_B);

    expect(result).toEqual({ ok: true });
    // Both roots are now in the workspace, ROOT_A still first (additive, ordered append).
    expect(ws.rootsList()).toEqual([ROOT_A, ROOT_B]);
    // ROOT_A's buffer survives untouched; ROOT_B's two .koi files are now open too.
    expect(ws.buffers.size).toBe(3);
    expect(ws.buffers.has(aUri)).toBe(true);
    expect(ws.buffers.has(uriUnder(ROOT_B, 'b1.koi'))).toBe(true);
    expect(ws.buffers.has(uriUnder(ROOT_B, 'b2.koi'))).toBe(true);
    // The new buffers carry their owning rootToken; the existing one is unchanged.
    expect(ws.buffers.get(uriUnder(ROOT_B, 'b1.koi'))!.rootToken).toBe(ROOT_B);
    expect(ws.buffers.get(aUri)!.rootToken).toBe(ROOT_A);
    // addRoot opened the new docs on the LSP (cross-root refs resolve) and closed NOTHING.
    expect(lsp.openDoc).toHaveBeenCalledTimes(2);
    expect(lsp.closeDoc).not.toHaveBeenCalled();
    // The active buffer is unchanged — addRoot must not steal focus.
    expect(ws.activeUri()).toBe(aUri);
  });

  test('addRoot of an already-open root is a no-op (no re-read, no close, no buffer churn)', async () => {
    const platform = new FakePlatform();
    platform.seed(ROOT_A, 'a.koi', 'context A {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor));
    await ws.openFolderPath(ROOT_A, { recent: false });

    const listSpy = vi.spyOn(platform, 'listKoiFiles');
    lsp.openDoc.mockClear();
    lsp.closeDoc.mockClear();

    const result = await ws.addRoot(ROOT_A);

    expect(result).toEqual({ ok: true });
    expect(ws.rootsList()).toEqual([ROOT_A]); // not duplicated
    expect(ws.buffers.size).toBe(1);
    expect(listSpy).not.toHaveBeenCalled(); // did not re-read the folder
    expect(lsp.openDoc).not.toHaveBeenCalled();
    expect(lsp.closeDoc).not.toHaveBeenCalled();
  });

  test('addRoot of an unreadable folder reports unreadable and does not append', async () => {
    const platform = new FakePlatform();
    platform.seed(ROOT_A, 'a.koi', 'context A {}\n');
    const ws = createWorkspaceController(makeDeps(platform, makeLsp([]), makeEditor([])));
    await ws.openFolderPath(ROOT_A, { recent: false });

    vi.spyOn(platform, 'listKoiFiles').mockRejectedValueOnce(new Error('gone'));
    // addRoot catches the injected listKoiFiles rejection and logs it; silence the expected error.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await ws.addRoot(ROOT_B);

    expect(result).toEqual({ ok: false, reason: 'unreadable' });
    expect(ws.rootsList()).toEqual([ROOT_A]);
  });

  test('addRoot of an empty folder reports empty and does not append', async () => {
    const platform = new FakePlatform();
    platform.seed(ROOT_A, 'a.koi', 'context A {}\n');
    const ws = createWorkspaceController(makeDeps(platform, makeLsp([]), makeEditor([])));
    await ws.openFolderPath(ROOT_A, { recent: false });

    const result = await ws.addRoot(ROOT_B); // ROOT_B was never seeded → no .koi files

    expect(result).toEqual({ ok: false, reason: 'empty' });
    expect(ws.rootsList()).toEqual([ROOT_A]);
  });

  test('addRoot of an empty folder does NOT raise the global error when a workspace is loaded (#627)', async () => {
    const platform = new FakePlatform();
    platform.seed(ROOT_A, 'a.koi', 'context A {}\n');
    const setStatus = vi.fn();
    const ws = createWorkspaceController(makeDeps(platform, makeLsp([]), makeEditor([]), { setStatus }));
    await ws.openFolderPath(ROOT_A, { recent: false }); // a healthy workspace is loaded (buffers.size === 1)
    setStatus.mockClear();

    const result = await ws.addRoot(ROOT_B); // ROOT_B never seeded → empty listing, but a workspace is loaded

    // Same #627 invariant for the additive multi-root path: an empty union must not clobber the loaded
    // workspace's healthy status. The caller still gets reason:'empty'; the root is not appended.
    expect(result).toEqual({ ok: false, reason: 'empty' });
    expect(setStatus).not.toHaveBeenCalledWith('no .koi files in folder', 'error');
    expect(ws.rootsList()).toEqual([ROOT_A]);
  });

  test('removeRoot closes ONLY that root’s buffers, drops their diagnostics, and leaves the others', async () => {
    const platform = new FakePlatform();
    platform.seed(ROOT_A, 'a.koi', 'context A {}\n');
    platform.seed(ROOT_B, 'b.koi', 'context B {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const dropDiagnostics = vi.fn();
    const renderRoots = vi.fn();
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor, { dropDiagnostics, explorer: { renderRoots } }));
    await ws.openFolderPath(ROOT_A, { recent: false });
    await ws.addRoot(ROOT_B);
    // a.koi is active (primary root's first file). Switch active to b.koi so removing ROOT_B exercises
    // the active-removed fallback in a LATER test; here keep active on ROOT_A so removeRoot(ROOT_B) is
    // a pure non-active removal.
    const aUri = uriUnder(ROOT_A, 'a.koi');
    const bUri = uriUnder(ROOT_B, 'b.koi');
    expect(ws.activeUri()).toBe(aUri);
    lsp.closeDoc.mockClear();
    renderRoots.mockClear();

    ws.removeRoot(ROOT_B);

    // ROOT_B spliced out; ROOT_A intact and still primary.
    expect(ws.rootsList()).toEqual([ROOT_A]);
    // Only b.koi closed + dropped; a.koi untouched and still active.
    expect(lsp.closeDoc).toHaveBeenCalledTimes(1);
    expect(lsp.closeDoc).toHaveBeenCalledWith(bUri);
    expect(dropDiagnostics).toHaveBeenCalledWith(bUri);
    expect(dropDiagnostics).not.toHaveBeenCalledWith(aUri);
    expect(ws.buffers.has(bUri)).toBe(false);
    expect(ws.buffers.has(aUri)).toBe(true);
    expect(ws.activeUri()).toBe(aUri);
    // A non-active removal must STILL re-render the explorer (regression: removeRoot once skipped this,
    // so the removed root's group + rows lingered, clickable, until an unrelated render fired). The
    // re-render names only the surviving root.
    expect(renderRoots).toHaveBeenCalled();
    const calls = renderRoots.mock.calls;
    const lastGroups = calls[calls.length - 1][0] as { root: string }[];
    expect(lastGroups.map((g) => g.root)).toEqual([ROOT_A]);
  });

  test('removing the active buffer’s root re-points active via the fallback', async () => {
    const platform = new FakePlatform();
    platform.seed(ROOT_A, 'a.koi', 'context A {}\n');
    platform.seed(ROOT_B, 'b.koi', 'context B {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const showDiagnostics = vi.fn();
    const invalidateDocViews = vi.fn();
    const onWorkspaceEmptied = vi.fn();
    const ws = createWorkspaceController(
      makeDeps(platform, lsp, editor, { showDiagnostics, invalidateDocViews, onWorkspaceEmptied }),
    );
    await ws.openFolderPath(ROOT_A, { recent: false });
    await ws.addRoot(ROOT_B);

    const aUri = uriUnder(ROOT_A, 'a.koi');
    const bUri = uriUnder(ROOT_B, 'b.koi');
    // Make b.koi (in ROOT_B) the active buffer, then remove ROOT_B.
    ws.activateFile(bUri);
    expect(ws.activeUri()).toBe(bUri);
    showDiagnostics.mockClear();
    invalidateDocViews.mockClear();

    ws.removeRoot(ROOT_B);

    // The fallback re-points to ROOT_A's surviving buffer via showDiagnostics + invalidateDocViews.
    expect(ws.activeUri()).toBe(aUri);
    expect(showDiagnostics).toHaveBeenCalledWith(aUri);
    expect(invalidateDocViews).toHaveBeenCalled();
    expect(onWorkspaceEmptied).not.toHaveBeenCalled(); // ROOT_A still has a buffer
  });

  test('removing the last root empties the workspace (onWorkspaceEmptied)', async () => {
    const platform = new FakePlatform();
    platform.seed(ROOT_A, 'a.koi', 'context A {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const onWorkspaceEmptied = vi.fn();
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor, { onWorkspaceEmptied }));
    await ws.openFolderPath(ROOT_A, { recent: false });

    ws.removeRoot(ROOT_A);

    expect(ws.rootsList()).toEqual([]);
    expect(ws.buffers.size).toBe(0);
    expect(onWorkspaceEmptied).toHaveBeenCalledTimes(1);
  });

  test('removeRoot of a folder not in roots is a harmless no-op', async () => {
    const platform = new FakePlatform();
    platform.seed(ROOT_A, 'a.koi', 'context A {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor));
    await ws.openFolderPath(ROOT_A, { recent: false });
    lsp.closeDoc.mockClear();

    ws.removeRoot(ROOT_B); // never added

    expect(ws.rootsList()).toEqual([ROOT_A]);
    expect(ws.buffers.size).toBe(1);
    expect(lsp.closeDoc).not.toHaveBeenCalled();
  });
});

// Rekey on rename/move (#982 Task 1 pin): re-keying open buffers on a file/folder rename or a cross-root
// move was UNTESTED before the workspace-ownership inversion, yet it is the subtlest transition the slice
// must reproduce atomically (new Map + re-pointed activeUri in one setState). These pins lock the current
// behavior — preserved unsaved text + dirty flag, re-pointed active buffer, paired lsp.closeDoc/openDoc,
// diagnostics moved via renameDiagnostics, rootToken re-derived on a cross-root move — so a regression in
// Task 3's rekeyBuffers-through-the-slice rewrite fails loudly. Buffers are dirtied through the real sync
// path (editor.setDoc + syncActiveBuffer), never a direct field write, so the pins survive the move to an
// immutable, store-owned buffer Map unchanged.
describe('createWorkspaceController — rekey on rename/move (pin, #982)', () => {
  test('renaming a dirty active file re-keys its buffer, preserves the unsaved text + dirty flag, and re-points active', async () => {
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    platform.files.set('b.koi', 'context B {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const renameDiagnostics = vi.fn();
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor, { renameDiagnostics }));
    await ws.openFolderPath(ROOT, { recent: false });

    const oldUri = uriOf('a.koi');
    expect(ws.activeUri()).toBe(oldUri);
    // Dirty the active buffer through the real onChange path (not a direct field write).
    const edited = 'context A { value V { x: Int } }\n';
    editor.setDoc(edited);
    ws.syncActiveBuffer(edited);
    expect(ws.buffers.get(oldUri)!.dirty).toBe(true);
    lsp.closeDoc.mockClear();
    lsp.openDoc.mockClear();
    lsp.setActive.mockClear();

    await ws.handleRename({ token: `${ROOT}/a.koi`, name: 'a.koi', relPath: 'a.koi', kind: 'file' }, 'renamed.koi');

    const newUri = uriOf('renamed.koi');
    // The old key is gone; the buffer now lives under the new uri with every identity field re-derived.
    expect(ws.buffers.has(oldUri)).toBe(false);
    const buf = ws.buffers.get(newUri)!;
    expect(buf).toBeDefined();
    expect(buf.uri).toBe(newUri);
    expect(buf.path).toBe(`${ROOT}/renamed.koi`);
    expect(buf.relPath).toBe('renamed.koi');
    expect(buf.name).toBe('renamed.koi');
    // The unsaved edit + dirty flag survive the re-key.
    expect(buf.text).toBe(edited);
    expect(buf.dirty).toBe(true);
    // The active buffer follows the rename, and the LSP is re-pointed at the new uri.
    expect(ws.activeUri()).toBe(newUri);
    expect(lsp.setActive).toHaveBeenCalledWith(newUri);
    // The LSP doc was closed under the old uri and reopened under the new one (paired, text preserved).
    expect(lsp.closeDoc).toHaveBeenCalledWith(oldUri);
    expect(lsp.openDoc).toHaveBeenCalledWith(newUri, edited);
    // The cached diagnostics moved with the buffer.
    expect(renameDiagnostics).toHaveBeenCalledWith(oldUri, newUri);
  });

  test('renaming a folder re-keys every open buffer beneath it, leaving siblings untouched', async () => {
    const platform = new FakePlatform();
    platform.files.set('sub/x.koi', 'context X {}\n');
    platform.files.set('sub/y.koi', 'context Y {}\n');
    platform.files.set('top.koi', 'context Top {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const renameDiagnostics = vi.fn();
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor, { renameDiagnostics }));
    await ws.openFolderPath(ROOT, { recent: false });
    expect(ws.buffers.size).toBe(3);

    await ws.handleRename({ token: `${ROOT}/sub`, name: 'sub', relPath: 'sub', kind: 'dir' }, 'renamed');

    // Both files under sub/ moved to renamed/; the sibling top.koi is untouched.
    expect(ws.buffers.has(uriOf('sub/x.koi'))).toBe(false);
    expect(ws.buffers.has(uriOf('sub/y.koi'))).toBe(false);
    expect(ws.buffers.has(uriOf('renamed/x.koi'))).toBe(true);
    expect(ws.buffers.has(uriOf('renamed/y.koi'))).toBe(true);
    expect(ws.buffers.has(uriOf('top.koi'))).toBe(true);
    // The re-keyed buffers' relPath fields are re-derived under the new folder name.
    expect(ws.buffers.get(uriOf('renamed/x.koi'))!.relPath).toBe('renamed/x.koi');
    expect(ws.buffers.get(uriOf('renamed/y.koi'))!.relPath).toBe('renamed/y.koi');
    // Each re-keyed buffer's diagnostics moved to its new uri.
    expect(renameDiagnostics).toHaveBeenCalledWith(uriOf('sub/x.koi'), uriOf('renamed/x.koi'));
    expect(renameDiagnostics).toHaveBeenCalledWith(uriOf('sub/y.koi'), uriOf('renamed/y.koi'));
  });

  test('moving a dirty file across roots re-keys it and re-derives its rootToken', async () => {
    const platform = new FakePlatform();
    platform.seed(ROOT_A, 'a.koi', 'context A {}\n');
    platform.seed(ROOT_B, 'keep.koi', 'context Keep {}\n');
    // The fake leaves moveEntry unimplemented (it rejects); supply a minimal cross-root move for this pin
    // — it returns the new token under the destination root, mirroring the host's reparent.
    platform.moveEntry = (async (_token: string, destRoot: string, relPath: string): Promise<string> =>
      `${destRoot}/${relPath}`) as unknown as FakePlatform['moveEntry'];
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const renameDiagnostics = vi.fn();
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor, { renameDiagnostics }));
    await ws.openFolderPath(ROOT_A, { recent: false });
    await ws.addRoot(ROOT_B);

    const oldUri = uriUnder(ROOT_A, 'a.koi');
    expect(ws.activeUri()).toBe(oldUri);
    expect(ws.buffers.get(oldUri)!.rootToken).toBe(ROOT_A);
    // Dirty it through the real path before the move.
    const edited = 'context A { entity E {} }\n';
    editor.setDoc(edited);
    ws.syncActiveBuffer(edited);
    lsp.closeDoc.mockClear();
    lsp.openDoc.mockClear();

    await ws.handleMove(
      { token: `${ROOT_A}/a.koi`, name: 'a.koi', relPath: 'a.koi', kind: 'file' },
      ROOT_B,
    );

    const newUri = uriUnder(ROOT_B, 'a.koi');
    expect(ws.buffers.has(oldUri)).toBe(false);
    const buf = ws.buffers.get(newUri)!;
    expect(buf).toBeDefined();
    // The cross-root move re-derives the owning root from the new path (was ROOT_A, now ROOT_B).
    expect(buf.rootToken).toBe(ROOT_B);
    // The unsaved edit + dirty flag survive the move.
    expect(buf.text).toBe(edited);
    expect(buf.dirty).toBe(true);
    // Active follows the move; the LSP doc was closed under the old uri and reopened under the new one.
    expect(ws.activeUri()).toBe(newUri);
    expect(lsp.closeDoc).toHaveBeenCalledWith(oldUri);
    expect(lsp.openDoc).toHaveBeenCalledWith(newUri, edited);
    expect(renameDiagnostics).toHaveBeenCalledWith(oldUri, newUri);
  });
});

// Store-ownership parity (#982 Task 3): the workspace slice is now the SINGLE owner — the facade reads
// through it and writes through its actions, with NO refreshDirtyIndicator projection. This is the
// parity bar that supersedes the Task-1 dirty-projection pin: drive the controller (built over a real
// createAppStore()) through open → edit → rename → save and assert after EACH step that the slice and
// the facade never diverge. The dep count carries no refreshDirtyIndicator — it no longer exists.
describe('createWorkspaceController — store ownership parity (#982)', () => {
  test('the workspace slice mirrors the facade through open → edit → rename → save', async () => {
    const store = createAppStore();
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    platform.files.set('b.koi', 'context B {}\n');
    const trace: string[] = [];
    const lsp = makeLsp(trace);
    const editor = makeEditor(trace);
    const ws = createWorkspaceController(makeDeps(platform, lsp, editor, { store }));

    // open: the slice holds the buffer Map, active uri, and roots the facade exposes.
    await ws.openFolderPath(ROOT, { recent: false });
    expect(store.getState().buffers).toBe(ws.buffers); // the facade getter IS the slice's Map (one truth)
    expect(store.getState().activeUri).toBe(ws.activeUri());
    expect(store.getState().folderRootToken).toBe(ws.folderRootToken());
    expect(store.getState().roots).toEqual(ws.rootsList());
    expect(ws.activeUri()).toBe(uriOf('a.koi'));

    // edit: dirty the active buffer through the real sync path — the slice sees it with no manual push.
    const edited = 'context A { value V {} }\n';
    editor.setDoc(edited);
    ws.syncActiveBuffer(edited);
    expect(store.getState().buffers.get(uriOf('a.koi'))!.dirty).toBe(true);
    expect(store.getState().dirtyCount()).toBe(1);

    // rename: the re-key lands atomically in the slice (new uri, active re-pointed, dirty text preserved).
    await ws.handleRename({ token: `${ROOT}/a.koi`, name: 'a.koi', relPath: 'a.koi', kind: 'file' }, 'renamed.koi');
    expect(store.getState().activeUri).toBe(uriOf('renamed.koi'));
    expect(store.getState().activeUri).toBe(ws.activeUri());
    expect(store.getState().buffers.has(uriOf('a.koi'))).toBe(false);
    expect(store.getState().buffers.get(uriOf('renamed.koi'))!.dirty).toBe(true);

    // save: markSaved clears dirty in the slice — again with no projection step.
    await ws.saveActive();
    expect(store.getState().buffers.get(uriOf('renamed.koi'))!.dirty).toBe(false);
    expect(store.getState().dirtyCount()).toBe(0);
    // Never diverged: the facade getter and the slice are the same Map throughout.
    expect(store.getState().buffers).toBe(ws.buffers);
  });
});

// Seq seams (#982 Task 4): the four callback seams became monotonic slice fields — activationSeq /
// workspaceEditSeq / entriesSeq / saveSeq — bumped at EXACTLY the points the old callbacks fired
// (workspaceController.ts:484/:918/:370/:941,:949,:1023,:1078). ide.ts subscribes to them. These tests
// pin each bump point (and the critical NON-bump: folder open must stay silent on activationSeq).
describe('createWorkspaceController — seq seams (#982)', () => {
  test('openFolderPath does NOT bump activationSeq (the folder-open :489 contract) but bumps entriesSeq', async () => {
    const store = createAppStore();
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    platform.files.set('b.koi', 'context B {}\n');
    const ws = createWorkspaceController(makeDeps(platform, makeLsp([]), makeEditor([]), { store }));
    const seqA0 = store.getState().activationSeq;
    const seqE0 = store.getState().entriesSeq;

    await ws.openFolderPath(ROOT, { recent: false });

    // Folder open activates the first file SILENTLY — activationSeq must not advance…
    expect(store.getState().activationSeq).toBe(seqA0);
    // …but the explorer tree was re-read, so entriesSeq advances (ide.ts resets history off it).
    expect(store.getState().entriesSeq).toBeGreaterThan(seqE0);
    expect(store.getState().activeUri).toBe(uriOf('a.koi')); // the active file still moved
  });

  test('applyWorkspaceEdit bumps workspaceEditSeq', async () => {
    const store = createAppStore();
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'AAAA\n');
    platform.files.set('b.koi', 'BBBB\n');
    const ws = createWorkspaceController(makeDeps(platform, makeLsp([]), makeEditor([]), { store }));
    await ws.openFolderPath(ROOT, { recent: false });
    const seq0 = store.getState().workspaceEditSeq;

    ws.applyWorkspaceEdit({
      changes: {
        [uriOf('b.koi')]: [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'Y' },
        ],
      },
    });

    expect(store.getState().workspaceEditSeq).toBe(seq0 + 1);
  });

  test('a structural op (rename) bumps entriesSeq via refreshEntries', async () => {
    const store = createAppStore();
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    const ws = createWorkspaceController(makeDeps(platform, makeLsp([]), makeEditor([]), { store }));
    await ws.openFolderPath(ROOT, { recent: false });
    const seq0 = store.getState().entriesSeq;

    await ws.handleRename({ token: `${ROOT}/a.koi`, name: 'a.koi', relPath: 'a.koi', kind: 'file' }, 'renamed.koi');

    expect(store.getState().entriesSeq).toBeGreaterThan(seq0);
  });

  test('each disk-writing save path bumps saveSeq (saveActive, saveAllDirty, applyFileEdit)', async () => {
    const store = createAppStore();
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    platform.files.set('b.koi', 'context B {}\n');
    const editor = makeEditor([]);
    const ws = createWorkspaceController(makeDeps(platform, makeLsp([]), editor, { store }));
    await ws.openFolderPath(ROOT, { recent: false });

    // saveActive: dirty the active buffer through the real sync path, then save.
    editor.setDoc('context A { v1 }\n');
    ws.syncActiveBuffer('context A { v1 }\n');
    let seq = store.getState().saveSeq;
    await ws.saveActive();
    expect(store.getState().saveSeq).toBe(seq + 1);

    // saveAllDirty: dirty the non-active b.koi, then Save all.
    ws.syncBuffer(uriOf('b.koi'), 'context B { v }\n');
    seq = store.getState().saveSeq;
    await ws.saveAllDirty();
    expect(store.getState().saveSeq).toBe(seq + 1);

    // applyFileEdit: writing a full body to an open file (by its uri key, #472) hits disk.
    seq = store.getState().saveSeq;
    await ws.applyFileEdit(uriOf('a.koi'), 'context A { v3 }\n');
    expect(store.getState().saveSeq).toBe(seq + 1);
  });

  // Type-level regression for #1010: `WorkspaceController.buffers` must be a
  // `ReadonlyMap<string, Readonly<Buffer>>` so an in-place write onto a store-owned Buffer is a
  // COMPILE error, not just a review-time convention. Before the facade type is tightened this
  // `@ts-expect-error` has nothing to suppress, so `tsc --noEmit` reports it as an unused directive
  // (TS2578) — that failure IS the red state the tightening flips.
  //
  // COMPILE-TIME-ONLY guard, not a runtime one: vitest transpiles this file (oxc/esbuild) without
  // type-checking, so `buf.text = 'mutated'` below actually EXECUTES at runtime regardless of the
  // `@ts-expect-error` directive — no store Buffer is ever `Object.freeze`d, so nothing throws. The
  // real guard is `npx tsc --noEmit` (a separate CI/local step): with the facade typed
  // `ReadonlyMap<string, Readonly<Buffer>>`, the assignment is a compile error, which
  // `@ts-expect-error` correctly suppresses — remove that directive and `tsc --noEmit` fails with
  // "Cannot assign to 'text' because it is a read-only property". This test's only job is to keep
  // that assignment PRESENT in the checked source tree so `tsc --noEmit` keeps exercising it; it
  // asserts nothing about runtime behavior.
  test('type guard: workspace.buffers.get(uri) is read-only through the facade (tsc --noEmit only)', async () => {
    const store = createAppStore();
    const platform = new FakePlatform();
    platform.files.set('a.koi', 'context A {}\n');
    const ws = createWorkspaceController(makeDeps(platform, makeLsp([]), makeEditor([]), { store }));
    await ws.openFolderPath(ROOT, { recent: false });

    const buf = ws.buffers.get(uriOf('a.koi'))!;
    // @ts-expect-error — Buffer fields must be immutable through the WorkspaceController facade;
    // any in-place write here must fail `tsc --noEmit` (it does NOT fail at vitest runtime — see
    // the test-level comment above).
    buf.text = 'mutated';
  });
});
