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

The first three are the same capabilities the [MCP server](/Koine/guides/mcp-server/) exposes, but
executed by the IDE itself, grounded in whatever is on screen. When you have a **folder workspace**
open, the assistant gains three more tools for editing **across** files (see
[Multi-file agentic editing](#multi-file-agentic-editing) below):

| Tool | What it does |
| --- | --- |
| `koine_list_files` | List the workspace's `.koi` files (by workspace-relative path) the assistant may read or edit. |
| `koine_read_file` | Read the current contents of one workspace file by its relative path. |
| `koine_write_file` | **Stage** new full-file contents for one file (creating it if new). Staged — *not* written to disk — for you to review and apply. |

## Multi-file agentic editing

A real Domain-Driven Design change rarely fits in one file: adding an integration event touches the
publisher context, the subscriber context, and the context map. With a **folder workspace** open and
the agentic tools enabled, the assistant can make that change in **one turn** — it lists and reads the
files it needs, then proposes full-file edits across as many `.koi` files as the change requires.

How it works:

1. **The model edits a *staging area*, not your files.** Each `koine_write_file` call records a
   proposed full-file body in an in-memory staging area keyed by relative path. Nothing is written to
   disk while the model works, and the whole staged workspace is re-validated together (via the
   multi-file compile envelope) so a cross-file change is checked as a unit, not file-by-file.
2. **You get a per-file review, not a single "Apply".** When the turn finishes with staged edits, the
   reply shows a **change set**: one row per file with a **new** / **modified** badge, an inline diff,
   and a per-file accept toggle (all on by default).
3. **Nothing lands until you accept.** **Apply N files** writes only the still-accepted files through
   the workspace — **new files are created under the folder root** — and the workspace re-validates
   after the write. **Discard** drops the staging area and writes nothing.

> **You:** Add an `OrderPlaced` integration event published by Ordering and consumed by Shipping, and
> wire it in the context map.
>
> 🔧 `koine_list_files → 6 file(s)` 🔧 `koine_read_file → ordering/orders.koi` 🔧 `koine_write_file → staged changes to ordering/orders.koi` 🔧 `koine_write_file → staged changes to shipping/shipping.koi` 🔧 `koine_write_file → staged changes to context-map.koi`
>
> **Assistant:** Staged edits to three files — review and apply below.
>
> *(a change set with three rows — `ordering/orders.koi` **modified**, `shipping/shipping.koi`
> **modified**, `context-map.koi` **modified** — each with a diff and an accept toggle, plus
> **Apply 3 files** / **Discard**.)*

:::note[When the edit tools appear]
The edit tools are offered only when a folder workspace with at least one `.koi` file is open **and**
the agentic tools are enabled (**Settings → Assistant**). A single-document chat keeps just the three
single-file compiler tools and the usual one-click *Apply to editor*. The staging area lives in
Studio's host layer and is provider-agnostic — the compiler and the target-agnostic model are
untouched — so it works the same in **Studio Web** (writing through the browser file host) and on the
**desktop** (through the Tauri file host).
:::

:::tip[Anthropic / remote endpoints]
Tool-calling is wired for the **OpenAI-compatible** path (the local-LLM use case). Remote
OpenAI-compatible endpoints (OpenAI, Groq, Together, OpenRouter) work the same way — just set a real
**API key**. The Anthropic provider stays plain chat for now.
:::

## Grammar-constrained generation

When you ask the Assistant to *generate* a model, Studio makes the `.koi` it produces **valid by
construction, not by luck**. One switch controls it — **Settings → Assistant → Constrain AI output to
the Koine grammar** — and it ships **on**. Which mechanism Studio uses is decided from the configured
backend's capability; you don't pick it:

| Backend | Mechanism | What it does |
| --- | --- | --- |
| **Grammar-capable local** — an OpenAI-compatible endpoint on a loopback host (Ollama `:11434`, LM Studio `:1234`) | **GBNF token masking** | The request carries a [GBNF](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md) grammar derived from Koine's own ANTLR grammar, so the decoder can **only** emit tokens that keep a valid `.koi` parse. The reply gets a **`grammar-constrained`** chip. |
| **Hosted API** — Anthropic, or OpenAI proper (`api.openai.com`) | **Parse-and-repair** | No decode-time hook exists on these, so Studio validates the candidate against the real Koine parser and, on failure, feeds the precise `line:column` diagnostics back for up to **3** repair rounds. A **`parse-and-repair`** chip and a live **`repair k/N`** counter show progress. |

Either way, **"Apply to editor" stays disabled until the candidate parses** — Studio never drops
unparseable text into your buffer. If parse-and-repair runs out of rounds, a *"couldn't produce valid
Koine"* notice appears and Apply stays off.

:::note[The guarantee, honestly]
A grammar-capable **local** model gets a **hard syntactic guarantee**: the GBNF is a recogniser-grade
projection of the language, so the decoder's output always *parses*. It is **not** a semantic checker —
it can't enforce name resolution or type rules — so Studio still validates the result once and only
enables Apply when it comes back clean. **Hosted** models get a **bounded best-effort** with a known
ceiling (three repair rounds), never silent junk.

Capability is inferred from your **provider + base URL** alone — a loopback OpenAI-compatible endpoint
counts; `api.openai.com` and Anthropic don't — not by probing the server. The grammar itself is derived
in the compiler (`GbnfExporter`) and stays target-agnostic.
:::

:::caution[Web vs desktop]
The GBNF is served by Studio's **in-browser** WebAssembly compiler, so token masking is available in
**Studio Web**. The **desktop** app doesn't expose it yet, so the same local model falls back to
**parse-and-repair** there — still gated behind a clean parse, just without the hard guarantee.
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
