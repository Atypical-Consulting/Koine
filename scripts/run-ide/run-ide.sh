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

# 2. Satisfy Tauri's externalBin validation. The build script (tauri_build) checks at
#    COMPILE time that binaries/koine-<target-triple> exists (see tauri.conf.json ->
#    bundle.externalBin). In dev the Rust host runs the sidecar via the DLL above, so a
#    zero-byte placeholder is enough; CI/publish overwrites it with the real binary.
#    Don't clobber an existing (real) sidecar.
triple="$(rustc -vV | sed -n 's/^host: //p')"
ext=""; [[ "$triple" == *windows* ]] && ext=".exe"
placeholder="$studio/src-tauri/binaries/koine-${triple}${ext}"
if [[ ! -e "$placeholder" ]]; then
  mkdir -p "$studio/src-tauri/binaries"
  touch "$placeholder"
fi

# 3. Install the frontend deps when missing or out of date. npm stamps
#    node_modules/.package-lock.json on every install, so a package-lock.json that's
#    newer means a dependency was added/changed since the last install (e.g. a new
#    @tauri-apps/plugin-* package) and we must reinstall — otherwise the stale
#    node_modules makes Vite fail to resolve the new import.
stamp="$studio/node_modules/.package-lock.json"
if [[ ! -d "$studio/node_modules" || "$studio/package-lock.json" -nt "$stamp" ]]; then
  (cd "$studio" && npm install)
fi

# 4. Launch the desktop IDE (Vite dev server + Tauri shell).
(cd "$studio" && npm run tauri dev -- "$@")
