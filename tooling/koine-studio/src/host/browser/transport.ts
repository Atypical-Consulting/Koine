// An in-process, WASM-backed language server that speaks the same JSON-RPC the studio's LSP
// client (lsp.ts) expects — the browser counterpart of the stdio `koine lsp` child. It keeps the
// open-document set, dispatches each request to the Koine.Wasm compiler module, and emits
// responses + per-file `textDocument/publishDiagnostics` notifications back through onMessage.
// Mirrors the request handlers in src/Koine.Cli/LspServer.cs for the nine methods Studio uses.
import type { LspTransport } from '../types';
import { loadWasmApi, type KoineWasmApi } from './wasm';

interface JsonRpc {
  id?: number | string | null;
  method?: string;
  params?: any;
}

export class WasmLspTransport implements LspTransport {
  private api: KoineWasmApi | null = null;
  private msgCb?: (json: string) => void;
  // Open documents (uri → full text), the in-memory workspace the compiler diagnoses/compiles.
  private docs = new Map<string, string>();

  onMessage(cb: (json: string) => void): void {
    this.msgCb = cb;
  }

  // The browser server never crashes or restarts, so these are inert.
  onExit(_cb: (code: number) => void): void {}
  onRestart(_cb: () => void): void {}

  async start(): Promise<void> {
    this.api = await loadWasmApi();
  }

  async stop(): Promise<void> {
    this.docs.clear();
  }

  async send(message: string): Promise<void> {
    let msg: JsonRpc;
    try {
      msg = JSON.parse(message) as JsonRpc;
    } catch {
      return;
    }
    const outgoing = await this.handle(msg);
    for (const out of outgoing) {
      this.msgCb?.(JSON.stringify(out));
    }
  }

  /** The current workspace as the WASM functions want it: `[{uri,text}]`. */
  private filesJson(): string {
    return JSON.stringify(Array.from(this.docs, ([uri, text]) => ({ uri, text })));
  }

  /** Run the merged-workspace diagnostics and turn them into publishDiagnostics notifications. */
  private diagnostics(api: KoineWasmApi): object[] {
    const buckets = JSON.parse(api.DiagnoseWorkspace(this.filesJson())) as {
      uri: string;
      diagnostics: unknown[];
    }[];
    return buckets.map((b) => ({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: b.uri, diagnostics: b.diagnostics },
    }));
  }

  private async handle(msg: JsonRpc): Promise<object[]> {
    const api = this.api ?? (this.api = await loadWasmApi());
    const id = msg.id;
    const result = (value: unknown) => ({ jsonrpc: '2.0', id, result: value });
    const td = msg.params?.textDocument;
    const uri: string | undefined = td?.uri;
    const pos = msg.params?.position;

    switch (msg.method) {
      case 'initialize':
        return [result({ capabilities: {}, serverInfo: { name: 'koine-wasm' } })];

      case 'initialized':
      case '$/setTrace':
      case '$/cancelRequest':
        return [];

      case 'textDocument/didOpen':
        if (uri != null) this.docs.set(uri, td.text ?? '');
        return this.diagnostics(api);

      case 'textDocument/didChange': {
        const changes = msg.params?.contentChanges;
        if (uri != null && Array.isArray(changes) && changes.length > 0) {
          this.docs.set(uri, changes[changes.length - 1].text ?? '');
        }
        return this.diagnostics(api);
      }

      case 'textDocument/didSave':
        if (uri != null && typeof msg.params?.text === 'string') this.docs.set(uri, msg.params.text);
        return this.diagnostics(api);

      case 'textDocument/didClose':
        if (uri != null) {
          this.docs.delete(uri);
          return [
            {
              jsonrpc: '2.0',
              method: 'textDocument/publishDiagnostics',
              params: { uri, diagnostics: [] },
            },
          ];
        }
        return [];

      case 'textDocument/hover':
        return [result(JSON.parse(api.Hover(this.filesJson(), uri ?? '', pos?.line ?? 0, pos?.character ?? 0)))];

      case 'textDocument/completion':
        return [result(JSON.parse(api.Completions(this.filesJson(), uri ?? '', pos?.line ?? 0, pos?.character ?? 0)))];

      case 'textDocument/definition':
        return [result(JSON.parse(api.Definition(this.filesJson(), uri ?? '', pos?.line ?? 0, pos?.character ?? 0)))];

      case 'textDocument/documentSymbol':
        return [result(JSON.parse(api.DocumentSymbols(this.docs.get(uri ?? '') ?? '')))];

      case 'textDocument/foldingRange':
        return [result(JSON.parse(api.FoldingRanges(this.docs.get(uri ?? '') ?? '')))];

      case 'textDocument/selectionRange': {
        const positions = JSON.stringify(msg.params?.positions ?? []);
        return [result(JSON.parse(api.SelectionRanges(this.docs.get(uri ?? '') ?? '', positions)))];
      }

      case 'textDocument/formatting':
        return [result(JSON.parse(api.Format(this.docs.get(uri ?? '') ?? '')))];

      case 'koine/emitPreview':
        return [result(JSON.parse(api.EmitPreview(this.filesJson(), msg.params?.target ?? 'csharp')))];

      case 'koine/glossary':
        return [result(JSON.parse(api.Glossary(this.filesJson())))];

      case 'koine/contextMap':
        return [result(JSON.parse(api.ContextMap(this.filesJson())))];

      case 'koine/glossaryModel':
        return [result(JSON.parse(api.GlossaryModel(this.filesJson())))];

      case 'koine/setDoc':
        return [result(JSON.parse(api.SetDoc(this.filesJson(), msg.params?.id ?? '', msg.params?.text ?? '')))];

      case 'koine/docs':
        return [result(JSON.parse(api.Docs(this.filesJson())))];

      case 'textDocument/references':
        return [result(JSON.parse(api.References(this.filesJson(), uri ?? '', pos?.line ?? 0, pos?.character ?? 0)))];

      case 'textDocument/prepareRename':
        return [result(JSON.parse(api.PrepareRename(this.filesJson(), uri ?? '', pos?.line ?? 0, pos?.character ?? 0)))];

      case 'textDocument/rename':
        return [
          result(
            JSON.parse(api.Rename(this.filesJson(), uri ?? '', pos?.line ?? 0, pos?.character ?? 0, msg.params?.newName ?? '')),
          ),
        ];

      case 'textDocument/codeAction': {
        const range = msg.params?.range;
        const diagnosticsJson = JSON.stringify(msg.params?.context?.diagnostics ?? []);
        return [
          result(
            JSON.parse(
              api.CodeActions(
                this.filesJson(),
                uri ?? '',
                range?.start?.line ?? 0,
                range?.start?.character ?? 0,
                range?.end?.line ?? 0,
                range?.end?.character ?? 0,
                diagnosticsJson,
              ),
            ),
          ),
        ];
      }

      case 'koine/check': {
        const baseline = JSON.stringify(msg.params?.baselineSources ?? []);
        return [result(JSON.parse(api.Check(this.filesJson(), baseline)))];
      }

      case 'shutdown':
        return [result(null)];

      case 'exit':
        return [];

      default:
        // Unknown request: reply method-not-found so the client doesn't hang. Notifications: ignore.
        return id != null
          ? [{ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + msg.method } }]
          : [];
    }
  }
}
