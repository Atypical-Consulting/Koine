// Characterization tests for the IDE shell's boot path (ide.ts `init()`). This file is the
// behavioral safety net for the planned decomposition of ide.ts: it pins down what init() does that
// is OBSERVABLE — the seeded editor doc on a default boot, the share-hash boot + hash clearing, the
// dirty-indicator title/pill, and the close/unload guard — against today's code, so any later
// extraction can be proven behavior-preserving by keeping these green.
//
// It drives the real init() with a fake host (an in-memory Platform over a Map + an in-memory
// LspTransport) injected through the existing getPlatform() seam (we mock ./host), and a DOM seeded
// to mirror index.html. No production behavior is changed — only test scaffolding.
import { afterEach, beforeEach, describe, expect, vi, test } from 'vitest';
import { act } from '@testing-library/preact';
import { EditorView } from '@codemirror/view';
import type { FsEntry, GitLogEntry, GitNumstatEntry, GitStatus, KoiFile, LspTransport, McpEndpoint, Platform } from '@/host/types';
import { buildShareUrl, buildWorkspaceShareUrl } from '@/export/share';
import { loadSettings, saveSettings } from '@/settings/persistence';

// The studio reads `__APP_VERSION__` (a vite build-time define) once at boot for the status bar.
// vitest does not define it, so stub it as a global before any init() runs — test scaffolding only,
// no production change.
vi.stubGlobal('__APP_VERSION__', '0.0.0-test');

// Drive boot through the existing getPlatform() seam: ide.ts imports getPlatform from '@/host', so we
// mock that module to return our in-memory fake. `fakePlatform.current` is swapped per test before
// init() runs. We re-export the real ./host/types so the type-only re-exports ide.ts relies on
// (FsEntry, KoiFile, …) still resolve.
const fakePlatform = { current: null as unknown as Platform };
vi.mock('@/host', async () => {
  const types = await vi.importActual<typeof import('@/host/types')>('@/host/types');
  return {
    ...types,
    getPlatform: () => fakePlatform.current,
    isTauri: () => false,
  };
});

// Make the legacy-scratch migration seam observable. ide.ts reads peekLegacyScratch() once at boot
// and calls clearLegacyScratch() ONLY inside openDefaultWorkspaceFlow AFTER the workspace is
// confirmed open (so a one-time migration of the pre-workspace scratch buffer can't lose content if
// OPFS is unavailable or the open fails). We wrap exactly those two exports in vi.fn() that DELEGATE
// to the real store implementation by default, so every other test (and every other store consumer
// at boot) behaves identically to production; a test can drive a specific scenario per-call via
// mockReturnValueOnce / mockImplementationOnce and assert on the spies. Everything else in
// @/settings/persistence is passed through untouched. (vi.hoisted so the spies exist before the hoisted vi.mock factory runs.)
const storeSeam = vi.hoisted(() => ({
  peekLegacyScratch: vi.fn<() => string | null>(),
  clearLegacyScratch: vi.fn<() => void>(),
}));
vi.mock('@/settings/persistence', async () => {
  const actual = await vi.importActual<typeof import('@/settings/persistence')>('@/settings/persistence');
  // Default: delegate to the real implementation (so boot behaves exactly as in production unless a
  // test overrides a single call).
  storeSeam.peekLegacyScratch.mockImplementation(() => actual.peekLegacyScratch());
  storeSeam.clearLegacyScratch.mockImplementation(() => actual.clearLegacyScratch());
  return {
    ...actual,
    peekLegacyScratch: storeSeam.peekLegacyScratch,
    clearLegacyScratch: storeSeam.clearLegacyScratch,
  };
});
const { peekLegacyScratch, clearLegacyScratch } = storeSeam;

// Capture the deps bag init() hands createWorkspaceController, so a test can fire the REACTIVE
// callbacks the workspace controller owns (onWorkspaceEmptied) exactly as production does — there is no
// DOM affordance that deletes the last buffer without also driving the explorer's menu + confirm. The
// mock delegates fully to the real controller, so every other test boots unchanged.
const wsControllerSeam = vi.hoisted(() => ({ deps: null as { onWorkspaceEmptied(): void } | null }));
vi.mock('@/shell/workspaceController', async () => {
  const actual = await vi.importActual<typeof import('@/shell/workspaceController')>('@/shell/workspaceController');
  return {
    ...actual,
    createWorkspaceController: (deps: Parameters<typeof actual.createWorkspaceController>[0]) => {
      wsControllerSeam.deps = deps;
      return actual.createWorkspaceController(deps);
    },
  };
});

// Same trick for the command surface: the palette's "Open folder…" entry and its mod+Shift+O chord, and
// the Save-to-disk command, both dispatch through thunks init() passes here. Driving the real chord
// would fan out to every prior boot's window keydown listener (happy-dom shares `window`), so capture
// the thunks instead.
const cmdWiringSeam = vi.hoisted(() => ({ deps: null as { openFolder(): void; saveProjectToDisk(): void } | null }));
vi.mock('@/shell/commandWiring', async () => {
  const actual = await vi.importActual<typeof import('@/shell/commandWiring')>('@/shell/commandWiring');
  return {
    ...actual,
    createCommandWiring: (deps: Parameters<typeof actual.createCommandWiring>[0]) => {
      cmdWiringSeam.deps = deps;
      return actual.createCommandWiring(deps);
    },
  };
});

// Capture the boot's single workspaceOpLock instance (#1275), so a test can contend for the REAL lock
// directly — hold it open with its own deferred op, or drive a rejecting op through it — instead of
// only ever holding it indirectly via a gated shared import. workspaceOpLock.ts is a dependency-free
// leaf module, so this delegating mock cannot skew any other module's instance graph. (Mocking
// lifecycleBoot itself to capture its deps bag is NOT safe here: its module-level appStore/bootIntent
// imports then resolve to different instances than the test's, breaking the route-intent tests.)
const lockSeam = vi.hoisted(() => ({
  current: null as null | { run<T>(op: () => Promise<T>): Promise<T> },
}));
vi.mock('@/shell/workspaceOpLock', async () => {
  const actual = await vi.importActual<typeof import('@/shell/workspaceOpLock')>('@/shell/workspaceOpLock');
  return {
    ...actual,
    createWorkspaceOpLock: () => {
      const lock = actual.createWorkspaceOpLock();
      lockSeam.current = lock;
      return lock;
    },
  };
});

// #731: capture the `onOpenPrefs` callback ide.ts wires into the (lazily-created) Assistant panel, so a
// test can invoke it and assert it routes to the Settings overlay. A partial mock: every other aiPanel
// export is preserved, and createAssistantChat returns a minimal stub (the panel is created lazily on
// "Show AI Chat", and no test exercises its other methods) instead of the real DOM-heavy panel.
const assistantSeam = vi.hoisted(() => ({ onOpenPrefs: null as null | (() => void) }));
vi.mock('@/ai/aiPanel', async () => {
  const actual = await vi.importActual<typeof import('@/ai/aiPanel')>('@/ai/aiPanel');
  return {
    ...actual,
    createAssistantChat: (opts: { onOpenPrefs: () => void }) => {
      assistantSeam.onOpenPrefs = opts.onOpenPrefs;
      return { syncWorkspace() {}, focusInput() {}, explainSelection() {} };
    },
  };
});

// happy-dom doesn't implement scrollIntoView; the Spotlight launcher (#1143) calls it on its selected
// result row when it opens (the ⌘K tests below open it).
if (typeof (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView !== 'function') {
  (HTMLElement.prototype as { scrollIntoView: () => void }).scrollIntoView = () => {};
}

// --- in-memory LspTransport --------------------------------------------------
// Records every framed message the client sends and lets the test drive server→client messages. The
// only server reply boot needs is the `initialize` response (KoineLsp.handshake awaits it before the
// workspace opens); without it start() would hang on the 15s request timeout. We answer it
// synchronously from `send` so `await lsp.start()` resolves promptly. We also answer the launcher's
// model-index requests (glossaryModel / docs / model, #1143) with empty results so
// controller.ensureModelIndex() — which buildCatalog awaits before listing commands — resolves.
class FakeLspTransport implements LspTransport {
  sent: string[] = [];
  private onMsg: ((json: string) => void) | null = null;

  start(): Promise<void> {
    return Promise.resolve();
  }
  send(message: string): Promise<void> {
    this.sent.push(message);
    const msg = JSON.parse(message) as { id?: number; method?: string };
    // Reply to the `initialize` request so the handshake completes, and to the launcher's model-index
    // requests with empty results (#1143). Any other request is left unanswered (boot does not depend on
    // it); notifications carry no id.
    if (typeof msg.id === 'number') {
      if (msg.method === 'initialize') {
        this.reply({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } });
      } else if (msg.method === 'koine/glossaryModel') {
        this.reply({ jsonrpc: '2.0', id: msg.id, result: { entries: [] } });
      } else if (msg.method === 'koine/docs') {
        this.reply({ jsonrpc: '2.0', id: msg.id, result: { files: [] } });
      } else if (msg.method === 'koine/model') {
        this.reply({ jsonrpc: '2.0', id: msg.id, result: null });
      }
    }
    return Promise.resolve();
  }
  onMessage(cb: (json: string) => void): void {
    this.onMsg = cb;
  }
  onExit(): void {
    // boot never exercises an exit
  }
  onRestart(): void {
    // boot never exercises a restart
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }

  /** Push one server→client message into the client (async, like a real transport). */
  private reply(obj: object): void {
    queueMicrotask(() => this.onMsg?.(JSON.stringify(obj)));
  }
}

