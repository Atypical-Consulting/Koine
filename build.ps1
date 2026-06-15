#!/usr/bin/env pwsh
# Build and test Koine.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
dotnet build @args
dotnet test
