---
title: "Local LLM in the Assistant"
description: "Point Koine Studio's built-in Assistant at a local model (LM Studio) and let it call the Koine compiler tools — validate, compile, and format — mid-conversation."
---

Koine Studio has a built-in **Assistant** (the *Assistant* tab in the inspector): a domain copilot that
keeps the current model + diagnostics in context and can apply a generated `.koi` model straight into
the editor. It talks to either the Anthropic API or **any OpenAI-compatible endpoint** — including a
**local model** served by [LM Studio](https://lmstudio.ai) or [Ollama](https://ollama.com), so nothing
leaves your machine.

With a **tool-capable** local model, the Assistant can do more than chat: it **calls the Koine compiler
tools** — `koine_validate`, `koine_compile`, `koine_format` — and feeds the real results back to the
model. In the web build these run **in-process via the WebAssembly compiler** (no server, no network);
in the desktop app they run through the bundled `koine mcp --http` sidecar.

:::note[Two different "LM Studio + Koine" integrations]
This page is about the **Assistant inside Studio** using LM Studio as its model backend. That is
*separate* from pointing **LM Studio's own chat** at the Koine **MCP server** (covered in
[MCP server → Over HTTP](/Koine/guides/mcp-server/#over-http-lm-studio-any-client-by-url)). They are
complementary: use the Assistant when you want the live editor grounding and one-click *Apply to
editor*; use LM Studio's chat when you want to work inside LM Studio.
:::

## Setup with LM Studio

### 1. Load a tool-capable model

Tool-calling needs a model trained for it. Good local choices: **Devstral**, **Qwen2.5-Coder**,
**Llama 3.x**. Load it in LM Studio and note its model id (e.g. `mistralai/devstral-small-2-2512`).

A model with no tool support will simply never call the tools — it answers from context only.

### 2. Start the LM Studio server **with CORS**

The web build of Studio runs at `http://localhost:1430`, so a browser request to LM Studio
(`http://localhost:1234`) is **cross-origin** and is blocked unless LM Studio sends CORS headers.

```bash
lms server start --cors --port 1234
```

…or toggle **Enable CORS** in LM Studio's **Developer → Server** settings. Then confirm the model
endpoint is up:

```bash
curl http://localhost:1234/v1/models
```

:::caution[`Request failed: Connection error`]
That error in the Assistant almost always means **CORS is off**. Open the browser console and look for
*"blocked by CORS policy: No 'Access-Control-Allow-Origin' header"*, then restart LM Studio with
`--cors`. The **desktop** Studio app makes native requests and is not subject to CORS.
:::

### 3. Point the Assistant at it

Open **Settings → Assistant** and set:

| Field | Value |
| --- | --- |
| **Provider** | `OpenAI-compatible` |
| **Base URL** | `http://localhost:1234/v1` |
| **API key** | *(leave blank — a local server needs none)* |
| **Model** | the model id you loaded, e.g. `mistralai/devstral-small-2-2512` |

That's it. Open the **Assistant** tab and start chatting.

## Using the tools

Ask the Assistant to do something a tool can answer and it will call one, showing a muted
**🔧 line** above its reply for each call:

> **You:** Compile the current model to TypeScript and tell me how many files it emits.
>
> 🔧 `koine_compile → compiled to typescript — 13 file(s):`
>
> **Assistant:** The compilation emitted 13 TypeScript files. Three of them are
> `Billing/value-objects/Money.ts`, `Billing/enums/Currency.ts`, `Billing/entities/Customer.ts`.

The tools the model can call:

| Tool | What it does |
| --- | --- |
| `koine_validate` | Validate `.koi` source and return diagnostics (line:col). Lets the model check a draft it just wrote and keep fixing until it compiles. |
| `koine_compile` | Compile to a target (`csharp` / `typescript` / `python`) and return the emitted files — so the model can inspect generated output. |
| `koine_format` | Return canonically-formatted `.koi` source. |

These are the same capabilities the [MCP server](/Koine/guides/mcp-server/) exposes, but executed by
the IDE itself, grounded in whatever is on screen.

:::tip[Anthropic / remote endpoints]
Tool-calling is wired for the **OpenAI-compatible** path (the local-LLM use case). Remote
OpenAI-compatible endpoints (OpenAI, Groq, Together, OpenRouter) work the same way — just set a real
**API key**. The Anthropic provider stays plain chat for now.
:::

## Inline completions (ghost text)

The Assistant is a *chat* surface. Studio also has an **inline** one: as you type in a `.koi` buffer it
can predict the next line and show it as **dimmed ghost text** after the caret — the keystroke-level
completion you expect from a modern editor.

Turn it on under **Settings → Assistant → AI inline completions** (it ships **off**). Then, after a
short pause in typing:

- **Tab** accepts the suggestion — a normal, undoable edit. **Esc**, or simply continuing to type,
  dismisses it.
- It **reuses the same provider, key, and model** as the chat Assistant above — so the **Local LLM
  setup** on this page covers it too: point it at LM Studio / Ollama and nothing leaves your machine.
- It stays clear of the deterministic, grammar-true **LSP completion popup**: while that popup is open,
  no ghost text appears. Every edit aborts an in-flight request, so a suggestion never lands a beat late.

:::caution[What is sent, and why it is off by default]
Each suggestion sends the **text around your caret** to the provider you configured, and predicting on
every idle pause spends API tokens — so the toggle defaults to **off** (no surprise spend) and simply
does nothing when no provider is configured. With a **local** model (the setup above) the buffer context
never leaves your machine.
:::

## Troubleshooting

- **`Request failed: Connection error`** — CORS is off (web build). Start LM Studio with `--cors`.
- **The model answers but never calls a tool** — it isn't tool-capable, or the task didn't need one
  (the current source + diagnostics are already in its context). Try a coder/instruct model and ask
  it explicitly to "use `koine_compile`/`koine_validate`".
- **A tool returns an error string** — that's by design: the error is fed back so the model can adapt.
  The 🔧 line shows the outcome.