// --- in-memory Platform ------------------------------------------------------
// A browser-like host backed by a Map<relPath, contents> under a single default workspace folder.
// Implements exactly the surface init()'s boot ladder touches: defaultWorkspace (first-run seeds
// model.koi), materializeWorkspace (share import), listKoiFiles / listEntries / readTextFile /
// writeTextFile, folderName, and the no-op capability reporters. canOpenFolders + createLspTransport
// complete the contract. Mutating/desktop-only ops throw if ever hit so a test can't silently pass
// against an unexercised path.
const ROOT = 'mem://workspace';

class FakePlatform implements Platform {
  readonly kind = 'browser' as const;
  readonly canHostMcp = false;
  readonly compatNeedsInProcessSources = true;
  readonly usesServiceWorker = true;
  readonly canOpenFolders = true;
  readonly canSaveProjects = true;
  readonly canRunShell = false;
  readonly canUseGit = false;
  readonly canRevealInFileManager = false;
  persistsWorkspace = true;
  readonly transport = new FakeLspTransport();

  /** relPath (forward-slashed) -> UTF-8 contents. Tokens are `${ROOT}/${relPath}`. */
  files = new Map<string, string>();
  /** Records share-import materializations so a test can assert the shared text was written. */
  materialized: { name: string; files: { relPath: string; contents: string }[] }[] = [];
  defaultWorkspaceSeed: string | null = null;

  private tokenFor(relPath: string): string {
    return `${ROOT}/${relPath}`;
  }
  private relOf(token: string): string {
    return token.startsWith(ROOT + '/') ? token.slice(ROOT.length + 1) : token;
  }

  createLspTransport(): LspTransport {
    return this.transport;
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
  openExternal(): void {
    // no-op in tests
  }
  revealPath(): Promise<void> {
    return Promise.resolve();
  }
  pickFolder(): Promise<string | null> {
    return Promise.resolve(null);
  }
  saveProjectToRoot = vi.fn(async (name: string, files: { relPath: string; contents: string }[]): Promise<string | null> => {
    // Seed the fake FS so the follow-up openFolderPath(token) reads the written files back.
    this.files.clear();
    for (const f of files) this.files.set(f.relPath, f.contents);
    return name;
  });
  workspaceRootName = vi.fn(async (): Promise<string | null> => null);
  pickWorkspaceRoot = vi.fn(async (): Promise<string | null> => null);
  materializeWorkspace(
    name: string,
    files: { relPath: string; contents: string }[],
  ): Promise<string | null> {
    this.materialized.push({ name, files });
    this.files.clear();
    for (const f of files) this.files.set(f.relPath, f.contents);
    return Promise.resolve(ROOT);
  }
  defaultWorkspace(seed: string): Promise<string | null> {
    // First-run: seed a single model.koi, mirroring the real OPFS-backed default workspace.
    this.defaultWorkspaceSeed = seed;
    if (this.files.size === 0) this.files.set('model.koi', seed);
    return Promise.resolve(ROOT);
  }
  isAutoRestorableToken(token: string): Promise<boolean> {
    return Promise.resolve(token === '(default)' || token.startsWith('example-'));
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
  gitLogForRange(): Promise<null> {
    return Promise.resolve(null);
  }
  // git is a desktop-only capability (#272); this browser-like fake reports canUseGit=false, so the
  // source-control methods are never reached. They reject (rather than fake-resolve) so a test that
  // forgot to guard fails loudly instead of passing against an unexercised path.
  private gitUnavailable(): Promise<never> {
    return Promise.reject(new Error('git is unavailable in this fake host'));
  }
  gitStatus(): Promise<GitStatus> {
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
    this.files.set(this.relOf(path), contents);
    return Promise.resolve();
  }
  saveZip(): Promise<boolean> {
    return Promise.resolve(true);
  }
  readFolderSources(): Promise<{ uri: string; text: string }[]> {
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
    return Promise.reject(new Error('listDir not used at boot'));
  }
  createFile(_folderToken: string, relPath: string, contents = ''): Promise<string> {
    this.files.set(relPath, contents);
    return Promise.resolve(this.tokenFor(relPath));
  }
  createFolder(_folderToken: string, relPath: string): Promise<string> {
    return Promise.resolve(this.tokenFor(relPath));
  }
  renameEntry(): Promise<string> {
    return Promise.reject(new Error('renameEntry not used at boot'));
  }
  deleteEntry(token: string): Promise<void> {
    this.files.delete(this.relOf(token));
    return Promise.resolve();
  }
  moveEntry(): Promise<string> {
    return Promise.reject(new Error('moveEntry not used at boot'));
  }
}

// --- DOM seed ----------------------------------------------------------------
// The `#app` markup from index.html, inlined so the id surface init() looks up via el(...) can never
// drift from production (a missing id makes el() throw). Kept byte-for-byte equivalent to index.html's
// <body> contents; if index.html changes its id set, this seed (and these tests) must follow.
const APP_HTML = `
    <div id="app">
      <header id="toolbar">
        <button type="button" id="btn-home" class="brand"><span class="brand-logo"></span><span class="brand-text"><span class="brand-name">Koine</span><span class="brand-eyebrow">Studio</span></span></button>
        <div class="iconset" role="toolbar">
          <button type="button" id="btn-new" class="t-ico" title="Start a new empty model (prompts if you have unsaved changes)">New</button>
          <button type="button" id="btn-open-folder" class="t-ico" title="Open a folder of .koi models">Open</button>
          <div id="history-controls-host"></div>
        </div>
        <button type="button" id="palette-hint" class="cmd palette-hint"><span class="cmd-kbd" data-role="cmd-kbd"></span></button>
        <div class="toolbar-right">
          <div id="emit-target-host"></div>
          <button type="button" id="btn-generate-project" class="generate">Generate</button>
          <button type="button" id="btn-prefs" class="icon-btn">prefs</button>
          <button type="button" id="btn-toolbar-overflow" class="icon-btn" aria-haspopup="menu" aria-expanded="false" hidden>⋮</button>
          <div id="status" role="status" aria-live="polite"></div>
        </div>
      </header>
      <main id="split">
        <!-- The rail's inner markup is owned by leftRail.ts and injected by init() (leftRailMarkup),
             exactly as index.html does — so this stays a thin shell and can't drift from the real ids. -->
        <aside id="leftrail" class="pane"></aside>
        <div class="koi-resizer" id="leftrail-resizer"></div>
        <section id="center" class="pane">
          <div id="deck-bar"></div>
          <div id="center-body">
            <section id="center-visual" class="center-host">
              <div id="canvas-palette-host"></div>
              <div id="diagram-host"></div>
            </section>
            <section id="center-technical" class="center-host" hidden>
              <div id="tech-body">
                <section id="editor-pane" class="tech-view"></section>
                <div id="view-scenarios" class="tech-view" hidden></div>
              </div>
            </section>
            <section id="center-output" class="center-host" hidden>
              <div id="output-body">
                <div id="view-preview" class="tech-view"></div>
                <div id="view-check" class="tech-view doc-view" hidden></div>
                <div id="panel-contextmap" class="tech-view doc-view" hidden></div>
              </div>
            </section>
            <section id="center-docs" class="center-host" hidden>
              <div id="docs-body">
                <div id="view-glossary" class="tech-view doc-view"></div>
                <div id="view-docs" class="tech-view doc-view" hidden></div>
                <div id="view-notes" class="tech-view doc-view" hidden></div>
              </div>
            </section>
          </div>
          <!-- The gear-launched Settings overlay (#482/#731): a sibling of #center-body, populated by
               createSettingsPage on first route into Settings. -->
          <section id="center-panel-settings" class="settings-page" role="dialog" aria-modal="true" aria-label="Settings" hidden>
            <header id="settings-page-header" class="settings-page-header">
              <h2 class="settings-page-title">Settings</h2>
              <div class="settings-page-header-controls">
                <div id="settings-scope-toggle" class="settings-scope-toggle"></div>
                <div id="settings-mode-toggle" class="settings-mode-toggle"></div>
              </div>
            </header>
            <div id="settings-page-body" class="settings-page-body"></div>
          </section>
          <footer id="diagnostics">
            <div class="koi-resizer koi-resizer-y" id="diag-resizer"></div>
            <div id="diag-header">
              <button type="button" id="diag-collapse" class="diag-collapse" aria-expanded="true" aria-controls="diag-body panel-events panel-relationships panel-terminal panel-review">collapse</button>
              <div class="diag-tabs" role="tablist">
                <button type="button" class="diag-tab" id="tab-problems" role="tab" data-panel="problems" aria-selected="true" aria-controls="diag-body">Problems</button>
                <button type="button" class="diag-tab" id="tab-events" role="tab" data-panel="events" aria-selected="false" aria-controls="panel-events">Events</button>
                <button type="button" class="diag-tab" id="tab-relationships" role="tab" data-panel="relationships" aria-selected="false" aria-controls="panel-relationships">Relationships</button>
                <button type="button" class="diag-tab" id="tab-terminal" role="tab" data-panel="terminal" aria-selected="false" aria-controls="panel-terminal">Terminal</button>
                <button type="button" class="diag-tab" id="tab-review" role="tab" data-panel="review" aria-selected="false" aria-controls="panel-review">Review</button>
              </div>
              <span id="diag-count" class="diag-count"></span>
            </div>
            <div id="diag-body" class="diag-panel" role="tabpanel" aria-labelledby="tab-problems"></div>
            <div id="panel-events" class="diag-panel" role="tabpanel" aria-labelledby="tab-events" hidden></div>
            <div id="panel-relationships" class="diag-panel" role="tabpanel" aria-labelledby="tab-relationships" hidden></div>
            <div id="panel-terminal" class="diag-panel diag-panel-terminal" role="tabpanel" aria-labelledby="tab-terminal" hidden></div>
            <div id="panel-review" class="diag-panel" role="tabpanel" aria-labelledby="tab-review" hidden></div>
          </footer>
        </section>
        <div class="koi-resizer" id="split-resizer"></div>
        <aside id="right" class="pane">
          <header id="right-header"><h2 id="right-title">Properties</h2><div id="right-header-actions" class="right-header-actions" hidden></div></header>
          <div id="right-body">
            <div id="inspector-host" class="rview" role="tabpanel"></div>
            <section id="view-assistant" class="rview" role="tabpanel" hidden></section>
            <div id="rview-source-control" class="rview doc-view" role="tabpanel" hidden></div>
            <div id="rview-syntax-tree" class="rview doc-view" role="tabpanel" hidden></div>
          </div>
        </aside>
        <!-- Thin shell: init() injects the tool-window stripe's buttons via rightStripMarkup() (#500). -->
        <div id="right-strip" class="pane" role="toolbar" aria-label="Tool windows" aria-orientation="vertical"></div>
      </main>
      <footer id="statusbar">
        <button type="button" class="sb-seg" id="sb-branch" hidden><span data-role="branch-name"></span></button>
        <button type="button" class="sb-seg" id="sb-problems"><span class="sb-err" id="sb-problems-errors">✕ 0</span><span class="sb-warn" id="sb-problems-warnings">⚠ 0</span></button>
        <span class="sb-seg sb-ctx" id="sb-context">Context: —</span>
        <span class="sb-seg" id="sb-docs-ring"></span>
        <span id="sb-problems-host"></span>
        <button type="button" id="unsaved-indicator" class="unsaved-indicator" hidden></button>
        <span class="sb-spacer"></span>
        <span id="sb-compiling-host"></span>
        <span class="sb-seg sb-emit" id="sb-emit"></span>
        <span class="sb-seg static" id="sb-cursor">Ln 1, Col 1</span>
        <span class="sb-seg static" id="sb-encoding">UTF-8</span>
        <span class="sb-seg sb-ready" id="sb-connection">Connecting…</span>
        <span class="sb-seg static" id="sb-version"></span>
      </footer>
      <nav id="mobile-zone-bar-host" aria-label="Studio zone switcher"></nav>
      <div id="inspector-sheet-host"></div>
    </div>`;

/** Seed document.body with the full app markup (mirrors index.html) so init()'s el() lookups resolve. */
function seedIdeDom(): void {
  document.body.innerHTML = APP_HTML;
  // index.html ships a clean <title>; capture it the way the app does (ide.ts reads document.title
  // once at boot as the dirty-indicator base).
  document.title = 'Koine Studio';
}

/** Install a fresh fake platform for a test and return it for assertions. */
function installPlatform(): FakePlatform {
  const p = new FakePlatform();
  fakePlatform.current = p;
  return p;
}

/**
 * Boot the IDE: seed the DOM (unless told not to), install the fake host, run init(), then let the
 * async boot ladder settle (lsp.start → handshake reply microtask → workspace open). Returns the
 * fake platform plus the `beforeunload` handler THIS init() registered on window.
 *
 * We capture that handler via an addEventListener spy because window is shared across tests in the
 * happy-dom environment: every prior init() left its own `beforeunload` listener (bound to its own,
 * possibly-dirty, closure), so `window.dispatchEvent` would fan out to stale guards too. Invoking the
 * captured handler in isolation tests exactly the guard the current boot wired up — the production
 * single-init reality — without cross-test leakage. (init() registers it once at line ~2132.)
 */
async function boot(opts: {
  dom?: boolean;
  platform?: FakePlatform;
  // The boot-layer seam main.ts injects (#391): a failed open-recent is reported here rather than
  // overlaid on the editor. Forwarded into init() so a test can observe the report.
  hooks?: {
    onOpenRecentFailed?: (path: string, reason: 'unreadable' | 'empty') => void;
    onOpenRecentSucceeded?: (path: string) => void;
  };
} = {}): Promise<{
  init: (hooks?: {
    onOpenRecentFailed?: (path: string, reason: 'unreadable' | 'empty') => void;
    onOpenRecentSucceeded?: (path: string) => void;
  }) => void;
  platform: FakePlatform;
  beforeUnload: (e: Event) => void;
}> {
  if (opts.dom ?? true) seedIdeDom();
  const platform = opts.platform ?? installPlatform();
  const { init } = await import('@/shell/ide');

  let beforeUnload: ((e: Event) => void) | null = null;
  const realAdd = window.addEventListener.bind(window);
  const spy = vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'beforeunload' && typeof listener === 'function') {
      beforeUnload = listener as (e: Event) => void;
    }
    return realAdd(type as never, listener as never, options as never);
  });
  try {
    // init() returns a teardown that disposes the controller's pending debounce timers. Capture it so
    // afterEach can release them — otherwise boot's onDocEdited debounce (a real 350ms timer) fires
    // after this file's happy-dom env is gone, throwing "document is not defined" as an unhandled error.
    disposeIde = init(opts.hooks);
  } finally {
    spy.mockRestore();
  }
  await settleBoot();
  if (!beforeUnload) throw new Error('init() did not register a beforeunload handler');
  return { init, platform, beforeUnload };
}

