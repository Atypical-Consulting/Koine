---
title: "CLI reference"
description: "The koine command — build, check, fmt, init, watch, lsp, and every flag, with exit codes and diagnostic format."
---

The `koine` CLI is the whole compiler. It has six subcommands — `build`, `check`, `fmt`, `init`, `watch`, and `lsp` — plus `--version`. Everything you do with Koine, from emitting C# to scaffolding a project, formatting `.koi`, or gating a CI pipeline on breaking changes, runs through this one tool.

In this repo you invoke it via `dotnet run`:

```bash
dotnet run --project src/Koine.Cli -- <subcommand> [args]
```

Everything after `--` is passed to `koine`. The examples below use `koine` for brevity; prefix them with `dotnet run --project src/Koine.Cli --` when running from source.

Want to try the compiler without installing anything? The <a class="koi-try" href="/Koine/studio/">browser-based Koine Studio</a> runs the same parser, validator, and emitters as the CLI.

## At a glance

```bash
koine --version
koine build <file.koi|dir> [--target csharp|typescript|python|php|rust|glossary|docs] [--out <dir>] [--glossary <file.md>] [--config <file>]
koine watch <file.koi|dir> [--target …] [--out …] [--config <file>]   # rebuild on every change
koine fmt   <file.koi|dir> [--check]            # canonically format .koi (--check: verify only)
koine init  [dir] [--force]                    # scaffold a starter project
koine check <file.koi|dir> --baseline <dir>    # flag breaking changes vs a published baseline
koine lsp                                      # Language Server (stdio) for editor diagnostics
```

Run `koine` with no arguments (or `koine --help`) to print this usage.

## A path is a file *or* a directory

Every subcommand that takes a model accepts either a single `.koi` file or a **directory**. Given a directory, the CLI reads every `.koi` file under it recursively, in deterministic (ordinal) order, and compiles them **as one model**. This is how cross-file `import`s, the `contextmap`, and integration events resolve across files — they all see one another in a single pass.

```bash
# one file
koine build templates/pizzeria/menu.koi

# the whole context map, compiled together
koine build templates/pizzeria --out demo/Pizzeria.Domain/Generated
```

:::tip
Real projects always point `build` at a directory. The pizzeria demo's MSBuild target runs `koine build templates/pizzeria --target csharp --out Generated` so all its contexts and their `contextmap` compile as a unit. See [Installation](/Koine/start/installation/) for wiring `build` into a `.csproj`.
:::

## `koine build`

Parses and validates the model, then — if you ask for output — emits files.

