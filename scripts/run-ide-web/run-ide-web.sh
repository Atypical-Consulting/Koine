#!/usr/bin/env bash
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
set -euo pipefail
# This script lives in scripts/run-ide-web/; run from the repo root so the paths below resolve.
cd "$(dirname "$0")/../.."

studio="tooling/koine-studio"

# 1. Preflight the .NET wasm workload. `npm run dev:web` (step 3) publishes src/Koine.Wasm via its
#    predev:web hook, and that `dotnet publish` hard-requires the wasm-tools workload. Without it the
#    publish fails with NETSDK1147 deep inside build-wasm.mjs, surfacing as a cryptic Node stack
#    trace — so check up front and point at the one-time fix instead.
if ! dotnet workload list 2>/dev/null | grep -qi 'wasm-tools'; then
  echo "ERROR: the .NET 'wasm-tools' workload is required to build the in-browser compiler, but it" >&2
  echo "       is not installed. Install it once (alongside wasm-experimental), then re-run:" >&2
  echo >&2
  echo "    dotnet workload install wasm-tools wasm-experimental" >&2
  echo >&2
  exit 1
fi

# 2. Install the frontend deps when missing or out of date (mirrors run-ide.sh).
stamp="$studio/node_modules/.package-lock.json"
if [[ ! -d "$studio/node_modules" || "$studio/package-lock.json" -nt "$stamp" ]]; then
  (cd "$studio" && npm install)
fi

# 3. Launch the web dev server (Vite on http://localhost:1430). The predev:web hook publishes
#    src/Koine.Wasm and refreshes public/koine-wasm/ first — slow on the first run / after a
#    compiler change, fast (incremental) otherwise.
(cd "$studio" && npm run dev:web -- "$@")