/** Flush the boot ladder's chained promises + microtask-delivered LSP handshake reply. */
async function settleBoot(): Promise<void> {
  // Several awaits chain: lsp.start() → handshake request → (microtask) initialize reply →
  // openDefaultWorkspaceFlow → openFolderPath. A handful of macrotask turns drains them.
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

/** The CodeMirror editor's current document text (the .cm-content element holds the doc lines). */
function editorDoc(): string {
  const content = document.querySelector('.cm-content');
  return content?.textContent ?? '';
}

/** The live EditorView init() created in #editor-pane (reached from its DOM, no private handle). */
function editorView(): EditorView {
  const dom = document.querySelector<HTMLElement>('#editor-pane .cm-editor');
  if (!dom) throw new Error('no EditorView mounted in #editor-pane');
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error('no EditorView mounted in #editor-pane');
  return view;
}

/**
 * Simulate a user edit by dispatching a real CodeMirror transaction that mutates the doc — this fires
 * the editor's updateListener (u.docChanged), i.e. exactly the onChange path a keystroke drives in the
 * app. We append text so the doc genuinely changes (the IDE flips the buffer dirty only on a real
 * change).
 */
function typeIntoEditor(text: string): void {
  const view = editorView();
  view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
}

/** Put a single-model share payload in the URL hash, the way a shared playground link arrives. */
function setSingleShareHash(source: string): void {
  const url = buildShareUrl(source);
  window.location.hash = url.slice(url.indexOf('#'));
}

/** Put a multi-file workspace share payload in the URL hash (a shared folder link). */
function setWorkspaceShareHash(files: { relPath: string; text: string }[], active?: string): void {
  const url = buildWorkspaceShareUrl(files, active);
  window.location.hash = url.slice(url.indexOf('#'));
}

// The teardown returned by the most recent init() (boot() captures it). afterEach calls it to dispose
// the controller's pending debounce timers before this file's happy-dom environment is torn down.
let disposeIde: (() => void) | undefined;

beforeEach(() => {
  document.body.innerHTML = '';
  fakePlatform.current = null as unknown as Platform;
  window.location.hash = '';
  // localStorage is a file-global in-memory shim (test-setup.ts), so a default/example boot persists a
  // `lastWorkspace` pointer that would otherwise leak into the next test's boot ladder (#535). Drop it so
  // every test boots as a fresh user unless it explicitly seeds the pointer.
  localStorage.removeItem('koine.studio.lastWorkspace');
  // Clear the legacy-scratch seam's call history + any queued *Once overrides so each test starts
  // from the delegating default (re-established by the vi.mock factory on the module reset below).
  peekLegacyScratch.mockReset();
  clearLegacyScratch.mockReset();
  vi.resetModules();
});

afterEach(() => {
  // Dispose the booted IDE first so its pending debounce timers are cleared while the DOM still exists;
  // otherwise a leaked 350ms refresh fires post-teardown and throws "document is not defined".
  disposeIde?.();
  disposeIde = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.location.hash = '';
});

describe('ide init() — scaffolding', () => {
  test('init() throws without a seeded DOM (the el() lookups must find their ids)', async () => {
    installPlatform();
    const { init } = await import('@/shell/ide');
    expect(() => init()).toThrow();
  });

  test('init() boots cleanly once the DOM is seeded and the host is faked', async () => {
    await boot();
    // The boot ladder ran to completion: openFolderPath writes the opened folder's display name into
    // #filetree-title (the last observable step before the tree renders), so a non-placeholder title
    // proves the workspace opened. (Status only goes "green" on a diagnostics push, which the boot
    // path itself never triggers, so it is not a boot-completion signal.)
    expect(document.getElementById('filetree-title')!.textContent).toBe('workspace');
  });
});

describe('ide init() — default-workspace boot', () => {
  test('opens a seeded model.koi and the editor shows the seed', async () => {
    const { platform } = await boot();
    // The host first-run-seeds a single model.koi from the SEED const ide.ts passed defaultWorkspace.
    expect(platform.files.has('model.koi')).toBe(true);
    const seed = platform.defaultWorkspaceSeed!;
    expect(seed).toContain('context Billing');
    // openFolderPath activates the first file and sets the editor doc to its text → the editor shows
    // the seed. CodeMirror strips trailing blank lines in textContent, so compare on a stable token.
    expect(editorDoc()).toContain('context Billing');
    expect(editorDoc()).toContain('value Money');
  });

  test('on a non-persistent (memory-only) host, the editor still opens AND a memory-only banner is shown', async () => {
    const platform = installPlatform(); // installs it as the active host
    platform.persistsWorkspace = false; // simulate a no-OPFS browser (Safari / Firefox Private)
    await boot({ platform });
    // The workspace still opens (no dead-end): the editor shows the seed.
    expect(editorDoc()).toContain('context Billing');
    // …and the user is warned that work won't survive a reload.
    const banner = document.getElementById('koi-memory-banner');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toMatch(/can.t save to disk/i);
  });

  test('a persistent host shows NO memory-only banner', async () => {
    await boot(); // default FakePlatform persists
    expect(document.getElementById('koi-memory-banner')).toBeNull();
  });
});

describe('ide init() — #-hash single shared model', () => {
  test("seeds the editor's initial doc from the shared model and clears the hash after boot", async () => {
    const SHARED = 'context Shared {\n  value Tag { raw: String }\n}\n';
    setSingleShareHash(SHARED);

    const { platform } = await boot();

    // The shared model is the editor's first paint (initialDoc), not the default SEED.
    expect(editorDoc()).toContain('context Shared');
    expect(editorDoc()).not.toContain('context Billing');
    // It opened as a transient 1-file 'shared' workspace (materializeWorkspace), not the default one.
    expect(platform.materialized.map((m) => m.name)).toContain('shared');
    const shared = platform.materialized.find((m) => m.name === 'shared')!;
    expect(shared.files[0].contents).toBe(SHARED);
    // The #model= fragment is cleared after import so a reload returns home (clearModelHash).
    expect(window.location.hash).toBe('');
  });
});

describe('ide init() — #-hash multi-file shared workspace', () => {
  test('materializes the shared files, opens the `active` one, and clears the hash after boot', async () => {
    // A workspace-share link carrying two files; the recipient should land on the named `active` file.
    // `active` is the relPath-SECOND file (orders.koi) on purpose: openFolderPath would otherwise
    // activate the relPath-first billing.koi, so landing on orders.koi proves `active` was honoured.
    const FILES = [
      { relPath: 'orders.koi', text: 'context Orders {\n  value Sku { raw: String }\n}\n' },
      { relPath: 'billing.koi', text: 'context Billing {\n  value Money { amount: Decimal }\n}\n' },
    ];
    setWorkspaceShareHash(FILES, 'orders.koi');

    const { platform } = await boot();

    // Boot took the `workspace` ladder branch → importSharedWorkspace materialized a real workspace
    // (name 'shared-workspace') from the shared files, not the default one.
    expect(platform.materialized.map((m) => m.name)).toContain('shared-workspace');
    const shared = platform.materialized.find((m) => m.name === 'shared-workspace')!;
    expect(shared.files.map((f) => f.relPath).sort()).toEqual(['billing.koi', 'orders.koi']);
    expect(shared.files.find((f) => f.relPath === 'orders.koi')!.contents).toBe(FILES[0].text);
    // The materialized files became openable: both are present in the host fs after the import.
    expect(platform.files.has('orders.koi')).toBe(true);
    expect(platform.files.has('billing.koi')).toBe(true);
    // importSharedWorkspace honours the share's `active`, so the editor opens orders.koi (not the
    // relPath-first billing.koi that openFolderPath would otherwise activate).
    expect(editorDoc()).toContain('context Orders');
    expect(editorDoc()).not.toContain('context Billing');
    // It did NOT fall through to the default SEED workspace (which would have seeded model.koi).
    expect(platform.defaultWorkspaceSeed).toBeNull();
    expect(platform.files.has('model.koi')).toBe(false);
    // The #model= fragment is cleared after import so a reload returns home (clearModelHash).
    expect(window.location.hash).toBe('');
  });
});

/**
 * Park the shared-workspace import inside `materializeWorkspace` until the returned `release()` is
 * called — i.e. hold the workspace-open lock the way a slow host does — then let the real import run.
 */
function gateSharedImport(platform: FakePlatform): () => void {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const real = platform.materializeWorkspace.bind(platform);
  platform.materializeWorkspace = async (name, files) => {
    await gate;
    return real(name, files);
  };
  return release;
}

// Regression (#1088): #1046's workspace-open lock lived inside createLifecycleBoot, so it only ever
// serialized the boot ladder's own branches. The toolbar's New / Open-folder buttons — and the mod+N,
// mod+Shift+O and palette entries that share their closures — reach the same underlying
// newModel()/openFolder() straight from ide.tsx and never saw the lock. They stayed clickable for the
// whole multi-second lsp.start() + import window, so either could land on top of an in-flight
// shared-workspace import, with whichever settled last silently winning.
//
// These drive the REAL init() with the shared import held open. The toolbar buttons are DISABLED for
// exactly that window now (#1275), so their pins assert the click is inert then works after release;
// the thunk-level pins below still contend for the lock itself (a disabled control is UX, not a race
// guard — the lock stays the mechanism that closes the race).
describe('ide init() — the workspace-open lock covers the toolbar entry points (#1088)', () => {
  test('the toolbar Open-folder button cannot race an in-flight shared import (disabled, then works after)', async () => {
    setWorkspaceShareHash([{ relPath: 'a.koi', text: 'context A {}\n' }], 'a.koi');
    const platform = installPlatform();
    const release = gateSharedImport(platform);
    // A cancelled picker: we assert only on WHEN the picker opens, never on what it returns.
    const pickFolder = vi.fn(async (): Promise<string | null> => null);
    platform.pickFolder = pickFolder;

    await boot({ platform }); // the ladder is parked mid-import, holding the lock

    // The import is still in flight: the button is greyed out (#1275) and a click is inert, so the
    // folder picker can never open on top of the import.
    const openBtn = document.getElementById('btn-open-folder') as HTMLButtonElement;
    expect(openBtn.disabled).toBe(true);
    openBtn.click();
    await settleBoot();
    expect(pickFolder).not.toHaveBeenCalled();

    release();
    await settleBoot();
    // Once the import settles the control comes back and opens the picker as usual.
    expect(openBtn.disabled).toBe(false);
    openBtn.click();
    await settleBoot();
    expect(pickFolder).toHaveBeenCalledOnce();
  });

  test('the toolbar New button cannot race an in-flight shared import (disabled, then works after)', async () => {
    setWorkspaceShareHash([{ relPath: 'a.koi', text: 'context A {}\n' }], 'a.koi');
    const platform = installPlatform();
    const release = gateSharedImport(platform);

    await boot({ platform });
    // A share boot never touches the default workspace, so `defaultWorkspaceSeed` is a clean probe for
    // "New ran": newModel() resets the default workspace via platform.defaultWorkspace(BLANK).
    expect(platform.defaultWorkspaceSeed).toBeNull();

    // The import is still in flight: the button is greyed out (#1275) and a click is inert, so the
    // reset can never blow the import away. (The reactive-reset pin below still proves a newModel()
    // that DOES land mid-import queues through the lock.)
    const newBtn = document.getElementById('btn-new') as HTMLButtonElement;
    expect(newBtn.disabled).toBe(true);
    newBtn.click();
    await settleBoot();
    expect(platform.defaultWorkspaceSeed).toBeNull();

    release();
    await settleBoot();
    // Once the import settles the control comes back; nothing is dirty, so the New guard's confirm
    // resolves straight through and the reset runs.
    expect(newBtn.disabled).toBe(false);
    newBtn.click();
    await settleBoot();
    expect(platform.defaultWorkspaceSeed).not.toBeNull();
  });

  test('the palette / mod+Shift+O Open-folder thunk defers to an in-flight shared import', async () => {
    setWorkspaceShareHash([{ relPath: 'a.koi', text: 'context A {}\n' }], 'a.koi');
    const platform = installPlatform();
    const release = gateSharedImport(platform);
    const pickFolder = vi.fn(async (): Promise<string | null> => null);
    platform.pickFolder = pickFolder;

    await boot({ platform });

    // The exact thunk init() handed createCommandWiring, which the palette entry and chord dispatch to.
    cmdWiringSeam.deps!.openFolder();
    await settleBoot();
    expect(pickFolder).not.toHaveBeenCalled();

    release();
    await settleBoot();
    expect(pickFolder).toHaveBeenCalledOnce();
  });

  // The fourth wrapped entry point. It fires reactively (the last buffer was deleted), so unlike the
  // toolbar paths it has no click to gate on — without this, a later refactor could unwrap it and the
  // suite would stay green while the clobber returned.
  test('the reactive onWorkspaceEmptied reset defers to an in-flight shared import', async () => {
    setWorkspaceShareHash([{ relPath: 'a.koi', text: 'context A {}\n' }], 'a.koi');
    const platform = installPlatform();
    const release = gateSharedImport(platform);

    await boot({ platform }); // parked mid-import, holding the lock
    expect(platform.defaultWorkspaceSeed).toBeNull();

    // Fire the exact callback ide.tsx handed the workspace controller.
    wsControllerSeam.deps!.onWorkspaceEmptied();
    await settleBoot();
    expect(platform.defaultWorkspaceSeed).toBeNull(); // the blank reset waited its turn

    release();
    await settleBoot();
    expect(platform.defaultWorkspaceSeed).toContain('context NewModel');
  });

  // The fifth wrapped entry point (#1274): Save-to-disk's own reopen-from-disk
  // (platform.saveProjectToRoot → workspace.openFolderPath) is the same class of workspace-replacing
  // operation as the other four — #1088 missed it because its `files.length === 0` guard makes it
  // unreachable during the connect window #1088 was scoped to, but not once buffers exist post-boot.
  test('the Save-to-disk thunk defers to an in-flight shared import instead of racing it', async () => {
    setWorkspaceShareHash([{ relPath: 'a.koi', text: 'context A {}\n' }], 'a.koi');
    const platform = installPlatform();
    const release = gateSharedImport(platform);

    await boot({ platform });

    // The exact thunk init() handed createCommandWiring, which the palette / launcher command dispatches to.
    cmdWiringSeam.deps!.saveProjectToDisk();
    await settleBoot();
    expect(platform.saveProjectToRoot).not.toHaveBeenCalled();

    release();
    await settleBoot();
    // The queued save now runs against the just-imported workspace (non-empty, so the files.length === 0
    // guard doesn't swallow it) — confirm the name prompt to reach the actual reopen-from-disk call.
    const input = document.querySelector('.koi-prompt-input') as HTMLInputElement;
    input.value = 'my-project';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('.koi-confirm-btn-primary') as HTMLButtonElement).click();
    await settleBoot();

    expect(platform.saveProjectToRoot).toHaveBeenCalledOnce();
  });

  // The other half of the invariant. The closures handed to createLifecycleBoot must stay UNWRAPPED:
  // runStartIntent already holds the lock when it calls them, and the FIFO queue has no re-entrancy
  // detection, so wrapping them too would enqueue the action behind the very op awaiting it — "New"
  // from Home would hang forever. Asserting the reset actually COMPLETED is what catches that; the
  // sibling #368 test only asserts the intent was consumed, which stays true under a deadlock.
  test('a Home "New model" start-intent still completes — the boot-ladder closures are not double-locked', async () => {
    const { setStartIntent } = await import('@/shell/bootIntent');
    const { appStore } = await import('@/store');

    const { platform } = await boot();
    expect(platform.defaultWorkspaceSeed).toContain('context Billing'); // the default boot's SEED

    setStartIntent({ kind: 'new' });
    appStore.setState({ route: 'editor' });
    await settleBoot();

    // runStartIntent → the raw deps.newModelUnlocked() ran to completion inside the lock, resetting to BLANK.
    expect(platform.defaultWorkspaceSeed).toContain('context NewModel');
  });

  // #1275 hardening: the same invariant, contended through the REAL lock instance (the seam), not just
  // the boot ladder's own shared import. A Home start-intent queued behind an arbitrary lock-holder
  // must (a) DEFER — runStartIntent serializes on the one boot-wide lock the facade wraps — and then
  // (b) COMPLETE once the holder releases, which is exactly what breaks if a refactor ever hands
  // createLifecycleBoot the locked facade instead of the `…Unlocked` closures: runStartIntent would
  // hold the lock while its newModel() waits behind it, and the release below would never unwedge it.
  test('a Home start-intent queued behind a held lock defers, then completes on release (no double-lock)', async () => {
    const { setStartIntent } = await import('@/shell/bootIntent');
    const { appStore } = await import('@/store');

    const { platform } = await boot();
    expect(platform.defaultWorkspaceSeed).toContain('context Billing'); // the default boot's SEED

    // Hold the boot's own lock with a deferred op — a stand-in for any slow workspace-opening op.
    let release!: () => void;
    void lockSeam.current!.run(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    await settleBoot();

    setStartIntent({ kind: 'new' });
    appStore.setState({ route: 'editor' });
    await settleBoot();
    // The intent's reset queued behind the held lock instead of racing it.
    expect(platform.defaultWorkspaceSeed).toContain('context Billing');

    release();
    await settleBoot();
    // …and ran to completion once its turn came — the raw closure inside runStartIntent is unlocked.
    expect(platform.defaultWorkspaceSeed).toContain('context NewModel');
  });
});

// #1275 item 2 (approach C from #1088's spec): the lock already serializes the workspace-opening entry
// points, but a control that LOOKS live while its click sits in the queue reads as a hang — e.g. the
// Open-folder handler holds the lock across the native picker, stalling a queued boot-ladder import
// with no visible reason. Reflect the lock's busy state onto the New / Open-folder toolbar buttons so
// the deferral is legible. onWorkspaceEmptied stays UNgated (it is automatic; the lock defers it).
describe('ide init() — workspace-opening controls grey out while an op is in flight (#1275)', () => {
  function toolbarButtons(): { newBtn: HTMLButtonElement; openBtn: HTMLButtonElement } {
    return {
      newBtn: document.getElementById('btn-new') as HTMLButtonElement,
      openBtn: document.getElementById('btn-open-folder') as HTMLButtonElement,
    };
  }

  test('New and Open-folder disable (with an explanatory title) while the shared import holds the lock, and re-enable after', async () => {
    setWorkspaceShareHash([{ relPath: 'a.koi', text: 'context A {}\n' }], 'a.koi');
    const platform = installPlatform();
    const release = gateSharedImport(platform);

    await boot({ platform }); // parked mid-import, holding the lock
    const { newBtn, openBtn } = toolbarButtons();
    for (const btn of [newBtn, openBtn]) {
      expect(btn.disabled).toBe(true);
      expect(btn.getAttribute('aria-disabled')).toBe('true');
      expect(btn.title).toMatch(/workspace/i); // says WHY, not just a dead control
    }

    release();
    await settleBoot();
    for (const btn of [newBtn, openBtn]) {
      expect(btn.disabled).toBe(false);
      expect(btn.hasAttribute('aria-disabled')).toBe(false);
    }
    // Idle restores EACH button's static index.html tooltip — the busy title must not linger, and the
    // idle title must not be stripped (every boot fires busy→idle, so a strip would be permanent).
    expect(newBtn.title).toBe('Start a new empty model (prompts if you have unsaved changes)');
    expect(openBtn.title).toBe('Open a folder of .koi models');
  });

  // The busy flag must clear on a REJECTED op — the lock already releases; a toolbar stuck disabled
  // would be strictly worse than the race the lock closes.
  test('an op that REJECTS still re-enables the controls', async () => {
    await boot();
    const { newBtn, openBtn } = toolbarButtons();
    expect(newBtn.disabled).toBe(false);

    const failing = lockSeam.current!.run(async () => Promise.reject(new Error('boom')));
    // Busy is synchronous at enqueue, so the controls grey out before the op even starts.
    expect(newBtn.disabled).toBe(true);
    expect(openBtn.disabled).toBe(true);

    await expect(failing).rejects.toThrow('boom');
    await settleBoot();
    expect(newBtn.disabled).toBe(false);
    expect(openBtn.disabled).toBe(false);
  });

  // The capability gate must win over a busy→idle re-enable: on a host that can't open folders the
  // Open-folder button is permanently disabled with its own explanation, and a drained lock must not
  // silently resurrect it (the #1088-era behavior this wiring composes over).
  test('a host without folder support keeps Open-folder disabled (capability title restored) after the lock drains', async () => {
    const platform = installPlatform();
    (platform as { canOpenFolders: boolean }).canOpenFolders = false;
    await boot({ platform });

    const { newBtn, openBtn } = toolbarButtons();
    await lockSeam.current!.run(async () => undefined);
    await settleBoot();

    expect(newBtn.disabled).toBe(false);
    expect(openBtn.disabled).toBe(true);
    expect(openBtn.title).toMatch(/Chromium-based browser/);
  });
});

describe('ide init() — boot ladder clears the model hash via try/finally', () => {
  test('the workspace branch clears the hash even when the import throws', async () => {
    setWorkspaceShareHash([{ relPath: 'a.koi', text: 'context A {}\n' }], 'a.koi');
    const platform = installPlatform();
    // Make the share import fail inside the try block.
    platform.materializeWorkspace = () => Promise.reject(new Error('disk full'));

    // Boot must not crash the page despite the rejected import…
    await boot({ platform });

    // …and the finally still cleared the #model= fragment, so a reload won't re-trigger the failing
    // import (the pinned guarantee of the workspace branch's try/finally).
    expect(window.location.hash).toBe('');
  });

  test('the single branch clears the hash even when the open throws', async () => {
    setSingleShareHash('context Shared { value Tag { raw: String } }\n');
    const platform = installPlatform();
    // Make the 1-file share open fail inside the try block.
    platform.materializeWorkspace = () => Promise.reject(new Error('disk full'));

    await boot({ platform });

    // The single branch's finally cleared the hash too, despite the throw.
    expect(window.location.hash).toBe('');
  });
});

describe('ide init() — legacy-scratch migration is crash-safe', () => {
  test('keeps the legacy scratch when the default workspace fails to open', async () => {
    // A pre-workspace user has a legacy scratch buffer waiting to migrate.
    peekLegacyScratch.mockReturnValue('context Legacy { value Note { raw: String } }\n');
    const platform = installPlatform();
    // The host can't back a default workspace (e.g. OPFS unavailable) → openDefaultWorkspaceFlow
    // returns { opened: false } and must bail BEFORE clearing the scratch.
    platform.defaultWorkspace = () => Promise.resolve(null);

    await boot({ platform });

    // peekLegacyScratch was consulted at boot…
    expect(peekLegacyScratch).toHaveBeenCalled();
    // …but because the workspace never opened, the scratch is NOT cleared — content is never lost.
    expect(clearLegacyScratch).not.toHaveBeenCalled();
  });

  test('clears the legacy scratch once the default workspace is confirmed open', async () => {
    // Same migration, but now the default workspace opens successfully.
    peekLegacyScratch.mockReturnValue('context Legacy { value Note { raw: String } }\n');

    const { platform } = await boot();

    // The default branch ran (no share hash) and the workspace opened, so the one-time migration
    // clear fired exactly once — and the legacy scratch text seeded the default workspace.
    expect(clearLegacyScratch).toHaveBeenCalledTimes(1);
    expect(platform.defaultWorkspaceSeed).toContain('context Legacy');
    expect(editorDoc()).toContain('context Legacy');
  });
});

describe('ide init() — dirty tracking', () => {
  test('an edit flips the title to a bullet prefix and reveals the "N unsaved" pill', async () => {
    await boot();

    // Clean boot: no bullet, pill hidden.
    const unsaved = document.getElementById('unsaved-indicator') as HTMLButtonElement;
    expect(document.title).toBe('Koine Studio');
    expect(unsaved.hidden).toBe(true);

    // Editing the active buffer marks it dirty → the indicator refreshes (title bullet + pill).
    typeIntoEditor('\n// a user edit\n');

    expect(document.title).toBe('• Koine Studio');
    expect(unsaved.hidden).toBe(false);
    expect(unsaved.textContent).toBe('1 unsaved');
    expect(unsaved.getAttribute('aria-label')).toBe('Save 1 unsaved file');
  });
});

describe('ide init() — the injected store is the real singleton (#760)', () => {
  test('a caret move through the live editor writes onto the real appStore, not merely an isolated instance', async () => {
    // editorSession.test.ts proves editorSession's onCursor logic is correct against WHATEVER store
    // it's handed (see its "caret mirrors into the store cursor slice" test, which always builds its
    // own createAppStore()). That leaves one thing unproven anywhere: that ide.tsx's actual
    // `createEditorSession({ ..., store: appStore, ... })` call site really does pass the real
    // singleton through, as opposed to some other store instance a future refactor could disconnect.
    // Boot the real IDE, drive a real caret move through the live CodeMirror EditorView, and assert the
    // result lands on the REAL `appStore` singleton (imported the same way other tests in this file do,
    // e.g. the return-visit start-intent test above).
    const { appStore } = await import('@/store');

    await boot();

    const view = editorView();
    // Move the caret to the end of the seeded doc. Derive the expected 1-based line/col the same way
    // editorSession's onCursor does (ln.number, head - ln.from + 1) — re-deriving it here isn't about
    // re-proving that arithmetic (editorSession.test.ts already does), it's about avoiding a brittle
    // hardcoded position while still proving THIS write reaches the real singleton.
    const pos = view.state.doc.length;
    const ln = view.state.doc.lineAt(pos);
    const expectedLine = ln.number;
    const expectedCol = pos - ln.from + 1;

    view.dispatch({ selection: { anchor: pos } });

    // The write landed on the real appStore singleton — not a locally-created, disconnected instance.
    expect(appStore.getState().cursor).toEqual({ line: expectedLine, column: expectedCol });
    // The status-bar mirror (a separate sink in the same onCursor callback) confirms the same live path.
    expect(document.getElementById('sb-cursor')!.textContent).toBe(`Ln ${expectedLine}, Col ${expectedCol}`);
  });
});

describe('ide init() — close/unload guard', () => {
  test('beforeunload is a no-op on a clean workspace and blocks once a buffer is dirty', async () => {
    // Invoke the handler THIS boot registered (captured by boot()), not window.dispatchEvent — the
    // shared happy-dom window still carries prior tests' beforeunload listeners (bound to their own,
    // possibly-dirty, closures), so dispatching would fan out to those stale guards.
    const { beforeUnload } = await boot();

    // A clean workspace: the guard does not cancel the unload (returnValue stays unset).
    const clean = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    beforeUnload(clean);
    expect(clean.defaultPrevented).toBe(false);
    expect(clean.returnValue).toBeFalsy();

    // Dirty the workspace, then the guard cancels the unload (preventDefault + legacy returnValue).
    typeIntoEditor('\n// unsaved work\n');
    const dirty = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    beforeUnload(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    expect(dirty.returnValue).toBeTruthy();
  });
});

describe('ide init() — Save to disk', () => {
  // Chrome v2 (#923) dropped the Save-to-disk toolbar button; the flow is now reached through the ⌘K
  // Spotlight launcher (#1143) — the `save-project-to-disk` command. Open the launcher, switch to
  // Commands mode (`>`, which lists every enabled command), then click the row by title. Async because
  // the launcher's catalog (buildCatalog) awaits the model index before its command rows appear.
  async function runLauncherCommand(title: string): Promise<void> {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    await settleBoot();
    const input = document.querySelector<HTMLInputElement>('#lx-input')!;
    input.value = '>'; // Commands mode + empty query ⇒ every enabled command listed
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settleBoot();
    const row = Array.from(document.querySelectorAll<HTMLElement>('.lx-item')).find(
      (r) => r.querySelector('.lx-title')?.textContent === title,
    );
    if (!row) throw new Error(`launcher command row not found: ${title}`);
    row.click();
  }

  test('Save to disk writes the open buffers as a named project', async () => {
    await boot();
    const saveSpy = (fakePlatform.current as FakePlatform).saveProjectToRoot;

    await runLauncherCommand('Save to disk…');
    await settleBoot(); // Koine's prompt modal opens (no window.prompt)

    // Name the project in the modal field and confirm with the primary action.
    const input = document.querySelector('.koi-prompt-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    input.value = 'my-pizzeria';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('.koi-confirm-btn-primary') as HTMLButtonElement).click();
    await settleBoot();

    expect(saveSpy).toHaveBeenCalledTimes(1);
    const [name, files] = saveSpy.mock.calls[0] as [string, { relPath: string; contents: string }[]];
    expect(name).toBe('my-pizzeria');
    expect(files.some((f) => f.relPath === 'model.koi')).toBe(true);
  });

  test('Save to disk does nothing when the name prompt is cancelled', async () => {
    await boot();
    const saveSpy = (fakePlatform.current as FakePlatform).saveProjectToRoot;

    await runLauncherCommand('Save to disk…');
    await settleBoot();

    // Dismiss the prompt with Cancel → ask() resolves null → nothing is written. The primary button
    // is unique to the prompt dialog, so reach its modal through it to find that dialog's Cancel.
    const promptModal = (document.querySelector('.koi-confirm-btn-primary') as HTMLElement).closest('.koi-modal')!;
    (promptModal.querySelector('.koi-confirm-btn:not(.koi-confirm-btn-primary)') as HTMLButtonElement).click();
    await settleBoot();

    expect(saveSpy).not.toHaveBeenCalled();
  });

  test('Save to disk is absent from the palette when the host cannot save projects', async () => {
    const p = installPlatform();
    // Override the readonly property to simulate a host that cannot save projects.
    (p as unknown as { canSaveProjects: boolean }).canSaveProjects = false;
    await boot({ platform: p });
    // The command's when() gate filters it out entirely (chrome v2, #923 removed the toolbar button whose
    // `hidden` used to carry this): the launcher's Commands mode offers no "Save to disk…" row.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    await settleBoot();
    const input = document.querySelector<HTMLInputElement>('#lx-input')!;
    input.value = '>';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settleBoot();
    const titles = Array.from(document.querySelectorAll('.lx-title')).map((e) => e.textContent);
    expect(titles).not.toContain('Save to disk…');
  });
});

describe('ide init() — Recent open recovery routes to the Home route (#391)', () => {
  test('a dead Recent (via the Home start-intent) is reported to the boot layer, not overlaid on the editor', async () => {
    // Seed one recent — production renders its row on the Home recovery view, not over the editor.
    localStorage.setItem('koine.studio.recentFolders', JSON.stringify(['ghost']));

    const p = installPlatform();
    // Make listKoiFiles throw only for the dead recent path ('ghost').
    const realListKoiFiles = p.listKoiFiles.bind(p);
    // Cast is required: FakePlatform omits the token arg but the real Platform interface has it.
    (p as unknown as { listKoiFiles: (token: string) => Promise<KoiFile[]> }).listKoiFiles = vi.fn(
      async (folder: string) => {
        if (folder === 'ghost') throw new Error('this folder is no longer available — open it again');
        return realListKoiFiles();
      },
    );

    // Home opens a recent by queuing a start-intent then navigating to the editor (#368); the IDE
    // consumes it once at boot. listKoiFiles throws → the IDE no longer paints the legacy welcome
    // overlay over the editor (#391): it hands the failure back to the boot layer (which returns to
    // Home and runs the dead-recent recovery there — exercised in boot.test.ts).
    window.location.hash = '';
    // Import setStartIntent AFTER beforeEach's vi.resetModules() so it shares the SAME bootIntent module
    // instance that boot()'s dynamic import('@/shell/ide') will load — a static top-of-file import binds
    // the pre-reset instance, whose `pending` the freshly-loaded IDE would never see.
    const { setStartIntent } = await import('@/shell/bootIntent');
    setStartIntent({ kind: 'open-recent', path: 'ghost' });

    const onOpenRecentFailed = vi.fn();
    await boot({ platform: p, hooks: { onOpenRecentFailed } });
    await settleBoot();

    // The IDE reported the dead recent to the boot layer, with its reason…
    expect(onOpenRecentFailed).toHaveBeenCalledWith('ghost', 'unreadable');
    // …and never mounted an in-editor start-screen overlay (the two-surfaces case #368/#391 remove).
    expect(document.querySelector('.koi-welcome')).toBeNull();
  });

  test('a successful open-recent reports back via onOpenRecentSucceeded (#1017)', async () => {
    // The boot layer's cloned-empty tracking (main.ts) needs a success signal, not just a failure one,
    // so a clone that opens cleanly doesn't leave a stale "just cloned" association pinned to its path
    // forever. FakePlatform's listKoiFiles ignores its folder argument and reads from `this.files`, so
    // seed one .koi file there — mirroring a clone whose repo already has a model — before the open.
    const p = installPlatform();
    p.files.set('model.koi', 'context Billing {}');

    window.location.hash = '';
    const { setStartIntent } = await import('@/shell/bootIntent');
    setStartIntent({ kind: 'open-recent', path: '/repos/my-clone' });

    const onOpenRecentSucceeded = vi.fn();
    const onOpenRecentFailed = vi.fn();
    await boot({ platform: p, hooks: { onOpenRecentSucceeded, onOpenRecentFailed } });
    await settleBoot();

    expect(onOpenRecentSucceeded).toHaveBeenCalledWith('/repos/my-clone');
    expect(onOpenRecentFailed).not.toHaveBeenCalled();
  });
});

describe('ide init() — return-visit start-intent (#368)', () => {
  test('a start-intent queued after boot is consumed on the next transition into the editor route', async () => {
    // The IDE boots once and survives Home↔Editor swaps, so init()'s boot ladder only consumes a
    // start-intent the first time. A start action taken on a RETURN visit to Home navigates back to a
    // still-initialised editor — init() does NOT re-run — so without the route-change subscriber the
    // intent would be silently dropped. This pins that the subscriber consumes it.
    const { setStartIntent, takeStartIntent } = await import('@/shell/bootIntent');
    const { appStore } = await import('@/store');

    await boot(); // first boot: route is the default 'home', init() runs once, no intent queued
    await settleBoot();

    // Simulate a Home action on a return visit: queue an intent, then the route flips home → editor.
    setStartIntent({ kind: 'new' });
    appStore.setState({ route: 'editor' });

    // The subscriber consumed it synchronously on the transition — nothing is left queued.
    expect(takeStartIntent()).toBeNull();

    // Drain the fire-and-forget action the intent triggered (newModel) before the env tears down.
    await settleBoot();
  });
});

describe('ide init() — mobile Props zone reflects selected state (#221)', () => {
  test('selecting Props marks its tab aria-selected and keeps the underlying zone (not the empty #right rail)', async () => {
    const origWidth = window.innerWidth;
    // A phone-width viewport so the bottom MobileZoneBar drives the single-column shell.
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 500 });
    try {
      await boot();
      const split = document.getElementById('split')!;
      const underlying = split.dataset.mobileZone; // boot lands on the default 'code' zone underneath

      const propsTab = document.querySelector<HTMLButtonElement>('#mobile-zone-bar-host button[data-zone="props"]')!;
      expect(propsTab.getAttribute('aria-selected')).toBe('false');

      act(() => propsTab.click()); // flush the store-driven MobileZoneBar re-render

      // The Props tab now reflects selected state (store-driven aria-selected + roving tabindex): the bug
      // was that selecting Props opened the sheet and returned BEFORE writing the slice, so the tab never
      // became selected.
      expect(propsTab.getAttribute('aria-selected')).toBe('true');
      // …and the single-column shell keeps the underlying real zone — the inspector is a sheet OVERLAY, so
      // #split is NOT switched to the empty #right rail.
      expect(split.dataset.mobileZone).toBe(underlying);
      expect(split.dataset.mobileZone).not.toBe('props');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: origWidth });
    }
  });
});

