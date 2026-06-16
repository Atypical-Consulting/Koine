---
title: "Installation"
description: "Get the Koine compiler building and run it from the .NET CLI."
---

Koine ships as source today. You clone the repository, build it with the .NET SDK, and invoke the
compiler through `dotnet run`. There is no NuGet package or global tool yet — see
[No NuGet package yet](#no-nuget-package-yet) below.

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
./build.sh
```

`build.sh` is a thin wrapper around the SDK — it runs `dotnet build` followed by `dotnet test`. If you
prefer to drive the SDK yourself (or you're on Windows), the equivalent is:

```bash
dotnet build
dotnet test
```

:::tip
On Windows, `build.cmd` and `build.ps1` do the same thing as `build.sh`.
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
  koine build <file.koi|dir> [--target csharp|glossary] [--out <dir>] [--glossary <file.md>]
  koine check <file.koi|dir> --baseline <dir>   # flag breaking changes vs a published baseline
  koine lsp                       # Language Server (stdio) for editor diagnostics
```

## Build your first model

The repository ships a tiny `examples/billing.koi` model. Just *checking* that a model parses and
validates — no output written — is the fastest round-trip:

```bash
dotnet run --project src/Koine.Cli -- build examples/billing.koi
```

```text
OK: examples/billing.koi parsed and validated
```

To actually emit C#, add `--target csharp` and an `--out` directory:

```bash
dotnet run --project src/Koine.Cli -- build examples/billing.koi --target csharp --out ./generated
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

## No NuGet package yet

Koine is feature-complete through epic R15, but it is not yet published to NuGet and there is no
`dotnet tool install` path. For now you **build from source** as shown above and invoke the compiler
with `dotnet run --project src/Koine.Cli -- …`. If you want a shorter command, publish the CLI once
and call the produced binary directly:

```bash
dotnet publish src/Koine.Cli -c Release -o ./bin
./bin/Koine.Cli --version
```

## Next steps

With the compiler building, you're ready to write your own `.koi` model.

- [Your first model](/Koine/start/your-first-model/) — write a bounded context from scratch and read the C# it emits.
- [CLI reference](/Koine/guides/cli/) — every command, flag, and exit code.
