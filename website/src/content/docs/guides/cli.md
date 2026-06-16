---
title: "CLI reference"
description: "The koine command — build, check, lsp, and every flag, with exit codes and diagnostic format."
---

The `koine` CLI is the whole compiler. It has three subcommands — `build`, `check`, and `lsp` — plus `--version`. Everything you do with Koine, from emitting C# to gating a CI pipeline on breaking changes, runs through this one tool.

In this repo you invoke it via `dotnet run`:

```bash
dotnet run --project src/Koine.Cli -- <subcommand> [args]
```

Everything after `--` is passed to `koine`. The examples below use `koine` for brevity; prefix them with `dotnet run --project src/Koine.Cli --` when running from source.

## At a glance

```bash
koine --version
koine build <file.koi|dir> [--target csharp|glossary] [--out <dir>] [--glossary <file.md>]
koine check <file.koi|dir> --baseline <dir>   # flag breaking changes vs a published baseline
koine lsp                                      # Language Server (stdio) for editor diagnostics
```

Run `koine` with no arguments (or `koine --help`) to print this usage.

## A path is a file *or* a directory

Every subcommand that takes a model accepts either a single `.koi` file or a **directory**. Given a directory, the CLI reads every `.koi` file under it recursively, in deterministic (ordinal) order, and compiles them **as one model**. This is how cross-file `import`s, the `contextmap`, and integration events resolve across files — they all see one another in a single pass.

```bash
# one file
koine build demo/Shop.Domain/Models/catalog.koi

# the whole context map, compiled together
koine build demo/Shop.Domain/Models --out demo/Shop.Domain/Generated
```

:::tip
Real projects always point `build` at a directory. The Shop demo's MSBuild target runs `koine build Models --target csharp --out Generated` so the six contexts and their `contextmap` compile as a unit. See [Installation](/Koine/start/installation/) for wiring `build` into a `.csproj`.
:::

## `koine build`

Parses and validates the model, then — if you ask for output — emits files.

| Flag | Default | What it does |
|------|---------|--------------|
| *(positional)* | — | The `.koi` file or directory to compile. Required. |
| `--target` | `csharp` | The emitter: `csharp` or `glossary`. |
| `--out <dir>` | *(none)* | Write the emitted files under this directory. Omit to only validate. |
| `--glossary <file.md>` | *(none)* | Also write a Markdown ubiquitous-language glossary to this file. |

### Validate only

With no `--out`, `build` parses, validates, and reports diagnostics — but writes nothing. It's the fastest way to check a model is well-formed:

```bash
koine build demo/Shop.Domain/Models
# OK: demo/Shop.Domain/Models parsed and validated
```

Exit code is `0` when the model is valid, `1` when there is any error diagnostic.

### Emit C#

Point `--out` at a directory to write the generated C#:

```bash
koine build demo/Shop.Domain/Models --out demo/Shop.Domain/Generated
# wrote 71 files to demo/Shop.Domain/Generated
```

The emitter lays types out by context into namespace-mirroring folders (`Catalog/`, `Ordering/Order.cs`, …). Before writing, `build` **deletes the top-level folders it owns** under `--out` and regenerates them, so a type you renamed or removed never leaves a stale orphan behind. It only touches the namespace roots it produced this run — hand-written files elsewhere in the directory are left alone.

:::caution
`--out` is destructive *within the folders Koine generates*. Point it at a dedicated output directory (the demo uses `Generated/`, git-ignored), never at a folder that also holds files you wrote by hand.
:::

### Emit a glossary

There are two ways to get a Markdown glossary. The `--glossary` flag writes one to a named file **independently** of `--target`/`--out`, so you can emit C# *and* a glossary in a single run:

```bash
koine build demo/Shop.Domain/Models --out Generated --glossary shop.glossary.md
# wrote glossary to shop.glossary.md
# wrote 71 files to Generated
```

Alternatively, `--target glossary` makes the glossary the primary output (paired with `--out`). Either way the glossary is grouped by context (each heading shows its `version`), then by type, listing fields, derived fields, and business rules.

## `koine check`

Backward-compatibility gate. It compiles a **current** model and a **baseline** model, then reports every change to a *published* surface — and fails if any change is breaking. This is what you run in CI to stop a breaking change from shipping.

```bash
koine check <current-file-or-dir> --baseline <baseline-dir>
```

| Flag | Required | What it does |
|------|----------|--------------|
| *(positional)* | yes | The current model (file or dir). |
| `--baseline <dir>` | yes | The previously published model to compare against. |