// #354 — the effective lspTrace setting is pushed to the live LSP client. PR #349 made lspTrace one of
// the per-workspace-scopable fields but left it inert; this wires applyEffectiveScoped → lsp.setTrace so
// a global (or per-workspace) trace change drives LSP logging verbosity live, exactly like the other
// three scoped fields. We spy on KoineLsp.prototype.setTrace — dynamic-imported AFTER beforeEach's
// vi.resetModules() so the spy lands on the same class the fresh ide module will construct.
describe('ide init() — effective lspTrace drives the LSP (#354)', () => {
  test('boot pushes the effective (verbose) lspTrace to lsp.setTrace', async () => {
    saveSettings({ ...loadSettings(), lspTrace: 'verbose' });
    const { KoineLsp } = await import('@/lsp/lsp');
    const setTrace = vi.spyOn(KoineLsp.prototype, 'setTrace');
    try {
      await boot();
      expect(setTrace).toHaveBeenCalledWith('verbose');
    } finally {
      localStorage.clear();
    }
  });

  test('boot applies the default off level when lspTrace is unset', async () => {
    saveSettings({ ...loadSettings(), lspTrace: 'off' });
    const { KoineLsp } = await import('@/lsp/lsp');
    const setTrace = vi.spyOn(KoineLsp.prototype, 'setTrace');
    try {
      await boot();
      expect(setTrace).toHaveBeenCalledWith('off');
    } finally {
      localStorage.clear();
    }
  });
});

