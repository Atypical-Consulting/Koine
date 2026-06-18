#!/usr/bin/env pwsh
# Build and test Koine.
$ErrorActionPreference = "Stop"
# This script lives in scripts/build/; run from the repo root so dotnet picks
# up the solution.
Set-Location (Join-Path $PSScriptRoot "../..")
dotnet build @args
dotnet test
