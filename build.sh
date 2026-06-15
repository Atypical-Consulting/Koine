#!/usr/bin/env bash
# Build and test Koine.
set -euo pipefail
cd "$(dirname "$0")"
dotnet build "$@"
dotnet test
