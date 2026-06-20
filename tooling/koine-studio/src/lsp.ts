// A tiny LSP client. Hand-rolled JSON-RPC with an id->resolver map, decoupled from how the bytes
// move via an injected LspTransport: the desktop transport brokers the `koine lsp` child over
// Tauri IPC, the browser transport drives an in-process WASM-backed server. This class is
// transport-agnostic — it only frames messages and tracks pending requests + open documents.
import type { LspTransport } from './host/types';

// --- protocol types (mirror the server contract) ----------------------------

export interface Position {
  line: number; // 0-based
  character: number; // 0-based
}
export interface Range {
  start: Position;
  end: Position;
}
export interface LspDiagnostic {
  range: Range;
  severity?: 1 | 2 | 3 | 4; // 1=error, 2=warning, 3=info, 4=hint
  code?: string | number;
  message: string;
}
export interface EmitFile {
  path: string;
  contents: string;
}
export interface EmitPreviewResult {
  target: string;
  files: EmitFile[];
  diagnostics: LspDiagnostic[];
  error: string | null;
}

export interface GlossaryResult {
  markdown: string;
}

export interface AclMapping {
  upstreamContext: string;
  upstreamType: string;
  localContext: string;
  localType: string;
}
export interface ContextRelation {
  upstream: string;
  downstream: string;
  kind: string;
  bidirectional: boolean;
  sharedTypes: string[];
  acl: AclMapping[];
}
export interface ContextMapResult {
  contexts: string[];
  relations: ContextRelation[];
}

// `koine/glossaryModel`: one entry per context/type, with doc presence (for coverage) and the
// name's range. `doc` is null when the declaration is undocumented.
export interface GlossaryEntry {
  id: string;
  name: string;
  kind: string;
  context: string;
  qualifiedName: string;
  doc: string | null;
  nameRange: Range;
}
export interface GlossaryModel {
  entries: GlossaryEntry[];
}

// `koine/setDoc` result: the file the edits apply to (null when the id is unknown) and the
// localized TextEdits that insert/replace/clear the declaration's `///` block.
export interface SetDocResult {
  uri: string | null;
  edits: TextEdit[];
}

// Standard LSP Hover. `contents` is a MarkupContent ({kind,value}), a MarkedString
// (string | {language,value}), or an array of those. `range` is optional.
export interface MarkupContent {
  kind: 'plaintext' | 'markdown';
  value: string;
}
export type MarkedString = string | { language: string; value: string };
export interface HoverResult {
  contents: MarkupContent | MarkedString | MarkedString[];
  range?: Range;
}

// Standard LSP completion. `kind` is the numeric CompletionItemKind (14=Keyword, 7=Class,
// 13=Enum, 20=EnumMember, 5=Field, 10=Property, 2=Method, …).
export interface CompletionItem {
  label: string;
  kind?: number;
  detail?: string | null;
  documentation?: string | null;
  // Snippet support: insertText is the body, insertTextFormat 2 = snippet (1/undefined = plaintext).
  insertText?: string | null;
  insertTextFormat?: number | null;
  // Characters that commit this item when typed; sortText orders the list (prefix < subsequence);
  // data is an opaque round-trip token for completionItem/resolve.
  commitCharacters?: string[] | null;
  sortText?: string | null;
  data?: string | null;
}
export interface CompletionList {
  isIncomplete: boolean;
  items: CompletionItem[];
}

// Standard LSP Location: a uri + a range within it. `definition` may resolve to one,
// an array, or null.
export interface Location {
  uri: string;
  range: Range;
}

// Standard LSP signature help (mirrors WASM WSignatureHelp / the desktop LSP). Koine has
// no overloads, so `signatures` always holds exactly one entry.
export interface ParameterInformation {
  label: string;
}
export interface SignatureInformation {
  label: string;
  parameters: ParameterInformation[];
}
export interface SignatureHelp {
  signatures: SignatureInformation[];
  activeSignature: number;
  activeParameter: number;
}

