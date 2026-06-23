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
- The frontend (`src/`) is a tiny LSP client over Tauri IPC (`src/lsp/lsp.ts`): it attaches the
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
URL to the **Settings → MCP** panel.

That panel (`src/settings/prefs.ts`, data-driven off `src/mcp/mcp.ts`) is where the user wires an LLM to Koine:

- **Enable MCP server** — a persisted, opt-in toggle (`mcpEnabled`). Enabling calls `mcp_endpoint`
  (start + reveal the URL); disabling calls `mcp_stop`. Nothing runs until the user opts in.
- **Client recipes** — a picker (Claude Desktop · LM Studio · Cursor · VS Code · Generic) renders the
  exact copy-paste config per client: the stdio `{ "command": "koine-mcp" }` form for spawn-style
  clients, the `{ "url": … }` block for URL clients, each with a config-file hint.
- **Test connection** — Studio acts as a minimal Streamable-HTTP MCP client (`probeMcp` in `mcp.ts`:
  `initialize` → `tools/list`) and reports `Connected ✓ — 5 tools` / `Not reachable`, confirming the
  endpoint an LLM will hit is live.

The web build can't host a server, so it passes `mcpHostable: false`: the toggle is disabled and the
endpoint/test rows hide, but the recipes still render (pointing at the `koine mcp --http` CLI).

## AI assistant

The **Assistant** inspector tab (`src/ai/aiPanel.ts`, client in `src/ai/ai.ts`) is a domain copilot: it
streams replies from the configured provider — **Anthropic** (Claude, the default) or any
**OpenAI-compatible** endpoint (OpenAI / Ollama / LM Studio / Groq / …, selected by base URL) — each
with the user's *own* key, or no key for a local server. Both SDKs are dynamically imported, so they
stay out of the main bundle until the assistant is used. Everything below works identically in both
hosts (browser/WASM and the Tauri desktop build).

- **Compiler tool-use on both providers.** When enabled (Settings → Assistant → *agentic tools*), the
  model can call the koine tools — `koine_validate` / `koine_compile` / `koine_format` — inside a
  bounded agentic loop, so it drafts a model, validates it, and fixes it before answering. The tool
  definitions are provider-neutral (`src/ai/assistantTools.ts`) and adapted to each API; the tools run
  in-process (in-WASM in the browser, via the `koine mcp --http` sidecar on desktop). Tool-use is now
  available on the **default Anthropic** path too, not just the OpenAI-compatible one. (It is opt-in
  because many local servers buffer the whole reply instead of streaming when tools are advertised.)
- **Domain-grounded answers.** The system prompt carries a compact **domain index** built from the
  compiled model (bounded contexts, aggregates → roots, context-map relations, and glossary
  documentation coverage), so reviews and questions see the *real* structure of the workspace, not
  just the current file. Built best-effort from the LSP; absent for an empty model.
- **Persisted conversations, per workspace.** Each opened folder keeps its own transcript
  (`koine.studio.chat.<folder>`; the no-folder/default workspace falls back to the `scratch` key), so a
  reload restores the conversation and switching folders swaps to that folder's history. A **Clear
  conversation** button forgets it.
- **Explain this construct.** A quick action (and the *Explain this construct* command-palette entry)
  asks for a plain-language explanation of the current selection — or the whole model when nothing is
  selected — aimed at a domain expert who doesn't code. It is explanatory, not generative: the reply
  deliberately omits the *Apply to editor* affordance.

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
- `src/lsp/lsp.ts` — Tauri-IPC LSP client (JSON-RPC, debounced `didChange`, `emitPreview`).
- `src/editor/editor.ts` — CodeMirror `.koi` editor + read-only output viewer; push-based diagnostics.
- `src/shell/ide.tsx` — app composition (editor, status line, diagnostics strip, preview buttons).
- `index.html` / `src/styles.css` — toolbar + split editor/output panes + diagnostics strip.

## Research notes

- [`docs/mobile-wasm-spike.md`](docs/mobile-wasm-spike.md) — measurement spike ([#219](https://github.com/Atypical-Consulting/Koine/issues/219)):
  can the in-browser WASM compiler run on a phone? Payload sizes, emulated D3/D4 baselines, a D1/D2
  real-device runbook, and a provisional verdict.
