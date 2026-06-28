// editorSession: the editor ↔ LSP + diagnostics wiring, lifted out of ide.ts's init() (Task 3 of
// the ide.ts decomposition, issue #180). It owns the CodeMirror editor and its callback wall (the
// hover/completion/definition/rename/references/code-action forwarders to the LSP), the per-uri
// diagnostics cache, the status pill + diagnostics strip rendering, and the LSP
// publishDiagnostics / serverExit subscriptions. Everything model-/workspace-/buffer-shaped stays
// in ide.ts and is injected as deps or surfaced as a callback — this module is deliberately
// agnostic of buffers, the file tree, and the host platform.
//
// The per-uri diagnostics cache now lives in the app store's `diagnostics` slice (issue #193): the
// LSP publish path writes it via appStore.setDiagnostics and the accessors below
// (diagnosticsFor / showDiagnostics / dropDiagnostics / renameDiagnostics / clearDiagnostics) delegate
// to that single source of truth. Other controllers — notably workspaceController — keep reading and
// mutating through these accessors. The diagnostics STRIP (#diag-body rows + its count) is rendered by
// the Preact DiagnosticsStripPanel mounted below, which subscribes to the slice; the editor gutter, the
// status pill (#status), the header count badge (#diag-count), and the status-bar validity mirror
// (#sb-validity) stay imperative here.
import { render } from 'preact';
import { createKoineEditor, setEditorDiagnostics, type KoineEditor } from '@/editor/editor';
import { mountSymbolRow } from '@/editor/symbolRow';
import { isNarrowViewport } from '@/shared/breakpoint';
import { diagnosticsInRange } from '@/shell/ideUtils';
import { appStore } from '@/store/index';
import { diagnosticsSummary } from '@/diagnostics/diagnosticsSummary';
import { DiagnosticsStripPanel } from '@/diagnostics/DiagnosticsStripPanel';
import type { ChangeSet, Text } from '@codemirror/state';
import type { ReviewThread } from '@/review/reviewStore';
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CodeAction,
  CompletionItem,
  HoverResult,
  InlayHint,
  Location,
  LspDiagnostic,
  PrepareRenameResult,
  Range,
  SemanticTokens,
  SourceSpan,
  WorkspaceEdit,
} from '@/lsp/lsp';

/** The status pill kinds — connecting (boot), green (model valid / success toast), error (diagnostics
 *  or a failed action toast). NOTE: the pill is transient UI only; the persistent connection indicator
 *  (#sb-connection) is driven separately by the LSP lifecycle, not by this kind. */
export type StatusKind = 'connecting' | 'green' | 'error';

/**
 * The slice of {@link import('@/lsp/lsp').KoineLsp} the editor callback wall + diagnostics wiring needs.
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
  inlayHints(startLine: number, startChar: number, endLine: number, endChar: number): Promise<InlayHint[]>;
  semanticTokens(): Promise<SemanticTokens>;
  prepareCallHierarchy(line: number, character: number): Promise<CallHierarchyItem[]>;
  incomingCalls(item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[]>;
  outgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[]>;
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
  /** Show the document-overview minimap on first paint. */
  minimap: boolean;
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

  // --- review threads (#259) -------------------------------------------------
  // All optional; editorSession FILE-SCOPES each one per group before handing it to that group's editor,
  // so group A and group B (which may show different files) each see only their own file's threads and
  // only re-anchor / pin to their own file. A host that doesn't wire reviews (or a test) leaves them unset
  // and the editor renders no review marks.
  /** The review-thread provider (the store's `list()`) — the FULL multi-file list; editorSession narrows it per group. */
  getReviewThreads?(): ReviewThread[];
  /** Open a review thread on `span` (editorSession fills `span.file` with the invoking group's uri). */
  onAddComment?(span: SourceSpan): void;
  /** Re-anchor the threads in `file` through a document edit's CodeMirror {@link ChangeSet} (ide.ts → store.remap). */
  onDocChange?(change: ChangeSet, doc: Text, file: string): void;
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

  /**
   * Register the downstream onChange callback ide.ts uses for buffer/dirty/tree side effects. The
   * callback receives the new full text AND the active uri so ide.ts syncs the edit into the right buffer.
   */
  onChange(cb: (doc: string, uri: string) => void): void;

  /** Repaint the editor's review-thread decorations after the review store changed — ide.ts calls this
   *  from the store subscription + after add/load. */
  refreshReviewDecorations(): void;

  // The editor's LSP forwarders, exposed so callers (and tests) can reach the wall directly.
  hover(line: number, character: number): Promise<HoverResult | null>;
  completion(line: number, character: number): Promise<CompletionItem[]>;
  codeActions(range: Range): Promise<CodeAction[]>;

  /**
   * Release everything the session owns: the mobile symbol-row accessory (its DOM + CM listeners), the
   * focusin/focusout/resize listeners it registered, and the editor — whose own destroy() removes its
   * visualViewport listener and trips its torn-down guard. ide.ts calls this from its init() teardown so
   * a session never outlives its host (the listeners would otherwise leak and fire into a torn-down DOM).
   */
  destroy(): void;
}

