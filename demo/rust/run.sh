#!/usr/bin/env bash
# Runnable, self-checking Rust demo (issue #1073).
#
# Regenerates templates/starters/ordering to Rust with the Koine CLI as a `koine-domain` crate
# under generated/, then builds AND runs the hand-written driver (src/main.rs) via `cargo run` --
# cargo's own compile step IS the type-check for this target (there is no separate lint pass the
# way tsc/mypy/phpstan provide for the TypeScript/Python/PHP demos). The driver asserts the
# outcomes itself and exits non-zero on any failed assertion.
#
# Contract (every demo/<lang>/run.sh in this repo follows this shape):
#   exit 0  clean generate + compile + run + assert
#   exit 3  the language toolchain is not available (the "skip" sentinel -- DemoBuildTests.cs maps
#           this to xUnit Skipped locally, or a hard Failed under KOINE_REQUIRE_CONFORMANCE / CI)
#   other   a real failure (bad generation, a compile error, a failed runtime assertion, ...)
#
# Idempotent and callable from anywhere (paths are resolved relative to this script), in particular
# from the repo root: `bash demo/rust/run.sh`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GENERATED_DIR="$SCRIPT_DIR/generated"

# --- Toolchain gate (checked BEFORE the regenerate step below): honor the same KOINE_CARGO override +
# resolution order the Conformance/ suites use (TestSupport.ResolveCargo), and exit fast when the
# toolchain is absent instead of paying for a multi-second CLI regenerate that would only be thrown
# away.
#   cargo: $KOINE_CARGO override -> 'cargo' on PATH
CARGO_BIN=""
if [ -n "${KOINE_CARGO:-}" ]; then
  CARGO_BIN="$KOINE_CARGO"
elif command -v cargo >/dev/null 2>&1; then
  CARGO_BIN="cargo"
fi

if [ -z "$CARGO_BIN" ]; then
  echo "No cargo toolchain found (checked \$KOINE_CARGO and a direct 'cargo' on PATH)." >&2
  echo "Install Rust (https://rustup.rs), or set KOINE_CARGO -- CI runs this for real." >&2
  exit 3
fi

echo "==> [1/2] Regenerating Rust from templates/starters/ordering"
rm -rf "$GENERATED_DIR"
dotnet run --project "$REPO_ROOT/src/Koine.Cli" -- build "$REPO_ROOT/templates/starters/ordering" \
  --target rust --out "$GENERATED_DIR"

echo "==> [2/2] Building and running the driver (cargo's compile step IS the type-check for this target)"
( cd "$SCRIPT_DIR" && "$CARGO_BIN" run --quiet )

echo "OK: Rust demo generated, compiled, and asserted successfully."
