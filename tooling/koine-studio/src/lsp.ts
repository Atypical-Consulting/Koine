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

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

const REQUEST_TIMEOUT_MS = 15000;

export class KoineLsp {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout> }>();
  private unlistenMsg?: UnlistenFn;
  private unlistenExit?: UnlistenFn;
  private version = 0;
  private opened = false;
  private changeTimer?: ReturnType<typeof setTimeout>;
  private onDiagnostics?: (uri: string, diags: LspDiagnostic[]) => void;
  private onExit?: (code: number) => void;
  private readonly uri = 'file:///model.koi';

  onPublishDiagnostics(cb: (uri: string, diags: LspDiagnostic[]) => void): void {
    this.onDiagnostics = cb;
  }

  onServerExit(cb: (code: number) => void): void {
    this.onExit = cb;
  }

  /** Attach event listeners FIRST, then spawn the child, then initialize. */
  async start(): Promise<void> {
    this.unlistenMsg = await listen<string>('lsp://message', (e) => {
      this.handle(JSON.parse(e.payload) as JsonRpcMessage);
    });
    this.unlistenExit = await listen<number>('lsp://exit', (e) => {
      this.onExit?.(typeof e.payload === 'number' ? e.payload : -1);
    });

    await invoke('lsp_start');

    await this.request('initialize', {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    this.notify('initialized', {});
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

  didOpen(text: string): void {
    this.notify('textDocument/didOpen', {
      textDocument: { uri: this.uri, languageId: 'koine', version: ++this.version, text },
    });
    this.opened = true;
  }

  /**
   * Full-text sync, debounced ~250ms. Dropped until the document has been opened so a
   * didChange can never precede didOpen (edits made during the connect window are safe:
   * didOpen carries the editor's current full text). Also no-ops once disposed.
   */
  didChange(text: string): void {
    if (!this.opened) return;
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.notify('textDocument/didChange', {
        textDocument: { uri: this.uri, version: ++this.version },
        contentChanges: [{ text }],
      });
    }, 250);
  }

  emitPreview(target: 'csharp' | 'typescript'): Promise<EmitPreviewResult> {
    return this.request<EmitPreviewResult>('koine/emitPreview', {
      textDocument: { uri: this.uri },
      target,
    });
  }

  dispose(): void {
    this.opened = false;
    clearTimeout(this.changeTimer);
    this.unlistenMsg?.();
    this.unlistenExit?.();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('LSP client disposed'));
    }
    this.pending.clear();
  }
}
