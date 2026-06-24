---
title: "Koine Studio"
description: "The Koine IDE for .koi files — run it in your browser at /Koine/studio/, or as a native Tauri desktop app. Both share the same compiler."
---

**Koine Studio** is the full IDE for `.koi` files: a live editor with push-based diagnostics, an
emitted-code preview (C# / TypeScript), the ubiquitous-language glossary, a context map, hover docs,
and go-to-definition. It runs **two ways from one codebase** (`tooling/koine-studio/`):

:::tip[Try it now — nothing to install]
**[Open Koine Studio in your browser ▸](/Koine/studio/)** — the compiler is shipped as WebAssembly,
so the whole IDE runs client-side. No download, no .NET SDK.
:::

- **Web edition** (hosted) — runs entirely in the browser. The Koine compiler is published as a
  WebAssembly module (`src/Koine.Wasm`) and called directly from the page, so parsing, validation,
  and emit all happen client-side. This is what you get at
  **[atypical-consulting.github.io/Koine/studio/](/Koine/studio/)**, and it shares the WASM bundle
  with the inline playground on the [home page](/Koine/).
- **Desktop edition** — a [Tauri v2](https://tauri.app/) app (a Rust host wrapping the same web
  frontend) that spawns the Koine language server (`koine lsp`) as a child process and talks to it
  over JSON-RPC. Build it from `tooling/koine-studio/` — see [Run it (desktop)](#run-it-desktop).

Both editions are currently an **MVP** and share their entire language backend with the
[VS Code extension](/Koine/guides/editor-tooling/) — the same parser, validator, and emitters as the
`koine` CLI. What you see in the browser is exactly what the build produces.

## Why a separate app

The [editor tooling guide](/Koine/guides/editor-tooling/) covers bringing Koine *into* an existing
editor (Rider, VS Code) through `koine lsp`. Koine Studio is the other end of that idea: a
self-contained window with nothing to configure. Open it, type, and the model is parsed, validated,
and previewed — the same way the build does it, because it *is* the same compiler.

## How it works

The **web edition** loads the WebAssembly compiler bundle once, then calls its language-service
exports (`DiagnoseWorkspace`, `EmitPreview`, `Glossary`, `Hover`, …) directly from the page — there
is no server and no `koine lsp` process. The **desktop edition** reaches the same language service
over a `koine lsp` child process instead:

```
Koine Studio (Tauri v2)
├── Rust host  (src-tauri/)  ─ spawns `koine lsp`, brokers JSON-RPC over stdio
└── Web UI     (src/)        ─ CodeMirror 6 editor + LSP client over Tauri IPC
                                   │
                                   ▼
                              koine lsp  ─ the compiler's own parser + validator
```

- The **Rust host** (`src-tauri/src/lib.rs`) spawns the language server lazily on first use, owns its
  stdin, and runs a reader thread that parses `Content-Length`-framed JSON-RPC off the server's
  stdout. Each message is re-emitted to the frontend as a Tauri event.
- The **web frontend** (`src/`) is a small LSP client over Tauri IPC. It runs the standard
  `initialize` → `initialized` → `didOpen` / `didChange` handshake, routes
  `textDocument/publishDiagnostics` into CodeMirror's lint state, and issues the custom
  `koine/emitPreview` request to populate the preview pane.

Because the backend is the real `koine lsp`, Studio's diagnostics land at the same line and column as
`koine build`. There is no second, drifting implementation of the rules.

## Features

Koine Studio surfaces the **enriched** language server, the same one the VS Code extension consumes:

- **Live diagnostics** — syntax and semantic errors as you type, pushed via
  `textDocument/publishDiagnostics`.
- **Emitted-code preview** — request the generated **C#** or **TypeScript** for the current model in a
  read-only pane (`koine/emitPreview`); if the model has errors, nothing is emitted and the
  diagnostics are shown instead.
- **Glossary** — the ubiquitous-language glossary the `glossary` emitter produces.
- **Context map** — the bounded contexts and their relationships, in the **Context Map** bottom tab.
  A **Graph | Table** toggle switches between two views of the same data:
  - **Graph** (the default) draws the strategic context map as an **interactive diagram** on the same
    pan/zoom canvas as the domain diagrams. Each bounded context is a distinct accent **tile**; each
    relation is an edge whose direction reads **upstream → downstream**, with the relationship **kind**
    (Partnership, Shared Kernel, Customer/Supplier, Conformist, ACL, …) as its label — a bidirectional
    relation (Partnership / Shared Kernel) renders two-headed. Hover an edge for its kind and shared
    types / ACL; click a context to **filter the workspace** to it, or click a relation to show its
    shared types and ACL in the details strip — so no detail from the table is lost.
  - **Table** keeps the dense, per-relation grid (Upstream · Direction · Downstream · Kind · Shared
    Types · ACL) for when you want every field at a glance.
- **Hover & navigation** — type/member hover cards and go-to-definition, served by the same LSP that
  powers the editors.
- **Shareable links** — _Copy shareable link_ encodes your work into the URL fragment (it never leaves
  the browser) so a teammate who opens the link lands on the same model. The link carries the **whole
  workspace** — every open file, with the active file flagged. Old single-file links still open (as a
  one-file workspace), so links shared before this change keep working.
- **Export `.koi` source** — _Export .koi source (.zip)_ bundles every open `.koi` file into a zip. A
  very large workspace can overflow a URL, so when _Copy shareable link_ would produce an oversized
  link Studio declines to copy a broken one and steers you to this export instead.

:::note
Studio is an MVP. The feature set above is what the shared language server provides and what the app
wires up today — it is not a full replacement for a general-purpose editor.
:::

## Relationship to the VS Code extension

Koine Studio and the [VS Code extension](/Koine/guides/editor-tooling/) are two clients of **one**
backend: the enriched `koine lsp`. The standard features (diagnostics, hover, completion,
go-to-definition) and the Koine-specific requests (`koine/emitPreview`, glossary, context map) are
implemented once, in the compiler's language service, and reused by both. Fix a rule in the compiler
and both clients get it — there is nothing IDE-specific to keep in sync.

## Run it (desktop)

The hosted [web edition](/Koine/studio/) needs nothing to run. To build the **desktop** app:
a helper script under `scripts/run-ide/` builds the CLI (so the `koine lsp` sidecar exists), installs
the frontend deps on first run, and launches the Tauri dev shell:

```bash
# from the repo root — pick the script for your shell
./scripts/run-ide/run-ide.sh     # macOS / Linux
.\scripts\run-ide\run-ide.ps1    # Windows (PowerShell)
.\scripts\run-ide\run-ide.cmd    # Windows (cmd)
```

By default the Rust host runs the Debug `Koine.Cli.dll` via `dotnet`. To use a self-contained
published binary instead, point `KOINE_LSP` at it before launching:

```bash
KOINE_LSP=/path/to/koine ./scripts/run-ide/run-ide.sh
```

### Build / verify by hand

```bash
# Rust broker: compile + framing unit tests
cd tooling/koine-studio/src-tauri && cargo build && cargo test

# Frontend: typecheck + bundle
cd tooling/koine-studio && npm install && npm run build
```

:::tip
You need a .NET SDK, Node/npm, and a Rust toolchain on `PATH`. On Linux, Tauri v2 also needs the
WebKitGTK / libsoup system packages — see the `Koine Studio` CI workflow for the exact `apt` list.
:::

## See also

- [Editor tooling](/Koine/guides/editor-tooling/) — the TextMate grammar, `koine lsp`, and the VS Code extension.
- [CLI reference](/Koine/guides/cli/) — `koine build` and `koine check`, which share the server's parser and validator.
- [Reading the generated C#](/Koine/start/reading-the-output/) — what the emitted-code preview shows you.
