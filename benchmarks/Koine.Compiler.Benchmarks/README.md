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

| Corpus    | Input                                                            |
|-----------|-----------------------------------------------------------------|
| `Billing` | `examples/billing.koi` — single small file (~0.8 KB)            |
| `Shop`    | `demo/Shop.Domain/Models/*.koi` — 7 files (~17 KB), one model   |

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
.NET SDK 10.0.203
  [Host] : .NET 10.0.7 (10.0.7, 10.0.726.21808), Arm64 RyuJIT armv8.0-a

Toolchain=InProcessEmitToolchain  

```
| Method   | Input   | Mean        | Error     | StdDev    | Ratio | RatioSD | Gen0     | Gen1     | Allocated  | Alloc Ratio |
|--------- |-------- |------------:|----------:|----------:|------:|--------:|---------:|---------:|-----------:|------------:|
| **Parse**    | **Billing** |    **56.67 μs** |  **0.556 μs** |  **0.493 μs** |  **0.35** |    **0.01** |  **15.9912** |   **2.8076** |   **98.25 KB** |        **0.27** |
| Diagnose | Billing |    73.32 μs |  1.461 μs |  2.000 μs |  0.46 |    0.02 |  21.3623 |   3.0518 |  131.41 KB |        0.36 |
| Compile  | Billing |   160.61 μs |  3.174 μs |  6.338 μs |  1.00 |    0.06 |  59.8145 |   9.2773 |  367.07 KB |        1.00 |
|          |         |             |           |           |       |         |          |          |            |             |
| **Parse**    | **Shop**    |   **738.55 μs** | **14.597 μs** | **14.990 μs** |  **0.34** |    **0.01** | **194.3359** |  **68.3594** |  **1193.1 KB** |        **0.42** |
| Diagnose | Shop    | 1,031.81 μs | 13.921 μs | 11.625 μs |  0.47 |    0.01 | 238.2813 |  82.0313 | 1464.48 KB |        0.52 |
| Compile  | Shop    | 2,203.67 μs | 42.482 μs | 58.149 μs |  1.00 |    0.04 | 457.0313 | 164.0625 | 2818.15 KB |        1.00 |

<!-- BENCHMARK:RESULTS:END -->
