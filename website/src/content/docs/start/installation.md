---
title: "Installation"
description: "Get the Koine compiler building and run it from the .NET CLI."
---

Koine ships as source. You clone the repository and build it with the .NET SDK; the CLI is packaged
as a [.NET tool](#install-as-a-global-tool), so you can also install a short `koine` command instead
of typing `dotnet run` each time — see [Install the `koine` command](#install-the-koine-command) below.

## Prerequisites

- **.NET 10 SDK** or newer. The whole solution targets `net10.0`. Check what you have:

  ```bash
  dotnet --version
  ```

  If you don't see a `10.x` SDK, install it from [the .NET download page](https://dotnet.microsoft.com/download).
- **Git**, to clone the repository.

That's the entire toolchain. Koine has no other runtime dependencies — the compiler is a plain .NET
console app, and the C# it emits is self-contained.

## Clone and build

```bash
git clone https://github.com/Atypical-Consulting/Koine.git
cd Koine
```

Build the solution and run the test suite in one shot:

```bash
./scripts/build/build.sh
```

`scripts/build/build.sh` is a thin wrapper around the SDK — it runs `dotnet build` followed by
`dotnet test`. If you prefer to drive the SDK yourself (or you're on Windows), the equivalent is:

```bash
dotnet build
dotnet test
```

:::tip
On Windows, `scripts\build\build.cmd` and `build.ps1` do the same thing as `build.sh`.
:::

A green test run means the compiler is ready to use.

## Invoke the CLI

The compiler lives in the `Koine.Cli` project. You run it with `dotnet run --project`, passing the
compiler's own arguments after a `--` separator:

```bash
dotnet run --project src/Koine.Cli -- <args>
```

Everything before `--` is for `dotnet run`; everything after is for Koine. Start by confirming it
works:

```bash
dotnet run --project src/Koine.Cli -- --version
```

```text
1.0.0.0
```

Run it with no arguments (or `--help`) to see the full usage:

```bash
dotnet run --project src/Koine.Cli -- --help
```

```text
Koine — a DSL for Domain-Driven Design.

Usage:
  koine --version
  koine build <file.koi|dir> [--target csharp|glossary] [--out <dir>] [--glossary <file.md>] [--config <file>]
  koine watch <file.koi|dir> [--target …] [--out …] [--config <file>]   # rebuild on every change
  koine fmt   <file.koi|dir> [--check]            # canonically format .koi (--check: verify only)
  koine init  [dir] [--force]                    # scaffold a starter project
  koine check <file.koi|dir> --baseline <dir>    # flag breaking changes vs a published baseline
  koine lsp                                      # Language Server (stdio) for editor diagnostics
```

## Build your first model

The repository ships a starter model at `templates/starters/billing/billing.koi`. Just *checking* that a model parses and
validates — no output written — is the fastest round-trip:

```bash
dotnet run --project src/Koine.Cli -- build templates/starters/billing/billing.koi
```

```text
OK: templates/starters/billing/billing.koi parsed and validated
```

To actually emit C#, add `--target csharp` and an `--out` directory:

```bash
dotnet run --project src/Koine.Cli -- build templates/starters/billing/billing.koi --target csharp --out ./generated
```

```text
wrote 15 files to ./generated
```

The generated C# under `./generated` is self-contained — it compiles on its own, with no reference to
Koine. That `build` argument is the heart of the compiler; the
[CLI reference](/Koine/guides/cli/) covers `build`, `check`, the `glossary` target, and the LSP
server in full.

:::note
The argument to `build` can be a single `.koi` file **or** a directory. Point it at a folder and Koine
compiles every `.koi` file underneath it as one model — that's how multi-file domains like the
[demo](https://github.com/Atypical-Consulting/Koine/tree/main/demo) are built.
:::

## Install the `koine` command

Typing `dotnet run --project src/Koine.Cli -- …` for every invocation gets old fast. There are two
ways to get a short `koine` command.

### Install as a global tool

The CLI is packaged as a .NET tool (`PackAsTool`, command name `koine`). Pack it from source, then
install it globally:

```bash
dotnet pack src/Koine.Cli -c Release -o ./nupkg
dotnet tool install -g --add-source ./nupkg Koine.Cli
koine --version
```

```text
0.17.3
```

`koine` is now on your `PATH`, so every example in the docs works verbatim — `koine build …`,
`koine fmt …`, `koine init …`. Update later with `dotnet tool update -g --add-source ./nupkg Koine.Cli`,
or remove it with `dotnet tool uninstall -g Koine.Cli`.

### Or publish a self-contained binary

If you'd rather not install a tool, publish the CLI once and alias the produced binary to `koine`:

```bash
dotnet publish src/Koine.Cli -c Release -o ./bin
alias koine="$PWD/bin/Koine.Cli"
koine --version
```

:::note[Feature status]
Koine ships **R1–R15, the R16 multi-target emitters** (TypeScript, Python, PHP, and Rust alongside
C#), **the R17 developer tooling** (`koine fmt`, `init`, `watch`, and the `lsp` language server),
**and R18 model-as-spec coverage** (`koine coverage`). The Rust emitter covers multi-context models
and the CQRS read side (Phase 2); details are on the
[roadmap](/Koine/guides/roadmap/#r16--multi-target-emitters).
:::

## Next steps

With the compiler building, you're ready to write your own `.koi` model.

- [Your first model](/Koine/start/your-first-model/) — write a bounded context from scratch and read the C# it emits.
- [CLI reference](/Koine/guides/cli/) — every command, flag, and exit code.
