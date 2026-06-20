# Koine.Compiler.Benchmarks

[BenchmarkDotNet](https://benchmarkdotnet.org/) harness for tracking compiler performance and catching
regressions as the codebase evolves. It exercises the public compile pipeline
(`KoineCompiler.Parse` / `DiagnoseWorkspace` / `Compile`) on a representative `.koi` corpus.

## What it measures

Three pipeline stages, each run against two inputs (`[Params]`):

| Stage      | What it covers                          |
|------------|-----------------------------------------|
| `Parse`    | lex + parse + model build               |
| `Diagnose` | parse + semantic validation             |
| `Compile`  | full pipeline incl. C# emit *(baseline)* |

| Corpus     | Input                                                            |
|------------|-----------------------------------------------------------------|
| `Billing`  | `templates/starters/billing/billing.koi` — single small file (~0.8 KB) |
| `Pizzeria` | `templates/pizzeria/*.koi` — 8 files, one model                  |

`[MemoryDiagnoser]` also reports allocations — a common silent regression source. The corpus files are
copied next to the binary at build time (see the `.csproj`) and read from `corpus/` at runtime, so the
benchmark always runs against the committed sample domains.

## Running

Release is **mandatory** — BenchmarkDotNet refuses to run Debug builds.

The `scripts/run-benchmarks/` wrappers (`run-benchmarks.sh` / `.ps1` / `.cmd`) do the canonical full
run with no arguments and forward any arguments to the harness — e.g. `./scripts/run-benchmarks/run-benchmarks.sh --filter '*Compile*'`.

```bash
# Full run AND refresh the committed numbers below (the canonical command)
dotnet run -c Release --project benchmarks/Koine.Compiler.Benchmarks -- --filter '*' --update-docs

# Full run without touching this file
dotnet run -c Release --project benchmarks/Koine.Compiler.Benchmarks

# Fast smoke run (rougher numbers, ~30s) — sanity check only, don't commit these
dotnet run -c Release --project benchmarks/Koine.Compiler.Benchmarks -- --filter '*' --job short

# A single stage
dotnet run -c Release --project benchmarks/Koine.Compiler.Benchmarks -- --filter '*Compile*'
```

`--update-docs` is our own flag (stripped before BenchmarkDotNet sees it). After the run it splices the
generated GitHub-markdown table into the **Latest results** block below, between the
`<!-- BENCHMARK:RESULTS:START/END -->` markers. Use it only with a **full** run (`--filter '*'`) — a
filtered run would write a partial table. Full results and CSV also land in
`BenchmarkDotNet.Artifacts/` (gitignored).

## Tracking regressions

The committed table below is the baseline. To check a change:

1. Regenerate on your branch with the `--update-docs` command above.
2. The numbers between the markers are now under version control, so `git diff` on this README shows
   exactly how `Mean` and `Allocated` moved. The `Compile` baseline `Ratio` column makes each stage's
   share of total cost obvious.
3. Commit the refreshed table in the same PR as the code change — the diff documents the perf impact.

Treat a meaningful jump in `Mean` or `Allocated` (beyond run-to-run noise — StdDev is ~1–3%) as a
regression to explain or fix before merging.

> Numbers are hardware/SDK-specific (see the environment block). Compare runs taken on the **same
> machine**; the `Ratio` column (stage cost relative to `Compile`) is the more portable signal. These
> are steady-state, JIT-warmed, in-process measurements — they exclude CLI/process startup, so don't
> read them as user-visible compile time.

## Latest results

Regenerate the table below with:

```bash
dotnet run -c Release --project benchmarks/Koine.Compiler.Benchmarks -- --filter '*' --update-docs
```

<!-- BENCHMARK:RESULTS:START -->

```

BenchmarkDotNet v0.15.8, macOS Tahoe 26.5.1 (25F80) [Darwin 25.5.0]
Apple M1 Max, 1 CPU, 10 logical and 10 physical cores
.NET SDK 10.0.301
  [Host] : .NET 10.0.9 (10.0.9, 10.0.926.27113), Arm64 RyuJIT armv8.0-a

Toolchain=InProcessEmitToolchain  

```
| Method   | Input   | Mean        | Error     | StdDev    | Ratio | RatioSD | Gen0     | Gen1     | Allocated  | Alloc Ratio |
|--------- |-------- |------------:|----------:|----------:|------:|--------:|---------:|---------:|-----------:|------------:|
| **Parse**    | **Billing** |    **52.72 μs** |  **1.049 μs** |  **1.122 μs** |  **0.36** |    **0.01** |  **15.9302** |   **3.0518** |   **97.89 KB** |        **0.28** |
| Diagnose | Billing |    68.29 μs |  1.355 μs |  1.450 μs |  0.47 |    0.01 |  21.3623 |   3.0518 |  131.14 KB |        0.38 |
| Compile  | Billing |   145.59 μs |  2.386 μs |  2.841 μs |  1.00 |    0.03 |  56.6406 |   9.5215 |  348.49 KB |        1.00 |
|          |         |             |           |           |       |         |          |          |            |             |
| **Parse**    | **Shop**    |   **720.54 μs** | **14.286 μs** | **21.816 μs** |  **0.37** |    **0.02** | **193.3594** |  **65.4297** | **1188.43 KB** |        **0.45** |
| Diagnose | Shop    |   966.43 μs | 14.178 μs | 12.568 μs |  0.50 |    0.02 | 238.2813 |  84.9609 | 1459.89 KB |        0.55 |
| Compile  | Shop    | 1,942.88 μs | 38.454 μs | 84.407 μs |  1.00 |    0.06 | 429.6875 | 152.3438 | 2639.27 KB |        1.00 |

<!-- BENCHMARK:RESULTS:END -->
