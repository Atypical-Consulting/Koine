---
title: "Editor tooling"
description: "Syntax highlighting and the language server for Rider and VS Code."
---

Writing `.koi` is nicer with an editor that understands it. Koine ships two pieces of tooling, both
living under `tooling/` in the repo:

- a **TextMate grammar** (`tooling/koine-textmate`) for syntax highlighting, and
- a **language server** (`koine lsp`) for live diagnostics, completion, hover, and go-to-definition.

The grammar works in JetBrains Rider (and any IntelliJ-based IDE) and VS Code. The language server is
wired up in Rider today via the LSP4IJ plugin; a thin VS Code client is a small follow-up.

## Syntax highlighting

`tooling/koine-textmate/` is a TextMate grammar bundle that is *also* a valid VS Code grammar
extension. It scopes keywords, declaration names, field names, primitive types, invariants, the
`matches /regex/` literal, strings, numbers, comments, and operators.

```
koine-textmate/
├── package.json                    # language + grammar contribution
├── language-configuration.json     # comments, brackets, auto-closing
└── syntaxes/koine.tmLanguage.json  # the TextMate grammar (scopeName: source.koine)
```

Colors follow your active color scheme through standard TextMate scopes — `keyword.control`,
`storage.type`, `entity.name.type`, `support.type`, `string.quoted`, `string.regexp`, `comment`,
`constant.numeric`, and `keyword.operator` — so it looks at home in whatever theme you use.

### JetBrains Rider (and IntelliJ-based IDEs)

Rider reads TextMate bundles directly — no plugin or build step needed.

1. **Settings / Preferences** → **Editor** → **TextMate Bundles**.
2. Click **+** and select the `tooling/koine-textmate` folder.
3. Click **OK** / **Apply**.

Open any `.koi` file (for example `demo/Shop.Domain/Models/catalog.koi`) and it lights up.

:::note
If `.koi` files aren't recognized automatically, map the extension under **Settings → Editor → File
Types**. (The TextMate Bundles page usually binds `.koi` for you.)
:::

### VS Code

The same folder is a complete extension.

- **Quick try:** copy or symlink `koine-textmate` into `~/.vscode/extensions/koine-textmate` and reload.
- **Package it:** install the packager and build a `.vsix`:

  ```bash
  npm i -g @vscode/vsce
  cd tooling/koine-textmate && vsce package
  ```

  Then install the resulting `.vsix` via **Extensions → … → Install from VSIX**.

The extension contributes the `koine` language id, so VS Code already knows `.koi` files are Koine —
which is exactly what the language client below hooks into.

## The language server

Syntax highlighting is static — it never reads your *whole* model. To get inline error squiggles for
unknown types, duplicate members, invalid invariants, and syntax errors, Koine ships a small language
server:

```bash
koine lsp        # speaks LSP over stdio, pushes textDocument/publishDiagnostics
```

The key property: **`koine lsp` reuses the compiler's own `Parse` + semantic validation.** Editor
diagnostics are produced by the same code path as `koine build`, so you get the same messages at the
same line and column. There is no second, drifting implementation of the rules — if the editor flags
it, the build flags it, and vice versa.

:::tip
Because the server *is* the compiler, fixing a squiggle in the editor is the same as fixing a build
error. See [the CLI reference](/Koine/guides/cli/) for what `koine build` and `koine check` report.
:::

### Editor features

Over stdio, `koine lsp` provides:

- **Diagnostics** — syntax and semantic errors as you type.
- **Completion** (`Ctrl Space`) — type names after `:`, enum members after `=`, and the declaration
  keywords valid at the current scope (for example `value` / `entity` / `enum` inside a context, or
  `operation` inside a service). Completion is lexer-based, so it keeps working while the document is
  mid-edit and not yet parseable.
- **Hover** — a markdown card showing a type's kind, members (with full generic types like
  `List<OrderLine>`), and doc comment. It resolves across files, and an `*Id` reference shows its
  owning entity.
