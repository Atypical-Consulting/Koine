#!/usr/bin/env bash
# Runnable, self-checking TypeScript demo (issue #1073).
#
# Regenerates templates/starters/ordering to TypeScript with the Koine CLI, type-checks the emitted
# sources plus the hand-written driver under `tsc --strict`, transpiles, and runs the driver under
# `node` — the driver asserts the outcomes itself and exits non-zero on any failed assertion.
#
# Contract (every demo/<lang>/run.sh in this repo follows this shape):
#   exit 0  clean generate + type-check + build + run + assert
#   exit 3  the language toolchain is not available (the "skip" sentinel — DemoBuildTests.cs maps
#           this to xUnit Skipped locally, or a hard Failed under KOINE_REQUIRE_CONFORMANCE / CI)
#   other   a real failure (bad generation, a type error, a failed runtime assertion, ...)
#
# Idempotent and callable from anywhere (paths are resolved relative to this script), in particular
# from the repo root: `bash demo/typescript/run.sh`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GENERATED_DIR="$SCRIPT_DIR/generated"
BUILD_DIR="$SCRIPT_DIR/.build"

echo "==> [1/4] Regenerating TypeScript from templates/starters/ordering"
rm -rf "$GENERATED_DIR"
dotnet run --project "$REPO_ROOT/src/Koine.Cli" -- build "$REPO_ROOT/templates/starters/ordering" \
  --target typescript --out "$GENERATED_DIR"

# --- Toolchain gate: honor the same KOINE_TSC/KOINE_NODE overrides the Conformance/ suites do. ---
TSC_BIN="${KOINE_TSC:-tsc}"
NODE_BIN="${KOINE_NODE:-node}"

if ! command -v "$TSC_BIN" >/dev/null 2>&1; then
  echo "No TypeScript toolchain (tsc) found on PATH (checked \$KOINE_TSC / 'tsc')." >&2
  echo "Install TypeScript (npm i -g typescript) or set KOINE_TSC to a tsc binary -- CI runs this for real." >&2
  exit 3
fi
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "No Node.js toolchain (node) found on PATH (checked \$KOINE_NODE / 'node')." >&2
  echo "Install Node.js or set KOINE_NODE to a node binary -- CI runs this for real." >&2
  exit 3
fi

echo "==> [2/4] Type-checking the generated sources + driver under the shipped tsconfig.json"
( cd "$SCRIPT_DIR" && "$TSC_BIN" -p tsconfig.json )

echo "==> [3/4] Transpiling to JavaScript"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
TS_FILES=$(cd "$SCRIPT_DIR" && find generated src -name '*.ts')
# --ignoreConfig: a tsconfig.json sits right here (for editors/`npm run typecheck`), but this
# invocation passes an explicit file list with its own flags, so silence tsc's TS5112 refusal to
# run both at once.
# shellcheck disable=SC2086
( cd "$SCRIPT_DIR" && "$TSC_BIN" --target ES2022 --module ESNext --moduleResolution bundler --strict \
    --skipLibCheck --ignoreConfig --outDir "$BUILD_DIR" $TS_FILES )

# The emitted TypeScript uses ESM with extensionless relative imports (e.g. `from '../../runtime'`);
# Node's own ESM resolver requires an explicit extension, so register a resolve hook that appends
# `.js` to an extensionless relative specifier before falling back to the default resolution. Mirrors
# tests/Koine.Compiler.Tests/TestSupport.cs's RunTypeScript harness exactly.
cat > "$BUILD_DIR/__loader.mjs" <<'EOF'
export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[mc]?js$/.test(specifier)) {
    try { return await nextResolve(specifier + '.js', context); } catch { /* fall through */ }
  }
  return nextResolve(specifier, context);
}
EOF
cat > "$BUILD_DIR/__register.mjs" <<'EOF'
import { register } from 'node:module';
register('./__loader.mjs', import.meta.url);
EOF

echo "==> [4/4] Running the driver under node"
"$NODE_BIN" --import "$BUILD_DIR/__register.mjs" "$BUILD_DIR/src/main.js"

echo "OK: TypeScript demo generated, type-checked, transpiled, and asserted successfully."
