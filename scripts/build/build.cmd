@echo off
REM Build and test Koine.
REM This script lives in scripts\build\; run from the repo root so dotnet picks
REM up the solution.
REM MSBuild's persistent build nodes are keyed by a pipe name derived from the toolset install,
REM not by working directory — so concurrent `dotnet build`/`dotnet test` runs from DIFFERENT git
REM worktrees on the same machine (routine for parallel agents) can share a node and deadlock on
REM it forever (issue #1552). Disable reuse for both invocations.
set MSBUILDDISABLENODEREUSE=1
pushd "%~dp0..\.."
dotnet build -nodereuse:false %* || (popd & exit /b 1)
dotnet test -nodereuse:false -m:1 || (popd & exit /b 1)
popd