- **Go-to-definition** — jump from a type, enum-member, spec, or `*Id` reference to its declaration in
  any `.koi` file in the workspace.

:::note
Go-to-definition lands on the declaration keyword. Cross-file *ambiguous* names — the same name
declared in two files — are not navigated. Files edited outside the editor re-index on server restart.
:::

### Setup in JetBrains Rider

Rider runs external LSP servers through the **LSP4IJ** plugin.

1. Build the CLI once so the server binary exists:

   ```bash
   dotnet build src/Koine.Cli -c Release
   ```

   Note the path to `…/src/Koine.Cli/bin/Release/net10.0/Koine.Cli.dll`.
2. **Settings → Plugins → Marketplace** → install **LSP4IJ** → restart.
3. **Settings → Languages & Frameworks → Language Servers** → **+** (New Language Server):
   - **Name:** `Koine`
   - **Command:** `dotnet "<abs-path>/src/Koine.Cli/bin/Release/net10.0/Koine.Cli.dll" lsp`
   - **Mappings → File name patterns:** `*.koi`
4. **OK**, then open a `.koi` file. Errors appear as you type; fix one and the squiggle clears.

:::tip
`dotnet publish src/Koine.Cli -c Release` produces a self-contained `koine` executable you can point
at directly (`/path/to/koine lsp`) instead of `dotnet … .dll lsp`. This also sidesteps the
`dotnet`-banner gotcha below.
:::

### Setup in VS Code

The TextMate extension already supplies the `koine` language id and highlighting. To add diagnostics,
pair it with a thin language client (`vscode-languageclient`) that spawns `koine lsp` for documents of
language `koine`. This client is a small follow-up — tracked as R17.2 in
[USER-STORIES.md](https://github.com/Atypical-Consulting/Koine/blob/main/USER-STORIES.md) — and isn't
shipped yet; highlighting works today regardless.

## Troubleshooting the server

If LSP4IJ reports that the server "stopped unexpectedly", there are three places to look:

1. **LSP4IJ console (most useful).** **View → Tool Windows → LSP Consoles → Koine**. The server writes
   lifecycle and per-request lines to stderr, which appear here:

   ```
   [koine-lsp] server started (pid 12345)
   [koine-lsp] <- initialize
   [koine-lsp] <- textDocument/didOpen
   [koine-lsp] error handling 'textDocument/didChange': <full stack trace>   ← a real crash shows here
   ```

   For raw JSON-RPC traffic, set the server's **Trace** to *verbose* under
   **Settings → Languages & Frameworks → Language Servers → Koine**.
2. **A log file.** Set `KOINE_LSP_LOG=/tmp/koine-lsp.log` in the language server's *Environment
   variables*, then `tail -f /tmp/koine-lsp.log` (handy when the console clears on restart).
3. **Rider's own log** for plugin-level issues: **Help → Show Log in Finder/Explorer** (`idea.log`).

Common causes of an immediate exit:

| Symptom | Cause | Fix |
| --- | --- | --- |
| Console empty or "cannot execute" | Wrong command/path | Re-check the absolute path to `Koine.Cli.dll`; rebuild first |
| Protocol stream corrupted on start | The .NET host's first-run / telemetry banner lands on stdout | Add `DOTNET_NOLOGO=1` and `DOTNET_CLI_TELEMETRY_OPTOUT=1` to the server's environment, or use the `dotnet publish` binary |
| `[koine-lsp] error handling …` line | A handler bug on one message | The server catches per-message exceptions and logs them instead of dying — the named line points at the culprit |

## See also

- [CLI reference](/Koine/guides/cli/) — `koine build` and `koine check`, which share the server's parser and validator.
- [Your first model](/Koine/start/your-first-model/) — write a `.koi` file to try the tooling on.
- [Language reference](/Koine/reference/overview/) — the constructs the grammar highlights and the server understands.
