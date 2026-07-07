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
# Push/Pop (in a finally) so the caller's working directory is restored on exit — a bare
# Set-Location would leak into the caller's session.
Push-Location (Join-Path $PSScriptRoot "../..")
try {

$studio = "tooling/koine-studio"

# 1. Build the language server the Studio spawns (Debug DLL — no build logs on stdout,
#    so it's safe for the LSP stdio stream; the Rust host resolves it when KOINE_LSP is unset).
dotnet build src/Koine.Cli/Koine.Cli.csproj
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# 2. Satisfy Tauri's externalBin validation. The build script (tauri_build) checks at
#    COMPILE time that binaries/koine-<target-triple> exists (see tauri.conf.json ->
#    bundle.externalBin). In dev the Rust host runs the sidecar via the DLL above, so a
#    zero-byte placeholder is enough; CI/publish overwrites it with the real binary.
#    Don't clobber an existing (real) sidecar.
$triple = (& rustc -vV | Select-String '^host: ').ToString() -replace '^host: ', ''
$ext = if ($triple -like '*windows*') { ".exe" } else { "" }
$binDir = Join-Path $studio "src-tauri/binaries"
$placeholder = Join-Path $binDir "koine-$triple$ext"
if (-not (Test-Path $placeholder)) {
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    New-Item -ItemType File -Force -Path $placeholder | Out-Null
}

# 3. Install the frontend deps when missing or out of date. npm stamps
#    node_modules/.package-lock.json on every install, so a package-lock.json that's
#    newer means a dependency was added/changed since the last install (e.g. a new
#    @tauri-apps/plugin-* package) and we must reinstall — otherwise the stale
#    node_modules makes Vite fail to resolve the new import.
$nodeModules = Join-Path $studio "node_modules"
$stamp = Join-Path $nodeModules ".package-lock.json"
$lockFile = Join-Path $studio "package-lock.json"
$needsInstall = (-not (Test-Path $nodeModules)) -or (-not (Test-Path $stamp)) -or `
    ((Test-Path $lockFile) -and (Get-Item $lockFile).LastWriteTime -gt (Get-Item $stamp).LastWriteTime)
if ($needsInstall) {
    Push-Location $studio
    npm install
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { exit $code }
}

# 4. Launch the desktop IDE (Vite dev server + Tauri shell).
Push-Location $studio
npm run tauri dev -- @args
$code = $LASTEXITCODE
Pop-Location
exit $code

} finally {
    Pop-Location
}
