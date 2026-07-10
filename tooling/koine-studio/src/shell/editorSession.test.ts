// Tests for the editorSession controller — the editor ↔ LSP + diagnostics wiring extracted from
// ide.ts's init(). These assert OBSERVABLE behavior (per the Task 3 brief): a published diagnostic
// for the active uri repaints the strip (#diag-count/#diag-body), the status pill (#status), the
// status-bar mirrors, and the editor gutter; a diagnostic for a NON-active uri only caches; and the
// editor callback wall forwards hover/completion/definition to the injected `lsp` spy with the right
// 0-based coordinates. The session is driven with an `lsp` stub and a small seeded DOM (the same
// id surface init() builds), mirroring explorer.test.ts / inspector.test.ts spy + DOM-seed idioms.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from '@testing-library/preact';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createEditorSession, type EditorSessionDeps } from '@/shell/editorSession';
import type { CodeAction, CompletionItem, HoverResult, Location, LspDiagnostic, Range } from '@/lsp/lsp';
import { domById } from '@/shared/domById';
import { ALL_CONTEXTS } from '@/model/activeContext';
import { appStore, createAppStore } from '@/store/index';

// --- DOM seed ----------------------------------------------------------------
// Exactly the ids editorSession looks up via document.getElementById, inlined so a drift from
// index.html surfaces as a thrown "missing #id" (the same domById() contract init() relies on), plus a
// parent for the CodeMirror editor the session constructs.
const SESSION_HTML = `
  <div id="editor-pane"></div>
  <div id="status" role="status" aria-live="polite"></div>
  <span id="diag-count"></span>
  <div id="diag-body"></div>
  <span id="sb-connection"></span>
  <span id="sb-problems-errors"></span>
  <span id="sb-problems-warnings"></span>
  <span id="sb-cursor"></span>`;

function seedDom(): void {
  document.body.innerHTML = SESSION_HTML;
}

// --- LSP stub ----------------------------------------------------------------
// A minimal stand-in for the KoineLsp surface editorSession touches: the request methods the editor
// callback wall forwards to (spied so a test can assert coordinates) and the two subscription
// registrations (onPublishDiagnostics / onServerExit) whose callbacks the test captures to drive
// server→client pushes by hand. changeDoc records the editor↔LSP sync.
function makeLsp() {
  let publish: ((uri: string, diags: LspDiagnostic[]) => void) | null = null;
  let exit: ((code: number) => void) | null = null;
  return {
    hover: vi.fn(async (_l: number, _c: number): Promise<HoverResult | null> => null),
    completion: vi.fn(async (_l: number, _c: number): Promise<CompletionItem[]> => []),
    definition: vi.fn(async (_l: number, _c: number): Promise<Location | Location[] | null> => null),
    prepareRename: vi.fn(async () => null),
    rename: vi.fn(async () => null),
    references: vi.fn(async (): Promise<Location[]> => []),
    codeActions: vi.fn(async (_range: Range, _diags: LspDiagnostic[]): Promise<CodeAction[]> => []),
    changeDoc: vi.fn((_uri: string, _doc: string) => {}),
    onPublishDiagnostics: (cb: (uri: string, diags: LspDiagnostic[]) => void) => {
      publish = cb;
    },
    onServerExit: (cb: (code: number) => void) => {
      exit = cb;
    },
    // Test driver: fire a server→client diagnostics push / exit the way the transport would.
    firePublish(uri: string, diags: LspDiagnostic[]): void {
      publish!(uri, diags);
    },
    fireExit(code: number): void {
      exit!(code);
    },
  };
}

type Lsp = ReturnType<typeof makeLsp>;

const ACTIVE = 'file:///work/order.koi';
const OTHER = 'file:///work/customer.koi';

// The shared buffer set (workspaceController owns it in ide.tsx); the session reads a uri's text
// through deps.docFor. Distinct texts per uri so a test can assert which buffer a group shows.
const DOCS: Record<string, string> = {
  [ACTIVE]: 'context Order {}\n',
  [OTHER]: 'context Customer {}\n',
};