// Standard LSP DocumentSymbol tree. `kind` is the SymbolKind number (e.g. 5=Class,
// 10=Enum, 22=EnumMember, 8=Field, 6=Method, 23=Struct, 13=Variable, 3=Namespace).
export interface DocumentSymbol {
  name: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

// Standard LSP SymbolInformation (flat, workspace-wide): the `workspace/symbol` result.
// `kind` is the SymbolKind number (same scheme as DocumentSymbol). `containerName` is the
// name of the enclosing declaration (a type's context, or a member's type).
export interface WorkspaceSymbol {
  name: string;
  kind: number;
  uri: string;
  range: Range;
  containerName?: string;
}

// Standard LSP FoldingRange: a collapsible region. `startLine`/`endLine` are 0-based and both
// inclusive (the `textDocument/foldingRange` result), one per multi-line block declaration.
export interface FoldingRange {
  startLine: number;
  endLine: number;
}

// Standard LSP SelectionRange (recursive): the range the editor expands to, plus the enclosing
// `parent` range it grows into next (the `textDocument/selectionRange` result, one chain per
// requested position, innermost first).
export interface SelectionRange {
  range: Range;
  parent?: SelectionRange;
}

// Standard LSP CodeLens: an annotation pinned to `range` (a declaration's identifier span) whose
// `command.title` is the reference-count label (`"N references"`, references-from-elsewhere). The
// server fills the title eagerly, so `command` is present on the `textDocument/codeLens` result and
// `codeLens/resolve` is a pass-through.
export interface CodeLens {
  range: Range;
  command?: { title: string; command: string };
}

// Standard LSP TextEdit: replace `range` with `newText`.
export interface TextEdit {
  range: Range;
  newText: string;
}

// `koine/check` change record (mirrors the server contract).
export interface CheckChange {
  impact: 'Breaking' | 'NonBreaking';
  code: string;
  message: string;
}

// `koine/check` result. `error` is set when the baseline could not be read/compiled;
// otherwise `hasBreakingChanges` + `changes` describe the diff.
export interface CheckResult {
  error?: string;
  hasBreakingChanges: boolean;
  changes: CheckChange[];
}

// Standard LSP WorkspaceEdit: text edits grouped by the file:// uri they apply to.
export interface WorkspaceEdit {
  changes: Record<string, TextEdit[]>;
}

// Standard LSP CodeAction: a titled quickfix/refactor carrying an inline WorkspaceEdit.
export interface CodeAction {
  title: string;
  kind: string;
  edit?: WorkspaceEdit;
  diagnostics?: LspDiagnostic[];
}

// Standard LSP prepareRename answer: the editable identifier range + the current name to pre-fill.
export interface PrepareRenameResult {
  range: Range;
  placeholder?: string;
}

// `koine/docs` result: one living-documentation file (Mermaid-in-Markdown) per emitted page.
export interface DocsFile {
  path: string;
  contents: string;
}
export interface DocsResult {
  files: DocsFile[];
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

const REQUEST_TIMEOUT_MS = 15000;

/** The default scratch-mode document uri. Used until a folder is opened. */
export const SCRATCH_URI = 'file:///model.koi';

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
  private activeUri = SCRATCH_URI;

  constructor(private readonly transport: LspTransport) {}

  /** The uri every request method currently targets. */
  get active(): string {
    return this.activeUri;
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

  private handle(msg: JsonRpcMessage): void {
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
   * carries the editor's current full text). The debounce is shared and re-armed per call, so it
   * always flushes the most recent edit to whichever uri was last changed.
   */
  changeDoc(uri: string, text: string): void {
    const doc = this.docs.get(uri);
    if (!doc) return; // not opened yet — drop
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

  emitPreview(target: 'csharp' | 'typescript' | 'python' | 'php'): Promise<EmitPreviewResult> {
    return this.request<EmitPreviewResult>('koine/emitPreview', {
      textDocument: { uri: this.activeUri },
      target,
    });
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
