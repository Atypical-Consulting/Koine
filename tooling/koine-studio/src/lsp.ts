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

// `koine/model*` (round-trip seam, #91): the structured model graph an editor drives forms/canvases
// from. The contract is additive-only — new fields are appended, existing ones never repurposed.
// A `ModelNode` is one declaration (the `model` root, a `context`, an aggregate/entity/value/enum/
// event, a state machine, or the context map); a `ModelMember` is one editable leaf (a field, enum
// member, transition, or relation).
export interface ModelMember {
  kind: string;
  name: string;
  type: string | null;
  value: string | null;
}
export interface ModelNode {
  kind: string;
  qualifiedName: string;
  title: string;
  members: ModelMember[];
  children: ModelNode[];
}
export interface ModelMembersResult {
  members: ModelMember[];
}

// A scoped structural edit against the model. `kind` is one of: 'renameMember' | 'addField' |
// 'removeMember' | 'changeFieldType' | 'addTransition'. `target` is the qualified name the edit
// applies to; `name`/`type` carry the new name / field type / transition states per kind.
export interface StructuredEdit {
  kind: string;
  target: string;
  name?: string | null;
  type?: string | null;
  value?: string | null;
}

// A round-trip diagnostic: the rejecting KOIxxxx with its range and owning file.
export interface ModelDiagnostic {
  code: string;
  message: string;
  range: Range;
  uri: string | null;
}

// `koine/emitKoine` result: the canonical `.koi` for the affected declaration (null when the edit
// is illegal), plus any rejecting diagnostics.
export interface EmitKoineResult {
  koine: string | null;
  diagnostics: ModelDiagnostic[];
}

// `koine/applyModelEdit` result: a span-minimal patch over just the touched declaration.
export interface ModelEditResult {
  uri: string | null;
  edits: TextEdit[];
  diagnostics: ModelDiagnostic[];
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
  diagrams: Diagram[]; // the structured graphs riding alongside this file's Mermaid (issue #93); [] if none
}
export interface DocsResult {
  files: DocsFile[];
}

// --- structured diagram graphs (issue #93) -----------------------------------
// Each Mermaid diagram in a DocsFile is accompanied by a source-aware Diagram: a graph of nodes
// (which carry a qualifiedName + raw 1-based sourceSpan for jump-to-source) and the edges between
// them. Field names mirror the C# DTOs (LSP dict keys + WASM W* records) verbatim.

/** A raw, 1-based source span (NOT a 0-based LSP range). End line/column are end-exclusive. */
export interface SourceSpan {
  file: string | null; // the source .koi uri the node was declared in
  line: number; // 1-based start line
  column: number; // 1-based start column
  endLine: number; // 1-based, end-exclusive
  endColumn: number; // 1-based, end-exclusive
  offset: number; // 0-based absolute character offset of the first character
  length: number; // character length
}

/** One UML class-body row: a pre-formatted text and which compartment it belongs to. */
export interface DiagramMember {
  text: string; // pre-formatted row, e.g. 'id: OrderId', 'submit()', or an enum value 'Draft'
  kind: string; // compartment: 'field' (attributes incl. id/version) | 'method' | 'value' (enum members)
}

/** One graph node: an aggregate, value object, state, context, integration event, … */
export interface DiagramNode {
  id: string; // stable identifier, unique within the owning graph
  label: string; // display text shown on the diagram
  kind: string; // styling category, e.g. 'aggregate-root' | 'value-object' | 'state' | 'context' | …
  qualifiedName: string; // dotted stable name, e.g. 'Ordering.Order'
  sourceSpan: SourceSpan | null; // null only when the node truly has no position
  stereotype: string | null; // UML stereotype w/o guillemets (class nodes only), e.g. 'aggregate root'
  members: DiagramMember[]; // UML class-body rows (class nodes only); [] for simple boxes
}

/** A directed edge between two node ids in the same graph. */
export interface DiagramEdge {
  from: string; // source node id
  to: string; // target node id
  label: string | null; // optional edge label (transition guard, relation kind, publish/subscribe verb)
  cardinality?: string | null; // composition target-end multiplicity, derived from the Koine field type ("1" | "0..1" | "*")
}

/** The structured graph behind one diagram. */
export interface DiagramGraph {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

/** One diagram: the rendered Mermaid plus the structured graph that drives an interactive renderer. */
export interface Diagram {
  caption: string; // the heading the diagram appears under
  kind: string; // diagram family: 'statemachine' | 'aggregate' | 'contextmap' | 'integration-events'
  mermaid: string; // the exact Mermaid snippet embedded in the file's Markdown
  graph: DiagramGraph;
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
