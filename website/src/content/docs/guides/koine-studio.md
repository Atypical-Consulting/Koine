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
- **Scenario runner** — exercise the domain without leaving the editor: pick an aggregate command or
  factory, give it a starting state and arguments as JSON, and run it to see the
  `command → events → invariant-checks` timeline. It lives in the **Scenarios** view of the **Code**
  surface (or command palette → *Show Scenario Runner*). Two engines can answer a run — the model
  **interpreter** (the default, everywhere) and, on the desktop, the model's own **generated code** —
  and every result says which one did. See [Scenario runner: interpreted vs
  executed](#scenario-runner-interpreted-vs-executed).
- **Hover & navigation** — type/member hover cards and go-to-definition, served by the same LSP that
  powers the editors.
- **Syntax tree** — a right-rail panel (the tree glyph in the tool stripe, beside Properties / AI Chat /
  Source Control) that renders the **raw parse tree** of the active `.koi` file — the Koine equivalent of
  Roslyn's *Syntax Visualizer*. One collapsible row per parse node shows its **kind** (the node's type
  name, e.g. `ValueObjectDecl`, `Invariant`, `BinaryExpr`), its **name** where it has one, and its
  **source span**. It's fed by a target-agnostic `koine/syntaxTree` request that walks the compiler's
  grammar-agnostic syntax graph, so **every present and future grammar construct appears automatically**,
  with no per-node code. Because the tree is built over Koine's **error-tolerant** parse, a half-typed
  file still yields a recovered tree: `ErrorNode` and inserted-`IsMissing` nodes render with a distinct
  style rather than blanking the panel — the point, not a failure. Navigation is **bidirectional**: click
  a node to select its span in the editor, or move the caret to highlight the deepest node whose span
  contains it. The tree collapses below the top-level contexts by default and expands on demand, and the
  rows are a keyboard-navigable ARIA tree. A **large or deeply-nested model stays smooth**: the panel
  *virtualizes* the render, mounting only the rows in (or near) the viewport while the arrow keys, the
  caret highlight, and the single roving tab stop still reach every row — an off-screen target is scrolled
  into view before it is focused or highlighted — so keyboard navigation and WCAG 2.1 AA hold across the
  whole tree, however big. Works in both the browser and desktop hosts.
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

## Scenario runner: interpreted vs executed

The scenario runner answers "if I place this draft order, what happens?" against the live `.koi`. Two
engines can produce that answer, and **every result is labelled with the one that actually ran** —
`Interpreted` or `Executed`, as a chip on the timeline header:

| | **Interpreted** (default) | **Executed** (opt-in, desktop only) |
|---|---|---|
| What runs | The model itself — Koine walks the command body and evaluates its expressions | The model's **generated C#**: emitted, compiled with Roslyn, and driven for real |
| Where | Both editions (browser and desktop) | Desktop only — it needs a child process |
| Speed | Immediate | Process start **plus a full emit and compile on every run** |
| Fidelity | High for the modelled subset; anything it cannot evaluate is shown as `?` rather than guessed | Exactly what ships — derived values are really computed |

**Interpreted is the default and stays the default.** It is fast, it works in the browser, and it never
runs anything. Reach for executed mode when the interpreter's `?` is the answer you actually needed —
typically a derived value object (`total = lines.sum(l => l.payable)`), a value object's own invariant
firing on the given state, an illegal state transition, or the exact wording of a domain-invariant
failure. Those four are precisely what executed mode adds. What it does **not** add: cross-aggregate
effects — the runner still exercises *one* aggregate in isolation, in either mode.

### Turning it on

On the **desktop** edition the scenario panel shows a checkbox — **"Execute generated code (high
fidelity)"** — under the arguments box. It is **off by default** and lasts for the session only:
nothing is written to your settings, so every new window starts interpreted.

