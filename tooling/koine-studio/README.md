# Koine Studio

A minimal desktop IDE for `.koi` files, built on Tauri v2 + CodeMirror 6. It gives you a
live editor with push-based diagnostics and an emitted-code (C# / TypeScript / Python / PHP / Rust) preview pane,
all driven by the existing Koine language server (`koine lsp`) spawned as a child process and
brokered over stdio by the Rust host. **`Mod`+`Shift`+`F`** opens a workspace-wide search &
replace panel (case / whole-word / regex / include-glob) across every `.koi` file in the open
folder, unsaved buffers included.

## Web Worker runtime (browser host)

The WASM compiler (`src/Koine.Wasm`) runs inside a **dedicated Web Worker** (`src/host/browser/koine.worker.ts`)
in both browser hosts — Koine Studio and the docs-site playground. A main-thread id-correlated
client (`workerClient.ts`) routes calls to the worker over `postMessage` and resolves each
response as a `Promise`. Cancellation is supported in two modes, both now **wired into the editors**
([#353](https://github.com/Atypical-Consulting/Koine/issues/353)):

- **Supersede** — a stale in-flight call is dropped when a newer one arrives (debounced diagnostics).
  Studio's `transport.ts` aborts the prior `DiagnoseWorkspace` on every keystroke; the playground's
  `controller.ts` does the same per-edit for `compile`/`diagnose`. A superseded call's late reply never
  overwrites newer state.
- **Terminate-and-respawn** — a runaway compile is abandoned by terminating the worker and booting a
  fresh one. Exposed as the **"Stop compilation"** command palette entry in Studio (offered only while a
  compile is actually in flight — `canStopCompile()` = a worker exists **and** `isCompileInFlight()`,
  see `stopCompile.ts` / `compileActivity.ts` — matching the playground's busy-only **Stop** button) and
  a **Stop** button in the playground toolbar. Awaiting `whenReady()` across a respawn now rejects rather
  than hangs (the outgoing generation's ready-promise is settled on respawn).

The same `compileActivity.ts` in-flight signal also drives a transient **"compiling…"** indicator in the
Studio **status bar** (#516): the `CompilingIndicator` panel subscribes to a small `onCompileActivityChange`
notify seam on that module and reveals an `aria-live="polite"` "compiling…" affordance while a compile is
running — debounced (~150 ms) so a fast keystroke-diagnose doesn't flash it, hidden immediately when the
compiler settles. This matches the docs-site playground's toolbar busy state, so a slow diagnose/emit no
longer reads as an idle editor.

`WasmEnableThreads` stays **`false`** in `src/Koine.Wasm/Koine.Wasm.csproj`. The worker uses
plain structured-clone `postMessage`, so **no `SharedArrayBuffer` and no COOP/COEP
cross-origin-isolation headers are required**.

**Boot ordering (issue #357 — do not regress).** The worker must wire its RPC loop with
`self.addEventListener('message', …)` **after** `dotnet.create()` resolves — never as a top-level
`self.onmessage = …`. Assigning `self.onmessage` at worker startup clobbers the `message` channel the
.NET WebAssembly runtime needs while it boots inside the Worker, which deadlocks the boot
(`import(dotnet.js)` resolves but `create()` never settles), bricking the studio with "connection
failed". Two safety nets back this up: a per-boot **watchdog** (`bootWatchdog.ts`) turns a silent hang
into an explicit `boot-failure`, and `loadWasmApi()` **falls back to a main-thread boot** (the
pre-worker path) if the worker boot fails — so a worker-boot regression degrades the UI, it doesn't
kill it. `getWasmBootMode()` reports which path won. The `npm run test:browser` smoke-test
(`scripts/smoke-boot.mjs`) boots the built studio in headless Chromium and gates the deploy on the
worker actually reaching `ready` and a compiler call round-tripping.

## Host abstraction (the `Platform` port)

Studio supports two host environments — the native Tauri desktop shell and the pure-WASM browser
build — behind a single **`Platform` port** defined in `src/host/types.ts`. The two adapters are
`TauriPlatform` (`src/host/tauri.ts`) and `BrowserPlatform` (`src/host/browser/`); `getPlatform()`
(`src/host/index.ts`) selects one at startup based on the runtime environment. The import boundary
is deliberately hard: **no `@tauri-apps` or WASM imports exist outside `src/host/`** — the rest of
the UI speaks only to the port, so a third host (e.g. the mobile-WASM build,
[#219](https://github.com/Atypical-Consulting/Koine/issues/219)/[#220](https://github.com/Atypical-Consulting/Koine/issues/220))
is a new adapter, not a rewrite of every call-site.

**Capability-over-identity rule** ([#749](https://github.com/Atypical-Consulting/Koine/issues/749)).
The UI asks *what the host can do*, never *who the host is*. All branching goes through `readonly`
capability flags — `canHostMcp`, `compatNeedsInProcessSources`, `usesServiceWorker`, alongside the
pre-existing `canUseGit`, `canSaveProjects`, and so on — and never through `platform.kind` or
`isTauri()`. The `kind` field remains on the port but is reserved for diagnostics and telemetry
only. This rule is enforced automatically by `src/host/seamGuard.test.ts`, a vitest guard that
fails CI if any platform-identity branch — an `isTauri()` call, an `=== 'tauri'`/`=== 'browser'`
comparison (either quote style), or a `switch`/`case` on a host kind — appears outside `src/host/`.
Keeping the seam leak-free means adding a host or renaming a capability never forces a grep-and-fix
across the whole codebase.

Two **deliberate-duplication exceptions** exist where a forced unified port method would be the
wrong abstraction:

- `src/shared/platform.ts` (`isMac` / `MOD`) handles the ⌘-vs-Ctrl modifier label shown in
  keyboard hints. This is pure presentation — which modifier key the user's OS uses — not a host
  capability, so it lives outside `src/host/` by design.
- The **unsaved-work close guard** uses two adapter-local mechanisms (Tauri's `onCloseRequested`
  window-close hook vs the browser's `beforeunload` event) surfaced behind the thin
  `onCloseRequested?` optional capability rather than a forced unified `confirmClose()`. The
  mechanisms are different enough that collapsing them would hide meaningful platform divergence
  rather than abstract it.

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
- The list of **emit targets** the IDE offers (the output-language picker, the Generate-project
  wizard, the Generated-tab labels and the assistant's compile tool) is **derived from the backend**:
  at boot the client issues `koine/emitTargets`, which returns the compiler emitter registry's
  targets as `{ id, displayName, fileExtension }`, and the front-end renders every target surface
  from that one list (`src/shared/emitTargets.ts`). Adding an emitter target to the registry therefore
  surfaces it in Studio with no front-end change; the built-in list is the offline fallback if the
  query is unavailable, and syntax highlighting degrades to plain text for a target with no bundled
  CodeMirror mode.

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
- **Inline completions (ghost text).** With **Settings → Assistant → AI inline completions** on (off by
  default), Studio predicts the next line as you type and shows it as dimmed ghost text after the caret —
  **Tab** accepts, **Esc** (or more typing) dismisses. It reuses the same provider/key/model as the chat
  and aborts the in-flight request on every edit; it no-ops when no provider is configured and never
  merges with the deterministic LSP completion popup. The debounce/accept/abort state machine and the
  provider client are pure-logic (`src/editor/inlineCompletionState.ts`, `src/ai/inlineCompletionClient.ts`);
  the CodeMirror ghost-text extension is `src/editor/inlineCompletion.ts`. See
  [Local LLM in the Assistant → Inline completions](https://atypical-consulting.github.io/Koine/guides/assistant-local-llm/#inline-completions-ghost-text).

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
- `src/shell/workspaceSearch.ts` — pure find/replace core (`runSearch` / `applyReplace` /
  `planReplacements`); `src/shell/searchController.tsx` — the `Mod`+`Shift`+`F` search panel.
- `index.html` / `src/styles.css` — toolbar + split editor/output panes + diagnostics strip.

## Canvas layout & annotations (`koine.layout.json`)

The authoring canvas persists its layout per workspace in a committable **`koine.layout.json`** at the
models-folder root (or browser storage in web/scratch mode) — see `src/diagrams/layoutStore.ts`. It is a
**view concern only**: nothing here round-trips into `.koi` (the compiler stays the single source of truth
for the model). The file is a versioned, minimal-diff envelope (`version: 2`):

- `positions` — hand-dragged node positions, keyed by qualified name.
- `notes` — **canvas-only annotations**: free text + position/size. Add via the palette's **Note** button;
  double-click to edit, right-click to delete.
- `groups` — **canvas-only annotations**: a labelled region drawn *behind* a set of nodes (by qualified
  name). Add via the palette's **Group** button (groups the current selection, or all nodes if none is
  selected); the rectangle is derived from the members' bounding box, so a group follows them as they move.

Notes and Group are *not* `.koi` constructs (per the #148 go/no-go) — they never create a second source of
truth. "Auto-arrange" resets node positions only; annotations are preserved.

## Research notes

- [`docs/mobile-wasm-spike.md`](docs/mobile-wasm-spike.md) — measurement spike ([#219](https://github.com/Atypical-Consulting/Koine/issues/219)):
  can the in-browser WASM compiler run on a phone? Payload sizes, emulated D3/D4 baselines, a D1/D2
  real-device runbook, and a provisional verdict.
