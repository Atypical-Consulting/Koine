// Tests for the editorSession controller — the editor ↔ LSP + diagnostics wiring extracted from
// ide.ts's init(). These assert OBSERVABLE behavior (per the Task 3 brief): a published diagnostic
// for the active uri repaints the strip (#diag-count/#diag-body), the status pill (#status), the
// status-bar mirrors, and the editor gutter; a diagnostic for a NON-active uri only caches; and the
// editor callback wall forwards hover/completion/definition to the injected `lsp` spy with the right
// 0-based coordinates. The session is driven with an `lsp` stub and a small seeded DOM (the same
// id surface init() builds), mirroring explorer.test.ts / inspector.test.ts spy + DOM-seed idioms.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from '@testing-library/preact';
import { createEditorSession, type EditorSessionDeps } from './editorSession';
import type { CodeAction, CompletionItem, HoverResult, Location, LspDiagnostic, Range } from './lsp';

// --- DOM seed ----------------------------------------------------------------
// Exactly the ids editorSession looks up via document.getElementById, inlined so a drift from
// index.html surfaces as a thrown "missing #id" (the same el() contract init() relies on), plus a
// parent for the CodeMirror editor the session constructs.
const SESSION_HTML = `
  <div id="editor-pane"></div>
  <div id="status" data-kind="connecting">connecting…</div>
  <span id="diag-count"></span>
  <div id="diag-body"></div>
  <span id="sb-connection"></span>
  <span id="sb-validity"></span>`;

