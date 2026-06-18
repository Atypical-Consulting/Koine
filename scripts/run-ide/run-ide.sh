#!/usr/bin/env bash
# Launch Koine Studio — the Tauri desktop IDE for .koi files — in dev mode.
# Builds the Koine CLI (the `koine lsp` server the Studio spawns as a sidecar),
# installs the frontend deps on first run, then starts `tauri dev`. Extra
# arguments are forwarded to `npm run tauri dev`.
#
# Requirements: .NET SDK, Node/npm, and a Rust toolchain (cargo) on PATH.
# To use a self-contained sidecar instead of the source build, set KOINE_LSP to a
# published `koine` binary before running; the Rust host prefers it over the DLL.
set -euo pipefail
# This script lives in scripts/run-ide/; run from the repo root so the paths below resolve.
cd "$(dirname "$0")/../.."

studio="tooling/koine-studio"

# 1. Build the language server the Studio spawns. Running the built Debug DLL emits no
#    build logs on stdout, so it's safe for the LSP stdio stream; the Rust host resolves
#    this DLL by default (when KOINE_LSP is unset).
dotnet build src/Koine.Cli/Koine.Cli.csproj

# 2. Install the frontend deps on first run.
if [[ ! -d "$studio/node_modules" ]]; then
  (cd "$studio" && npm install)
fi

# 3. Launch the desktop IDE (Vite dev server + Tauri shell).
(cd "$studio" && npm run tauri dev -- "$@")
