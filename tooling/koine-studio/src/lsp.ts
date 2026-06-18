// A tiny LSP client over Tauri IPC. Brokers JSON-RPC to the `koine lsp` child process
// via the Rust commands `lsp_start` / `lsp_send` and the events `lsp://message` /
// `lsp://exit`. Hand-rolled JSON-RPC with an id->resolver map.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

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

// Standard LSP Location: a uri + a range within it. `definition` may resolve to one,
// an array, or null.
export interface Location {
  uri: string;
  range: Range;
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
  private unlistenMsg?: UnlistenFn;
  private unlistenExit?: UnlistenFn;
  private unlistenRestart?: UnlistenFn;
  // Per-uri open buffers (text + monotonic version). The active uri is the one all
  // request methods target; didChange is debounced per active uri.
  private docs = new Map<string, OpenDoc>();
  private changeTimer?: ReturnType<typeof setTimeout>;
  private onDiagnostics?: (uri: string, diags: LspDiagnostic[]) => void;
  private onExit?: (code: number) => void;
  private onRestart?: () => void;
  private activeUri = SCRATCH_URI;

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

  /** Attach event listeners FIRST, then spawn the child, then initialize. */
  async start(): Promise<void> {
    this.unlistenMsg = await listen<string>('lsp://message', (e) => {
      this.handle(JSON.parse(e.payload) as JsonRpcMessage);
    });
    this.unlistenExit = await listen<number>('lsp://exit', (e) => {
      this.onExit?.(typeof e.payload === 'number' ? e.payload : -1);
    });
    // Stream B may respawn the sidecar and emit `lsp://restart`. When it does, the fresh
    // child knows nothing about our document, so re-handshake and re-open from the latest text.
    this.unlistenRestart = await listen('lsp://restart', () => {
      void this.reinitialize();
    });

    await invoke('lsp_start');
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
    clearTimeout(this.changeTimer);
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
    return invoke('lsp_send', { message: JSON.stringify(obj) });
  }

  private request<T>(method: string, params: unknown): Promise<T> {
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
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.notify('textDocument/didChange', {
        textDocument: { uri, version: ++doc.version },
        contentChanges: [{ text }],
      });
    }, 250);
  }

  /** Close and stop tracking a document. Sends textDocument/didClose. */
  closeDoc(uri: string): void {
    if (!this.docs.delete(uri)) return;
    this.notify('textDocument/didClose', {
      textDocument: { uri },
    });
  }

  /** Switch which uri all request methods target. Does NOT send any notification. */
  setActive(uri: string): void {
    this.activeUri = uri;
  }

  emitPreview(target: 'csharp' | 'typescript'): Promise<EmitPreviewResult> {
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

  /** Standard LSP hover at a 0-based position. Resolves to null when there is nothing to show. */
  hover(line: number, character: number): Promise<HoverResult | null> {
    return this.request<HoverResult | null>('textDocument/hover', {
      textDocument: { uri: this.activeUri },
      position: { line, character },
    });
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

  /** Model-versioning compatibility of the active buffer against a baseline model folder. */
  check(baseline: string): Promise<CheckResult> {
    return this.request<CheckResult>('koine/check', {
      textDocument: { uri: this.activeUri },
      baseline,
    });
  }

  dispose(): void {
    clearTimeout(this.changeTimer);
    this.unlistenMsg?.();
    this.unlistenExit?.();
    this.unlistenRestart?.();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('LSP client disposed'));
    }
    this.pending.clear();
  }
}
