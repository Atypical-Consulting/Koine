#!/usr/bin/env pwsh
# Launch Koine Studio — the Tauri desktop IDE for .koi files — in dev mode.
# Builds the Koine CLI (the `koine lsp` server the Studio spawns as a sidecar),
# installs the frontend deps on first run, then starts `tauri dev`. Extra
# arguments are forwarded to `npm run tauri dev`.
#
# Requirements: .NET SDK, Node/npm, and a Rust toolchain (cargo) on PATH.
# To use a self-contained sidecar instead of the source build, set KOINE_LSP to a
# published `koine` binary before running; the Rust host prefers it over the DLL.
$ErrorActionPreference = "Stop"
# This script lives in scripts/run-ide/; run from the repo root so the paths below resolve.
Set-Location (Join-Path $PSScriptRoot "../..")

$studio = "tooling/koine-studio"

# 1. Build the language server the Studio spawns (Debug DLL — no build logs on stdout,
#    so it's safe for the LSP stdio stream; the Rust host resolves it when KOINE_LSP is unset).
dotnet build src/Koine.Cli/Koine.Cli.csproj
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# 2. Install the frontend deps on first run.
if (-not (Test-Path (Join-Path $studio "node_modules"))) {
    Push-Location $studio
    npm install
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { exit $code }
}

# 3. Launch the desktop IDE (Vite dev server + Tauri shell).
Push-Location $studio
npm run tauri dev -- @args
$code = $LASTEXITCODE
Pop-Location
exit $code