In the **browser** edition the checkbox is simply absent, because a tab has no process to run generated
code in. If a request for executed mode reaches the browser backend anyway, it is answered by the
interpreter and labelled `interpreted`, with a note saying execution was unavailable on this host — a
degraded answer that says so, never a silent one. Bringing executed mode to the browser would mean a
second Roslyn compile-and-load *inside the tab*, which runs into the per-tab memory ceilings tracked in
[#219](https://github.com/Atypical-Consulting/Koine/issues/219).

Asking to execute is a **request, not a promise**: a host that cannot execute, a model that does not
compile, or a run that overruns its budget all come back honestly labelled. Read the chip, not the
checkbox.

### Timeouts, and what a runaway model costs you

An executed run happens in a **child process with a wall-clock deadline — 5 seconds by default**. When
the deadline expires the child *and its whole process tree* are killed, and the run comes back as a
failed result carrying a note saying it timed out: the emitted code may simply not terminate (an
unbounded loop or runaway allocation in a derived member or invariant). Nothing of that run survives —
but your editor, its diagnostics and its open documents are untouched. The run happens *off* the
language server's message loop, so the editor keeps answering — diagnostics, hover and completion carry
on while a scenario is compiling and running. A client can ask for a different budget (the `timeoutMs`
parameter of `koine/runScenario`), clamped to **100 ms – 60 s**.

Executed runs are also **serialized per window**: fire two in quick succession and they run one after
the other, rather than putting two Roslyn compiles inside the editor backend at once.

### Resource ceilings and OS-level confinement

Beyond the deadline, the child runs under limits the runtime and the operating system enforce. What you
get depends on the platform, and the run **tells you** when something could not be applied — any gap is
appended to the result's notes rather than left implied:

| | macOS | Linux | Windows |
|---|---|---|---|
| Managed-heap ceiling (1 GiB) | ✅ | ✅ | ✅ *(also capped by a Job Object)* |
| Processor-time ceiling | ✅ | ✅ | ✅ *(Job Object)* |
| Network denied | ✅ | ⚠️ *(only where unprivileged user namespaces are permitted)* | ❌ *(reported)* |
| Writes confined to the run directory | ✅ | ❌ *(reported)* | ❌ *(reported)* |

The memory row is a **managed-heap** ceiling on macOS and Linux — the .NET runtime enforces it, and it
bounds the managed heap, which is where an allocation storm in emitted code lands. It does not bound
native allocations; only the Windows Job Object caps those too.

Linux network denial uses an unprivileged network namespace, which several distributions restrict —
Ubuntu 24.04's AppArmor policy blocks it by default, and this project's own CI runners fall in that
group. Where it is blocked, the run says so in its notes rather than pretending otherwise.

Reads are unrestricted everywhere — the child has to load the .NET runtime and its own assemblies. A run
stopped by a *resource* ceiling says so by name, so an allocation storm is never reported as an infinite
loop. And confinement is never allowed to break a run: if a mechanism is missing on your machine, the
scenario still executes and the result says which confinement was skipped.

:::caution[The child process is defence in depth, not a security sandbox]
Running a scenario in a confined, killable child process protects the **editor** from the generated
code — a hang, a crash, or an allocation storm costs you one dead child process and an honest error, not
your session — and, where the platform allows it, stops that code touching the network or your files.

It is still **not** a containment boundary for a model you do not trust: reads are open everywhere, and
two of the three platforms cannot confine writes at all. The boundary rests on the fact that you are
running **your own model on your own machine** — code you could equally have produced with `koine build`
and run yourself. The reasoning, the trust model and exactly what is enforced where are recorded in
[ADR 0011 — Scenario execution runs in a killable child process](https://github.com/Atypical-Consulting/Koine/blob/main/adr/0011-scenario-execution-sandbox.md)
and
[ADR 0012 — Scenario sandbox confinement uses each platform's native mechanism](https://github.com/Atypical-Consulting/Koine/blob/main/adr/0012-scenario-sandbox-os-confinement.md).
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
