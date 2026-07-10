#!/usr/bin/env bash
# Runnable, self-checking Python demo (issue #1073).
#
# Regenerates templates/starters/ordering to Python with the Koine CLI, type-checks the generated
# package plus the hand-written driver under `mypy --strict`, then runs the driver under Python --
# the driver asserts the outcomes itself and exits non-zero on any failed assertion.
#
# Contract (every demo/<lang>/run.sh in this repo follows this shape):
#   exit 0  clean generate + type-check + run + assert
#   exit 3  the language toolchain is not available (the "skip" sentinel -- DemoBuildTests.cs maps
#           this to xUnit Skipped locally, or a hard Failed under KOINE_REQUIRE_CONFORMANCE / CI)
#   other   a real failure (bad generation, a type error, a failed runtime assertion, ...)
#
# Idempotent and callable from anywhere (paths are resolved relative to this script), in particular
# from the repo root: `bash demo/python/run.sh`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GENERATED_DIR="$SCRIPT_DIR/generated"

echo "==> [1/4] Regenerating Python from templates/starters/ordering"
rm -rf "$GENERATED_DIR"
dotnet run --project "$REPO_ROOT/src/Koine.Cli" -- build "$REPO_ROOT/templates/starters/ordering" \
  --target python --out "$GENERATED_DIR"

# --- Toolchain gate: honor the same KOINE_PYTHON/KOINE_MYPY overrides + resolution order the
# Conformance/ suites use (TestSupport.ResolvePython / ResolveMypy):
#   python:  $KOINE_PYTHON override -> python3.13 -> python3.12 -> python3.11 -> python3 -> python
#   mypy:    $KOINE_MYPY override -> 'mypy' on PATH -> '<resolved python> -m mypy'
PYTHON_BIN=""
if [ -n "${KOINE_PYTHON:-}" ]; then
  PYTHON_BIN="$KOINE_PYTHON"
else
  for candidate in python3.13 python3.12 python3.11 python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
      PYTHON_BIN="$candidate"
      break
    fi
  done
fi

MYPY_CMD=()
if [ -n "${KOINE_MYPY:-}" ]; then
  MYPY_CMD=("$KOINE_MYPY")
elif command -v mypy >/dev/null 2>&1; then
  MYPY_CMD=(mypy)
elif [ -n "$PYTHON_BIN" ] && "$PYTHON_BIN" -m mypy --version >/dev/null 2>&1; then
  MYPY_CMD=("$PYTHON_BIN" -m mypy)
fi

if [ -z "$PYTHON_BIN" ] || [ "${#MYPY_CMD[@]}" -eq 0 ]; then
  echo "No mypy/python toolchain found (checked \$KOINE_MYPY / \$KOINE_PYTHON, a direct 'mypy', '<python> -m mypy', and python3.13/python3.12/python3.11/python3/python on PATH)." >&2
  echo "Install Python 3.11+ and mypy (pip install mypy), or set KOINE_MYPY/KOINE_PYTHON -- CI runs this for real." >&2
  exit 3
fi

echo "==> [2/4] Type-checking the generated package under mypy --strict (via its shipped mypy.ini)"
( cd "$GENERATED_DIR" && "${MYPY_CMD[@]}" --config-file mypy.ini . )

echo "==> [3/4] Type-checking the driver (main.py) against the generated package"
( cd "$SCRIPT_DIR" && MYPYPATH="$GENERATED_DIR" "${MYPY_CMD[@]}" --strict main.py )

echo "==> [4/4] Running the driver"
( cd "$SCRIPT_DIR" && PYTHONPATH="$GENERATED_DIR" "$PYTHON_BIN" main.py )

echo "OK: Python demo generated, type-checked, and asserted successfully."