| Flag | Default | What it does |
|------|---------|--------------|
| *(positional)* | — | The `.koi` file or directory to compile. Required. |
| `--target` | `csharp` | The emitter: `csharp`, `typescript`, `python`, `php`, `rust`, `glossary`, or `docs`. |
| `--layers <list>` | `domain` | (C# only) Comma-separated layers to emit: `domain` (the model + application contracts) and/or `infrastructure` (a runnable EF Core realization — `DbContext`, repositories, unit of work, outbox, DI). `infrastructure` implies `domain`. See [C# infrastructure layer](#c-infrastructure-layer---layers). |
| `--out <dir>` | *(none)* | Write the emitted files under this directory. Omit to only validate. |
| `--layers <list>` | `domain` | Comma-separated output layers (`domain`, `application`). `application` implies `domain`. C# only. See [the Application layer](#the-c-application-layer). |
| `--app-mediatr` | *(off)* | Application layer: emit the MediatR request/handler shape + validation/transaction pipeline behaviors instead of plain handlers. |
| `--app-mapping <mode>` | `plain` | Application layer: DTO/read-model mapping strategy — `plain` (hand-rolled) or `mapperly` (reserved). |
| `--glossary <file.md>` | *(none)* | Also write a Markdown ubiquitous-language glossary to this file. |
| `--config <file>` | *(discovered)* | Read build defaults from this `koine.config` instead of the discovered one. See [`koine.config`](#koineconfig). |

`--target` and `--out` may also be supplied by a `koine.config` beside the model — an explicit flag always wins. See [`koine.config`](#koineconfig) below.

### Validate only

With no `--out`, `build` parses, validates, and reports diagnostics — but writes nothing. It's the fastest way to check a model is well-formed:

```bash
koine build templates/pizzeria
# OK: templates/pizzeria parsed and validated
```

Exit code is `0` when the model is valid, `1` when there is any error diagnostic.

### Emit C#

Point `--out` at a directory to write the generated C#:

```bash
koine build templates/pizzeria --out demo/Pizzeria.Domain/Generated
# wrote 91 files to demo/Pizzeria.Domain/Generated
```

The emitter lays types out by context into namespace-mirroring folders (`Menu/`, `Ordering/Order.cs`, …). Before writing, `build` **deletes the top-level folders it owns** under `--out` and regenerates them, so a type you renamed or removed never leaves a stale orphan behind. It only touches the namespace roots it produced this run — hand-written files elsewhere in the directory are left alone.

:::caution
`--out` is destructive *within the folders Koine generates*. Point it at a dedicated output directory (the demo uses `Generated/`, git-ignored), never at a folder that also holds files you wrote by hand.
:::

### The C# Application layer

By default the C# target emits the application **contracts** only — `IUnitOfWork`, the `I<Service>`
use-case interfaces, read-model projections, query objects and `IQueryHandler<,>` — with no
implementations. Add `application` to `--layers` to also emit the layer that fills them in:

```bash
koine build templates/pizzeria --target csharp --layers domain,application --out Generated
```

Per aggregate **command** and **factory** it emits a request `record`, a handler that loads the
aggregate via its `IUnitOfWork` repository, invokes the behavior and calls `SaveChangesAsync`, and a
**FluentValidation** validator whose rules are rendered from the same invariants the domain enforces.
Per **query** it emits a concrete `IQueryHandler<,>` (a single result keyed by the root's identity
loads + projects via the `To<ReadModel>` mapper). It also emits an
`Add<Context>Application(this IServiceCollection)` DI extension registering them all.

Plain handlers (no runtime dependency beyond FluentValidation) are the default. Two opt-in
sub-options:

- `--app-mediatr` — emit the **MediatR** shape (`IRequest`/`IRequest<T>`, `IRequestHandler<,>`, and
  validation + transaction `IPipelineBehavior<,>`s) instead of plain handlers.
- `--app-mapping plain|mapperly` — mapping strategy (`mapperly` reserved for source-generated mapping).

With the layer **off** (the default), the emitted C# is byte-identical to before. Koine `usecase`
declarations carry no binding to a specific aggregate behavior, so the generated `I<Service>`
implementation throws `NotImplementedException` until wired — the generated command/factory handlers
are the real entry points. The sub-options can also be set in `koine.config`
(`targets.csharp.layers`, `targets.csharp.application.mediatr`, `targets.csharp.application.mapping`).

### C# infrastructure layer (`--layers`)

By default the C# target emits the **domain layer**: value objects, entities, aggregates, smart enums, events, and the *persistence-ignorant* application contracts (`IRepository`, `IUnitOfWork`). Add `--layers domain,infrastructure` to also emit a runnable **EF Core** realization of those contracts, regenerated from the model on every build:

```bash
koine build templates/pizzeria --out Generated --layers domain,infrastructure
```

Per bounded context, the infrastructure layer adds (under an `Infrastructure/` folder):

- a `<Context>DbContext : DbContext` with one `DbSet` per aggregate root;
- an `IEntityTypeConfiguration<Root>` per aggregate — value objects → owned types (`OwnsOne`/`OwnsMany`), the `versioned` token → `IsRowVersion()`, smart enums → `HasConversion` value converters, strongly-typed IDs → key converters;
- a concrete `<Root>Repository : I<Root>Repository` and a `UnitOfWork : IUnitOfWork`;
- a transactional `OutboxMessage` table + an `IntegrationEventDispatcher` (only when the context publishes an integration event);
- an `Add<Context>Infrastructure(this IServiceCollection, Action<DbContextOptionsBuilder>)` DI extension — you supply the database provider, so the emitter stays provider-agnostic.

`--layers domain` (or omitting the flag) keeps the output **byte-identical** to before. EF Core is the only backend in v1.

### Emit a glossary

There are two ways to get a Markdown glossary. The `--glossary` flag writes one to a named file **independently** of `--target`/`--out`, so you can emit C# *and* a glossary in a single run:

```bash
koine build templates/pizzeria --out Generated --glossary pizzeria.glossary.md
# wrote glossary to pizzeria.glossary.md
# wrote 91 files to Generated
```

Alternatively, `--target glossary` makes the glossary the primary output (paired with `--out`). Either way the glossary is grouped by context (each heading shows its `version`), then by type, listing fields, derived fields, and business rules.

### `koine.config`

A `koine.config` file supplies defaults for the `build`/`watch` flags so you don't repeat `--target`/`--out` on every invocation. It is a tiny `key = value` format — one pair per line, `#` starts a comment:

```ini
# koine.config — build defaults for this domain model.
target = csharp
out = generated
```

**Discovery.** Unless you pass `--config <file>` explicitly, `build` and `watch` look for a file literally named `koine.config`, in order:

1. the directory of the input path (or the input directory itself, when you point the command at a folder), then
2. the current working directory.

The first one found wins; if none is found, no defaults are applied. A flag on the command line always overrides the config.

**Keys read today.** The flat keys `target` (`csharp`, `typescript`, `python`, `php`, `rust`, `glossary`, or `docs`) and `out` (the output directory) are honoured, plus the per-target key `targets.csharp.layers` (e.g. `domain,infrastructure`) — the config equivalent of [`--layers`](#c-infrastructure-layer---layers), overridden by an explicit `--layers` flag. Every other key is **silently ignored**, which keeps the file forward-compatible — older tooling tolerates a newer config.

:::note[`targets.*` is reserved for R16]
A structured `targets.<name> = { … }` block (per-target namespace maps, `instantMode`, output layout) is sketched in the scaffolded config but **not yet implemented** — it is reserved for [R16](/Koine/guides/roadmap/#r16--multi-target-emitters) and ignored today. `koine init` writes a commented example of it for forward reference.
:::

## `koine fmt`

Canonically formats `.koi` source. The formatter is a deterministic, **idempotent** token-stream reprinter: running it twice produces the same bytes as running it once. Point it at a file or a directory (every `.koi` underneath is formatted).

```bash
koine fmt templates/pizzeria
# formatted templates/pizzeria/menu.koi
# formatted 1 of 7 file(s)
```

| Flag | Default | What it does |
|------|---------|--------------|
| *(positional)* | — | The `.koi` file or directory to format. Required. |
| `--check` | off | **Verify only.** Writes nothing; reports each file that is not already formatted and exits non-zero if any need formatting. Use it in CI. |

Without `--check`, `fmt` rewrites each unformatted file in place and prints what it changed; files already in canonical form are left untouched (`OK: N file(s) already formatted`).

With `--check`, nothing is written. Each unformatted file is reported to stderr (`path: not formatted`); if any file would change, it prints an `error: N file(s) need formatting` message (telling you to run `koine fmt`) and exits `1`. A clean tree prints `OK: N file(s) already formatted` and exits `0` — drop it straight into a CI step.

### Exit codes

| Exit | Meaning |
|------|---------|
| `0` | Files formatted (or all already formatted; with `--check`, all already formatted). |
| `1` | Path not found, no `.koi` files found, a usage error — or, with `--check`, at least one file needs formatting. |

## `koine init`

Scaffolds a starter Koine project: a `domain.koi` model, a `koine.config` with build defaults, and a `README.md`. The scaffold builds end-to-end out of the box.

```bash
koine init my-domain
# initialized koine project in my-domain
#   domain.koi     starter model
#   koine.config   build defaults
#   README.md      project notes
# next: koine build my-domain/domain.koi
```

| Flag | Default | What it does |
|------|---------|--------------|
| *(positional)* | `.` | The target directory (created if missing). Defaults to the current directory. |
| `--force` | off | Overwrite existing scaffold files. Without it, `init` refuses if any of `domain.koi`, `koine.config`, or `README.md` already exist. |

Without `--force`, `init` will not clobber your work: if any scaffold file already exists it prints `error: refusing to overwrite existing file(s): … (use --force)` and exits `1`.

### Exit codes

| Exit | Meaning |
|------|---------|
| `0` | Project scaffolded. |
| `1` | A scaffold file already exists and `--force` was not given, or a usage error. |

## `koine watch`

Like `build`, but it stays running and **re-emits on every change**. It watches the input's directory (recursively) for `*.koi` edits, debounces a burst of saves, and runs a fresh build for each batch — fast feedback while you model. It accepts the same flags as `build` (`--target`, `--out`, `--config`); `--out` makes it re-emit C# on save, while omitting it gives you continuous validation.

```bash
koine watch templates/pizzeria --out demo/Pizzeria.Domain/Generated
# watching templates/pizzeria for *.koi changes — press Ctrl+C to stop
```

Press **Ctrl+C** to stop; `watch` unwinds cleanly and exits `0`. Like `build`, `--target`/`--out` fall back to a discovered (or `--config`) `koine.config` when omitted.

### Exit codes

| Exit | Meaning |
|------|---------|
| `0` | Stopped cleanly with Ctrl+C. |
| `1` | A usage error before the watch loop starts (e.g. missing path, unknown option). |

A failing build *within* a watch session prints its diagnostics but keeps watching — `watch` doesn't exit on a per-build error, so you fix and save again.

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
koine build templates/pizzeria
# menu.koi:14:18: error KOI0101: unknown type 'Currancy' — did you mean 'Currency'?
```

Three things make these diagnostics worth reading:

- **Stable codes.** Every diagnostic carries a `KOIxxxx` code that never changes and is never reused, so you can search, suppress, or document against it. Codes are grouped by area — `KOI00xx` syntax, `KOI01xx` declarations, `KOI02xx` expressions, `KOI12xx` application layer, `KOI15xx` versioning, and so on.
- **Multi-error recovery.** The compiler doesn't stop at the first error. It recovers and reports as many independent problems as it can in one run, so you fix a batch per build instead of one-at-a-time.
- **"Did you mean…?"** When a name doesn't resolve — an unknown type, field, member, or enum case — the compiler suggests the nearest declared name (`— did you mean 'Currency'?`) when there's a close match.

Diagnostics go to **stderr**; success messages (`OK: …`, `wrote N files to …`) go to **stdout**. Any error diagnostic makes `build` exit `1`.

## Exit codes, summarised

| Code | When |
|------|------|
| `0` | Success — model valid, files written, formatted (or already formatted), project scaffolded, no breaking changes, or `watch` stopped cleanly. |
| `1` | Usage error, file/path not found, a parse/validation error, an unknown command, a breaking change from `check`, a `--check` formatting failure, or `init` refusing to overwrite. |

## See also

- [Installation](/Koine/start/installation/) — building the CLI and wiring `koine build` into a `.csproj` via MSBuild.
- [Versioning & evolution](/Koine/reference/versioning/) — `version`, `@since`, and what `koine check` enforces.
- [Reading the generated C#](/Koine/start/reading-the-output/) — what `koine build` emits, file by file.
- [Editor tooling](/Koine/guides/editor-tooling/) — what `koine lsp` powers.
