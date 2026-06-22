// editorSession: the editor ↔ LSP + diagnostics wiring, lifted out of ide.ts's init() (Task 3 of
// the ide.ts decomposition, issue #180). It owns the CodeMirror editor and its callback wall (the
// hover/completion/definition/rename/references/code-action forwarders to the LSP), the per-uri
// diagnostics cache, the status pill + diagnostics strip rendering, and the LSP
// publishDiagnostics / serverExit subscriptions. Everything model-/workspace-/buffer-shaped stays
// in ide.ts and is injected as deps or surfaced as a callback — this module is deliberately
// agnostic of buffers, the file tree, and the host platform.
//
// The diagnosticsByUri cache lives HERE (it moved out of init()). Other controllers — notably
// Task 5's workspaceController — read and mutate it through the accessors exposed below
// (diagnosticsFor / showDiagnostics / dropDiagnostics / renameDiagnostics / clearDiagnostics) and
// MUST NOT relocate the Map again.
import { createKoineEditor, setEditorDiagnostics, type KoineEditor } from './editor';
import { diagnosticsInRange } from './ideUtils';
import type {
  CodeAction,
  CompletionItem,
  HoverResult,
  Location,
  LspDiagnostic,
  PrepareRenameResult,
  Range,
  WorkspaceEdit,
} from './lsp';

/** The status pill kinds — connecting (boot), green (model valid), error (diagnostics/connection). */
export type StatusKind = 'connecting' | 'green' | 'error';

/**
 * The slice of {@link import('./lsp').KoineLsp} the editor callback wall + diagnostics wiring needs.
 * A structural interface (not the class) so tests can pass a spy. Methods mirror KoineLsp 1:1.
 */
export interface EditorSessionLsp {
  hover(line: number, character: number): Promise<HoverResult | null>;
  completion(line: number, character: number): Promise<CompletionItem[]>;
  definition(line: number, character: number): Promise<Location | Location[] | null>;
  prepareRename(line: number, character: number): Promise<PrepareRenameResult | null>;
  rename(line: number, character: number, newName: string): Promise<WorkspaceEdit | null>;
  references(line: number, character: number): Promise<Location[]>;
  codeActions(range: Range, diagnostics: LspDiagnostic[]): Promise<CodeAction[]>;
  changeDoc(uri: string, text: string): void;
  onPublishDiagnostics(cb: (uri: string, diags: LspDiagnostic[]) => void): void;
  onServerExit(cb: (code: number) => void): void;
}

export interface EditorSessionDeps {
  /** Where the CodeMirror editor mounts (ide.ts's #editor-pane). */
  parent: HTMLElement;
  /** The editor's initial document text. */
  doc: string;
  /** Soft-wrap long lines on first paint. */
  lineWrap: boolean;
  /** The LSP client (request methods + diagnostics/exit subscriptions). */
  lsp: EditorSessionLsp;

  // Diagnostics / status DOM refs (looked up by ide.ts via el(...) and passed in).
  status: HTMLElement;
  diagCount: HTMLElement;
  diagBody: HTMLElement;
  /** Status-bar connection mirror (#sb-connection). */
  sbConnection: HTMLElement;
  /** Status-bar validity mirror (#sb-validity). */
  sbValidity: HTMLElement;

  /** The uri the editor currently shows / all LSP requests target (read live from ide.ts). */
  activeUri(): string;
  /** Map a file:// uri to a short label for the references picker (its relPath). */
  uriLabel(uri: string): string;

  /** Navigate to a resolved definition/reference Location (ide.ts switches files then jumps). */
  onNavigate(loc: Location): void;
  /** Apply a rename/code-action WorkspaceEdit (ide.ts spreads it across its open buffers). */
  onApplyWorkspaceEdit(edit: WorkspaceEdit): void;
  /**
   * Fired after EVERY diagnostics push (active or not), so ide.ts can refresh the file tree's
   * per-file error/warning badges. The session has already cached the diagnostics and (for the
   * active uri) repainted the editor + strip + status before this fires.
   */
  onDiagnostics(uri: string, diags: LspDiagnostic[]): void;
}

export interface EditorSession {
  /** The live CodeMirror editor handle (ide.ts drives setDoc/getDoc/goto/applyEdits on it). */
  editor: KoineEditor;

