@echo off
REM Build and test Koine.
REM This script lives in scripts\build\; run from the repo root so dotnet picks
REM up the solution.
REM setlocal confines `set` below to this script's own execution — without it, `set` modifies the
REM CALLING cmd.exe session directly (a well-known batch gotcha: a .cmd run by typing its name, or via
REM `call`, executes IN the current session, not a child process), leaking MSBUILDDISABLENODEREUSE=1
REM into the caller's shell for the rest of that session.
setlocal
REM MSBuild's persistent build nodes are keyed by a pipe name derived from the toolset install,
REM not by working directory — so concurrent `dotnet build`/`dotnet test` runs from DIFFERENT git
REM worktrees on the same machine (routine for parallel agents) can share a node and deadlock on
REM it forever (issue #1552). Disable reuse for both invocations.
set MSBUILDDISABLENODEREUSE=1
pushd "%~dp0..\.."
dotnet build -nodereuse:false %* || (popd & exit /b 1)
REM -m:1 caps the test run to a single MSBuild worker node — this is the exact combination (issue
REM #1552) proven to turn a 46-minute cross-worktree hang into a ~1-2 minute pass. Not applied to the
REM build above: that would serialize the whole solution's compilation for no proven benefit, since
REM -nodereuse:false alone already stops build-phase nodes from persisting into the test phase.
dotnet test -nodereuse:false -m:1 || (popd & exit /b 1)
popd
