@echo off
REM Build and test Koine.
REM This script lives in scripts\build\; run from the repo root so dotnet picks
REM up the solution.
pushd "%~dp0..\.."
dotnet build %* || (popd & exit /b 1)
dotnet test || (popd & exit /b 1)
popd