  /**
   * Cache the diagnostics for `uri`; if it is the active file, repaint the editor gutter, the strip,
   * and the status pill — otherwise cache only. (The LSP publishDiagnostics subscription routes
   * through here; ide.ts also reuses it where it needs to push a known set.)
   */
  renderDiagnostics(uri: string, diags: LspDiagnostic[]): void;
  /** Repaint the editor gutter + strip + status from `uri`'s CACHED diagnostics (on a file switch). */
  showDiagnostics(uri: string): void;
  /** The cached diagnostics for `uri` (the file tree badges + code actions read through this). */
  diagnosticsFor(uri: string): LspDiagnostic[];
  /** Forget the cached diagnostics for `uri` (a file delete/move). Does not repaint. */
  dropDiagnostics(uri: string): void;
  /** Move the cached diagnostics from `oldUri` to `newUri` (a file rename/move). Does not repaint. */
  renameDiagnostics(oldUri: string, newUri: string): void;
  /** Forget every cached diagnostic (a workspace swap). Does not repaint. */
  clearDiagnostics(): void;

  /** Write the status pill + mirror the connection state into the status bar. */
  setStatus(text: string, kind: StatusKind): void;
  /** Re-derive the status pill from a diagnostics set (green ✓ / N errors / N warnings). */
  updateStatus(diags: LspDiagnostic[]): void;

  /** Register the downstream onChange callback ide.ts uses for buffer/dirty/tree side effects. */
  onChange(cb: (doc: string) => void): void;

  // The editor's LSP forwarders, exposed so callers (and tests) can reach the wall directly.
  hover(line: number, character: number): Promise<HoverResult | null>;
  completion(line: number, character: number): Promise<CompletionItem[]>;
  codeActions(range: Range): Promise<CodeAction[]>;
}

