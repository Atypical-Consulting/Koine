// A tiny LSP client. Hand-rolled JSON-RPC with an id->resolver map, decoupled from how the bytes
// move via an injected LspTransport: the desktop transport brokers the `koine lsp` child over
// Tauri IPC, the browser transport drives an in-process WASM-backed server. This class is
// transport-agnostic — it only frames messages and tracks pending requests + open documents.
import type { LspTransport } from '@/host/types';
import type { EmitTarget } from '@/shared/emitTargets';
// The protocol DTOs (the server contract) live in ./protocol; re-export them so the ~23 type-only
// importers keep resolving `import type { … } from '@/lsp/lsp'` unchanged, and import the subset this
// client's request methods reference.
export * from '@/lsp/protocol';
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CheckResult,
  CodeAction,
  CodeLens,
  CompletionItem,
  CompletionList,
  ContextMapResult,
  DocsResult,
  DocumentSymbol,
  EmitKoineResult,
  EmitPreviewResult,
  FoldingRange,
  GlossaryModel,
  GlossaryResult,
  HoverResult,
  InlayHint,
  Location,
  LspDiagnostic,
  ModelEditResult,
  ModelMembersResult,
  ModelNode,
  Position,
  PrepareRenameResult,
  Range,
  ScenarioCatalog,
  ScenarioResult,
  SelectionRange,
  SemanticTokens,
  SetDocResult,
  SignatureHelp,
  StructuredEdit,
  TextEdit,
  WorkspaceEdit,
  WorkspaceSymbol,
} from '@/lsp/protocol';

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

const REQUEST_TIMEOUT_MS = 15000;

/**
 * LSP logging verbosity (issues #264/#354), mirroring the `lspTrace` setting: `off` logs nothing,
 * `messages` logs each wire message's direction + method, `verbose` additionally logs the
 * (size-guarded) params/result/error.
 */
export type LspTraceLevel = 'off' | 'messages' | 'verbose';

// Cap a verbose-trace payload so a large didOpen / semanticTokens body can't flood the devtools console.
const TRACE_PAYLOAD_MAX = 2000;

/** Render a trace payload as a single size-guarded string (truncated past {@link TRACE_PAYLOAD_MAX}). */
function traceFormat(payload: unknown): string {
  let s: string | undefined;
  try {
    s = JSON.stringify(payload);
  } catch {
    return '[unserializable]';
  }
  if (s === undefined) return '';
  return s.length > TRACE_PAYLOAD_MAX ? `${s.slice(0, TRACE_PAYLOAD_MAX)}… (${s.length} bytes)` : s;
}

interface OpenDoc {
  text: string;
  version: number;
}

