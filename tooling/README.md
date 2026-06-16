# Koine editor tooling

## Command-line developer tools (R17.3)

Beyond `koine build`, the CLI ships the day-to-day workflow commands:

```bash
koine init [dir] [--force]     # scaffold domain.koi + koine.config + README.md (must build immediately)
koine fmt  <file|dir> [--check] # canonically format .koi; --check verifies without writing (exit 1 if not)
koine watch <file|dir> [...]    # rebuild on every change, debounced, honoring --target/--out/koine.config
```

- **`koine fmt`** is a token-stream reprinter: 2-space indentation, K&R braces, one space after `:`
  with the type columns of consecutive `name: Type` fields aligned, single spaces around binary
  operators, and collapsed blank runs. It preserves every comment and emits string/regex literals
  byte-for-byte, and is idempotent (`fmt(fmt(x)) == fmt(x)`). Source line breaks are preserved
  (it normalizes layout, it does not reflow).
- **`koine.config`** (written by `init`, read by `build`/`watch`) supplies defaults for `--target`
  and `--out`; its structured `targets.*` block is reserved for R16 and ignored today.

## Syntax highlighting for `.koi`

`koine-textmate/` is a TextMate grammar bundle (also a valid VS Code grammar extension) that
highlights Koine source. It scopes every keyword (all declaration kinds, clauses, and the
hyphenated context-map roles), declaration names, field names, primitive and collection types
(`List`/`Set`/`Map`/`Range`), annotations (`@since`), invariants, the `matches /regex/` literal,
strings, numbers, line/block/doc comments, and the full operator set (`-> <-> <- => ?? @` …). The
grammar is verified against the real TextMate engine over every `.koi` in `examples/` and `demo/`.
Package it as a `.vsix` with `npm run package` (after `npm run install-vsce`).

```
koine-textmate/
├── package.json                    # language + grammar contribution
├── language-configuration.json     # comments, brackets, auto-closing
└── syntaxes/koine.tmLanguage.json  # the TextMate grammar (scopeName: source.koine)
```

### JetBrains Rider (and IntelliJ-based IDEs)

Rider reads TextMate bundles directly — no plugin or build step needed.

1. **Settings / Preferences** → **Editor** → **TextMate Bundles**.
2. Click **+** and select the `tooling/koine-textmate` folder.
3. Click **OK** / **Apply**.

Open any `.koi` file (e.g. `examples/billing.koi` or `demo/Shop.Domain/Models/*.koi`) and it is
highlighted. The colors follow your active color scheme via standard TextMate scopes
(`keyword.control`, `storage.type`, `entity.name.type`, `support.type`, `string.quoted`,
`string.regexp`, `comment`, `constant.numeric`, `keyword.operator`).

> If `.koi` files aren't recognized automatically, map the extension under
> **Settings → Editor → File Types** (or the TextMate Bundles page already binds `.koi`).

### VS Code

The same folder is a complete extension.

- **Quick try:** copy/symlink `koine-textmate` into `~/.vscode/extensions/koine-textmate` and reload.
- **Package it:** `npm i -g @vscode/vsce && cd tooling/koine-textmate && vsce package`, then install the
  resulting `.vsix` via *Extensions → … → Install from VSIX*.

## Live diagnostics (Language Server)

Syntax highlighting is static. To get **inline error squiggles** in `.koi` files — unknown types,
duplicate members, invalid invariants, syntax errors, etc. — Koine ships a small Language Server:

```bash
koine lsp        # speaks LSP over stdio, pushes textDocument/publishDiagnostics
```

It reuses the compiler's `Parse` + semantic validation, so editor diagnostics match `koine build`
exactly (same messages, same line/column).

### Editor features

Over stdio (LSP), `koine lsp` provides:

- **Diagnostics** — syntax and semantic errors as you type.
- **Completion** (`Ctrl Space`) — type names after `:`, enum members after `=`, and the declaration
  keywords valid at the current scope (e.g. `value`/`entity`/`enum` in a context, `operation` in a
  service). Completion is lexer-based, so it keeps working while the document is mid-edit and not yet
  parseable.
- **Hover** — a markdown card showing a type's kind, members (with full generic types like
  `List<OrderLine>`), and doc comment; resolves across files, and an `*Id` shows its owning entity.
- **Go-to-definition** — jump from a type, enum-member, spec, or `*Id` reference to its declaration
  in any `.koi` file in the workspace. (Navigation lands on the declaration keyword; cross-file
  *ambiguous* names — declared in two files — are not navigated. Files edited outside the editor
  re-index on server restart.)

### JetBrains Rider

Rider runs external LSP servers through the **LSP4IJ** plugin.

1. Build the CLI once: `dotnet build src/Koine.Cli -c Release`
   (note the path to `…/src/Koine.Cli/bin/Release/net10.0/Koine.Cli.dll`).
2. **Settings → Plugins → Marketplace** → install **LSP4IJ** → restart.
3. **Settings → Languages & Frameworks → Language Servers** → **+** (New Language Server):
   - **Name:** `Koine`
   - **Command:** `dotnet "<abs-path>/src/Koine.Cli/bin/Release/net10.0/Koine.Cli.dll" lsp`
   - **Mappings → File name patterns:** `*.koi`
