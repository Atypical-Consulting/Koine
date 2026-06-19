# Koine Studio Assistant — in-IDE compiler tool-calling

**Date:** 2026-06-19 · **Branch:** `feat/studio-assistant-tools` · **Status:** approved (verified by a 4-lens adversarial review)

## Goal

Let the Assistant panel's local LLM (LM Studio, OpenAI-compatible) actually **call** Koine compiler
tools during a chat — `validate`, `compile`, `format` — executed **in-process** (no external server for
the web build), and ship a docs procedure for the setup.

Established facts (verified):
- LM Studio does **not** run the MCP agentic loop for `/v1` API clients — only for its own GUI chat.
  So the Studio Assistant must own the tool loop itself.
- LM Studio's `/v1/chat/completions` **does** emit well-formed `tool_calls` (streamed as
  index-keyed deltas; arg fragments are not individually valid JSON) — empirically confirmed with
  `devstral-small-2`.
- The web build needs LM Studio CORS on (`lms server start --cors`) because its origin is `:1430`.

## Architecture

```
aiPanel.send() → runAssistant() → runOpenAiCompatible()   [ai.ts]
   advertise koine tools (OpenAI `tools`)  ─┐
   stream; accumulate delta.tool_calls by index
   on finish_reason==='tool_calls':         │  bounded by MAX_TOOL_ROUNDS = 5
     JSON.parse args, execute each via       │
       Platform.runCompilerTool(name, argsJson) → string
     push assistant{tool_calls} + tool{result} LOCALLY, re-call create()
   else → return text  ───────────────────┘
```

- **Tool loop** lives in `runOpenAiCompatible` (OpenAI path only; Anthropic stays plain — YAGNI).
  Tool round-trip messages are **local** to the function (built on the OpenAI SDK message type),
  never pushed into the panel's persisted `messages[]` — so `aiPanel.ts`'s pop-one-on-failure
  rollback is untouched and `ChatMessage` does **not** change.
- **Executor seam:** new optional `Platform.runCompilerTool?(name, argsJson): Promise<string>`.
  - **Browser:** `loadWasmApi()` → `validate`→`DiagnoseWorkspace`, `compile`→`EmitPreview(target)`,
    `format`→`Format` (return `edits[0].newText ?? source`). Wrap `{source}` → `[{uri:'file:///model.koi', text}]`.
  - **Tauri:** `mcpEndpoint()` (lazily starts `koine mcp --http`) → `mcpCall(url, name, mcpArgs)`
    (`initialize` → session → `tools/call`), built on the existing `readRpc`/session machinery in
    `mcp.ts`. Translate `{source,target}` → MCP `{files:[{path,source}],target}`.
  - Tool exec error → return an error **string** (the model can recover/relay), never throw into the loop.

## Tools (mirrors `src/Koine.Mcp/Tools/*` descriptions)

| name | args | backend |
|---|---|---|
| `koine_validate` | `{ source: string }` | DiagnoseWorkspace → diagnostics summary |
| `koine_compile` | `{ source: string, target: 'csharp'\|'typescript'\|'python' }` | EmitPreview → files / error |
| `koine_format` | `{ source: string }` | Format → formatted text |

`compile` targets are restricted to `csharp/typescript/python` (EmitPreview rejects glossary/docs).

## Files

- `tooling/koine-studio/src/assistantTools.ts` *(new)* — `KOINE_TOOLS` (OpenAI tool defs), pure
  result formatters (`formatValidate`, `formatCompile`) over the WASM shapes, `summarizeForChip`.
- `tooling/koine-studio/src/ai.ts` — add `runCompilerTool?`/`onToolCall?` to `AssistantRequest`;
  agentic loop in `runOpenAiCompatible` (index-keyed accumulation, parse args at `finish_reason`,
  MAX_TOOL_ROUNDS cap, final tool-less round to force a text answer).
- `tooling/koine-studio/src/host/types.ts` — add `runCompilerTool?`.
- `tooling/koine-studio/src/host/browser/index.ts` — WASM dispatch.
- `tooling/koine-studio/src/host/tauri.ts` — MCP dispatch via `mcpCall`.
- `tooling/koine-studio/src/mcp.ts` — add `mcpCall(url, name, args, fetchFn?)`.
- `tooling/koine-studio/src/aiPanel.ts` — thread `runCompilerTool` + `onToolCall`; one muted inline
  status line per tool round (no bespoke chip component). Tool messages stay out of `messages[]`.
- `tooling/koine-studio/src/ide.ts` — pass `platform.runCompilerTool` into the panel.

## Tests (vitest)

- `assistantTools.test.ts` — tool defs shape; `formatValidate`/`formatCompile` over fixtures.
- tool-loop control flow with a mocked `chat.completions.create` (streamed `tool_calls` fixture in the
  confirmed LM Studio shape): asserts index-keyed accumulation, executor invocation, re-call, the
  `MAX_TOOL_ROUNDS` cap, and the model-declined (plain text) path.
- `mcpCall` over a mocked fetch (initialize → tools/call → text extraction).

## Deferred (named follow-ups)

- `reference` / `examples` tools via **D1** (relocate `KnowledgeStore` → `Koine.Compiler`, add
  `Reference`/`Examples` JSExports + `KOINE_WASM_EXPORTS` entries + C# parity test). Cut from v1
  because their content is already injected via `KOINE_PRIMER` + live source/diagnostics.
- Anthropic-path tool loop (reuse the provider-neutral tool defs).

### Known follow-ups from the implementation review (low severity)

- **Desktop result parity** — the desktop (MCP-sidecar) path returns the MCP tool's raw JSON text,
  while the browser path returns the compact `formatValidate`/`formatCompile` summaries. Both are
  usable; reformatting the desktop results to match was deferred (no Tauri test harness here).
- **`notifications/initialized`** — `mcpCall`/`probeMcp` skip the spec's post-initialize notification.
  The Koine MCP server works without it (verified live), so this is a spec-compliance nicety only.

## Docs (item 2)

New `website/` Starlight page: LM Studio + tools setup — `lms server start --cors`, a tool-capable
model, the OpenAI-compatible provider config in Studio Settings, plus the separate LM-Studio-native-MCP
recipe (`koine mcp --http`) for LM Studio's own GUI chat.