// #535: a cold boot with no start-intent restores the LAST opened OPFS workspace (the bug was that an
// opened example silently reverted to the empty default on reload). Only OPFS-internal tokens
// ('(default)' / 'example-*') are auto-restored — a picked-folder handle needs a permission gesture
// boot can't provide, so it stays a manual Recents click.
describe('ide init() — last-workspace restore on reload (#535)', () => {
  const LAST_WS_KEY = 'koine.studio.lastWorkspace';
  // localStorage is a file-global in-memory shim (test-setup.ts) that the suite's beforeEach does NOT
  // clear, so drop the pointer after each test here to avoid leaking it into later boots.
  afterEach(() => localStorage.removeItem(LAST_WS_KEY));

  /** Override listKoiFiles to record which folder tokens boot asked the host to read, returning the
   *  current fake FS for every token (so a seeded example resolves like its persisted OPFS dir would). */
  function captureOpened(p: FakePlatform, opened: string[]): void {
    (p as unknown as { listKoiFiles: (token: string) => Promise<KoiFile[]> }).listKoiFiles = vi.fn(
      async (folder: string) => {
        opened.push(folder);
        const out: KoiFile[] = [];
        for (const relPath of p.files.keys()) {
          if (!relPath.toLowerCase().endsWith('.koi')) continue;
          out.push({ path: `${ROOT}/${relPath}`, name: relPath.split('/').pop()!, relPath });
        }
        out.sort((a, b) => a.relPath.localeCompare(b.relPath));
        return out;
      },
    );
  }

  test('restores the last OPFS example workspace instead of the default seed', async () => {
    localStorage.setItem(LAST_WS_KEY, 'example-saas');
    const p = installPlatform();
    // The example's persisted OPFS files survive a reload, so re-opening the token resolves.
    p.files.set('sub.koi', 'context Sub { value Plan { raw: String } }\n');
    const opened: string[] = [];
    captureOpened(p, opened);

    await boot({ platform: p });

    // Boot re-opened the example token and NEVER seeded the default workspace.
    expect(opened).toContain('example-saas');
    expect(p.defaultWorkspaceSeed).toBeNull();
    expect(editorDoc()).toContain('context Sub');
  });

  test('falls back to the default seed when the last workspace no longer resolves', async () => {
    localStorage.setItem(LAST_WS_KEY, 'example-gone');
    const p = installPlatform();
    const realListKoiFiles = p.listKoiFiles.bind(p);
    (p as unknown as { listKoiFiles: (token: string) => Promise<KoiFile[]> }).listKoiFiles = vi.fn(
      async (folder: string) => {
        // The persisted example dir was evicted / IndexedDB cleared: re-opening it throws.
        if (folder === 'example-gone') throw new Error('this folder is no longer available — open it again');
        return realListKoiFiles();
      },
    );

    await boot({ platform: p });

    // The restore attempt failed → boot opened + seeded the default workspace rather than stranding the user.
    expect(p.defaultWorkspaceSeed).not.toBeNull();
    expect(editorDoc()).toContain('context Billing');
  });

  test('does NOT auto-restore a picked-folder token at boot (it needs a permission gesture)', async () => {
    localStorage.setItem(LAST_WS_KEY, '/Users/me/picked-folder');
    const p = installPlatform();
    const opened: string[] = [];
    captureOpened(p, opened);

    await boot({ platform: p });

    // A picked token is not OPFS-internal, so boot ignored it and opened the default workspace.
    expect(opened).not.toContain('/Users/me/picked-folder');
    expect(p.defaultWorkspaceSeed).not.toBeNull();
    expect(editorDoc()).toContain('context Billing');
  });

  test('a stored (default) pointer opens the default flow without a doomed openFolderPath or error pill', async () => {
    // The '(default)' handle is registered lazily (never in IndexedDB), so re-opening it via
    // openFolderPath at cold boot would always fail and leave a red "could not read folder" status pill
    // on the most common returning-user boot. Boot must route '(default)' straight to the default flow.
    localStorage.setItem(LAST_WS_KEY, '(default)');
    const p = installPlatform();
    const opened: string[] = [];
    captureOpened(p, opened);

    await boot({ platform: p });

    expect(p.defaultWorkspaceSeed).not.toBeNull();
    expect(editorDoc()).toContain('context Billing');
    expect(opened).not.toContain('(default)'); // never attempted a doomed openFolderPath('(default)')
    expect(document.getElementById('status')!.dataset.kind).not.toBe('error');
  });
});