function seedDom(): void {
  document.body.innerHTML = SESSION_HTML;
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
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

function makeDeps(lsp: Lsp, overrides: Partial<EditorSessionDeps> = {}): EditorSessionDeps {
  return {
    parent: el('editor-pane'),
    doc: 'context Demo {}\n',
    lineWrap: false,
    lsp: lsp as unknown as EditorSessionDeps['lsp'],
    status: el('status'),
    diagCount: el('diag-count'),
    diagBody: el('diag-body'),
    sbConnection: el('sb-connection'),
    sbValidity: el('sb-validity'),
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

beforeEach(() => {
  seedDom();
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('createEditorSession — diagnostics for the active uri', () => {
  test('a published diagnostic for the active uri repaints the strip, status pill, and bar mirrors', () => {
    const lsp = makeLsp();
    const session = createEditorSession(makeDeps(lsp));

    // The strip body is now a Preact panel reading the diagnostics slice; act() flushes its
    // (async-batched) re-render so the rows are in the DOM before we assert.
    act(() => lsp.firePublish(ACTIVE, [err(0, 'no good'), warn(2, 'meh')]));

    // Strip count summarises errors + warnings.
    expect(el('diag-count').textContent).toBe('1 error · 1 warning');
    expect(el('diag-count').dataset.kind).toBe('error');
    // Strip body has one row per diagnostic, with the 1-based line:col + message.
    const rows = el('diag-body').querySelectorAll('button.diag');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('error 1:1');
    expect(rows[0].textContent).toContain('no good');
    // Status pill goes red with the error/warning summary.
    expect(el('status').dataset.kind).toBe('error');
    expect(el('status').textContent).toBe('1 error / 1 warning');
    // Status-bar mirrors track the same counts.
    expect(el('sb-validity').textContent).toBe('1 error');
    expect(el('sb-validity').dataset.kind).toBe('error');

    // diagnosticsFor exposes the cached active diagnostics for downstream readers.
    expect(session.diagnosticsFor(ACTIVE).length).toBe(2);
  });

  test('a clean push for the active uri shows the green/clean state', () => {
    const lsp = makeLsp();
    createEditorSession(makeDeps(lsp));

    // act() flushes the strip panel's re-render so its empty-state span is in the DOM before we assert.
    act(() => lsp.firePublish(ACTIVE, []));

    expect(el('diag-count').textContent).toBe('clean');
    expect(el('diag-count').dataset.kind).toBe('clean');
    expect(el('status').textContent).toBe('green ✓');
    expect(el('status').dataset.kind).toBe('green');
    expect(el('sb-validity').textContent).toBe('No errors');
    expect(el('sb-validity').dataset.kind).toBe('ok');
    expect(el('diag-body').querySelector('.diag-empty')!.textContent).toBe('No diagnostics.');
  });
});

describe('createEditorSession — diagnostics for a non-active uri', () => {
  test('only caches: no strip / status repaint, but diagnosticsFor returns them', () => {
    const lsp = makeLsp();
    const session = createEditorSession(makeDeps(lsp));

    // Seed a known active strip first so we can prove a non-active push leaves it untouched.
    lsp.firePublish(ACTIVE, []);
    expect(el('diag-count').textContent).toBe('clean');

    lsp.firePublish(OTHER, [err(5, 'elsewhere')]);

    // Strip + pill still reflect the ACTIVE file's (clean) state — the non-active push did not paint.
    expect(el('diag-count').textContent).toBe('clean');
    expect(el('status').textContent).toBe('green ✓');
    // …but the non-active file's diagnostics are cached and readable.
    expect(session.diagnosticsFor(OTHER).length).toBe(1);
    expect(session.diagnosticsFor(OTHER)[0].message).toBe('elsewhere');
  });

  test('every push notifies onDiagnostics so ide.ts can refresh the file tree badges', () => {
    const lsp = makeLsp();
    const onDiagnostics = vi.fn();
    createEditorSession(makeDeps(lsp, { onDiagnostics }));

    lsp.firePublish(OTHER, [err(1)]);
    lsp.firePublish(ACTIVE, []);

    // Both pushes (active and not) fire the tree-refresh hook.
    expect(onDiagnostics).toHaveBeenCalledTimes(2);
    expect(onDiagnostics).toHaveBeenNthCalledWith(1, OTHER, expect.any(Array));
  });
});

describe('createEditorSession — the editor callback wall forwards to the LSP', () => {
  test('hover / completion / definition forward to the lsp spy with 0-based coordinates', async () => {
    const lsp = makeLsp();
    const session = createEditorSession(makeDeps(lsp));
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
    const session = createEditorSession(makeDeps(lsp));
    // Cache an error on line 0 for the active file; a code action over line 0 must pass it through.
    lsp.firePublish(ACTIVE, [err(0, 'fixme')]);

    await session.codeActions({ start: { line: 0, character: 0 }, end: { line: 0, character: 2 } });

    expect(lsp.codeActions).toHaveBeenCalledTimes(1);
    const [, diags] = lsp.codeActions.mock.calls[0];
    expect(diags.length).toBe(1);
    expect(diags[0].message).toBe('fixme');
  });
});

describe('createEditorSession — onChange split', () => {
  test('an editor edit syncs the LSP (changeDoc) and invokes the registered downstream callback', () => {
    const lsp = makeLsp();
    const session = createEditorSession(makeDeps(lsp));
    const seen: string[] = [];
    session.onChange((doc) => seen.push(doc));

    session.editor.view.dispatch({ changes: { from: session.editor.view.state.doc.length, insert: '\n// edit' } });

    // editor↔LSP forwarding happened inside the session…
    expect(lsp.changeDoc).toHaveBeenCalledTimes(1);
    expect(lsp.changeDoc.mock.calls[0][0]).toBe(ACTIVE);
    // …and the downstream callback got the new full text (ide.ts does buffer/dirty/tree there).
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain('// edit');
  });
});

describe('createEditorSession — status + server exit', () => {
  test('setStatus writes the pill and mirrors the connection state into the status bar', () => {
    const lsp = makeLsp();
    const session = createEditorSession(makeDeps(lsp));

    session.setStatus('connecting…', 'connecting');
    expect(el('status').textContent).toBe('connecting…');
    expect(el('sb-connection').textContent).toBe('Connecting…');

    session.setStatus('all good', 'green');
    expect(el('sb-connection').textContent).toBe('Local');

    session.setStatus('down', 'error');
    expect(el('sb-connection').textContent).toBe('Offline');
  });

  test('a server exit surfaces an error in the pill', () => {
    const lsp = makeLsp();
    createEditorSession(makeDeps(lsp));

    lsp.fireExit(137);

    expect(el('status').dataset.kind).toBe('error');
    expect(el('status').textContent).toContain('137');
  });
});
