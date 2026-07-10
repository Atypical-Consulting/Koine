#!/usr/bin/env bash
# Orchestrator for every runnable Koine demo (issue #1073).
#
# Runs the C# demo (demo/Pizzeria.Domain) first, then each of the four polyglot demos
# (demo/typescript, demo/python, demo/php, demo/rust) in turn via their own `run.sh`, and prints a
# one-line PASS/SKIP/FAIL summary per demo at the end.
#
# Exit code contract for the four demo/<lang>/run.sh scripts (see any of them for the full
# rationale):
#   exit 0  clean generate + build/type-check + run + assert  -> PASS
#   exit 3  the language toolchain is not available            -> SKIP (does NOT fail this script)
#   other   a real failure                                     -> FAIL (fails this script)
#
# The C# demo has no toolchain-gate sentinel (a .NET SDK is this repo's own primary tool, so it is
# always assumed present) -- `dotnet run` exiting 0 is a PASS, anything else is a FAIL.
#
# This script itself exits non-zero if, and only if, at least one demo produced a real FAIL. A
# toolchain-absent SKIP never fails the overall run -- that's the expected local shape when e.g.
# mypy/phpstan aren't installed; CI installs every toolchain and sets KOINE_REQUIRE_CONFORMANCE, so
# no demo may report Skipped there.
#
# Usage (from anywhere, in particular the repo root): `bash demo/build-all.sh`.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# name -> status, in run order, for the closing summary table.
DEMO_NAMES=()
DEMO_STATUSES=()
OVERALL_EXIT=0

record() {
  DEMO_NAMES+=("$1")
  DEMO_STATUSES+=("$2")
}

echo "==================================================================="
echo " Koine demos: C# (Pizzeria) + TypeScript/Python/PHP/Rust (Ordering)"
echo "==================================================================="

echo
echo "--- C# (demo/Pizzeria.Domain) ---------------------------------------"
if ( cd "$REPO_ROOT" && dotnet run --project demo/Pizzeria.Domain ); then
  echo "PASS: C# demo"
  record "csharp" "PASS"
else
  cs_exit=$?
  echo "FAIL: C# demo (dotnet run exited ${cs_exit})"
  record "csharp" "FAIL"
  OVERALL_EXIT=1
fi

for lang in typescript python php rust; do
  echo
  echo "--- ${lang} (demo/${lang}/run.sh) ------------------------------------"
  bash "$SCRIPT_DIR/$lang/run.sh"
  lang_exit=$?
  if [ "$lang_exit" -eq 0 ]; then
    echo "PASS: ${lang} demo"
    record "$lang" "PASS"
  elif [ "$lang_exit" -eq 3 ]; then
    echo "SKIP: ${lang} demo (toolchain not available -- see output above)"
    record "$lang" "SKIP"
  else
    echo "FAIL: ${lang} demo (run.sh exited ${lang_exit})"
    record "$lang" "FAIL"
    OVERALL_EXIT=1
  fi
done

echo
echo "==================================================================="
echo " Summary"
echo "==================================================================="
for i in "${!DEMO_NAMES[@]}"; do
  printf '  %-10s %s\n' "${DEMO_NAMES[$i]}" "${DEMO_STATUSES[$i]}"
done
echo "==================================================================="

if [ "$OVERALL_EXIT" -ne 0 ]; then
  echo "OVERALL: FAIL (at least one demo failed for real -- see above)"
else
  echo "OVERALL: PASS (no real failures; a toolchain-absent SKIP is expected locally, see above)"
fi

exit "$OVERALL_EXIT"
