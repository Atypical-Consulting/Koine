---
title: "Koine Studio"
description: "The Koine IDE for .koi files — run it in your browser at /Koine/studio/, or as a native Tauri desktop app. Both share the same compiler."
---

**Koine Studio** is the full IDE for `.koi` files: a live editor with push-based diagnostics, an
emitted-code preview (C# / TypeScript / Python / PHP / Rust), the ubiquitous-language glossary, a context map, hover docs,
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
exports (`DiagnoseWorkspace`, `EmitPreview`, `Glossary`, `Hover`, …) from a **dedicated Web
Worker** — there is no server and no `koine lsp` process. The worker runs off the UI thread; a
main-thread client routes each call over `postMessage` and resolves its response as a `Promise`.
Cancellation works in two modes: **supersede** (drop a stale call) and **terminate-and-respawn**
(abort a runaway compile by terminating the worker and booting a fresh one). `WasmEnableThreads`
stays `false`, so the worker uses plain structured-clone `postMessage` — **no COOP/COEP
cross-origin-isolation headers are needed**.

The **desktop edition** reaches the same language service over a `koine lsp` child process instead:

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

## Caching & offline (the wasm bundle)

The WebAssembly runtime is a multi-megabyte download (the trimmed BCL + the Koine compiler and ANTLR
assemblies). To keep repeat visits fast, the **home-page [Playground](/Koine/) registers a service
worker** that **cache-first** serves its `koine-wasm/_framework/*` assets: the first visit downloads
them, every later visit boots the in-browser compiler from the local cache (only a small boot-manifest
check touches the network), and the Playground keeps working **offline** once warmed. The cache is keyed
on the bundle's content hash (`resources.hash` from the wasm boot manifest), so a new release
transparently supersedes the old one — no manual cache-busting, no half-old/half-new runtime.

A service worker is the lever here because the site is hosted on **GitHub Pages**, which **cannot set
custom response headers**: there is no `Cache-Control: immutable` to make the browser trust the bundle
across visits, and no `Content-Encoding: br` (Pages serves **gzip, not Brotli**). It *does* serve
`application/wasm`, so streaming instantiation already works. So `Cache-Control: immutable` and Brotli
are **"if/when the host changes" follow-ups** — not enabled today; the service worker delivers the
instant-repeat-load and offline wins regardless of host headers.

:::note
This caching covers the **home-page Playground's** bundle only — its service worker is deliberately
scoped to `/Koine/koine-wasm/_framework/*` and does **not** manage Studio's own copy under
`/Koine/studio/`. Giving **Koine Studio** the same treatment — and turning it into an installable,
mobile-friendly **PWA** — is a separate, larger effort tracked in
[#221](https://github.com/Atypical-Consulting/Koine/issues/221).
:::

## Features

Koine Studio surfaces the **enriched** language server, the same one the VS Code extension consumes:

- **Live diagnostics** — syntax and semantic errors as you type, pushed via
  `textDocument/publishDiagnostics`.
- **Emitted-code preview** — request the generated **C#**, **TypeScript**, **Python**, **PHP**, or
  **Rust** for the current model in a read-only pane (`koine/emitPreview`); if the model has errors,
  nothing is emitted and the diagnostics are shown instead. The list of targets the picker offers is
  **derived from the backend** — Studio asks the language server which targets the compiler's emitter
  registry supports (`koine/emitTargets`) and renders the picker, the Generate-project wizard and the
  assistant's compile tool from that one list, so a new emitter target appears automatically with no
  front-end change. Syntax highlighting for a target without a bundled editor mode degrades gracefully
  to plain (unhighlighted) text rather than hiding the target.
- **Glossary** — the ubiquitous-language glossary the `glossary` emitter produces.
- **Context map** — the bounded contexts and their relationships, in the **Context Map** bottom tab.
  A **Graph | Table** toggle switches between two views of the same data:
  - **Graph** (the default) draws the strategic context map as an **interactive diagram** on the same
    pan/zoom canvas as the domain diagrams. Each bounded context is a distinct accent **tile**; each
    relation is an edge whose direction reads **upstream → downstream**, with the relationship **kind**
    (Partnership, Shared Kernel, Customer/Supplier, Conformist, ACL, …) as its label — a bidirectional
    relation (Partnership / Shared Kernel) renders two-headed. Hover an edge for its kind and shared
    types / ACL; click a context to **filter the workspace** to it **and jump the editor to its `.koi`
    declaration** (the same jump-to-source a domain-diagram node gives), or click a relation to show its
    shared types and ACL in the details strip — so no detail from the table is lost.
  - **Table** keeps the dense, per-relation grid (Upstream · Direction · Downstream · Kind · Shared
    Types · ACL) for when you want every field at a glance.
- **Canvas notes & groups** — free-text **Notes** and node **Groups** you can drop on the diagram
  canvas from the palette. These are *annotations only*: they never touch your `.koi` source. They
  persist per workspace in a committable `koine.layout.json` (alongside hand-dragged node positions), so
  they travel with the repo and diff cleanly. Double-click to edit, right-click to delete; a group draws
  a labelled region behind its member nodes and follows them as they move.
- **Hover & navigation** — type/member hover cards and go-to-definition, served by the same LSP that
  powers the editors.
- **Workspace search & replace** — press **`Mod`+`Shift`+`F`** (⌘/Ctrl) to open the search panel and
  find a term across **every `.koi` file** in the open folder, including unsaved buffers. Toggle
  **match case**, **whole word**, and **regular expression** (with `$1` capture groups in the
  replacement), and narrow the scan with an **include glob** (e.g. `*.koi`, `src/*.koi`). Results are
  grouped by file with per-file and total counts; click a hit to jump to it. **Replace** rewrites a
  single file or every match across the workspace — edits to open files flow through the normal
  dirty/save pipeline, so they stay **undoable** and the unsaved indicator updates.
- **Shareable links** — _Copy shareable link_ encodes your work into the URL fragment (it never leaves
  the browser) so a teammate who opens the link lands on the same model. The link carries the **whole
  workspace** — every open file, with the active file flagged. Old single-file links still open (as a
  one-file workspace), so links shared before this change keep working.
- **Export `.koi` source** — _Export .koi source (.zip)_ bundles every open `.koi` file into a zip. A
  very large workspace can overflow a URL, so when _Copy shareable link_ would produce an oversized
  link Studio declines to copy a broken one and steers you to this export instead.
- **Settings (Visual + JSON)** — the **Settings** view edits your Studio preferences either through the
  Visual controls or directly as `settings.json`. The JSON pane is **schema-aware**: it validates every
  field against the settings schema and surfaces that schema's per-field documentation inline — **hover**
  a field key for its title and description (e.g. `editor.tabSize` → **Tab size** · _Indent width in
  spaces._), and **completion** inside a group lists each field with the same human-readable title (as
  the option detail) and description (as the info panel). The secret API key is never part of the
  document, so it can never appear in a hover or completion.

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

### Store inspector (dev only)

While developing the IDE, a read-only **store inspector** overlay shows exactly what the app's
Zustand store holds right now — selection, active context, the panel/view fields, the active file,
the dirty-files and diagnostics rollups, and a collapsible "Raw state" dump of the whole store. It's
the tool for diagnosing cross-panel-sync bugs. Open it from the command palette (<kbd>Cmd/Ctrl</kbd>
+<kbd>K</kbd>) → **Toggle store inspector (debug)**.

The command is registered **only in dev builds**. Both `run-ide` and `run-ide-web` launch Vite's
*serve* command, where `import.meta.env.DEV === true`, so the inspector is available there. Published
builds go through `vite build` (`import.meta.env.DEV === false`), where the command isn't registered
and the panel's code is excluded from the bundle — so it never appears in the shipped desktop app or
the deployed web playground.

## See also

- [Local LLM in the Assistant](/Koine/guides/assistant-local-llm/) — point the built-in Assistant at a local model, and how grammar-constrained generation keeps its output valid `.koi`.
- [Editor tooling](/Koine/guides/editor-tooling/) — the TextMate grammar, `koine lsp`, and the VS Code extension.
- [CLI reference](/Koine/guides/cli/) — `koine build` and `koine check`, which share the server's parser and validator.
- [Reading the generated C#](/Koine/start/reading-the-output/) — what the emitted-code preview shows you.
