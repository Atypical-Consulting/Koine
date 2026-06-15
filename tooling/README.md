# Koine editor tooling

## Syntax highlighting for `.koi`

`koine-textmate/` is a TextMate grammar bundle (also a valid VS Code grammar extension) that
highlights Koine source. It scopes keywords, declaration names, field names, primitive types,
invariants, the `matches /regex/` literal, strings, numbers, comments, and operators.

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
- **Hover** — a markdown card showing a type's kind, its members (with full generic types, e.g.
  `List<OrderLine>`), and its `///` doc comment; enum members and specs are described too.
- **Go-to-definition** — jump from a type, enum-member, or spec reference to its declaration. (Note:
  navigation currently lands on the declaration keyword, not the name token; ambiguous enum members —
  declared in more than one enum — are not navigated.)

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

The TextMate extension supplies the `koine` language id and highlighting. To add diagnostics, pair it
with a thin language client (`vscode-languageclient`) that spawns `koine lsp` for documents of language
`koine` — a small follow-up (see `USER-STORIES.md` R17.2).

### Verifying the grammar

The grammar was tested against the real TextMate engine (`vscode-textmate` + `vscode-oniguruma`).
To re-check after edits:

```bash
cd /tmp && npm i vscode-textmate vscode-oniguruma
# then tokenize a sample file with grammar scopeName "source.koine"
```