// #731: every Settings entry point — the toolbar gear, the command palette ("Settings…" / "About"), the
// mod+, chord, and the Assistant's "Open Settings" — routes to the ONE gear-launched center overlay; the
// legacy createPreferences modal is retired (never instantiated). Observed purely through the DOM: the
// overlay reveals #center-panel-settings (hiding #center-body) and mounts the preferences pane into
// #settings-page-body; the modal would instead mount a .koi-modal--settings backdrop on document.body.
describe('ide init() — Settings entry points unify on the center overlay (#731)', () => {
  beforeEach(() => {
    // createSettingsPage restores the last-used representation; pin Visual so the category tabs render.
    localStorage.removeItem('koine.studio.settingsEditorMode');
  });

  const overlayShown = () =>
    document.getElementById('center-panel-settings')!.hidden === false &&
    document.getElementById('center-body')!.hidden === true;
  const paneMounted = () => document.querySelector('#settings-page-body .koi-settings-layout') !== null;
  const aboutTabSelected = () =>
    document.querySelector('#settings-page-body #koi-settings-tab-about')?.getAttribute('aria-selected') ===
    'true';
  const settingsModalExists = () => document.querySelector('.koi-modal--settings') !== null;

  /** Open the Spotlight launcher (mod+K), switch to Commands mode (`>`), click the row whose title
   *  matches — which runs it. Async: the launcher's command rows appear only after buildCatalog resolves. */
  async function runLauncherCommand(title: string): Promise<void> {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    await settleBoot();
    const input = document.querySelector<HTMLInputElement>('#lx-input')!;
    input.value = '>';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settleBoot();
    const row = Array.from(document.querySelectorAll<HTMLElement>('.lx-item')).find(
      (r) => r.querySelector('.lx-title')?.textContent === title,
    );
    if (!row) throw new Error(`launcher command not found: ${title}`);
    row.click();
  }

  test('the toolbar gear opens the overlay and mounts the preferences pane (regression)', async () => {
    await boot();
    document.getElementById('btn-prefs')!.click();
    expect(overlayShown()).toBe(true);
    expect(paneMounted()).toBe(true);
  });

  test('the "Settings…" launcher command opens the overlay, not a modal', async () => {
    await boot();
    await runLauncherCommand('Settings…');
    expect(overlayShown()).toBe(true);
    expect(paneMounted()).toBe(true);
  });

  test('the "About Koine Studio" launcher command opens the overlay on the About tab', async () => {
    await boot();
    await runLauncherCommand('About Koine Studio');
    expect(overlayShown()).toBe(true);
    expect(aboutTabSelected()).toBe(true);
  });

  test('the mod+, chord opens the overlay', async () => {
    await boot();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }));
    expect(overlayShown()).toBe(true);
  });

  test("the Assistant's onOpenPrefs opens the overlay", async () => {
    await boot();
    // Showing the AI Chat right view lazily creates the assistant panel, capturing its onOpenPrefs.
    await runLauncherCommand('Show AI Chat');
    expect(typeof assistantSeam.onOpenPrefs).toBe('function');
    assistantSeam.onOpenPrefs!();
    expect(overlayShown()).toBe(true);
  });

  test('the legacy createPreferences modal is never instantiated', async () => {
    await boot();
    expect(settingsModalExists()).toBe(false);
  });
});