export function createEditorSession(deps: EditorSessionDeps): EditorSession {
  const { lsp } = deps;

  // The per-uri diagnostics cache. Holds the latest pushed diagnostics for every file in the
  // workspace so switching files can re-render the active one and the tree can badge files with
  // errors. Lives here (it moved out of init()); see the module header — Task 5 reads it via the
  // accessors below rather than relocating it.
  const diagnosticsByUri = new Map<string, LspDiagnostic[]>();

  // The registered downstream onChange callback (ide.ts: welcome.hide / buffer+dirty / onDocEdited /
  // renderTree). The session's own onChange does the editor↔LSP sync, then invokes this.
  let downstreamOnChange: ((doc: string) => void) | null = null;

  // --- the editor LSP forwarders ---------------------------------------------
  // The hover/completion forwarders are also exposed on the session so callers/tests can reach them.
  const hover = (line: number, character: number) => lsp.hover(line, character);
  const completion = (line: number, character: number) => lsp.completion(line, character);
  // Scope a code-action request to the active file's diagnostics under the range (so the quickfix
  // menu offers fixes for THIS selection, not unrelated typos elsewhere in the file).
  const codeActions = (range: Range) =>
    lsp.codeActions(range, diagnosticsInRange(diagnosticsByUri.get(deps.activeUri()) ?? [], range));

  const editor = createKoineEditor({
    parent: deps.parent,
    doc: deps.doc,
    lineWrap: deps.lineWrap,
    onChange: (doc) => {
      // The editor↔LSP half of the old init() onChange: keep the server's document snapshot current
      // (debounced inside the client), then hand the new full text to ide.ts for the buffer/dirty/
      // tree side effects it still owns.
      lsp.changeDoc(deps.activeUri(), doc);
      downstreamOnChange?.(doc);
    },
    onHover: hover,
    onCompletion: completion,
    onDefinition: (line, character) => lsp.definition(line, character),
    onNavigate: (loc) => deps.onNavigate(loc),
    // Refactors + quick fixes (F2 rename, Shift-F12 references, Mod-. code actions). The editor
    // owns the in-editor widgets; ide.ts resolves the data and applies the resulting edits.
    onPrepareRename: (line, character) => lsp.prepareRename(line, character),
    onRename: (line, character, newName) => lsp.rename(line, character, newName),
    onReferences: (line, character) => lsp.references(line, character),
    onNavigateLocation: (loc) => deps.onNavigate(loc),
    uriLabel: (uri) => deps.uriLabel(uri),
    onCodeActions: (range) => codeActions(range),
    onApplyWorkspaceEdit: (edit) => deps.onApplyWorkspaceEdit(edit),
    // Save (Cmd/Ctrl-S) is owned by ide.ts's window keydown handler: it formats AND writes the
    // active buffer to disk. We deliberately do NOT pass onFormat here so the editor's Mod-s keymap
    // stays inert and there's exactly one save path.
  });

  // --- status + strip --------------------------------------------------------

  function setStatus(text: string, kind: StatusKind): void {
    deps.status.textContent = text;
    deps.status.dataset.kind = kind;
    // Mirror the connection state into the status bar as a stable label (the toolbar pill keeps the
    // live text). "Local" reflects that the model is compiled in-process, not against a remote server.
    deps.sbConnection.textContent = kind === 'connecting' ? 'Connecting…' : kind === 'error' ? 'Offline' : 'Local';
  }

  function renderStrip(diags: LspDiagnostic[]): void {
    const errors = diags.filter((d) => d.severity === 1 || d.severity == null).length;
    const warnings = diags.filter((d) => d.severity === 2).length;
    // Status-bar validity: a plain-language read of the same error count that feeds #diag-count.
    if (errors) {
      deps.sbValidity.textContent = errors === 1 ? '1 error' : `${errors} errors`;
      deps.sbValidity.dataset.kind = 'error';
    } else {
      deps.sbValidity.textContent = 'No errors';
      deps.sbValidity.dataset.kind = 'ok';
    }
    if (!errors && !warnings) {
      deps.diagCount.textContent = 'clean';
      deps.diagCount.dataset.kind = 'clean';
    } else {
      const parts: string[] = [];
      if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
      if (warnings) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
      deps.diagCount.textContent = parts.join(' · ');
      deps.diagCount.dataset.kind = errors ? 'error' : 'warn';
    }

    deps.diagBody.innerHTML = '';
    if (!diags.length) {
      const span = document.createElement('span');
      span.className = 'diag-empty';
      span.textContent = 'No diagnostics.';
      deps.diagBody.appendChild(span);
      return;
    }
    for (const d of diags) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = d.severity === 2 ? 'diag diag-warn' : 'diag diag-err';
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      const code = d.code != null ? `${d.code}: ` : '';
      row.textContent = `${d.severity === 2 ? 'warn' : 'error'} ${line}:${col}  ${code}${d.message}`;
      row.addEventListener('click', () => editor.goto(line, col));
      deps.diagBody.appendChild(row);
    }
  }

  function updateStatus(diags: LspDiagnostic[]): void {
    const errors = diags.filter((d) => d.severity === 1 || d.severity == null).length;
    const warnings = diags.filter((d) => d.severity === 2).length;
    if (errors === 0 && warnings === 0) {
      setStatus('green ✓', 'green');
    } else {
      const parts: string[] = [];
      if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
      if (warnings) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
      setStatus(parts.join(' / '), 'error');
    }
  }

  // --- diagnostics cache + render --------------------------------------------

  /** Repaint the editor gutter + strip + status from a diagnostics set (the active file). */
  function paintActive(diags: LspDiagnostic[]): void {
    setEditorDiagnostics(editor.view, diags);
    renderStrip(diags);
    updateStatus(diags);
  }

  function renderDiagnostics(uri: string, diags: LspDiagnostic[]): void {
    diagnosticsByUri.set(uri, diags);
    if (uri === deps.activeUri()) paintActive(diags);
  }

  function showDiagnostics(uri: string): void {
    paintActive(diagnosticsByUri.get(uri) ?? []);
  }

  function diagnosticsFor(uri: string): LspDiagnostic[] {
    return diagnosticsByUri.get(uri) ?? [];
  }

  function dropDiagnostics(uri: string): void {
    diagnosticsByUri.delete(uri);
  }

  function renameDiagnostics(oldUri: string, newUri: string): void {
    const diags = diagnosticsByUri.get(oldUri);
    diagnosticsByUri.delete(oldUri);
    if (diags) diagnosticsByUri.set(newUri, diags);
  }

  function clearDiagnostics(): void {
    diagnosticsByUri.clear();
  }

  // --- LSP subscriptions -----------------------------------------------------
  // Diagnostics are pushed per-uri for every file in the workspace. Cache them all; only the ACTIVE
  // file's diagnostics drive the editor gutter, the strip, and the status pill. ide.ts re-renders
  // the tree (via onDiagnostics) so non-active files can badge their error/warning counts.
  lsp.onPublishDiagnostics((uri, diags) => {
    renderDiagnostics(uri, diags);
    deps.onDiagnostics(uri, diags);
  });
  lsp.onServerExit((code) => {
    setStatus(`server exited (${code})`, 'error');
  });

  return {
    editor,
    renderDiagnostics,
    showDiagnostics,
    diagnosticsFor,
    dropDiagnostics,
    renameDiagnostics,
    clearDiagnostics,
    setStatus,
    updateStatus,
    onChange(cb) {
      downstreamOnChange = cb;
    },
    hover,
    completion,
    codeActions,
  };
}