export class KoineLsp {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout> }>();
  // Per-uri open buffers (text + monotonic version). The active uri is the one all
  // request methods target; didChange is debounced per active uri.
  private docs = new Map<string, OpenDoc>();
  private changeTimer?: ReturnType<typeof setTimeout>;
  // The uri of the document with a debounced didChange still pending (see changeDoc/flush).
  private pendingUri?: string;
  private onDiagnostics?: (uri: string, diags: LspDiagnostic[]) => void;
  private onExit?: (code: number) => void;
  private onRestart?: () => void;
  private activeUri = '';

  constructor(
    private readonly transport: LspTransport,
    private trace: LspTraceLevel = 'off',
  ) {}

  /** The uri every request method currently targets. */
  get active(): string {
    return this.activeUri;
  }

  /**
   * Set the LSP logging verbosity live (issues #264/#354). Driven by the effective `lspTrace` setting,
   * so a global change or a per-workspace override takes effect immediately on the running client
   * without a reconnect. See {@link LspTraceLevel} for the level semantics.
   */
  setTrace(level: LspTraceLevel): void {
    this.trace = level;
  }

  onPublishDiagnostics(cb: (uri: string, diags: LspDiagnostic[]) => void): void {
    this.onDiagnostics = cb;
  }

  onServerExit(cb: (code: number) => void): void {
    this.onExit = cb;
  }

  /** Fired AFTER the client has re-initialized and re-opened the document on a sidecar restart. */
  onServerRestart(cb: () => void): void {
    this.onRestart = cb;
  }

  /** Attach transport handlers FIRST, then bring the server up, then initialize. */
  async start(): Promise<void> {
    this.transport.onMessage((json) => {
      this.handle(JSON.parse(json) as JsonRpcMessage);
    });
    this.transport.onExit((code) => {
      this.onExit?.(code);
    });
    // The transport may respawn the server (desktop sidecar) and signal a restart. When it does,
    // the fresh server knows nothing about our documents, so re-handshake and re-open them.
    this.transport.onRestart(() => {
      void this.reinitialize();
    });

    await this.transport.start();
    await this.handshake();
  }

  /** initialize + initialized. Pending requests from a dead sidecar are rejected first. */
  private async handshake(): Promise<void> {
    await this.request('initialize', {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    this.notify('initialized', {});
  }

  /**
   * Re-handshake the fresh sidecar after a restart and re-open EVERY currently-open document so
   * the new server regains the whole workspace. Any in-flight requests belong to the dead child —
   * reject them.
   */
  private async reinitialize(): Promise<void> {
    // Drop any pending debounced edit so the initialize handshake's flush() is a no-op — otherwise
    // it would emit a didChange before reopen() re-sends didOpen (didChange-before-didOpen).
    clearTimeout(this.changeTimer);
    this.changeTimer = undefined;
    this.pendingUri = undefined;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('LSP server restarted'));
    }
    this.pending.clear();
    try {
      await this.handshake();
      this.reopen();
      this.onRestart?.();
    } catch (e) {
      console.error('LSP reinitialize after restart failed:', e);
    }
  }

  /** Re-send didOpen for every tracked document with its latest text (used after a restart). */
  reopen(): void {
    for (const [uri, doc] of this.docs) {
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: 'koine', version: ++doc.version, text: doc.text },
      });
    }
  }

  /** Console-log one wire message at the current trace level (a no-op at `off`). */
  private traceLog(direction: '→' | '←', msg: JsonRpcMessage): void {
    if (this.trace === 'off') return;
    const kind = msg.method ? (msg.id != null ? 'request' : 'notification') : 'response';
    const label = msg.method ?? `#${msg.id ?? '?'}`;
    if (this.trace === 'messages') {
      console.debug(`[lsp] ${direction} ${kind} ${label}`);
      return;
    }
    // verbose: the request's params, or the response's result/error, size-guarded.
    const payload = msg.params ?? msg.result ?? msg.error;
    if (payload === undefined) console.debug(`[lsp] ${direction} ${kind} ${label}`);
    else console.debug(`[lsp] ${direction} ${kind} ${label}`, traceFormat(payload));
  }

  private handle(msg: JsonRpcMessage): void {
    this.traceLog('←', msg);
    if (msg.id != null && typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics') {
      this.onDiagnostics?.(msg.params.uri, msg.params.diagnostics ?? []);
    }
    // Other server->client requests/notifications (window/logMessage, etc.) ignored.
  }

  private send(obj: object): Promise<void> {
    this.traceLog('→', obj as JsonRpcMessage);
    return this.transport.send(JSON.stringify(obj));
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    // Flush any debounced edit first so the server answers against the current document text —
    // critical for the mutating refactors (rename/code-action) and format, whose returned ranges
    // are applied to the live editor text. A no-op when nothing is pending.
    this.flush();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request '${method}' timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params }).catch((e) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  private notify(method: string, params: unknown): void {
    // Surface transport failures (e.g. a send before the child is up) instead of
    // swallowing them — a dropped notification is otherwise invisible.
    this.send({ jsonrpc: '2.0', method, params }).catch((e) => {
      console.error(`LSP notify '${method}' failed:`, e);
    });
  }

  /**
   * Open a document under `uri` and track it. Sends textDocument/didOpen. The first opened
   * document becomes the active uri if none has been set yet by the caller. Re-opening a uri
   * already tracked just re-sends didOpen with the new text.
   */
  openDoc(uri: string, text: string): void {
    const existing = this.docs.get(uri);
    const version = existing ? existing.version + 1 : 1;
    this.docs.set(uri, { text, version });
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'koine', version, text },
    });
  }

  /**
   * Full-text sync for `uri`, debounced ~250ms. Dropped until the document has been opened so a
   * didChange can never precede didOpen (edits made during the connect window are safe: didOpen
   * carries the editor's current full text). The debounce timer is shared across uris, so when the
   * uri switches mid-window (e.g. the assistant's multi-file apply calling changeDoc per file), the
   * previous uri's pending didChange is flushed first rather than dropped.
   */
  changeDoc(uri: string, text: string): void {
    const doc = this.docs.get(uri);
    if (!doc) return; // not opened yet — drop
    if (this.pendingUri !== undefined && this.pendingUri !== uri) this.flush();
    doc.text = text;
    this.pendingUri = uri;
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      this.pendingUri = undefined;
      // Re-check the doc is still open: it may have been closed (folder teardown, or a workspace
      // rename/delete) during the debounce window — sending didChange after didClose would be a
      // protocol violation.
      const current = this.docs.get(uri);
      if (!current) return;
      this.notify('textDocument/didChange', {
        textDocument: { uri, version: ++current.version },
        contentChanges: [{ text }],
      });
    }, 250);
  }

  /**
   * Synchronously send any debounced didChange that is still pending, so the server's document
   * snapshot is current before a request reads it. A no-op when nothing is pending. Called before
   * every request method (so a refactor/format/preview can't run against stale text) and before
   * switching the active file (so the leaving file's last edits aren't dropped by the shared timer).
   */
  flush(): void {
    if (this.changeTimer === undefined) return;
    clearTimeout(this.changeTimer);
    this.changeTimer = undefined;
    const uri = this.pendingUri;
    this.pendingUri = undefined;
    if (uri === undefined) return;
    const doc = this.docs.get(uri);
    if (!doc) return;
    this.notify('textDocument/didChange', {
      textDocument: { uri, version: ++doc.version },
      contentChanges: [{ text: doc.text }],
    });
  }

  /**
   * Immediately push the full text of `uri` to the server (no debounce), used when a non-active
   * buffer is edited programmatically (e.g. a cross-file rename). Falls back to openDoc for an
   * untracked uri so a didChange never precedes a didOpen.
   */
  syncDoc(uri: string, text: string): void {
    const doc = this.docs.get(uri);
    if (!doc) {
      this.openDoc(uri, text);
      return;
    }
    doc.text = text;
    this.notify('textDocument/didChange', {
      textDocument: { uri, version: ++doc.version },
      contentChanges: [{ text }],
    });
  }

  /** Close and stop tracking a document. Sends textDocument/didClose. */
  closeDoc(uri: string): void {
    if (!this.docs.delete(uri)) return;
    // A debounced didChange may still be queued for this uri; the changeDoc timer re-checks the doc
    // is open before firing, so the now-deleted uri is dropped rather than sent after didClose.
    this.notify('textDocument/didClose', {
      textDocument: { uri },
    });
  }

  /** Switch which uri all request methods target. Does NOT send any notification. */
  setActive(uri: string): void {
    this.activeUri = uri;
  }

  emitPreview(target: string): Promise<EmitPreviewResult> {
    return this.request<EmitPreviewResult>('koine/emitPreview', {
      textDocument: { uri: this.activeUri },
      target,
    });
  }

  /**
   * The backend's emit-target capability list (issue #282): the registry's code targets, each with
   * `{ id, displayName, fileExtension }`. Document-independent, so it sends no `textDocument`. The
   * caller seeds {@link EMIT_TARGETS} from this at boot, falling back to the built-ins if it rejects.
   */
  emitTargets(): Promise<EmitTarget[]> {
    return this.request<{ targets: EmitTarget[] }>('koine/emitTargets', {}).then((r) => r?.targets ?? []);
  }

  /** Ubiquitous-language glossary as markdown for the active document. */
  glossary(): Promise<GlossaryResult> {
    return this.request<GlossaryResult>('koine/glossary', {
      textDocument: { uri: this.activeUri },
    });
  }

  /** Context map (contexts + relations) for the active document. */
  contextMap(): Promise<ContextMapResult> {
    return this.request<ContextMapResult>('koine/contextMap', {
      textDocument: { uri: this.activeUri },
    });
  }

  /** Structured ubiquitous-language glossary (entries + doc presence) for the merged workspace. */
  glossaryModel(): Promise<GlossaryModel> {
    return this.request<GlossaryModel>('koine/glossaryModel', {
      textDocument: { uri: this.activeUri },
    });
  }

  /**
   * Structured model graph (#91) for the merged workspace — the whole tree, or the subtree at
   * `qualifiedName` when given — that a visual editor builds forms/canvases from.
   */
  model(qualifiedName?: string): Promise<ModelNode> {
    return this.request<ModelNode>('koine/model', {
      textDocument: { uri: this.activeUri },
      qualifiedName: qualifiedName ?? null,
    });
  }

  /** The editable children (fields, enum members, transitions, relations) of a model node (#91). */
  modelMembers(qualifiedName: string): Promise<ModelMembersResult> {
    return this.request<ModelMembersResult>('koine/modelMembers', {
      textDocument: { uri: this.activeUri },
      qualifiedName,
    });
  }

  /** Apply a structured edit and get back the validated canonical `.koi` (or diagnostics) (#91). */
  emitKoine(edit: StructuredEdit): Promise<EmitKoineResult> {
    return this.request<EmitKoineResult>('koine/emitKoine', {
      textDocument: { uri: this.activeUri },
      edit,
    });
  }

  /** Apply a structured edit and get back a span-minimal `TextEdit` patch for the buffer (#91). */
  applyModelEdit(edit: StructuredEdit): Promise<ModelEditResult> {
    return this.request<ModelEditResult>('koine/applyModelEdit', {
      textDocument: { uri: this.activeUri },
      edit,
    });
  }

  /** The runnable surface of the workspace (#149): entities with commands/factories, for the panel's dropdowns. */
  scenarioCatalog(): Promise<ScenarioCatalog> {
    return this.request<ScenarioCatalog>('koine/scenarioCatalog', {
      textDocument: { uri: this.activeUri },
    });
  }

  /**
   * Run a scenario (#149): exercise one aggregate command/factory (`target`/`operation`) against a
   * `given` starting state and `args`, returning the command → events → invariant-checks timeline.
   * Backend-agnostic — routed to the CLI `koine lsp` child or the in-browser WASM export identically.
   */
  runScenario(
    target: string,
    operation: string,
    given: Record<string, unknown>,
    args: Record<string, unknown>,
  ): Promise<ScenarioResult> {
    return this.request<ScenarioResult>('koine/runScenario', {
      textDocument: { uri: this.activeUri },
      target,
      operation,
      given,
      args,
    });
  }

  /** Living-documentation files (Mermaid-in-Markdown) for the merged workspace. */
  livingDocs(): Promise<DocsResult> {
    return this.request<DocsResult>('koine/docs', {
      textDocument: { uri: this.activeUri },
    });
  }

  /** Set (insert/replace/clear) a declaration's `///` doc comment, addressed by its glossary id. */
  setDoc(id: string, text: string): Promise<SetDocResult> {
    return this.request<SetDocResult>('koine/setDoc', {
      textDocument: { uri: this.activeUri },
      id,
      text,
    });
  }

  /**
   * Every reference to the symbol at a 0-based position across the workspace (declaration
   * included). Resolves to [] when the cursor is not on a renameable name.
   */
  async references(line: number, character: number): Promise<Location[]> {
    const res = await this.request<Location[] | null>('textDocument/references', {
      textDocument: { uri: this.activeUri },
      position: { line, character },
      context: { includeDeclaration: true },
    });
    return res ?? [];
  }

  /**
   * The editable identifier range under the cursor (LSP prepareRename). Resolves to null when a
   * rename is not valid there (string/regex, non-word token, or no resolvable symbol).
   */
  prepareRename(line: number, character: number): Promise<PrepareRenameResult | null> {
    return this.request<PrepareRenameResult | null>('textDocument/prepareRename', {
      textDocument: { uri: this.activeUri },
      position: { line, character },
    });
  }

  /**
   * Compute the workspace edit to rename the symbol under the cursor to `newName`. Resolves to
   * null when no rename applies (cursor not on a renameable name, invalid identifier, unchanged).
   */
  rename(line: number, character: number, newName: string): Promise<WorkspaceEdit | null> {
    return this.request<WorkspaceEdit | null>('textDocument/rename', {
      textDocument: { uri: this.activeUri },
      position: { line, character },
      newName,
    });
  }

  /**
   * Code actions for a 0-based range: diagnostic quickfixes (from the supplied active-file
   * diagnostics) plus selection-driven refactors. Resolves to [] when none apply.
   */
  async codeActions(range: Range, diagnostics: LspDiagnostic[]): Promise<CodeAction[]> {
    const res = await this.request<CodeAction[] | null>('textDocument/codeAction', {
      textDocument: { uri: this.activeUri },
      range,
      context: { diagnostics },
    });
    return res ?? [];
  }

  /** Standard LSP hover at a 0-based position. Resolves to null when there is nothing to show. */
  hover(line: number, character: number): Promise<HoverResult | null> {
    return this.request<HoverResult | null>('textDocument/hover', {
      textDocument: { uri: this.activeUri },
      position: { line, character },
    });
  }

  /** IntelliSense completions at a 0-based position. Resolves to [] when there are none. */
  async completion(line: number, character: number): Promise<CompletionItem[]> {
    const res = await this.request<CompletionList | CompletionItem[] | null>('textDocument/completion', {
      textDocument: { uri: this.activeUri },
      position: { line, character },
    });
    if (!res) return [];
    return Array.isArray(res) ? res : res.items;
  }

  /** Go-to-definition at a 0-based position. Resolves to a Location, an array, or null. */
  definition(line: number, character: number): Promise<Location | Location[] | null> {
    return this.request<Location | Location[] | null>('textDocument/definition', {
      textDocument: { uri: this.activeUri },
      position: { line, character },
    });
  }

  /**
   * Inlay hints (inferred type / parameter-name annotations) for a 0-based range. Resolves to []
   * when the server returns null. The editor renders each as a dimmed inline widget.
   */
  async inlayHints(
    startLine: number,
    startChar: number,
    endLine: number,
    endChar: number,
  ): Promise<InlayHint[]> {
    const res = await this.request<InlayHint[] | null>('textDocument/inlayHint', {
      textDocument: { uri: this.activeUri },
      range: { start: { line: startLine, character: startChar }, end: { line: endLine, character: endChar } },
    });
    return res ?? [];
  }

  /**
   * Semantic tokens (full document) for the active document: the LSP delta-encoded int stream the
   * editor decodes into semantically-accurate highlighting. Resolves to `{ data: [] }` when the
   * server returns null, so the editor falls back to the static grammar (graceful degradation).
   */
  async semanticTokens(): Promise<SemanticTokens> {
    const res = await this.request<SemanticTokens | null>('textDocument/semanticTokens/full', {
      textDocument: { uri: this.activeUri },
    });
    return res ?? { data: [] };
  }

  /**
   * Prepare call hierarchy at a 0-based position: the CallHierarchyItem(s) the cursor resolves to.
   * Each item carries an opaque `data` blob that must be echoed back verbatim on incoming/outgoing.
   * Resolves to [] when the cursor is not on a command/event.
   */
  async prepareCallHierarchy(line: number, character: number): Promise<CallHierarchyItem[]> {
    const res = await this.request<CallHierarchyItem[] | null>('textDocument/prepareCallHierarchy', {
      textDocument: { uri: this.activeUri },
      position: { line, character },
    });
    return res ?? [];
  }

  /**
   * Incoming calls into a prepared CallHierarchyItem. The item (including its opaque `data`) is sent
   * back verbatim so the server can reconstruct it. Resolves to [] when the server returns null.
   */
  async incomingCalls(item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[]> {
    const res = await this.request<CallHierarchyIncomingCall[] | null>('callHierarchy/incomingCalls', { item });
    return res ?? [];
  }

  /**
   * Outgoing calls from a prepared CallHierarchyItem. The item (including its opaque `data`) is sent
   * back verbatim so the server can reconstruct it. Resolves to [] when the server returns null.
   */
  async outgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[]> {
    const res = await this.request<CallHierarchyOutgoingCall[] | null>('callHierarchy/outgoingCalls', { item });
    return res ?? [];
  }

  /** Signature help for the call enclosing a 0-based position. Resolves to null when there is none. */
  signatureHelp(line: number, character: number): Promise<SignatureHelp | null> {
    return this.request<SignatureHelp | null>('textDocument/signatureHelp', {
      textDocument: { uri: this.activeUri },
      position: { line, character },
    });
  }

  /** Workspace-wide symbol search (subsequence-matches `query`). Resolves to [] when nothing matches. */
  async workspaceSymbols(query: string): Promise<WorkspaceSymbol[]> {
    const res = await this.request<WorkspaceSymbol[] | null>('workspace/symbol', { query });
    return res ?? [];
  }

  /** Document outline as a DocumentSymbol tree. Resolves to [] when the server returns null. */
  async documentSymbols(): Promise<DocumentSymbol[]> {
    const res = await this.request<DocumentSymbol[] | null>('textDocument/documentSymbol', {
      textDocument: { uri: this.activeUri },
    });
    return res ?? [];
  }

  /** Collapsible regions of the active document. Resolves to [] when the server returns null. */
  async foldingRanges(): Promise<FoldingRange[]> {
    const res = await this.request<FoldingRange[] | null>('textDocument/foldingRange', {
      textDocument: { uri: this.activeUri },
    });
    return res ?? [];
  }

  /**
   * Selection-range chains for a set of 0-based positions. Returns one chain per requested position,
   * in parallel order (innermost first, each `parent` strictly enclosing its child).
   */
  async selectionRanges(positions: Position[]): Promise<SelectionRange[]> {
    const res = await this.request<SelectionRange[] | null>('textDocument/selectionRange', {
      textDocument: { uri: this.activeUri },
      positions,
    });
    return res ?? [];
  }

  /**
   * Code lenses of the active document — one per top-level declaration, annotated with a
   * `"N references"` reference-count label. Resolves to [] when the server returns null.
   */
  async codeLenses(): Promise<CodeLens[]> {
    const res = await this.request<CodeLens[] | null>('textDocument/codeLens', {
      textDocument: { uri: this.activeUri },
    });
    return res ?? [];
  }

  /** Canonical formatting edits for the whole active document. Resolves to [] when nothing changes. */
  async format(tabSize = 2, insertSpaces = true): Promise<TextEdit[]> {
    const res = await this.request<TextEdit[] | null>('textDocument/formatting', {
      textDocument: { uri: this.activeUri },
      options: { tabSize, insertSpaces },
    });
    return res ?? [];
  }

  /** Notify the server the active document was saved (optional; harmless if unhandled). */
  didSave(): void {
    const doc = this.docs.get(this.activeUri);
    if (!doc) return;
    this.notify('textDocument/didSave', {
      textDocument: { uri: this.activeUri },
      text: doc.text,
    });
  }

  /**
   * Model-versioning compatibility of the active buffer against a baseline model folder.
   * `baseline` is a folder token the desktop server reads server-side; in the browser there is no
   * filesystem, so the caller passes the baseline `{uri,text}` sources directly via
   * `baselineSources` and the in-process server uses those instead of the token.
   */
  check(baseline: string, baselineSources?: { uri: string; text: string }[]): Promise<CheckResult> {
    return this.request<CheckResult>('koine/check', {
      textDocument: { uri: this.activeUri },
      baseline,
      ...(baselineSources ? { baselineSources } : {}),
    });
  }

  dispose(): void {
    clearTimeout(this.changeTimer);
    void this.transport.stop();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('LSP client disposed'));
    }
    this.pending.clear();
  }
}