// #789: the save (Ctrl+S / ⌘S) and undo/redo (Ctrl+Z / ⌘Z / ⌘⇧Z) global keydown listeners
// registered directly in init() were never paired with a removeEventListener in the aggregate
// teardown. This suite pins the fix: after teardown, both listeners must be gone so repeated
// init()/teardown cycles in vitest don't accumulate stale global handlers.
describe('ide init() — editor keydown listeners are disposed on teardown (#789)', () => {
  test('Ctrl+S does not trigger a disk write after teardown (save listener removed)', async () => {
    // Disable format-on-save so saveActive() reaches writeTextFile without hanging on an LSP
    // format request (FakeLspTransport only responds to `initialize`, not `formatting`).
    saveSettings({ ...loadSettings(), formatOnSave: false });
    const { platform } = await boot();

    // Dirty the active buffer so a fired save handler calls writeTextFile.
    typeIntoEditor('\n// save-test edit\n');
    await settleBoot();

    const writeSpy = vi.spyOn(platform, 'writeTextFile');

    // Confirm the listener fires BEFORE teardown: Ctrl+S must trigger a write now.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    await settleBoot();
    expect(writeSpy).toHaveBeenCalled(); // pre-teardown baseline — listener IS registered
    writeSpy.mockClear();

    // Teardown — must remove the global save keydown listener.
    disposeIde?.();
    disposeIde = undefined;

    // Ctrl+S after teardown. Without the fix the listener is still registered and calls
    // workspace.saveActive() → platform.writeTextFile(). With the fix it is gone.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    await settleBoot();

    expect(writeSpy).not.toHaveBeenCalled();
  });

  test('init() removes all window keydown listeners it registered on teardown (undo/redo listener removed)', async () => {
    // Capture every keydown listener init() synchronously registers on window.
    const keydownListeners: EventListener[] = [];
    const realAdd = window.addEventListener.bind(window);
    const addSpy = vi.spyOn(window, 'addEventListener').mockImplementation(
      (type: string, listener: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) => {
        if (type === 'keydown' && typeof listener === 'function') {
          keydownListeners.push(listener as EventListener);
        }
        return realAdd(type as never, listener as never, opts as never);
      },
    );

    // Boot manually (without the boot() helper) to keep the addSpy active for the synchronous
    // part of init().
    seedIdeDom();
    installPlatform();
    const { init: initIde } = await import('@/shell/ide');
    disposeIde = initIde();
    addSpy.mockRestore();
    await settleBoot();

    // Now capture which listeners are removed when the aggregate teardown runs.
    const removedListeners: EventListener[] = [];
    const realRemove = window.removeEventListener.bind(window);
    const removeSpy = vi.spyOn(window, 'removeEventListener').mockImplementation(
      (type: string, listener: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions) => {
        if (type === 'keydown' && typeof listener === 'function') {
          removedListeners.push(listener as EventListener);
        }
        return realRemove(type as never, listener as never, opts as never);
      },
    );

    disposeIde?.();
    disposeIde = undefined;
    removeSpy.mockRestore();

    // Every keydown listener init() added must appear in the removed set after teardown.
    // Without the fix: saveFn and undoFn are anonymous — removeEventListener is never called for
    // them, so removedListeners is missing them and the assertion below fails (RED).
    // With the fix: all registered listeners are named and removed (GREEN).
    expect(keydownListeners.length).toBeGreaterThanOrEqual(2); // at minimum: save + undo/redo
    for (const listener of keydownListeners) {
      expect(removedListeners).toContain(listener);
    }
  });
});

