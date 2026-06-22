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
import { EditorView } from '@codemirror/view';
import type { FsEntry, KoiFile, LspTransport, Platform } from './host/types';
import { buildShareUrl, buildWorkspaceShareUrl } from './share';

// The studio reads `__APP_VERSION__` (a vite build-time define) once at boot for the status bar.
// vitest does not define it, so stub it as a global before any init() runs — test scaffolding only,
// no production change.
vi.stubGlobal('__APP_VERSION__', '0.0.0-test');

// Drive boot through the existing getPlatform() seam: ide.ts imports getPlatform from './host', so we
// mock that module to return our in-memory fake. `fakePlatform.current` is swapped per test before
// init() runs. We re-export the real ./host/types so the type-only re-exports ide.ts relies on
// (FsEntry, KoiFile, …) still resolve.
const fakePlatform = { current: null as unknown as Platform };
vi.mock('./host', async () => {
  const types = await vi.importActual<typeof import('./host/types')>('./host/types');
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
// mockReturnValueOnce / mockImplementationOnce and assert on the spies. Everything else in ./store is
// passed through untouched. (vi.hoisted so the spies exist before the hoisted vi.mock factory runs.)
const storeSeam = vi.hoisted(() => ({
  peekLegacyScratch: vi.fn<() => string | null>(),
  clearLegacyScratch: vi.fn<() => void>(),
}));
vi.mock('./store', async () => {
  const actual = await vi.importActual<typeof import('./store')>('./store');
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
          <div class="tb-group">
            <button type="button" id="btn-generate-project">Generate</button>
          </div>
          <button type="button" id="btn-check">Check</button>
        </div>
        <div id="context-switcher" class="context-switcher" hidden></div>
        <div id="breadcrumb-host" class="topbar-breadcrumb"></div>
        <div class="toolbar-right">
          <button type="button" id="palette-hint" class="palette-hint">K</button>
          <button type="button" id="btn-theme" class="icon-btn">theme</button>
          <button type="button" id="btn-prefs" class="icon-btn">prefs</button>
          <button type="button" id="btn-about" class="icon-btn">about</button>
          <div id="status" data-kind="connecting" role="status" aria-live="polite">connecting…</div>
          <button type="button" id="unsaved-indicator" class="unsaved-indicator" hidden></button>
        </div>
      </header>
      <main id="split">
        <aside id="leftrail" class="pane">
          <section class="rail-sect" id="rail-files" data-open="true">
            <div class="rail-sect-head-row">
              <button type="button" class="rail-sect-head" aria-expanded="true" aria-controls="filetree-body">Files</button>
              <span id="filetree-title" class="rail-sect-meta">Scratch</span>
            </div>
            <div class="rail-sect-body" id="filetree-body"></div>
          </section>
          <section class="rail-sect" id="rail-explorer" data-open="true">
            <button type="button" class="rail-sect-head" aria-expanded="true" aria-controls="rail-explorer-body">Explorer</button>
            <div class="rail-sect-body" id="rail-explorer-body"></div>
          </section>
          <section class="rail-sect" id="rail-overview" data-open="true">
            <button type="button" class="rail-sect-head" aria-expanded="true" aria-controls="rail-overview-body">Overview</button>
            <div class="rail-sect-body" id="rail-overview-body"></div>
          </section>
        </aside>
        <div class="koi-resizer" id="leftrail-resizer"></div>
        <section id="center" class="pane">
          <div id="center-tabs" role="tablist">
            <button type="button" class="center-tab" id="center-tab-visual" role="tab" data-center="visual" aria-selected="true">Visual</button>
            <button type="button" class="center-tab" id="center-tab-technical" role="tab" data-center="technical" aria-selected="false">Code</button>
            <button type="button" class="center-tab" id="center-tab-docs" role="tab" data-center="docs" aria-selected="false">Documentation</button>
          </div>
          <div id="center-body">
            <section id="center-visual" class="center-host" role="tabpanel"></section>
            <section id="center-technical" class="center-host" role="tabpanel" hidden>
              <div id="tech-tabs" role="tablist">
                <button type="button" class="tech-tab" id="tech-tab-editor" role="tab" data-tech="editor" aria-selected="true">Editor</button>
                <button type="button" class="tech-tab" id="tech-tab-preview" role="tab" data-tech="preview" aria-selected="false">Generated</button>
                <button type="button" class="tech-tab" id="tech-tab-check" role="tab" data-tech="check" aria-selected="false">Compatibility</button>
                <button type="button" class="tech-tab" id="tech-tab-assistant" role="tab" data-tech="assistant" aria-selected="false">Assistant</button>
              </div>
              <div id="tech-body">
                <section id="editor-pane" class="tech-view"></section>
                <div id="view-preview" class="tech-view" role="tabpanel" hidden></div>
                <div id="view-check" class="tech-view doc-view" role="tabpanel" hidden></div>
                <div id="view-assistant" class="tech-view" role="tabpanel" hidden></div>
              </div>
            </section>
            <section id="center-docs" class="center-host" role="tabpanel" hidden>
              <div id="docs-tabs" role="tablist">
                <button type="button" class="docs-tab" id="docs-tab-glossary" role="tab" data-docs="glossary" aria-selected="true">Glossary</button>
                <button type="button" class="docs-tab" id="docs-tab-adr" role="tab" data-docs="adr" aria-selected="false">Decisions &amp; Notes</button>
              </div>
              <div id="docs-body">
                <div id="view-glossary" class="tech-view doc-view" role="tabpanel"></div>
                <div id="view-docs" class="tech-view doc-view" role="tabpanel" hidden></div>
              </div>
            </section>
          </div>
          <footer id="diagnostics">
            <div class="koi-resizer koi-resizer-y" id="diag-resizer"></div>
            <div id="diag-header">
              <button type="button" id="diag-collapse" class="diag-collapse" aria-expanded="true" aria-controls="diag-body panel-events panel-relationships panel-contextmap">collapse</button>
              <div class="diag-tabs" role="tablist">
                <button type="button" class="diag-tab" id="tab-problems" role="tab" data-panel="problems" aria-selected="true" aria-controls="diag-body">Problems</button>
                <button type="button" class="diag-tab" id="tab-events" role="tab" data-panel="events" aria-selected="false" aria-controls="panel-events">Events</button>
                <button type="button" class="diag-tab" id="tab-relationships" role="tab" data-panel="relationships" aria-selected="false" aria-controls="panel-relationships">Relationships</button>
                <button type="button" class="diag-tab" id="tab-contextmap" role="tab" data-panel="contextmap" aria-selected="false" aria-controls="panel-contextmap">Context Map</button>
              </div>
              <span id="diag-count" class="diag-count"></span>
            </div>
            <div id="diag-body" class="diag-panel" role="tabpanel" aria-labelledby="tab-problems"></div>
            <div id="panel-events" class="diag-panel" role="tabpanel" aria-labelledby="tab-events" hidden></div>
            <div id="panel-relationships" class="diag-panel" role="tabpanel" aria-labelledby="tab-relationships" hidden></div>
            <div id="panel-contextmap" class="diag-panel doc-view" role="tabpanel" aria-labelledby="tab-contextmap" hidden></div>
          </footer>
        </section>
        <div class="koi-resizer" id="split-resizer"></div>
        <aside id="right" class="pane">
          <div id="right-tabs" role="tablist">
            <button type="button" class="rtab" id="rtab-props" role="tab" data-rview="props" aria-selected="true">Properties</button>
            <button type="button" class="rtab" id="rtab-rules" role="tab" data-rview="rules" aria-selected="false">Rules</button>
            <button type="button" class="rtab" id="rtab-notes" role="tab" data-rview="notes" aria-selected="false">Notes</button>
          </div>
          <div id="right-body">
            <div id="inspector-host" class="rview" role="tabpanel"></div>
            <div id="rview-rules" class="rview doc-view" role="tabpanel" hidden><p class="muted">Coming soon.</p></div>
            <div id="rview-notes" class="rview doc-view" role="tabpanel" hidden><p class="muted">Coming soon.</p></div>
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
  const { init } = await import('./ide');

  let beforeUnload: ((e: Event) => void) | null = null;
  const realAdd = window.addEventListener.bind(window);
  const spy = vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'beforeunload' && typeof listener === 'function') {
      beforeUnload = listener as (e: Event) => void;
    }
    return realAdd(type as never, listener as never, options as never);
  });
  try {
    init();
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
  const dom = document.querySelector<HTMLElement>('#editor-pane .cm-editor')!;
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

beforeEach(() => {
  document.body.innerHTML = '';
  fakePlatform.current = null as unknown as Platform;
  window.location.hash = '';
  // Clear the legacy-scratch seam's call history + any queued *Once overrides so each test starts
  // from the delegating default (re-established by the vi.mock factory on the module reset below).
  peekLegacyScratch.mockReset();
  clearLegacyScratch.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.location.hash = '';
});

describe('ide init() — scaffolding', () => {
  test('init() throws without a seeded DOM (the el() lookups must find their ids)', async () => {
    installPlatform();
    const { init } = await import('./ide');
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
