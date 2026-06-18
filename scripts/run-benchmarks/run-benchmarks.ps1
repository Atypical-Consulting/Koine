#!/usr/bin/env pwsh
# Run the Koine compiler benchmarks (BenchmarkDotNet, Release is mandatory).
# With no arguments it does a full run and refreshes the committed numbers in
# the benchmark README. Pass extra arguments to forward them to the harness,
# e.g. `./run-benchmarks.ps1 --filter '*Compile*'` or `... --job short`.
$ErrorActionPreference = "Stop"
# This script lives in scripts/run-benchmarks/; run from the repo root so the
# --project path below resolves.
Set-Location (Join-Path $PSScriptRoot "../..")

$project = "benchmarks/Koine.Compiler.Benchmarks"

if ($args.Count -eq 0) {
    # Canonical command: full run that splices the result table back into the README.
    dotnet run -c Release --project $project -- --filter '*' --update-docs
} else {
    dotnet run -c Release --project $project -- @args
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
