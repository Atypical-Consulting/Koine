import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import { registerKoineFeatures } from "./features";

let client: LanguageClient | undefined;
let clientReady: Promise<void> | undefined;

/**
 * Resolves the started LanguageClient once its `start()` handshake (initialize)
 * has completed — that is exactly when the server's experimental capabilities
 * (koineEmitPreview, koineGlossary, koineContextMap, koineCheck) are known, so
 * awaiting it is sufficient before any custom `sendRequest`. Returns undefined
 * when the client is absent or failed to start, so callers can warn gracefully.
 */
async function getReadyClient(): Promise<LanguageClient | undefined> {
  if (!client) {
    return undefined;
  }
  try {
    await clientReady;
  } catch {
    return undefined;
  }
  return client;
}

/**
 * Activated on the first `.koi` document (see `activationEvents`). Spawns the
 * Koine language server (`koine lsp`) and wires it up as an LSP client so the
 * editor shows the same diagnostics, completion, hover, and go-to-definition
 * that `koine build` and the CLI's `lsp` command provide.
 */
export function activate(context: vscode.ExtensionContext): void {
  const serverOptions: ServerOptions = makeServerOptions();

  const clientOptions: LanguageClientOptions = {
    // Match the language id contributed by this extension's grammar.
    documentSelector: [{ scheme: "file", language: "koine" }],
    synchronize: {
      // The server re-indexes on restart; notify it of on-disk `.koi` changes too.
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.koi"),
    },
  };

  client = new LanguageClient(
    "koine",
    "Koine Language Server",
    serverOptions,
    clientOptions
  );

  // Starts the server and the client; surfaces a friendly error if the
  // executable can't be found (the most common misconfiguration). The promise
  // is stored so the custom commands can await initialize before sendRequest.
  clientReady = client.start();
  clientReady.catch((err) => {
    void vscode.window.showErrorMessage(
      `Koine: failed to start the language server. Check the "koine.server.path" setting. (${err})`
    );
  });

  // Add UI for the custom koine/* LSP requests (emit preview, glossary,
  // context map, compatibility check). Standard LSP features are unchanged.
  registerKoineFeatures(context, getReadyClient);
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}

/**
 * Builds the command/args that launch `koine lsp` from the user's settings.
 *
 * - `koine.server.path` empty  -> `koine lsp` (executable on PATH)
 * - `koine.server.path` set    -> `<path> [koine.server.args...] lsp`
 *
 * The classic `dotnet`-from-source setup is therefore:
 *   "koine.server.path": "dotnet"
 *   "koine.server.args": ["run", "--project", "src/Koine.Cli", "--"]
 *
 * DOTNET_NOLOGO / DOTNET_CLI_TELEMETRY_OPTOUT are forced on so the .NET host's
 * first-run banner can't corrupt the stdio JSON-RPC stream.
 */
function makeServerOptions(): ServerOptions {
  const config = vscode.workspace.getConfiguration("koine");
  const configuredPath = (config.get<string>("server.path") ?? "").trim();
  const extraArgs = config.get<string[]>("server.args") ?? [];

  const command = configuredPath.length > 0 ? configuredPath : "koine";
  const args = [...extraArgs, "lsp"];

  const env = {
    ...process.env,
    DOTNET_NOLOGO: "1",
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
  };

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  return {
    run: { command, args, transport: TransportKind.stdio, options: { env, cwd } },
    debug: { command, args, transport: TransportKind.stdio, options: { env, cwd } },
  };
}