export function createEditorSession(deps: EditorSessionDeps): EditorSession {
  const { lsp } = deps;

  // Review threads (#259) are file-scoped per editor group: `currentUri()` returns the uri the group is
  // showing right now, so each group renders/edits ONLY its own file's threads. Without this a comment in
  // file A would paint over file B and an edit in A would corrupt B's spans (both editors share one store).
  function reviewOptionsFor(currentUri: () => string): {
    getReviewThreads?: () => ReviewThread[];
    onAddComment?: (span: SourceSpan) => void;
    onDocChange?: (change: ChangeSet, doc: Text) => void;
  } {
    return {
      // Only this group's file's threads, so the offsets line up with this editor's document.
      getReviewThreads: deps.getReviewThreads ? () => deps.getReviewThreads!().filter((t) => t.file === currentUri()) : undefined,
      // The editor builds the span with `file: null` (it doesn't know its uri); pin it to this group's file.
      onAddComment: deps.onAddComment ? (span) => deps.onAddComment!({ ...span, file: currentUri() }) : undefined,
      // Re-anchor only this group's file's threads through this buffer's change.
      onDocChange: deps.onDocChange ? (change, doc) => deps.onDocChange!(change, doc, currentUri()) : undefined,
    };
  }

  // The per-uri diagnostics cache is the app store's `diagnostics` slice (issue #193). Holds the latest
  // pushed diagnostics for every file in the workspace so switching files can re-render the active one
  // and the tree can badge files with errors. Reads/writes go through the slice via these helpers so the
  // strip panel (which subscribes to the slice) stays in sync; the accessors exposed on the session
  // delegate here. See the module header.
  const diagFor = (uri: string): LspDiagnostic[] => appStore.getState().diagnosticsFor(uri);

  // The registered downstream onChange callback (ide.ts: welcome.hide / buffer+dirty / onDocEdited /
  // renderTree). The session's own onChange does the editor↔LSP sync, then invokes this with the
  // editing group's uri so ide.ts syncs the edit into the right buffer (#265).
  let downstreamOnChange: ((doc: string, uri: string) => void) | null = null;

  // --- the editor LSP forwarders ---------------------------------------------
  // The hover/completion forwarders are also exposed on the session so callers/tests can reach them.
  const hover = (line: number, character: number) => lsp.hover(line, character);
  const completion = (line: number, character: number) => lsp.completion(line, character);
  // Scope a code-action request to the active file's diagnostics under the range (so the quickfix
  // menu offers fixes for THIS selection, not unrelated typos elsewhere in the file).
  const codeActions = (range: Range) =>
    lsp.codeActions(range, diagnosticsInRange(diagFor(deps.activeUri()), range));

  const editor = createKoineEditor({
    parent: deps.parent,
    doc: deps.doc,
    lineWrap: deps.lineWrap,
    minimap: deps.minimap,
    onChange: (doc) => {
      // The editor↔LSP half of the old init() onChange: keep the server's document snapshot current
      // (debounced inside the client), then hand the new full text + the active uri to ide.ts for the
      // buffer/dirty/tree side effects it still owns.
      lsp.changeDoc(deps.activeUri(), doc);
      downstreamOnChange?.(doc, deps.activeUri());
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
    // Inlay hints (inferred type / parameter-name annotations) and call hierarchy (Mod-Alt-h). The
    // editor owns the in-editor widgets/menu; the LSP client resolves the data over the active uri.
    onInlayHints: (sl, sc, el, ec) => lsp.inlayHints(sl, sc, el, ec),
    onSemanticTokens: () => lsp.semanticTokens(),
    onPrepareCallHierarchy: (line, character) => lsp.prepareCallHierarchy(line, character),
    onIncomingCalls: (item) => lsp.incomingCalls(item),
    onOutgoingCalls: (item) => lsp.outgoingCalls(item),
    // Review threads (#259): file-scoped to group A's active file (the marks/gutter provider, the
    // add-comment handler, and the span-remap hook), so A never paints or remaps another file's threads.
    ...reviewOptionsFor(() => deps.activeUri()),
    // Save (Cmd/Ctrl-S) is owned by ide.ts's window keydown handler: it formats AND writes the
    // active buffer to disk. We deliberately do NOT pass onFormat here so the editor's Mod-s keymap
    // stays inert and there's exactly one save path.
  });

  // --- DSL symbol accessory row (#221, mobile) -------------------------------
  // A one-tap punctuation strip for the phone soft keyboard (which buries Koine's `->`, `«`, `=>`, …
  // behind shift layers), mounted into group A's pane. mountSymbolRow owns the DOM + insert-at-caret;
  // this only gates visibility: shown solely while group A's editor (or the strip itself) holds focus
  // on a narrow viewport, hidden otherwise. Tapping a token preventDefaults mousedown so the editor
  // keeps focus — so a tap never fires focusout and the strip stays up between insertions. The
  // `within` check is scoped to group A's editor DOM (not the whole pane) so a focused group B never
  // shows group A's strip, and so keyboard-tabbing INTO the strip's buttons keeps it visible.
  const symbolRowHost = document.createElement('div');
  symbolRowHost.className = 'koi-symbol-row-host';
  symbolRowHost.hidden = true;
  deps.parent.appendChild(symbolRowHost);
  // Keep mountSymbolRow's handle so destroy() can tear the strip down (it owns the DOM + CM listeners).
  const symbolRow = mountSymbolRow(editor.view, symbolRowHost);
  const syncSymbolRow = (): void => {
    const narrow = isNarrowViewport();
    const active = document.activeElement;
    const within = editor.view.dom.contains(active) || symbolRowHost.contains(active);
    symbolRowHost.hidden = !(narrow && within);
  };
  // focusout fires BEFORE focus settles on the next element, so defer the read of document.activeElement.
  // Named (not an inline arrow) so destroy() can removeEventListener it — the inline form was un-removable.
  const onSymbolRowFocusOut = (): void => void setTimeout(syncSymbolRow, 0);
  deps.parent.addEventListener('focusin', syncSymbolRow);
  deps.parent.addEventListener('focusout', onSymbolRowFocusOut);
  // A rotate/resize that crosses the breakpoint while focused must re-evaluate visibility.
  window.addEventListener('resize', syncSymbolRow);

  // --- status + strip --------------------------------------------------------

  function setStatus(text: string, kind: StatusKind): void {
    deps.status.textContent = text;
    deps.status.dataset.kind = kind;
  }

  // The status-bar connection indicator (#sb-connection) tracks the language service's LIVENESS, not
  // diagnostics: it stays "Connecting…" until the first server push proves the (in-process / WASM)
  // service is live ("Local"), and flips to "Offline" only if the server exits. Diagnostics and
  // transient action toasts must NOT drive it — a model with a warning is still a live, local session
  // (the old code mirrored the pill's `kind` here, so any warning or error toast falsely read "Offline").
  function setConnection(state: 'connecting' | 'online' | 'offline'): void {
    deps.sbConnection.textContent =
      state === 'connecting' ? 'Connecting…' : state === 'offline' ? 'Offline' : 'Local';
  }

  // The strip ROWS + their count text now live in the DiagnosticsStripPanel (mounted into #diag-body
  // below), which reads the diagnostics slice. This helper keeps the two imperative MIRRORS that ride
  // alongside the strip: the bottom-panel header count badge (#diag-count) and the status-bar validity
  // mirror (#sb-validity). Both summarise the active file's diagnostics with the exact strings used
  // before the migration.
  function renderStrip(diags: LspDiagnostic[]): void {
    const { errors, kind, parts } = diagnosticsSummary(diags);
    // Status-bar validity: a plain-language read of the same error count that feeds #diag-count.
    if (errors) {
      deps.sbValidity.textContent = errors === 1 ? '1 error' : `${errors} errors`;
      deps.sbValidity.dataset.kind = 'error';
    } else {
      deps.sbValidity.textContent = 'No errors';
      deps.sbValidity.dataset.kind = 'ok';
    }
    if (kind === 'clean') {
      deps.diagCount.textContent = 'clean';
      deps.diagCount.dataset.kind = 'clean';
    } else {
      deps.diagCount.textContent = parts.join(' · ');
      deps.diagCount.dataset.kind = kind;
    }
  }

  // Mount (and re-render) the diagnostics strip as a Preact panel into #diag-body. The panel reads the
  // app store's diagnostics slice for the live activeUri, so it owns the strip rows + its own count text;
  // the row click drives the same editor.goto the old imperative rows did. The panel self-subscribes to
  // the slice, but paintActive also re-renders it synchronously on each active-file push — Preact's
  // top-level render() reconciles into the same #diag-body node, so the host keeps its identity and the
  // strip repaints immediately (the same synchronous behavior the old imperative renderStrip had). It is
  // mounted lazily on the first paint (NOT at construction) because deps.activeUri() — read during the
  // panel's render — may close over wiring (e.g. ide.ts's workspace) that isn't assigned yet here.
  function renderStripPanel(): void {
    render(
      <DiagnosticsStripPanel
        store={appStore}
        activeUri={deps.activeUri}
        onGoto={(line, col) => editor.goto(line, col)}
      />,
      deps.diagBody,
    );
  }

  function updateStatus(diags: LspDiagnostic[]): void {
    const { kind, parts } = diagnosticsSummary(diags);
    if (kind === 'clean') {
      setStatus('green ✓', 'green');
    } else {
      // The status pill joins the SAME parts with ' / ' (not the strip's ' · ').
      setStatus(parts.join(' / '), 'error');
    }
  }

  // --- diagnostics cache + render --------------------------------------------

  /**
   * Repaint the editor gutter + the strip panel + the strip mirrors (#diag-count badge, #sb-validity) +
   * the status pill from a diagnostics set (the active file). The strip ROWS are owned by the panel; the
   * synchronous re-render here makes its repaint immediate (the slice was just written).
   */
  function paintActive(diags: LspDiagnostic[]): void {
    setEditorDiagnostics(editor.view, diags);
    renderStripPanel();
    renderStrip(diags);
    updateStatus(diags);
  }

  function renderDiagnostics(uri: string, diags: LspDiagnostic[]): void {
    // Write the slice first — the strip panel subscribes to it and re-renders the rows + its count.
    appStore.getState().setDiagnostics(uri, diags);
    if (uri === deps.activeUri()) paintActive(diags);
  }

  function showDiagnostics(uri: string): void {
    paintActive(diagFor(uri));
  }

  function diagnosticsFor(uri: string): LspDiagnostic[] {
    return diagFor(uri);
  }

  function dropDiagnostics(uri: string): void {
    appStore.getState().dropDiagnostics(uri);
  }

  function renameDiagnostics(oldUri: string, newUri: string): void {
    appStore.getState().renameDiagnostics(oldUri, newUri);
  }

  function clearDiagnostics(): void {
    appStore.getState().clearDiagnostics();
  }

  // --- LSP subscriptions -----------------------------------------------------
  // Diagnostics are pushed per-uri for every file in the workspace. Cache them all; only the ACTIVE
  // file's diagnostics drive the editor gutter, the strip, and the status pill. ide.ts re-renders
  // the tree (via onDiagnostics) so non-active files can badge their error/warning counts.
  lsp.onPublishDiagnostics((uri, diags) => {
    // A server→client push (even an empty one) proves the language service is live — mark the
    // connection "Local" regardless of whether the diagnostics carry warnings or errors.
    setConnection('online');
    renderDiagnostics(uri, diags);
    deps.onDiagnostics(uri, diags);
  });
  lsp.onServerExit((code) => {
    setStatus(`server exited (${code})`, 'error');
    setConnection('offline');
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
    refreshReviewDecorations() {
      editor.refreshReviewDecorations();
    },
    hover,
    completion,
    codeActions,
    destroy(): void {
      deps.parent.removeEventListener('focusin', syncSymbolRow);
      deps.parent.removeEventListener('focusout', onSymbolRowFocusOut);
      window.removeEventListener('resize', syncSymbolRow);
      symbolRow.destroy();
      symbolRowHost.remove();
      editor.destroy();
    },
  };
}
