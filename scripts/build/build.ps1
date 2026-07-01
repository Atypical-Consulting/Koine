#!/usr/bin/env pwsh
# Build and test Koine.
$ErrorActionPreference = "Stop"
# This script lives in scripts/build/; run from the repo root so dotnet picks
# up the solution. Push/Pop (in a finally) so the caller's working directory is
# restored on exit — a bare Set-Location would leak into the caller's session.
Push-Location (Join-Path $PSScriptRoot "../..")
try {
    dotnet build @args
    dotnet test
} finally {
    Pop-Location
}