function makeDeps(lsp: Lsp, overrides: Partial<EditorSessionDeps> = {}): EditorSessionDeps {
  return {
    parent: domById('editor-pane'),
    doc: DOCS[ACTIVE],
    lineWrap: false,
    minimap: false,
    lsp: lsp as unknown as EditorSessionDeps['lsp'],
    // A fresh store per session by default (issue #760): the session must read/write whatever store it
    // is handed, not the global singleton — callers that want to assert against a KNOWN store instance
    // pass their own via overrides (see the "injected, not the global" test below).
    store: createAppStore(),
    status: domById('status'),
    diagCount: domById('diag-count'),
    diagBody: domById('diag-body'),
    sbConnection: domById('sb-connection'),
    sbProblemsErrors: domById('sb-problems-errors'),
    sbProblemsWarnings: domById('sb-problems-warnings'),
    sbCursor: domById('sb-cursor'),
    activeUri: () => ACTIVE,
    uriLabel: (uri) => uri.split('/').pop() ?? uri,
    onNavigate: vi.fn(),
    onApplyWorkspaceEdit: vi.fn(),
    onDiagnostics: vi.fn(),
    ...overrides,
  };
}

function err(line: number, message = 'boom'): LspDiagnostic {
  return { range: { start: { line, character: 0 }, end: { line, character: 4 } }, severity: 1, message };
}
function warn(line: number, message = 'careful'): LspDiagnostic {
  return { range: { start: { line, character: 0 }, end: { line, character: 4 } }, severity: 2, message };
}

// Every session mounts a real CodeMirror EditorView whose DOMObserver schedules a deferred measure
// (a 50ms resize setTimeout -> view.requestMeasure() that reads this.win.requestAnimationFrame). If a
// session is left alive when a test ends, that timer can fire after happy-dom tears the window down and
// throw an uncaught `this.win.requestAnimationFrame is not a function`, crashing the studio job despite a
// green suite (#493). Wrap createEditorSession so afterEach can destroy() every session it created — a
// destroy() clears the pending measure, so nothing survives the test.
const liveSessions: ReturnType<typeof createEditorSession>[] = [];
function newSession(deps: EditorSessionDeps): ReturnType<typeof createEditorSession> {
  const session = createEditorSession(deps);
  liveSessions.push(session);
  return session;
}

