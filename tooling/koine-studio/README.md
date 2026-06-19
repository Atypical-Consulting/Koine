# Koine Studio

A minimal desktop IDE for `.koi` files, built on Tauri v2 + CodeMirror 6. It gives you a
live editor with push-based diagnostics and an emitted-code (C# / TypeScript) preview pane,
all driven by the existing Koine language server (`koine lsp`) spawned as a child process and
brokered over stdio by the Rust host.

## How it works

- The Rust host (`src-tauri/src/lib.rs`) spawns the Koine LSP lazily on the `lsp_start`
  command, owns its stdin behind a `Mutex`, and runs a reader thread that parses
  `Content-Length`-framed JSON-RPC off stdout. Each message body is re-emitted as the Tauri
  event `lsp://message`; child exit is signalled via `lsp://exit`.
- The frontend (`src/`) is a tiny LSP client over Tauri IPC (`src/lsp.ts`): it attaches the
  `lsp://message` listener **before** invoking `lsp_start` (no startup race), then runs the
  standard `initialize` → `initialized` → `didOpen` / `didChange` handshake, routes
  `textDocument/publishDiagnostics` into CodeMirror's lint state, and issues the custom
  `koine/emitPreview` request for the preview pane.

### Commands & events (the Rust ↔ JS contract)

| Direction | Name | Payload |
| --- | --- | --- |
| JS → Rust command | `lsp_start` | — (spawns the child lazily, idempotent) |
| JS → Rust command | `lsp_send` | `{ message: string }` (a JSON-RPC frame body) |
| Rust → JS event | `lsp://message` | `string` — one JSON-RPC message body |
| Rust → JS event | `lsp://exit` | `i32` — `0` clean, `-1` error |
| JS → Rust command | `mcp_endpoint` | — → `string \| null` (lazily starts the `koine mcp --http` sidecar; resolves the loopback URL it announces) |
| JS → Rust command | `mcp_stop` | — (stops the MCP sidecar; idempotent) |

The **MCP HTTP sidecar** is independent of the LSP one: `mcp_endpoint` spawns `koine mcp --http
--port 0`, scrapes the `[koine-mcp] http://127.0.0.1:PORT/mcp` line off its stderr, and hands the
URL to **Settings → Assistant** so the user can copy a ready-to-paste `mcp.json` for LM Studio.

## Run

Pick one of the two ways to provide the language server.

**Option A — self-contained sidecar (no .NET SDK needed):**

```bash
cd tooling/koine-studio
KOINE_LSP=/tmp/koine-sidecar/Koine.Cli npm run tauri dev
```

**Option B — Debug DLL via `dotnet` (default resolution):**

```bash
# build the CLI first so the Debug DLL exists
dotnet build /Users/philippe/repo/gh-phmatray/Koine/.claude/worktrees/thirsty-euler-b0ca0b/src/Koine.Cli

cd tooling/koine-studio
npm run tauri dev
```

When `KOINE_LSP` is unset, the host falls back to
`dotnet <repo>/src/Koine.Cli/bin/Debug/net10.0/Koine.Cli.dll lsp` (resolved relative to the
crate at compile time). Both branches set `DOTNET_NOLOGO=1` / `DOTNET_CLI_TELEMETRY_OPTOUT=1`
to keep stdout pure JSON-RPC.

The **MCP HTTP sidecar** resolves the same way: `KOINE_MCP` (falling back to `KOINE_LSP`, since it is
the same `koine` binary) runs `<bin> mcp --http --port 0`; otherwise it falls back to the Debug DLL
via `dotnet`.

## Develop / verify

```bash
# Rust broker: compiles + framing unit tests
cd tooling/koine-studio/src-tauri && cargo build && cargo test

# Frontend: typecheck + bundle
cd tooling/koine-studio && npm install && npm run build
```

## Layout

- `src-tauri/src/lib.rs` — LSP-sidecar broker (`lsp_start` / `lsp_send`, framing + tests) and the
  MCP HTTP-sidecar broker (`mcp_endpoint` / `mcp_stop`, endpoint-scrape + tests).
- `src/lsp.ts` — Tauri-IPC LSP client (JSON-RPC, debounced `didChange`, `emitPreview`).
- `src/editor.ts` — CodeMirror `.koi` editor + read-only output viewer; push-based diagnostics.
- `src/ide.ts` — app composition (editor, status line, diagnostics strip, preview buttons).
- `index.html` / `src/styles.css` — toolbar + split editor/output panes + diagnostics strip.