"Published surfaces" means only the parts of the language other teams depend on: **integration events**, **shared-kernel types**, and **open-host value objects**. Internal refactors — renaming a private field, restructuring an aggregate's commands — are invisible to `check`. See [Versioning & evolution](/Koine/reference/versioning/) for what counts as published and which changes are breaking.

### A worked example

A complete before/after lives under [`examples/versioning/`](https://github.com/Atypical-Consulting/Koine/tree/main/examples/versioning). The v2 contract adds an optional field (fine) and removes a published field (breaking):

```koine
context Sales version 2 {

  integration event OrderPlaced {
    orderId: OrderId
    total:   Decimal
    // coupon removed  -> BREAKING (PublishedFieldRemoved)
    @since(2) note: String?     // added optional field -> backward-compatible
  }

  publishes OrderPlaced
}
```

```bash
koine check examples/versioning/v2 --baseline examples/versioning/v1
# breaking KOI1511: field 'coupon' of published integration event 'OrderPlaced' was removed.
# non-breaking: field 'note' of published integration event 'OrderPlaced' was added.
# error: 1 breaking change(s) to published surfaces
```

Breaking changes print to stderr prefixed `breaking <CODE>:`; non-breaking changes print to stdout prefixed `non-breaking:`. The breaking-change codes live in the `KOI15xx` range (`PublishedTypeRemoved`, `PublishedFieldRemoved`, `PublishedFieldTypeChanged`, `PublishedFieldNowRequired`, `PublishedRequiredFieldAdded`).

### Exit codes

| Exit | Meaning |
|------|---------|
| `0` | No breaking changes. Prints `OK: no breaking changes to published surfaces`. |
| `1` | At least one breaking change — or either model failed to parse. |

Because a parse failure in *either* model also exits `1`, a green `koine check` proves both models compiled *and* the evolution is safe. Drop it straight into a CI step.

## `koine lsp`

Starts the Koine **Language Server** over stdio. It powers in-editor diagnostics, hover, and go-to-definition (including cross-file workspace navigation). You don't run it by hand — your editor's Koine extension launches `koine lsp` and speaks LSP to it over stdin/stdout. See the [editor tooling guide](/Koine/guides/editor-tooling/).

```bash
koine lsp   # blocks, reading LSP messages on stdin
```

## `koine --version`

Prints the compiler version and exits `0`. `-v` is an alias.

```bash
koine --version
# 1.0.0.0
```

## Diagnostics

Every diagnostic `build` (and the parse step of `check`) emits uses a single, **MSBuild- and Roslyn-parseable** format:

```
file:line:col: severity KOIxxxx: message
```

For example, a typo'd type name:

```bash
koine build demo/Shop.Domain/Models
# catalog.koi:14:18: error KOI0101: unknown type 'Currancy' — did you mean 'Currency'?
```

Three things make these diagnostics worth reading:

- **Stable codes.** Every diagnostic carries a `KOIxxxx` code that never changes and is never reused, so you can search, suppress, or document against it. Codes are grouped by area — `KOI00xx` syntax, `KOI01xx` declarations, `KOI02xx` expressions, `KOI12xx` application layer, `KOI15xx` versioning, and so on.
- **Multi-error recovery.** The compiler doesn't stop at the first error. It recovers and reports as many independent problems as it can in one run, so you fix a batch per build instead of one-at-a-time.
- **"Did you mean…?"** When a name doesn't resolve — an unknown type, field, member, or enum case — the compiler suggests the nearest declared name (`— did you mean 'Currency'?`) when there's a close match.

Diagnostics go to **stderr**; success messages (`OK: …`, `wrote N files to …`) go to **stdout**. Any error diagnostic makes `build` exit `1`.

## Exit codes, summarised

| Code | When |
|------|------|
| `0` | Success — model valid, files written, or no breaking changes. |
| `1` | Usage error, file/path not found, a parse/validation error, an unknown command, or a breaking change from `check`. |

## See also

- [Installation](/Koine/start/installation/) — building the CLI and wiring `koine build` into a `.csproj` via MSBuild.
- [Versioning & evolution](/Koine/reference/versioning/) — `version`, `@since`, and what `koine check` enforces.
- [Reading the generated C#](/Koine/start/reading-the-output/) — what `koine build` emits, file by file.
- [Editor tooling](/Koine/guides/editor-tooling/) — what `koine lsp` powers.
