#!/usr/bin/env bash
# check-roadmap-sync.sh — guard for issue #239 (roadmap doc sync).
#
# Greps the four roadmap narrative surfaces (README.md, USER-STORIES.md, and the
# two website sources under website/src) for phrasing that predates R16/R17/R18
# actually shipping: R16 marked "deferred", the project framed as topping out at
# R1–R17, Rust described as unshipped ("next up" / "on the roadmap" / "soon"), and
# R16 called "partial". Prints every offending file:line and exits non-zero if any
# stale pattern remains — this is the executable red->green acceptance check for
# the doc edits in tasks 2–5.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

# Dated blog posts under website/src/content/docs/blog are point-in-time records of
# what was true when published, so they are excluded (--exclude-dir=blog below).
FILES=(README.md USER-STORIES.md website/src)
fail=0

check() {
  local desc="$1" pat="$2" hits
  hits="$(grep -rnE --exclude-dir=blog "$pat" "${FILES[@]}" 2>/dev/null)" || true
  if [ -n "$hits" ]; then
    echo "STALE — $desc:"
    printf '%s\n' "$hits" | sed 's/^/    /'
    fail=1
  fi
}

check "R16 marked deferred" \
  '⏸ *\**Deferred'
check "R1–R17 used as the project ceiling (should be R1–R18)" \
  'R1(–|-)R17'
check "Rust framed as unshipped (next up / on the roadmap / · soon)" \
  'Next up:\*\* a \*\*Rust|Rust .*on the roadmap|Rust is on the$|Rust · soon|tgt--soon'
check "R16 multi-target emitters undercounting the shipped targets" \
  'multi-target emitters\*\* \(TypeScript and Python'
check "R16 labelled partial" \
  'Multi-target emitters \(partial\)'
check "R16–R17 sequencing framed as future proof of target-agnosticism" \
  'R16(–|-)R17(\*\*)? prove'

if [ "$fail" -eq 0 ]; then
  echo "roadmap-sync: OK — no stale R16/R17/R18/Rust phrasing found."
fi
exit "$fail"