// #746: Settings overlay keyboard-dismiss, shortcut suppression, and focus management.
describe('ide init() — Settings overlay a11y (#746)', () => {
  const overlayShown = () => document.getElementById('center-panel-settings')!.hidden === false;

  test('Esc while Settings is open closes the overlay', async () => {
    await boot();
    // Open Settings via the gear.
    document.getElementById('btn-prefs')!.click();
    expect(overlayShown()).toBe(true);

    // Esc should close it.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(overlayShown()).toBe(false);
  });

  test('Esc while Settings is closed is a no-op for Settings', async () => {
    await boot();
    // Settings is closed at boot.
    expect(overlayShown()).toBe(false);
    // Esc — should not throw, should not open Settings.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(overlayShown()).toBe(false);
  });

  test('opening Settings moves focus into the panel (close button); closing restores it to the opener', async () => {
    await boot();

    // Place focus on the gear button (the opener).
    const gear = document.getElementById('btn-prefs')!;
    gear.focus();
    expect(document.activeElement).toBe(gear);

    // Open Settings — should move focus into the panel.
    gear.click();
    expect(overlayShown()).toBe(true);
    const closeBtn = document.querySelector<HTMLButtonElement>('#settings-page-header button[aria-label="Close settings"]')!;
    expect(closeBtn).not.toBeNull();
    expect(document.activeElement).toBe(closeBtn);

    // Close via Esc — focus should return to the gear.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(overlayShown()).toBe(false);
    expect(document.activeElement).toBe(gear);
  });

  test('Settings panel has role="dialog" and aria-modal="true"', async () => {
    await boot();
    const panel = document.getElementById('center-panel-settings')!;
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
  });
});
