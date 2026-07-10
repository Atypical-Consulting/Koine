#!/usr/bin/env bash
# Runnable, self-checking PHP demo (issue #1073).
#
# Regenerates templates/starters/ordering to PHP with the Koine CLI, syntax-checks every emitted
# file plus the hand-written driver under `php -l`, type-checks the lot under
# `phpstan analyse --level max`, then runs the driver under `php` -- the driver asserts the
# outcomes itself and exits non-zero on any failed assertion.
#
# Contract (every demo/<lang>/run.sh in this repo follows this shape):
#   exit 0  clean generate + syntax-check + type-check + run + assert
#   exit 3  the language toolchain is not available (the "skip" sentinel -- DemoBuildTests.cs maps
#           this to xUnit Skipped locally, or a hard Failed under KOINE_REQUIRE_CONFORMANCE / CI)
#   other   a real failure (bad generation, a syntax/type error, a failed runtime assertion, ...)
#
# Idempotent and callable from anywhere (paths are resolved relative to this script), in particular
# from the repo root: `bash demo/php/run.sh`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GENERATED_DIR="$SCRIPT_DIR/generated"

# --- Toolchain gate (checked BEFORE the regenerate step below): honor the same KOINE_PHP/KOINE_PHPSTAN
# overrides + resolution order the Conformance/ suites use (TestSupport.ResolvePhp / ResolvePhpStan),
# and exit fast when the toolchain is absent instead of paying for a multi-second CLI regenerate that
# would only be thrown away.
#   php:     $KOINE_PHP override -> 'php' on PATH
#   phpstan: $KOINE_PHPSTAN override -> 'phpstan' on PATH -> <repo root>/vendor/bin/phpstan
PHP_BIN=""
if [ -n "${KOINE_PHP:-}" ]; then
  PHP_BIN="$KOINE_PHP"
elif command -v php >/dev/null 2>&1; then
  PHP_BIN="php"
fi

PHPSTAN_BIN=""
if [ -n "${KOINE_PHPSTAN:-}" ]; then
  PHPSTAN_BIN="$KOINE_PHPSTAN"
elif command -v phpstan >/dev/null 2>&1; then
  PHPSTAN_BIN="phpstan"
elif [ -x "$REPO_ROOT/vendor/bin/phpstan" ]; then
  PHPSTAN_BIN="$REPO_ROOT/vendor/bin/phpstan"
fi

if [ -z "$PHP_BIN" ] || [ -z "$PHPSTAN_BIN" ]; then
  echo "No phpstan/php toolchain found (checked \$KOINE_PHP / \$KOINE_PHPSTAN, a direct 'php'/'phpstan' on PATH, and <repo root>/vendor/bin/phpstan)." >&2
  echo "Install PHP 8.1+ and phpstan (composer require --dev phpstan/phpstan), or set KOINE_PHP/KOINE_PHPSTAN -- CI runs this for real." >&2
  exit 3
fi

echo "==> [1/4] Regenerating PHP from templates/starters/ordering"
rm -rf "$GENERATED_DIR"
dotnet run --project "$REPO_ROOT/src/Koine.Cli" -- build "$REPO_ROOT/templates/starters/ordering" \
  --target php --out "$GENERATED_DIR"

echo "==> [2/4] Syntax-checking every emitted file plus the driver under php -l"
while IFS= read -r -d '' php_file; do
  "$PHP_BIN" -l "$php_file" >/dev/null
done < <(find "$GENERATED_DIR" -name '*.php' -print0)
"$PHP_BIN" -l "$SCRIPT_DIR/main.php" >/dev/null

echo "==> [3/4] Type-checking the generated package plus the driver under phpstan analyse --level max"
( cd "$SCRIPT_DIR" && "$PHPSTAN_BIN" analyse --level max --no-progress --memory-limit=1G \
    "$GENERATED_DIR" "$SCRIPT_DIR/main.php" )

echo "==> [4/4] Running the driver"
"$PHP_BIN" "$SCRIPT_DIR/main.php"

echo "OK: PHP demo generated, syntax-checked, type-checked, and asserted successfully."
