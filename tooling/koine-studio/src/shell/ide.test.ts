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
import type { FsEntry, GitLogEntry, GitStatus, KoiFile, LspTransport, Platform } from '@/host/types';
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

// --- in-memory LspTransport --------------------------------------------------
// Records every framed message the client sends and lets the test drive server→client messages. The
// only server reply boot needs is the `initialize` response (KoineLsp.handshake awaits it before the
// workspace opens); without it start() would hang on the 15s request timeout. We answer it
// synchronously from `send` so `await lsp.start()` resolves promptly.
class FakeLspTransport implements LspTransport {
  sent: string[] = [];
  private onMsg: ((json: string) => void) | null = null;

  start(): Promise<void> {
    return Promise.resolve();
  }
  send(message: string): Promise<void> {
    this.sent.push(message);
    const msg = JSON.parse(message) as { id?: number; method?: string };
    // Reply to the `initialize` request so the handshake completes. Any other request is left
    // unanswered (boot does not depend on it); notifications carry no id.
    if (msg.method === 'initialize' && typeof msg.id === 'number') {
      this.reply({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } });
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
  readonly canOpenFolders = true;
  readonly canSaveProjects = true;
  readonly canRunShell = false;
  readonly canUseGit = false;
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
  mcpEndpoint(): Promise<string | null> {
    return Promise.resolve(null);
  }
  mcpStop(): Promise<void> {
    return Promise.resolve();
  }
  openExternal(): void {
    // no-op in tests
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
  gitStage(): Promise<void> {
    return this.gitUnavailable();
  }
  gitUnstage(): Promise<void> {
    return this.gitUnavailable();
  }
  gitCommit(): Promise<void> {
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
        <div class="toolbar-actions" role="toolbar">
          <div class="tb-group">
            <button type="button" id="btn-new">New</button>
            <button type="button" id="btn-open-folder">Open</button>
          </div>
          <div id="history-controls-host"></div>
          <div class="tb-group">
            <button type="button" id="btn-generate-project">Generate</button>
            <button type="button" id="btn-save-project">Save to disk</button>
          </div>
          <button type="button" id="btn-check">Check</button>
        </div>
        <div id="breadcrumb-host" class="topbar-breadcrumb" hidden></div>
        <div class="toolbar-right">
          <button type="button" id="palette-hint" class="palette-hint">K</button>
          <button type="button" id="btn-theme" class="icon-btn">theme</button>
          <button type="button" id="btn-prefs" class="icon-btn">prefs</button>
          <div id="status" data-kind="connecting" role="status" aria-live="polite">connecting…</div>
          <button type="button" id="unsaved-indicator" class="unsaved-indicator" hidden></button>
        </div>
      </header>
      <main id="split">
        <!-- The rail's inner markup is owned by leftRail.ts and injected by init() (leftRailMarkup),
             exactly as index.html does — so this stays a thin shell and can't drift from the real ids. -->
        <aside id="leftrail" class="pane"></aside>
        <div class="koi-resizer" id="leftrail-resizer"></div>
        <section id="center" class="pane">
          <div id="center-tabs" role="tablist">
            <button type="button" class="center-tab" id="center-tab-visual" role="tab" data-center="visual" aria-selected="true">Visual</button>
            <button type="button" class="center-tab" id="center-tab-technical" role="tab" data-center="technical" aria-selected="false">Code</button>
            <button type="button" class="center-tab" id="center-tab-docs" role="tab" data-center="docs" aria-selected="false">Documentation</button>
            <button type="button" class="center-tab center-tab-ai" id="center-tab-assistant" role="tab" data-center="assistant" aria-selected="false">Assistant</button>
          </div>
          <div id="center-body">
            <section id="center-visual" class="center-host" role="tabpanel">
              <div id="canvas-palette-host"></div>
              <div id="diagram-host"></div>
            </section>
            <section id="center-technical" class="center-host" role="tabpanel" hidden>
              <div id="tech-tabs" role="tablist">
                <button type="button" class="tech-tab" id="tech-tab-editor" role="tab" data-tech="editor" aria-selected="true">Editor</button>
                <button type="button" class="tech-tab" id="tech-tab-preview" role="tab" data-tech="preview" aria-selected="false">Generated</button>
                <button type="button" class="tech-tab" id="tech-tab-check" role="tab" data-tech="check" aria-selected="false">Compatibility</button>
                <button type="button" class="tech-tab" id="tech-tab-scenarios" role="tab" data-tech="scenarios" aria-selected="false">Scenarios</button>
              </div>
              <div id="tech-body">
                <section id="editor-pane" class="tech-view">
                  <div class="koi-resizer" id="group-resizer" aria-hidden="true"></div>
                  <section id="editor-pane-b" aria-label="Editor (second group)"></section>
                </section>
                <div id="view-preview" class="tech-view" role="tabpanel" hidden></div>
                <div id="view-check" class="tech-view doc-view" role="tabpanel" hidden></div>
                <div id="view-scenarios" class="tech-view" role="tabpanel" hidden></div>
              </div>
            </section>
            <section id="center-docs" class="center-host" role="tabpanel" hidden>
              <div id="docs-tabs" role="tablist">
                <button type="button" class="docs-tab" id="docs-tab-glossary" role="tab" data-docs="glossary" aria-selected="true">Glossary</button>
                <button type="button" class="docs-tab" id="docs-tab-adr" role="tab" data-docs="adr" aria-selected="false">Decisions</button>
                <button type="button" class="docs-tab" id="docs-tab-notes" role="tab" data-docs="notes" aria-selected="false">Notes</button>
              </div>
              <div id="docs-body">
                <div id="view-glossary" class="tech-view doc-view" role="tabpanel"></div>
                <div id="view-docs" class="tech-view doc-view" role="tabpanel" hidden></div>
                <div id="view-notes" class="tech-view doc-view" role="tabpanel" hidden></div>
              </div>
            </section>
            <section id="view-assistant" class="center-host" role="tabpanel" hidden></section>
          </div>
          <footer id="diagnostics">
            <div class="koi-resizer koi-resizer-y" id="diag-resizer"></div>
            <div id="diag-header">
              <button type="button" id="diag-collapse" class="diag-collapse" aria-expanded="true" aria-controls="diag-body panel-events panel-relationships panel-contextmap panel-terminal panel-review">collapse</button>
              <div class="diag-tabs" role="tablist">
                <button type="button" class="diag-tab" id="tab-problems" role="tab" data-panel="problems" aria-selected="true" aria-controls="diag-body">Problems</button>
                <button type="button" class="diag-tab" id="tab-events" role="tab" data-panel="events" aria-selected="false" aria-controls="panel-events">Events</button>
                <button type="button" class="diag-tab" id="tab-relationships" role="tab" data-panel="relationships" aria-selected="false" aria-controls="panel-relationships">Relationships</button>
                <button type="button" class="diag-tab" id="tab-contextmap" role="tab" data-panel="contextmap" aria-selected="false" aria-controls="panel-contextmap">Context Map</button>
                <button type="button" class="diag-tab" id="tab-terminal" role="tab" data-panel="terminal" aria-selected="false" aria-controls="panel-terminal">Terminal</button>
                <button type="button" class="diag-tab" id="tab-review" role="tab" data-panel="review" aria-selected="false" aria-controls="panel-review">Review</button>
              </div>
              <span id="diag-count" class="diag-count"></span>
            </div>
            <div id="diag-body" class="diag-panel" role="tabpanel" aria-labelledby="tab-problems"></div>
            <div id="panel-events" class="diag-panel" role="tabpanel" aria-labelledby="tab-events" hidden></div>
            <div id="panel-relationships" class="diag-panel" role="tabpanel" aria-labelledby="tab-relationships" hidden></div>
            <div id="panel-contextmap" class="diag-panel doc-view" role="tabpanel" aria-labelledby="tab-contextmap" hidden></div>
            <div id="panel-terminal" class="diag-panel diag-panel-terminal" role="tabpanel" aria-labelledby="tab-terminal" hidden></div>
            <div id="panel-review" class="diag-panel" role="tabpanel" aria-labelledby="tab-review" hidden></div>
          </footer>
        </section>
        <div class="koi-resizer" id="split-resizer"></div>
        <aside id="right" class="pane">
          <div id="right-tabs" role="tablist">
            <button type="button" class="rtab" id="rtab-props" role="tab" data-rview="props" aria-selected="true">Properties</button>
            <button type="button" class="rtab" id="rtab-rules" role="tab" data-rview="rules" aria-selected="false">Rules</button>
            <button type="button" class="rtab" id="rtab-notes" role="tab" data-rview="notes" aria-selected="false">Notes</button>
            <button type="button" class="rtab" id="rtab-source-control" role="tab" data-rview="source-control" aria-selected="false">Source Control</button>
          </div>
          <div id="right-body">
            <div id="inspector-host" class="rview" role="tabpanel"></div>
            <div id="rview-rules" class="rview doc-view" role="tabpanel" hidden><p class="muted">Coming soon.</p></div>
            <div id="rview-notes" class="rview doc-view" role="tabpanel" hidden><p class="muted">Coming soon.</p></div>
            <div id="rview-source-control" class="rview doc-view" role="tabpanel" hidden></div>
          </div>
        </aside>
      </main>
      <footer id="statusbar">
        <span class="sb-item" id="sb-context">Context: —</span>
        <span class="sb-item" id="sb-validity">No errors</span>
        <span id="sb-problems-host"></span>
        <span class="sb-spacer"></span>
        <span class="sb-item" id="sb-connection">Connecting…</span>
        <span class="sb-item" id="sb-version"></span>
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
async function boot(opts: { dom?: boolean; platform?: FakePlatform } = {}): Promise<{
  init: () => void;
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
    disposeIde = init();
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
  // The group-B editor is nested INSIDE #editor-pane (#editor-pane-b is its child), so scope group A's
  // lookup to the .cm-editor that is NOT inside #editor-pane-b.
  const dom = Array.from(document.querySelectorAll<HTMLElement>('#editor-pane .cm-editor')).find(
    (cm) => !document.getElementById('editor-pane-b')!.contains(cm),
  );
  if (!dom) throw new Error('no EditorView mounted in #editor-pane');
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error('no EditorView mounted in #editor-pane');
  return view;
}

/** Group A's doc text (the primary editor's, scoped past the nested group-B pane). */
function groupADoc(): string {
  return editorView().state.doc.toString();
}

/** Group B's doc text, or null when the split is closed (no editor mounted in #editor-pane-b). */
function groupBDoc(): string | null {
  const dom = document.querySelector<HTMLElement>('#editor-pane-b .cm-editor');
  if (!dom) return null;
  return EditorView.findFromDOM(dom)?.state.doc.toString() ?? null;
}

/** The live group-B EditorView, reached from its DOM. Throws when the split is closed. */
function groupBView(): EditorView {
  const dom = document.querySelector<HTMLElement>('#editor-pane-b .cm-editor');
  const view = dom ? EditorView.findFromDOM(dom) : null;
  if (!view) throw new Error('no EditorView mounted in #editor-pane-b');
  return view;
}

/** Simulate a user edit IN GROUP B — the same docChanged → onChange path a keystroke drives, but on B. */
function typeIntoGroupB(text: string): void {
  const view = groupBView();
  view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
}

/** Open the command palette and click the (first) command row whose title matches `title` exactly. */
function runPaletteCommand(title: string): void {
  const hint = document.querySelector<HTMLElement>('.palette-hint');
  hint!.click(); // ide.ts wires the toolbar hint to palette.toggle()
  const rows = Array.from(document.querySelectorAll<HTMLElement>('.koi-palette-item'));
  const row = rows.find((r) => r.querySelector('.koi-palette-item-title')?.textContent === title);
  if (!row) throw new Error(`no palette command titled "${title}" (have: ${rows.length} rows)`);
  row.click(); // click runs the command and closes the palette
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

describe('ide init() — editor split routes file-open to the focused group (#265)', () => {
  // The headline use case: split the editor, then open a DIFFERENT file in group B. The open must land
  // in B and leave group A's file AND the workspace active uri untouched (group A is primary; B is a
  // secondary view). This exercises the focus-routing branch ide.tsx wires into the user-initiated
  // open affordances (the Go-to-File palette here) on top of the editorSession openFocusedGroup seam.
  const FILES = [
    { relPath: 'orders.koi', text: 'context Orders {\n  value Sku { raw: String }\n}\n' },
    { relPath: 'billing.koi', text: 'context Billing {\n  value Money { amount: Decimal }\n}\n' },
  ];

  test('split then Go-to-File a different file shows it in group B; group A + active uri stay put', async () => {
    // Layout state persists in localStorage; clear it so this test starts from a fresh (unsplit) shell
    // and doesn't bleed splitOpen into later boots.
    localStorage.clear();
    try {
      setWorkspaceShareHash(FILES, 'orders.koi');
      await boot();

      // Boot lands on orders.koi in the single (group-A) editor; no split yet.
      expect(groupADoc()).toContain('context Orders');
      expect(groupBDoc()).toBeNull();

      // Split the editor. The fresh split focuses the NEW group B (so the next open lands there) and
      // seeds B with group A's current file.
      runPaletteCommand('Split editor');
      expect(groupBDoc()).toContain('context Orders'); // B mirrors A on the initial split

      // With B focused, Go-to-File billing.koi → it loads into group B…
      runPaletteCommand('billing.koi');
      expect(groupBDoc()).toContain('context Billing');
      // …while group A still shows orders.koi (the secondary view never touched the primary)…
      expect(groupADoc()).toContain('context Orders');
      expect(groupADoc()).not.toContain('context Billing');
      // …and the workspace active uri is unchanged: the status-bar context / tree still follow orders.
      // (A read-through proxy: the group-A editor doc is the active buffer's text, asserted above.)
    } finally {
      localStorage.clear();
    }
  });

  test('after the split, clicking the group-A pane returns focus so the next open lands in A', async () => {
    localStorage.clear();
    try {
      setWorkspaceShareHash(FILES, 'orders.koi');
      await boot();
      runPaletteCommand('Split editor'); // focuses B

      // A pointerdown on the group-A pane retargets routing to A (the focus-switch listener ide.tsx
      // mounts on #editor-pane). #editor-pane-b is nested inside #editor-pane, so dispatch on the
      // group-A editor surface itself, which is not inside #editor-pane-b.
      editorView().dom.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }),
      );

      // Now a Go-to-File lands in group A (the primary), changing the active file, and B is untouched.
      runPaletteCommand('billing.koi');
      expect(groupADoc()).toContain('context Billing');
      expect(groupBDoc()).toContain('context Orders'); // B still shows what the split seeded
    } finally {
      localStorage.clear();
    }
  });

  test('typing in group B (showing a DIFFERENT file) edits B’s buffer, NOT group A’s — #265 data-loss guard', async () => {
    localStorage.clear();
    try {
      setWorkspaceShareHash(FILES, 'orders.koi');
      const { platform } = await boot();

      // Split, then open billing.koi into the focused group B (group A stays on orders.koi).
      runPaletteCommand('Split editor');
      runPaletteCommand('billing.koi');
      expect(groupBDoc()).toContain('context Billing');
      expect(groupADoc()).toContain('context Orders');

      // Type a unique marker into group B. The OLD bug routed this through syncActiveBuffer → it wrote
      // B's text into group A's (active) buffer + marked A dirty + autosaved A → orders.koi got billing's
      // content. With the fix, the edit syncs into B's OWN buffer.
      typeIntoGroupB('\n// EDIT_IN_B_MARKER\n');

      // Group A's editor doc is untouched — it never received B's keystrokes.
      expect(groupADoc()).not.toContain('EDIT_IN_B_MARKER');
      expect(groupADoc()).toContain('context Orders');

      // Persist all open buffers to disk (Save to disk maps each buffer's text by relPath); this is the
      // observable proof the right BUFFER was edited. orders.koi (group A) must NOT carry B's marker;
      // billing.koi (group B) must.
      (document.getElementById('btn-save-project') as HTMLButtonElement).click();
      await settleBoot();
      const input = document.querySelector('.koi-prompt-input') as HTMLInputElement;
      input.value = 'split-save';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      (document.querySelector('.koi-confirm-btn-primary') as HTMLButtonElement).click();
      await settleBoot();

      const saveSpy = platform.saveProjectToRoot;
      expect(saveSpy).toHaveBeenCalledTimes(1);
      const [, files] = saveSpy.mock.calls[0] as [string, { relPath: string; contents: string }[]];
      const orders = files.find((f) => f.relPath === 'orders.koi')!;
      const billing = files.find((f) => f.relPath === 'billing.koi')!;
      // The data-loss assertion: group A's file is uncorrupted, group B's file holds B's edit.
      expect(orders.contents).not.toContain('EDIT_IN_B_MARKER');
      expect(orders.contents).toContain('context Orders');
      expect(billing.contents).toContain('EDIT_IN_B_MARKER');
    } finally {
      localStorage.clear();
    }
  });

  test('routing a file into group B persists B’s uri so reload restores the right file — #265', async () => {
    localStorage.clear();
    try {
      setWorkspaceShareHash(FILES, 'orders.koi');
      await boot();

      runPaletteCommand('Split editor'); // splitOpen + B seeded with A's orders.koi
      runPaletteCommand('billing.koi'); // re-point B at billing.koi (the focused group)

      // The persisted layout's group-B slot now tracks billing.koi (not the stale split-open orders.koi),
      // so a reload would restore B to billing.koi. A's slot stays on the active orders.koi.
      const persisted = JSON.parse(localStorage.getItem('koine.studio.layout')!) as {
        splitOpen: boolean;
        groupActiveUris: [string, string?];
      };
      expect(persisted.splitOpen).toBe(true);
      expect(persisted.groupActiveUris[0]).toMatch(/orders\.koi$/);
      expect(persisted.groupActiveUris[1]).toMatch(/billing\.koi$/);
    } finally {
      localStorage.clear();
    }
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
  test('Save to disk writes the open buffers as a named project', async () => {
    await boot();
    const saveSpy = (fakePlatform.current as FakePlatform).saveProjectToRoot;

    (document.getElementById('btn-save-project') as HTMLButtonElement).click();
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

    (document.getElementById('btn-save-project') as HTMLButtonElement).click();
    await settleBoot();

    // Dismiss the prompt with Cancel → ask() resolves null → nothing is written. The primary button
    // is unique to the prompt dialog, so reach its modal through it to find that dialog's Cancel.
    const promptModal = (document.querySelector('.koi-confirm-btn-primary') as HTMLElement).closest('.koi-modal')!;
    (promptModal.querySelector('.koi-confirm-btn:not(.koi-confirm-btn-primary)') as HTMLButtonElement).click();
    await settleBoot();

    expect(saveSpy).not.toHaveBeenCalled();
  });

  test('Save to disk button is hidden when the host cannot save projects', async () => {
    const p = installPlatform();
    // Override the readonly property to simulate a host that cannot save projects.
    (p as unknown as { canSaveProjects: boolean }).canSaveProjects = false;
    await boot({ platform: p });
    expect((document.getElementById('btn-save-project') as HTMLButtonElement).hidden).toBe(true);
  });
});

describe('ide init() — Recent open recovery', () => {
  test('opening a dead Recent (via the Home start-intent) keeps the start screen up and offers removal', async () => {
    // Seed one recent so the recovered start screen renders a row for it.
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
    // consumes it once at boot. listKoiFiles throws → openRecentFolder shows the start screen and a
    // "Remove from Recent?" confirm rather than stranding the user.
    window.location.hash = '';
    // Import setStartIntent AFTER beforeEach's vi.resetModules() so it shares the SAME bootIntent module
    // instance that boot()'s dynamic import('@/shell/ide') will load — a static top-of-file import binds
    // the pre-reset instance, whose `pending` the freshly-loaded IDE would never see.
    const { setStartIntent } = await import('@/shell/bootIntent');
    setStartIntent({ kind: 'open-recent', path: 'ghost' });
    await boot({ platform: p });
    await settleBoot();

    // The start screen is up with the 'ghost' row, and the confirm modal must now be visible.
    expect(document.querySelector('.koi-welcome-recent')).not.toBeNull();
    const okBtn = document.querySelector<HTMLButtonElement>('.koi-confirm-btn-danger');
    expect(okBtn).not.toBeNull();

    // Confirm removal — this resolves the confirmDialog.ask() promise with true.
    okBtn!.click();
    await settleBoot();

    // The dead recent must be gone from localStorage.
    expect(localStorage.getItem('koine.studio.recentFolders')).not.toContain('ghost');

    // The welcome (start screen) must still be present — the user is never stranded.
    expect(document.querySelector('.koi-welcome-recent')).not.toBeNull();

    // …AND the list must have rebuilt: the dead row is gone from the DOM, not just from storage.
    // (Regression guard: welcome.show() early-returns when already shown, so the post-removal refresh
    // must use refreshRecent() to re-render — otherwise the stale row lingers on screen.)
    const remainingRows = Array.from(
      document.querySelectorAll<HTMLElement>('.koi-welcome-recent-item-name'),
    ).map((el) => el.textContent);
    expect(remainingRows).not.toContain('ghost');
    // It was the only recent, so the empty-state copy is now shown in its place.
    expect(document.querySelector('.koi-welcome-empty')).not.toBeNull();
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
