#!/usr/bin/env pwsh
# Launch Koine Studio in the BROWSER — the same studio UI as the desktop app, but running the
# compiler in-process via WebAssembly (no Tauri, no Rust, no `koine lsp` sidecar). Useful for
# debugging/iterating on the front-end with browser tooling.
#
# Builds the Koine.Wasm compiler bundle on first run (when missing), installs the frontend deps,
# then starts the Vite web dev server. Extra arguments are forwarded to `npm run dev:web`.
#
# Requirements: .NET SDK + the wasm workloads (dotnet workload install wasm-tools wasm-experimental),
# and Node/npm. No Rust toolchain needed.
$ErrorActionPreference = "Stop"
# This script lives in scripts/run-ide-web/; run from the repo root so the paths below resolve.
Set-Location (Join-Path $PSScriptRoot "../..")

$studio = "tooling/koine-studio"

# 1. Build the in-browser compiler bundle if it isn't present yet (slow wasm publish — only when
#    missing; re-run `npm run build:wasm` in the studio to refresh after a compiler change).
$wasmEntry = Join-Path $studio "public/koine-wasm/_framework/dotnet.js"
if (-not (Test-Path $wasmEntry)) {
    Write-Host "Building the Koine.Wasm compiler bundle (first run)…"
    Push-Location $studio
    npm run build:wasm
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { exit $code }
}

# 2. Install the frontend deps when missing or out of date (mirrors run-ide.ps1).
$nodeModules = Join-Path $studio "node_modules"
$stamp = Join-Path $nodeModules ".package-lock.json"
$lockFile = Join-Path $studio "package-lock.json"
$needsInstall = (-not (Test-Path $nodeModules)) -or (-not (Test-Path $stamp)) -or `
    ((Get-Item $lockFile).LastWriteTime -gt (Get-Item $stamp).LastWriteTime)
if ($needsInstall) {
    Push-Location $studio
    npm install
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { exit $code }
}

# 3. Launch the web dev server (Vite on http://localhost:1430).
Push-Location $studio
npm run dev:web -- @args
$code = $LASTEXITCODE
Pop-Location
exit $code
