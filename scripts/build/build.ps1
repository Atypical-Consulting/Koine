#!/usr/bin/env pwsh
# Build and test Koine.
$ErrorActionPreference = "Stop"
# This script lives in scripts/build/; run from the repo root so dotnet picks
# up the solution. Push/Pop (in a finally) so the caller's working directory is
# restored on exit — a bare Set-Location would leak into the caller's session.
Push-Location (Join-Path $PSScriptRoot "../..")
# $env: assignments are process-scoped, not script-scoped — unlike an ordinary PowerShell variable,
# setting one here would otherwise leak into and persist in the CALLER's session (the same class of
# leak Push-Location/Pop-Location above guards against for the working directory). Save/restore it
# the same way.
$originalNodeReuse = $env:MSBUILDDISABLENODEREUSE
try {
    # MSBuild's persistent build nodes are keyed by a pipe name derived from the toolset install,
    # not by working directory — so concurrent `dotnet build`/`dotnet test` runs from DIFFERENT git
    # worktrees on the same machine (routine for parallel agents) can share a node and deadlock on
    # it forever (issue #1552). Disable reuse for both invocations.
    $env:MSBUILDDISABLENODEREUSE = "1"
    dotnet build -nodereuse:false @args
    # -m:1 caps the test run to a single MSBuild worker node — this is the exact combination (issue
    # #1552) proven to turn a 46-minute cross-worktree hang into a ~1-2 minute pass. Not applied to the
    # build above: that would serialize the whole solution's compilation for no proven benefit, since
    # -nodereuse:false alone already stops build-phase nodes from persisting into the test phase.
    dotnet test -nodereuse:false -m:1
} finally {
    if ($null -eq $originalNodeReuse) {
        Remove-Item Env:\MSBUILDDISABLENODEREUSE -ErrorAction SilentlyContinue
    } else {
        $env:MSBUILDDISABLENODEREUSE = $originalNodeReuse
    }
    Pop-Location
}
