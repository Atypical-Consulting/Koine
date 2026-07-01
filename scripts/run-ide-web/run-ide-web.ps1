#!/usr/bin/env pwsh
# Launch Koine Studio in the BROWSER — the same studio UI as the desktop app, but running the
# compiler in-process via WebAssembly (no Tauri, no Rust, no `koine lsp` sidecar). Useful for
# debugging/iterating on the front-end with browser tooling.
#
# Installs the frontend deps, then starts the Vite web dev server. `npm run dev:web` rebuilds the
# Koine.Wasm compiler bundle first via its `predev:web` hook, so the in-browser compiler always
# matches the current C# sources (no stale public/koine-wasm/). Extra arguments are forwarded to
# `npm run dev:web`.
#
# Requirements: .NET SDK + the wasm workloads (dotnet workload install wasm-tools wasm-experimental),
# and Node/npm. No Rust toolchain needed.
$ErrorActionPreference = "Stop"
# This script lives in scripts/run-ide-web/; run from the repo root so the paths below resolve.
# Push/Pop (in a finally) so the caller's working directory is restored on exit — a bare
# Set-Location would leak into the caller's session.
Push-Location (Join-Path $PSScriptRoot "../..")
try {

$studio = "tooling/koine-studio"

# 1. Preflight the .NET wasm workload. `npm run dev:web` (step 3) publishes src/Koine.Wasm via its
#    predev:web hook, and that `dotnet publish` hard-requires the wasm-tools workload. Without it the
#    publish fails with NETSDK1147 deep inside build-wasm.mjs, surfacing as a cryptic Node stack
#    trace — so check up front and point at the one-time fix instead.
$workloads = (& dotnet workload list 2>$null | Out-String)
if ($workloads -notmatch 'wasm-tools') {
    Write-Host "ERROR: the .NET 'wasm-tools' workload is required to build the in-browser compiler, but it" -ForegroundColor Red
    Write-Host "       is not installed. Install it once (alongside wasm-experimental), then re-run:" -ForegroundColor Red
    Write-Host ""
    Write-Host "    dotnet workload install wasm-tools wasm-experimental"
    Write-Host ""
    exit 1
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

# 3. Launch the web dev server (Vite on http://localhost:1430). The predev:web hook publishes
#    src/Koine.Wasm and refreshes public/koine-wasm/ first — slow on the first run / after a
#    compiler change, fast (incremental) otherwise.
Push-Location $studio
npm run dev:web -- @args
$code = $LASTEXITCODE
Pop-Location
exit $code

} finally {
    Pop-Location
}
