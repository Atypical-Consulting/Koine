#!/usr/bin/env bash
# Launch Koine Studio in the BROWSER — the same studio UI as the desktop app, but running the
# compiler in-process via WebAssembly (no Tauri, no Rust, no `koine lsp` sidecar). Useful for
# debugging/iterating on the front-end with browser tooling.
#
# Builds the Koine.Wasm compiler bundle on first run (when missing), installs the frontend deps,
# then starts the Vite web dev server. Extra arguments are forwarded to `npm run dev:web`.
#
# Requirements: .NET SDK + the wasm workloads (dotnet workload install wasm-tools wasm-experimental),
# and Node/npm. No Rust toolchain needed.
set -euo pipefail
# This script lives in scripts/run-ide-web/; run from the repo root so the paths below resolve.
cd "$(dirname "$0")/../.."

studio="tooling/koine-studio"

# 1. Build the in-browser compiler bundle if it isn't present yet. This publishes src/Koine.Wasm
#    and copies the AppBundle into the studio's public/koine-wasm/. It's slow (a wasm publish), so
#    we only do it when missing — re-run `npm run build:wasm` in the studio to refresh after a
#    compiler change.
if [[ ! -f "$studio/public/koine-wasm/_framework/dotnet.js" ]]; then
  echo "Building the Koine.Wasm compiler bundle (first run)…"
  (cd "$studio" && npm run build:wasm)
fi

# 2. Install the frontend deps when missing or out of date (mirrors run-ide.sh).
stamp="$studio/node_modules/.package-lock.json"
if [[ ! -d "$studio/node_modules" || "$studio/package-lock.json" -nt "$stamp" ]]; then
  (cd "$studio" && npm install)
fi

# 3. Launch the web dev server (Vite on http://localhost:1430).
(cd "$studio" && npm run dev:web -- "$@")