beforeEach(() => {
  seedDom();
});
afterEach(() => {
  // Tear down every session so no deferred CodeMirror measure survives into happy-dom teardown (#493).
  // try/catch tolerates a session a test already destroyed itself (the destroy() coverage below).
  while (liveSessions.length) {
    try {
      liveSessions.pop()!.destroy();
    } catch {
      /* already destroyed */
    }
  }
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('createEditorSession — diagnostics for the active uri', () => {
  test('a published diagnostic for the active uri repaints the strip, status pill, and bar mirrors', () => {
    const lsp = makeLsp();
    const session = newSession(makeDeps(lsp));

    // The strip body is now a Preact panel reading the diagnostics slice; act() flushes its
    // (async-batched) re-render so the rows are in the DOM before we assert.
    act(() => lsp.firePublish(ACTIVE, [err(0, 'no good'), warn(2, 'meh')]));

    // Strip count summarises errors + warnings.
    expect(domById('diag-count').textContent).toBe('1 error · 1 warning');
    expect(domById('diag-count').dataset.kind).toBe('error');
    // Strip body has one row per diagnostic, with the 1-based line:col + message.
    const rows = domById('diag-body').querySelectorAll('button.diag');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('error 1:1');
    expect(rows[0].textContent).toContain('no good');
    // Status pill goes red with the error/warning summary.
    expect(domById('status').dataset.kind).toBe('error');
    expect(domById('status').textContent).toBe('1 error / 1 warning');
    // Status-bar problems split (#923) tracks the same counts: ✕ reddens with errors, ⚠ shows warnings.
    expect(domById('sb-problems-errors').textContent).toBe('✕ 1');
    expect(domById('sb-problems-errors').classList.contains('has')).toBe(true);
    expect(domById('sb-problems-warnings').textContent).toBe('⚠ 1');

    // diagnosticsFor exposes the cached active diagnostics for downstream readers.
    expect(session.diagnosticsFor(ACTIVE).length).toBe(2);
  });

  test('a diagnostics write lands in the injected store, not the global appStore singleton (#760)', () => {
    const lsp = makeLsp();
    const store = createAppStore();
    newSession(makeDeps(lsp, { store }));

    act(() => lsp.firePublish(ACTIVE, [err(0, 'no good')]));

    // The session was handed `store`, not the global singleton — the write must land there…
    expect(store.getState().diagnosticsFor(ACTIVE).length).toBe(1);
    expect(store.getState().diagnosticsFor(ACTIVE)[0].message).toBe('no good');
    // …and the global singleton must be left untouched.
    expect(appStore.getState().diagnosticsFor(ACTIVE).length).toBe(0);
  });

  test('a clean push for the active uri clears the pill (no success toast)', () => {
    const lsp = makeLsp();
    newSession(makeDeps(lsp));

    // act() flushes the strip panel's re-render so its empty-state span is in the DOM before we assert.
    act(() => lsp.firePublish(ACTIVE, []));

    expect(domById('diag-count').textContent).toBe('clean');
    expect(domById('diag-count').dataset.kind).toBe('clean');
    expect(domById('status').textContent).toBe('');
    expect(domById('sb-problems-errors').textContent).toBe('✕ 0');
    expect(domById('sb-problems-errors').classList.contains('has')).toBe(false);
    expect(domById('sb-problems-warnings').textContent).toBe('⚠ 0');
    expect(domById('diag-body').querySelector('.diag-empty')!.textContent).toBe('No diagnostics.');
  });
});

describe('createEditorSession — diagnostics for a non-active uri', () => {
  test('only caches: no strip / status repaint, but diagnosticsFor returns them', () => {
    const lsp = makeLsp();
    const session = newSession(makeDeps(lsp));

    // Seed a known active strip first so we can prove a non-active push leaves it untouched.
    lsp.firePublish(ACTIVE, []);
    expect(domById('diag-count').textContent).toBe('clean');

    lsp.firePublish(OTHER, [err(5, 'elsewhere')]);

    // Strip + pill still reflect the ACTIVE file's (clean) state — the non-active push did not paint.
    expect(domById('diag-count').textContent).toBe('clean');
    expect(domById('status').textContent).toBe('');
    // …but the non-active file's diagnostics are cached and readable.
    expect(session.diagnosticsFor(OTHER).length).toBe(1);
    expect(session.diagnosticsFor(OTHER)[0].message).toBe('elsewhere');
  });

  test('every push notifies onDiagnostics so ide.ts can refresh the file tree badges', () => {
    const lsp = makeLsp();
    const onDiagnostics = vi.fn();
    newSession(makeDeps(lsp, { onDiagnostics }));

    lsp.firePublish(OTHER, [err(1)]);
    lsp.firePublish(ACTIVE, []);

    // Both pushes (active and not) fire the tree-refresh hook.
    expect(onDiagnostics).toHaveBeenCalledTimes(2);
    expect(onDiagnostics).toHaveBeenNthCalledWith(1, OTHER, expect.any(Array));
  });
});

describe('createEditorSession — the #diag-count pill obeys the active-context scope (#1203)', () => {
  test('scoped to a context whose .koi is NOT the open file: the pill mirrors the scoped strip, the status bar stays active-file', () => {
    const lsp = makeLsp();
    const store = createAppStore();
    // Scope to Customer while the OPEN file stays order.koi — the mismatch #1203 is about.
    store.getState().setActiveContext('Customer');
    newSession(makeDeps(lsp, { store }));

    act(() => {
      // The open file carries a warning; the scoped context's file carries an error.
      lsp.firePublish(ACTIVE, [warn(2, 'meh')]);
      lsp.firePublish(OTHER, [err(5, 'elsewhere')]);
    });

    // The strip is scoped (ADR 0009): it shows customer.koi's row, file-labelled.
    const rows = domById('diag-body').querySelectorAll('button.diag');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('customer.koi');
    expect(rows[0].textContent).toContain('elsewhere');
    // The Problems tab pill MIRRORS that scoped strip — Customer's 1 error, not the open file's warning.
    expect(domById('diag-count').textContent).toBe('1 error');
    expect(domById('diag-count').dataset.kind).toBe('error');
    // The status-bar problem counts stay ACTIVE-FILE by design: order.koi has 0 errors / 1 warning.
    expect(domById('sb-problems-errors').textContent).toBe('✕ 0');
    expect(domById('sb-problems-errors').classList.contains('has')).toBe(false);
    expect(domById('sb-problems-warnings').textContent).toBe('⚠ 1');
    // The status pill (action feedback) stays active-file too.
    expect(domById('status').textContent).toBe('1 warning');
  });

  test('back to All contexts: the pill returns to the ACTIVE file, byte-for-byte', () => {
    const lsp = makeLsp();
    const store = createAppStore();
    store.getState().setActiveContext('Customer');
    newSession(makeDeps(lsp, { store }));

    act(() => {
      lsp.firePublish(ACTIVE, [warn(2, 'meh')]);
      lsp.firePublish(OTHER, [err(5, 'elsewhere')]);
    });
    expect(domById('diag-count').textContent).toBe('1 error'); // scoped (proven above)

    // Widening back to All contexts repaints the pill from the ACTIVE file's diagnostics.
    act(() => store.getState().setActiveContext(ALL_CONTEXTS));
    expect(domById('diag-count').textContent).toBe('1 warning');
    expect(domById('diag-count').dataset.kind).toBe('warn');
  });
});

describe('createEditorSession — the editor callback wall forwards to the LSP', () => {
  test('hover / completion / definition forward to the lsp spy with 0-based coordinates', async () => {
    const lsp = makeLsp();
    const session = newSession(makeDeps(lsp));
    const view = session.editor.view;

    // Put the cursor on line 1 (0-based line 0), column index 3, then drive the editor providers the
    // way CodeMirror would. The callback wall converts the CM offset to {line, character}; here we call
    // the editor's gotoDefinition (which resolves via opts.onDefinition → lsp.definition).
    view.dispatch({ selection: { anchor: 3 } });
    await session.editor.gotoDefinition(3);
    expect(lsp.definition).toHaveBeenCalledWith(0, 3);

    // The editor exposes no direct hover/completion handle, so assert the wall is wired by invoking the
    // session's exposed forwarders (a thin pass-through to lsp.*) used to build the editor options.
    await session.hover(0, 3);
    expect(lsp.hover).toHaveBeenCalledWith(0, 3);
    await session.completion(0, 3);
    expect(lsp.completion).toHaveBeenCalledWith(0, 3);
  });

  test('a code-action request scopes the LSP call to the active file diagnostics under the range', async () => {
    const lsp = makeLsp();
    const session = newSession(makeDeps(lsp));
    // Cache an error on line 0 for the active file; a code action over line 0 must pass it through.
    lsp.firePublish(ACTIVE, [err(0, 'fixme')]);

    await session.codeActions({ start: { line: 0, character: 0 }, end: { line: 0, character: 2 } });

    expect(lsp.codeActions).toHaveBeenCalledTimes(1);
    const [, diags] = lsp.codeActions.mock.calls[0];
    expect(diags.length).toBe(1);
    expect(diags[0].message).toBe('fixme');
  });
});

describe('createEditorSession — onChange', () => {
  test('an editor edit syncs the LSP (changeDoc) and invokes the registered downstream callback with the ACTIVE uri', () => {
    const lsp = makeLsp();
    const session = newSession(makeDeps(lsp));
    const seen: { doc: string; uri: string }[] = [];
    session.onChange((doc, uri) => seen.push({ doc, uri }));

    session.editor.view.dispatch({ changes: { from: session.editor.view.state.doc.length, insert: '\n// edit' } });

    // editor↔LSP forwarding happened inside the session…
    expect(lsp.changeDoc).toHaveBeenCalledTimes(1);
    expect(lsp.changeDoc.mock.calls[0][0]).toBe(ACTIVE);
    // …and the downstream callback got the new full text PLUS group A's active uri (ide.ts uses the uri
    // to sync the edit into the right buffer — #265).
    expect(seen.length).toBe(1);
    expect(seen[0].doc).toContain('// edit');
    expect(seen[0].uri).toBe(ACTIVE);
  });
});

describe('createEditorSession — caret mirrors into the store cursor slice (#890)', () => {
  test('moving the caret publishes its 1-based line/column to the store AND the status bar', () => {
    const lsp = makeLsp();
    const store = createAppStore();
    const session = newSession(makeDeps(lsp, { store }));

    // goto dispatches a selection change → the editor's onCursor → the status-bar write AND setCursor.
    session.editor.goto(1, 8);

    // The write lands in the INJECTED store (not the global singleton, #760).
    expect(store.getState().cursor).toEqual({ line: 1, column: 8 });
    // The existing status-bar readout is unchanged (both sinks fire).
    expect(domById('sb-cursor').textContent).toBe('Ln 1, Col 8');
  });
});

describe('createEditorSession — status + server exit', () => {
  test('setStatus writes the pill but does NOT drive the connection mirror (it tracks the LSP lifecycle)', () => {
    const lsp = makeLsp();
    const session = newSession(makeDeps(lsp));

    // The pill is action feedback only — an error toast, never a connection state (#756).
    session.setStatus('down', 'error');
    expect(domById('status').textContent).toBe('down');
    expect(domById('status').dataset.kind).toBe('error');
    // The connection indicator is independent of transient pill toasts — an error toast (e.g. "Rename
    // rejected") or a model with a warning must not read "Offline".
    expect(domById('sb-connection').textContent).toBe('');
  });

  test('the connection mirror tracks the LSP lifecycle: a server push reads Ready, an exit reads Offline', () => {
    const lsp = makeLsp();
    newSession(makeDeps(lsp));

    // A diagnostics push WITH a warning still proves the service is live → "Ready" (not "Offline").
    // (Chrome v2, #923 relabelled the online state from "Local" to "Ready".)
    act(() => lsp.firePublish(ACTIVE, [warn(0, 'meh')]));
    expect(domById('sb-connection').textContent).toBe('Ready');
    expect(domById('sb-connection').dataset.state).toBe('online');

    act(() => lsp.fireExit(1));
    expect(domById('sb-connection').textContent).toBe('Offline');
    expect(domById('sb-connection').dataset.state).toBe('offline');
  });

  test('a server exit surfaces an error in the pill', () => {
    const lsp = makeLsp();
    newSession(makeDeps(lsp));

    lsp.fireExit(137);

    expect(domById('status').dataset.kind).toBe('error');
    expect(domById('status').textContent).toContain('137');
  });
});

// The topbar `#status` pill is the transient ACTION-FEEDBACK toast for a FAILED action (Rename
// rejected, save failed, …) — a successful action clears it instead of a success toast — and it is
// NOT a connection indicator — connection is `#sb-connection` in the status bar, the single home for
// that fact (#756). Its boot seed must therefore be neutral: if it shipped "connecting…" it would
// impersonate the connection indicator for the first frame (two elements reading "connecting…"), the
// exact overlap #756 removes. This reads the REAL index.html so a regression to a connection seed is
// caught at the source, not in a hand-copied fixture.
describe('#status boot seed is decoupled from connection (#756)', () => {
  const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
  const seed = new DOMParser().parseFromString(html, 'text/html').getElementById('status');

  test('the index.html #status seed carries no connection text or kind', () => {
    expect(seed).not.toBeNull();
    expect(seed!.textContent?.trim()).toBe('');
    expect(seed!.dataset.kind).not.toBe('connecting');
  });

  test('#status keeps its action-feedback a11y affordances (role=status, aria-live=polite)', () => {
    expect(seed!.getAttribute('role')).toBe('status');
    expect(seed!.getAttribute('aria-live')).toBe('polite');
  });
});

describe('createEditorSession — destroy() tears the session down (#221)', () => {
  test('destroy() removes the symbol-row host + the editor and a later window resize is inert', () => {
    const lsp = makeLsp();
    const session = newSession(makeDeps(lsp));
    const pane = domById('editor-pane');
    // The session mounted the mobile DSL-symbol accessory row + a CodeMirror editor into its pane.
    expect(pane.querySelector('.koi-symbol-row-host')).not.toBeNull();
    expect(pane.querySelector('.cm-editor')).not.toBeNull();

    session.destroy();

    // Both are gone: destroy() removed the symbol-row host and called editor.destroy() (which detaches the
    // CodeMirror view + removes its visualViewport/matchMedia listeners).
    expect(pane.querySelector('.koi-symbol-row-host')).toBeNull();
    expect(pane.querySelector('.cm-editor')).toBeNull();
    // The focusin/focusout/resize listeners were removed too, so a post-teardown resize is a no-op — it
    // neither throws nor re-shows the (removed) row.
    expect(() => window.dispatchEvent(new Event('resize'))).not.toThrow();
  });
});

describe('createEditorSession — a destroyed session leaves no measure to crash teardown (#493 regression)', () => {
  test('destroy() clears the pending resize-measure so a post-teardown rAF deref cannot throw', () => {
    // Reproduces the exact #493 race deterministically: CodeMirror's DOMObserver.onResize schedules a
    // 50ms setTimeout -> view.requestMeasure(), which reads this.win.requestAnimationFrame. Without the
    // afterEach destroy(), that timer outlives the test; happy-dom then strips rAF from the captured
    // window, and the late measure throws an uncaught `this.win.requestAnimationFrame is not a function`.
    vi.useFakeTimers();
    const lsp = makeLsp();
    const session = newSession(makeDeps(lsp));

    // A resize near the test's end queues the deferred measure.
    window.dispatchEvent(new Event('resize'));
    // Destroying the session (what afterEach now does for every session) clears that pending measure.
    session.destroy();

    // Simulate happy-dom teardown stripping rAF off the editor's captured window. Save + restore so this
    // global mutation never leaks into sibling tests sharing the per-file happy-dom window.
    const win = (session.editor.view.dom.ownerDocument?.defaultView ?? window) as unknown as Record<string, unknown>;
    const savedRaf = win.requestAnimationFrame;
    delete win.requestAnimationFrame;
    try {
      // With the measure cleared, draining the timer queue past the 50ms resize timeout is inert.
      expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    } finally {
      win.requestAnimationFrame = savedRaf;
      vi.useRealTimers();
    }
  });
});
