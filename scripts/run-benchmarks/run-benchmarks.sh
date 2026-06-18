#!/usr/bin/env bash
# Run the Koine compiler benchmarks (BenchmarkDotNet, Release is mandatory).
# With no arguments it does a full run and refreshes the committed numbers in
# the benchmark README. Pass extra arguments to forward them to the harness,
# e.g. `./run-benchmarks.sh --filter '*Compile*'` or `... --job short`.
set -euo pipefail
# This script lives in scripts/run-benchmarks/; run from the repo root so the
# --project path below resolves.
cd "$(dirname "$0")/../.."

project="benchmarks/Koine.Compiler.Benchmarks"

if [[ $# -eq 0 ]]; then
  # Canonical command: full run that splices the result table back into the README.
  dotnet run -c Release --project "$project" -- --filter '*' --update-docs
else
  dotnet run -c Release --project "$project" -- "$@"
fi
