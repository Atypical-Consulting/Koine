#!/usr/bin/env bash
# Build and test Koine.
set -euo pipefail
# This script lives in scripts/build/; run from the repo root so dotnet picks
# up the solution.
cd "$(dirname "$0")/../.."
dotnet build "$@"
dotnet test
