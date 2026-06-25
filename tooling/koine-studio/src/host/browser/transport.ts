// An in-process, WASM-backed language server that speaks the same JSON-RPC the studio's LSP
// client (lsp.ts) expects — the browser counterpart of the stdio `koine lsp` child. It keeps the
// open-document set, dispatches each request to the Koine.Wasm compiler module, and emits
// responses + per-file `textDocument/publishDiagnostics` notifications back through onMessage.
// Mirrors the request handlers in src/Koine.Cli/LspServer.cs for the nine methods Studio uses.
import type { LspTransport } from '@/host/types';
import { loadWasmApi, type KoineWasmApi } from '@/host/browser/wasm';

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
  private async diagnostics(api: KoineWasmApi): Promise<object[]> {
    const buckets = JSON.parse(await api.DiagnoseWorkspace(this.filesJson())) as {
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
        return await this.diagnostics(api);

      case 'textDocument/didChange': {
        const changes = msg.params?.contentChanges;
        if (uri != null && Array.isArray(changes) && changes.length > 0) {
          this.docs.set(uri, changes[changes.length - 1].text ?? '');
        }
        return await this.diagnostics(api);
      }

      case 'textDocument/didSave':
        if (uri != null && typeof msg.params?.text === 'string') this.docs.set(uri, msg.params.text);
        return await this.diagnostics(api);

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
        return [result(JSON.parse(await api.Hover(this.filesJson(), uri ?? '', pos?.line ?? 0, pos?.character ?? 0)))];

      case 'textDocument/completion':
        return [result(JSON.parse(await api.Completions(this.filesJson(), uri ?? '', pos?.line ?? 0, pos?.character ?? 0)))];

      case 'textDocument/definition':
        return [result(JSON.parse(await api.Definition(this.filesJson(), uri ?? '', pos?.line ?? 0, pos?.character ?? 0)))];

      case 'textDocument/signatureHelp':
        return [result(JSON.parse(await api.SignatureHelp(this.filesJson(), uri ?? '', pos?.line ?? 0, pos?.character ?? 0)))];

      case 'workspace/symbol':
        return [result(JSON.parse(await api.WorkspaceSymbols(this.filesJson(), msg.params?.query ?? '')))];

      case 'textDocument/documentSymbol':
        return [result(JSON.parse(await api.DocumentSymbols(this.docs.get(uri ?? '') ?? '')))];

      case 'textDocument/foldingRange':
        return [result(JSON.parse(await api.FoldingRanges(this.docs.get(uri ?? '') ?? '')))];

      case 'textDocument/selectionRange': {
        const positions = JSON.stringify(msg.params?.positions ?? []);
        return [result(JSON.parse(await api.SelectionRanges(this.docs.get(uri ?? '') ?? '', positions)))];
      }

      case 'textDocument/codeLens': {
        // The WASM export returns `{range, title}`; reshape to the LSP CodeLens `{range, command}`
        // so the browser host matches the stdio LSP contract the studio client consumes.
        const lenses = JSON.parse(await api.CodeLenses(this.filesJson(), uri ?? '')) as Array<{
          range: unknown;
          title: string | null;
        }>;
        return [
          result(
            lenses.map((l) => ({
              range: l.range,
              command: l.title == null ? undefined : { title: l.title, command: '' },
            })),
          ),
        ];
      }

      case 'codeLens/resolve':
        // Titles are computed eagerly on textDocument/codeLens, so resolve is a pass-through.
        return [result(msg.params ?? null)];

      case 'textDocument/formatting':
        return [result(JSON.parse(await api.Format(this.docs.get(uri ?? '') ?? '')))];

      case 'koine/emitPreview':
        return [result(JSON.parse(await api.EmitPreview(this.filesJson(), msg.params?.target ?? 'csharp')))];

      case 'koine/emitTargets':
        return [result(JSON.parse(await api.ListEmitTargets()))];

      case 'koine/glossary':
        return [result(JSON.parse(await api.Glossary(this.filesJson())))];

      case 'koine/contextMap':
        return [result(JSON.parse(await api.ContextMap(this.filesJson())))];

      case 'koine/glossaryModel':
        return [result(JSON.parse(await api.GlossaryModel(this.filesJson())))];

      case 'koine/model':
        return [result(JSON.parse(await api.Model(this.filesJson(), msg.params?.qualifiedName ?? null)))];

      case 'koine/modelMembers':
        return [result(JSON.parse(await api.ModelMembers(this.filesJson(), msg.params?.qualifiedName ?? '')))];

      case 'koine/emitKoine':
        return [result(JSON.parse(await api.EmitKoine(this.filesJson(), JSON.stringify(msg.params?.edit ?? {}))))];

      case 'koine/applyModelEdit':
        return [result(JSON.parse(await api.ApplyModelEdit(this.filesJson(), JSON.stringify(msg.params?.edit ?? {}))))];

      case 'koine/setDoc':
        return [result(JSON.parse(await api.SetDoc(this.filesJson(), msg.params?.id ?? '', msg.params?.text ?? '')))];

      case 'koine/docs':
        return [result(JSON.parse(await api.Docs(this.filesJson())))];

      case 'koine/runScenario':
        return [
          result(
            JSON.parse(
              await api.RunScenario(
                this.filesJson(),
                msg.params?.target ?? '',
                msg.params?.operation ?? '',
                JSON.stringify(msg.params?.given ?? {}),
                JSON.stringify(msg.params?.args ?? {}),
              ),
            ),
          ),
        ];

      case 'koine/scenarioCatalog':
        return [result(JSON.parse(await api.ScenarioCatalog(this.filesJson())))];

      case 'textDocument/references':
        return [result(JSON.parse(await api.References(this.filesJson(), uri ?? '', pos?.line ?? 0, pos?.character ?? 0)))];

      case 'textDocument/prepareRename':
        return [result(JSON.parse(await api.PrepareRename(this.filesJson(), uri ?? '', pos?.line ?? 0, pos?.character ?? 0)))];

      case 'textDocument/rename':
        return [
          result(
            JSON.parse(await api.Rename(this.filesJson(), uri ?? '', pos?.line ?? 0, pos?.character ?? 0, msg.params?.newName ?? '')),
          ),
        ];

      case 'textDocument/codeAction': {
        const range = msg.params?.range;
        const diagnosticsJson = JSON.stringify(msg.params?.context?.diagnostics ?? []);
        return [
          result(
            JSON.parse(
              await api.CodeActions(
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

      case 'textDocument/inlayHint': {
        const range = msg.params?.range;
        return [
          result(
            JSON.parse(
              await api.InlayHints(
                this.filesJson(),
                uri ?? '',
                range?.start?.line ?? 0,
                range?.start?.character ?? 0,
                range?.end?.line ?? 0,
                range?.end?.character ?? 0,
              ),
            ),
          ),
        ];
      }

      case 'textDocument/prepareCallHierarchy':
        return [result(JSON.parse(await api.PrepareCallHierarchy(this.filesJson(), uri ?? '', pos?.line ?? 0, pos?.character ?? 0)))];

      case 'callHierarchy/incomingCalls':
        return [result(JSON.parse(await api.IncomingCalls(this.filesJson(), JSON.stringify(msg.params?.item ?? {}))))];

      case 'callHierarchy/outgoingCalls':
        return [result(JSON.parse(await api.OutgoingCalls(this.filesJson(), JSON.stringify(msg.params?.item ?? {}))))];

      case 'koine/check': {
        const baseline = JSON.stringify(msg.params?.baselineSources ?? []);
        return [result(JSON.parse(await api.Check(this.filesJson(), baseline)))];
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