4. **OK**, then open a `.koi` file. Errors appear as you type; fix one and the squiggle clears.

> Tip: `dotnet publish src/Koine.Cli -c Release` produces a self-contained `koine` you can point at
> directly (`/path/to/koine lsp`) instead of `dotnet … .dll lsp`.

### Viewing the server logs / troubleshooting

If the server "stopped unexpectedly", there are three places to look:

1. **LSP4IJ console (most useful).** Open **View → Tool Windows → LSP Consoles**, pick **Koine**. The
   server writes lifecycle and per-request lines to stderr, which appears here:
   ```
   [koine-lsp] server started (pid 12345)
   [koine-lsp] <- initialize
   [koine-lsp] <- textDocument/didOpen
   [koine-lsp] error handling 'textDocument/didChange': <full stack trace>   ← a real crash shows here
   ```
   For the raw JSON-RPC traffic, set the server's **Trace** to *verbose* in
   **Settings → Languages & Frameworks → Language Servers → Koine** (Debug/Trace tab).
2. **A log file.** Add an environment variable to the server config so logs are also written to disk
   (handy when the console clears on restart): set **`KOINE_LSP_LOG=/tmp/koine-lsp.log`** in the
   language-server's *Environment variables*, then `tail -f /tmp/koine-lsp.log`.
3. **Rider's own log** for plugin-level issues: **Help → Show Log in Finder/Explorer** (`idea.log`).

**Common causes of an immediate exit:**

- **Wrong command/path** — the console shows nothing or a "cannot execute" message. Double-check the
  absolute path to `Koine.Cli.dll` (rebuild first).
- **`dotnet` banner on stdout** — the .NET host's first-run/telemetry notice can corrupt the protocol
  stream. Add `DOTNET_NOLOGO=1` and `DOTNET_CLI_TELEMETRY_OPTOUT=1` to the server's environment, or use
  the `dotnet publish` binary. (The server itself routes any stray `Console.Out` writes to stderr, so it
  won't corrupt the stream on its own.)
- **A handler bug** — the server now catches per-message exceptions and logs them instead of dying, so a
  single bad message no longer takes the server down; the `[koine-lsp] error handling …` line names the
  culprit.

### VS Code

The `koine-textmate/` extension is a full VS Code extension: it contributes the `koine` language id and
highlighting **and** ships a language client (`vscode-languageclient`) that spawns `koine lsp`, so `.koi`
files get live diagnostics, completion, hover, and go-to-definition out of the box.

```
koine-textmate/
├── package.json                    # language + grammar + LSP client contribution
├── language-configuration.json     # comments, brackets, auto-closing
├── tsconfig.json                   # TypeScript build config (out/)
├── assets/icon.png                 # marketplace icon (placeholder — see note below)
├── src/extension.ts                # LanguageClient that launches the Koine LSP server
└── syntaxes/koine.tmLanguage.json  # the TextMate grammar (scopeName: source.koine)
```

**Build & run (from `tooling/koine-textmate/`):**

```bash
npm install        # installs vscode-languageclient + the TypeScript toolchain
npm run compile    # tsc -> out/extension.js
```

Then open the `koine-textmate/` folder in VS Code and press **F5** ("Run Extension") to launch an
Extension Development Host with the extension loaded. Open any `.koi` file and diagnostics appear as you
type. To package a `.vsix`: `npm run install-vsce && npm run package`.

**How it spawns the server.** On the first `.koi` document (`activationEvents: onLanguage:koine`),
`extension.ts` starts a `LanguageClient` whose `serverOptions` spawn the server over stdio. The command
is driven by settings:

| Setting | Default | Effect |
| --- | --- | --- |
| `koine.server.path` | *(empty)* | Launches `koine lsp` from your `PATH`. Set to an absolute published binary, or to `dotnet` to run from source. |
| `koine.server.args` | `[]` | Args inserted **before** `lsp`. For source: `["run", "--project", "src/Koine.Cli", "--"]`. |
| `koine.trace.server` | `off` | LSP traffic tracing (`messages` / `verbose`) in the *Koine Language Server* output channel. |

So `koine.server.path: "dotnet"` + `koine.server.args: ["run", "--project", "src/Koine.Cli", "--"]`
runs `dotnet run --project src/Koine.Cli -- lsp`. The client forces `DOTNET_NOLOGO=1` and
`DOTNET_CLI_TELEMETRY_OPTOUT=1` in the server's environment so the .NET host's first-run banner can't
corrupt the stdio JSON-RPC stream.

> **Publishing notes.** `package.json` uses the placeholder publisher `atypical-consulting`; register it
> on the VS Code Marketplace (`vsce create-publisher`) before publishing. `assets/icon.png` is a generated
> solid-color placeholder — replace it with a real 128×128 icon for the listing.

### Verifying the grammar

The grammar was tested against the real TextMate engine (`vscode-textmate` + `vscode-oniguruma`).
To re-check after edits:

```bash
cd /tmp && npm i vscode-textmate vscode-oniguruma
# then tokenize a sample file with grammar scopeName "source.koine"
```
