#!/usr/bin/env pwsh
# Build and test Koine.
$ErrorActionPreference = "Stop"
# This script lives in scripts/build/; run from the repo root so dotnet picks
# up the solution. Push/Pop (in a finally) so the caller's working directory is
# restored on exit — a bare Set-Location would leak into the caller's session.
Push-Location (Join-Path $PSScriptRoot "../..")
try {
    # MSBuild's persistent build nodes are keyed by a pipe name derived from the toolset install,
    # not by working directory — so concurrent `dotnet build`/`dotnet test` runs from DIFFERENT git
    # worktrees on the same machine (routine for parallel agents) can share a node and deadlock on
    # it forever (issue #1552). Disable reuse for both invocations.
    $env:MSBUILDDISABLENODEREUSE = "1"
    dotnet build -nodereuse:false @args
    dotnet test -nodereuse:false -m:1
} finally {
    Pop-Location
}
