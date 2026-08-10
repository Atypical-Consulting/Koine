---
id: 0022
title: Studio hosts coding agents over ACP on desktop, and drops the assistant on web
status: proposed
date: 2026-08-10
tags: [studio, ai, tauri, mcp, protocol]
---

# Studio hosts coding agents over ACP on desktop, and drops the assistant on web

## Context and Problem Statement

Koine Studio's assistant is not an agent host — it is a **raw LLM API client**. `src/ai/ai.ts`
declares `type AiProvider = 'anthropic' | 'openai'` (line 75) and nothing else; the agentic loop is
ours (`MAX_TOOL_ROUNDS = 5`, line 72), written twice — once against the Anthropic Messages API,
once against OpenAI-compatible Chat Completions. Our six tools
(`koine_validate/compile/format/list_files/read_file/write_file`, `src/ai/assistantTools.ts:35`) are
hand-mapped into both vendors' tool schemas by `toAnthropicTool` / `toOpenAiTool`.

The consequence is the shape of the cost: **every additional agent is a new SDK adapter plus a new
tool-format translation.** Supporting a third vendor does not reuse the second. Users are therefore
limited to whatever two backends we chose to hand-write, and each new one taxes the same
10,767-line `src/ai/` tree.

The [Agent Client Protocol](https://agentclientprotocol.com) (ACP) is the LSP-shaped answer to
exactly this: a JSON-RPC protocol between *clients* (editors) and *agents* (coding assistants), so
an editor implements the protocol once instead of an integration per agent. Roughly thirty-five
agents implement it today (Claude Code, Codex CLI, Gemini CLI, Copilot in preview, Goose, Cline,
OpenCode, Qwen Code, Junie, Cursor…), and the TypeScript SDK is at
`@agentclientprotocol/sdk@1.3.0`. So the protocol is not a bet on a spec draft.

Three facts, established by measurement rather than assumption, decide the shape of any adoption:

1. **stdio is the only stable transport.** The spec marks streamable HTTP as a *draft proposal in
   progress*, and no WebSocket transport exists. A browser tab cannot spawn a subprocess, so it
   cannot speak ACP at all today.
2. **Studio's desktop host already has the exact plumbing ACP needs.** `lsp_start` / `lsp_send` /
   `lsp_stop` (`src-tauri/src/lib.rs:1999–2033`) already broker JSON-RPC to a spawned `koine lsp`
   child behind the `Platform.createLspTransport()` seam (`src/host/types.ts:288`); ACP's framing is
   *simpler* than LSP's (newline-delimited, no `Content-Length`). `pty_*` (`lib.rs:2317`) is a
   working `portable-pty` broker, which is what ACP's `terminal/*` client methods need.
3. **`session/new` carries `mcpServers`.** The spec's session-setup parameters are `cwd` plus a list
   of MCP servers (stdio `command/args/env`, or HTTP `url/headers`). Koine already ships that
   server — `src/Koine.Mcp/` with `CompileTool`, `ValidateTool`, `FormatTool`, `ReferenceTool`,
   `ExamplesTool`, `CoverageTool` — and the Tauri host already starts it and resolves its loopback
   endpoint (`mcp_endpoint`, `lib.rs:2227`).

Fact 3 is the one that changes the argument from "more agent choice" to an architectural
simplification: if Studio hands its own MCP server to the agent at session creation, **any** ACP
agent becomes Koine-aware with no per-agent adaptation, and the Koine-specific capability stops
being duplicated per vendor in `assistantTools.ts`.

The browser host is already the degraded one on every adjacent seam: `createLspTransport()` returns
a `WasmLspTransport` instead of brokering a child (`src/host/browser/index.ts:53`), and
`mcpEndpoint()` returns `null` because "a browser tab cannot listen as a server" (line 63). Today it
compensates by running the vendor SDKs *in the tab* with the user's key and
`dangerouslyAllowBrowser`. So the open question is not whether ACP works on web — it does not — but
what web does instead.

## Considered Options

* **A — ACP is the assistant on desktop; the assistant is removed on web.** One agentic surface,
  one protocol, and the browser build stops carrying vendor SDKs and in-tab API keys entirely.
* **B — ACP on desktop, the current in-tab assistant retained on web.** No feature loss, but two
  assistant implementations, two tool paths, and two transcript models to keep in step forever.
* **C — Keep the hand-written adapters and add providers.** No new protocol, no desktop/web split;
  the M×N cost stays and every new agent is another `runAssistant` branch.
* **D — Wait for ACP's streamable HTTP transport to stabilize, then adopt on both hosts at once.**
  One implementation, no split — at the price of blocking on a draft with no shipping date.

## Decision Outcome

Chosen option: **"A — ACP is the assistant on desktop; the assistant is removed on web"**, because it
buys the agent choice *and* removes an implementation rather than adding one, and because the web
host was already the degraded path on LSP and MCP — carrying a third vendor-SDK-in-the-tab
compensation was the anomaly, not the baseline. B keeps the M×N problem alive under a new name;
C declines the problem; D trades a shipped capability for a draft transport.

We will:

1. **Add an `acp_*` broker to the Tauri host**, modeled on `lsp_start`/`lsp_send`/`lsp_stop`:
   spawn the configured agent command with `args`/`env`/`cwd`, broker newline-delimited JSON both
   ways over Tauri events, and surface child exit. Register the commands in
   `src-tauri/capabilities/default.json`.
2. **Add a `createAcpTransport()` seam to `Platform`** (`src/host/types.ts`), implemented by the
   Tauri host and reported as unsupported by the browser host, consistent with how `mcpEndpoint()`
   already returns `null` there.
3. **Implement the ACP client on `@agentclientprotocol/sdk`** — `initialize`, `session/new`,
   `session/prompt`, `session/cancel` outbound; `session/update`, `session/request_permission`,
   `fs/read_text_file`, `fs/write_text_file` and `terminal/*` inbound. `fs/*` routes through the
   existing per-turn `EditSession` staging and the `ChangeSetPanel` review; `terminal/*` routes onto
   the existing `pty_*` broker.
4. **Pass Studio's own Koine MCP server in `session/new`**, so every agent gets
   validate/compile/format/reference/examples/coverage without Studio adapting anything per agent.
   `assistantTools.ts`'s hand-mapped compiler tools cease to be the integration point.
5. **Ship three pre-configured agents**: `@zed-industries/claude-code-acp` (Anthropic),
   `@zed-industries/codex-acp` (OpenAI), and **Goose** configured against a local LM Studio endpoint
   (`http://localhost:1234`, keyless). Note explicitly: *LM Studio is not an ACP agent* — it is an
   OpenAI-compatible inference server and an MCP host. Local-model support is therefore delivered by
   an ACP agent that speaks to LM Studio, and Goose is chosen because LM Studio is a first-class
   provider in it. The registry is user-extensible; these three are defaults, not a whitelist.
6. **Remove the assistant surface from the web build**: the chat panel, the in-tab vendor SDKs, the
   browser secret store for API keys, and `dangerouslyAllowBrowser`.
7. **Retain `src/ai/ai.ts`, narrowed to desktop and to what ACP cannot express.** ACP has no method
   for a sub-second ghost-text completion, so `inlineCompletionClient.ts` (which calls `runAssistant`
   directly) and `grammarConstraint.ts` (GBNF-constrained decoding against a local backend) keep a
   raw-LLM endpoint. That endpoint becomes a *separate* setting from the agent registry.

## Consequences

**Easier.** Adding an agent becomes a configuration row, not a code path — the M×N adapter cost is
gone. The Koine-specific capability lives in exactly one place (`src/Koine.Mcp`), already built and
already tested, instead of being re-expressed in each vendor's tool schema. The web bundle sheds two
LLM SDKs and stops holding user API keys in a browser tab, which removes a security surface rather
than mitigating one. And agent-side features we have never implemented — plans, thoughts, slash
commands, operating modes, session resumption — arrive as protocol data rather than as roadmap.

**Harder, and accepted.** Web loses the assistant outright. That is a deliberate funnel toward the
desktop build, but it is a real removal on the zero-install surface, and the free/demo path is
exactly where an assistant does the most marketing work — this trade is the weakest point of the
decision and should be revisited if ACP's streamable HTTP transport stabilizes. Desktop users must
now install an agent (`npx`, or a binary on `PATH`), which is onboarding friction the current
paste-an-API-key flow does not have. `src/ai/ai.ts` does not die, so `inlineCompletionClient.ts`
loses its stated "one place to configure AI in Studio" property: there will be two configuration
surfaces, an agent registry and a completions endpoint. The permission model gains a second shape —
today the user reviews a staged change-set *after* the turn, whereas ACP agents ask *mid-turn* via
`session/request_permission` — and both must coexist. Finally, the transcript model has to grow
(thought chunks, plan, available commands, modes, session ids); `aiPanel.test.ts` is 2,472 lines
against a 994-line panel, so that growth is where the bulk of the work actually lands, not in the
protocol.

**Bet accepted.** We depend on a 1.x protocol whose only stable transport is stdio. If it stalls,
the desktop client is still a working stdio JSON-RPC broker over an SDK we do not maintain, and the
retained `ai.ts` still serves completions — the failure mode is a narrowed product, not a rewrite.
