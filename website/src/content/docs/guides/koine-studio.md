---
title: "Koine Studio"
description: "A Tauri desktop IDE for .koi files, driven by the same koine lsp server as the VS Code extension."
---

**Koine Studio** is a desktop IDE for `.koi` files. It's a [Tauri v2](https://tauri.app/) app —
a Rust host wrapping a web frontend — that spawns the Koine language server (`koine lsp`) as a child
process and talks to it over JSON-RPC. You write your model in a live editor and see diagnostics, a
glossary, a context map, and the emitted C# / TypeScript without leaving the window.

It lives in `tooling/koine-studio/` and is currently an **MVP**: the core editor + LSP loop works,
and it shares its entire language backend with the [VS Code extension](/Koine/guides/editor-tooling/).

## Why a separate app

The [editor tooling guide](/Koine/guides/editor-tooling/) covers bringing Koine *into* an existing
editor (Rider, VS Code) through `koine lsp`. Koine Studio is the other end of that idea: a
self-contained window with nothing to configure. Open it, type, and the model is parsed, validated,
and previewed — the same way the build does it, because it *is* the same compiler.

## How it works

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
- **Context map** — the bounded contexts and their relationships.
- **Hover & navigation** — type/member hover cards and go-to-definition, served by the same LSP that
  powers the editors.

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

## Run it

A helper script under `scripts/run-ide/` builds the CLI (so the `koine lsp` sidecar exists), installs
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
