#!/usr/bin/env bash
# check-no-nul-bytes.sh — guard against #1384-style regressions.
#
# A literal NUL byte (\x00) anywhere in a tracked text file makes Git treat the ENTIRE file as
# binary: `git diff`, `git show`, and `git log -p` all collapse to "Binary files … differ",
# silently defeating line-by-line review until someone notices (PR #1341's review had to work
# around it with `git diff -a`). Issue #1384 fixed two such bytes that had sat undetected in
# tooling/koine-studio/src/model/modelTables.ts since commit 4b32513d; its Spec explicitly deferred
# building this guard rail as a follow-up. This script is that follow-up — see issue #1527.
#
# Enumerates every tracked file, skips extensions that are genuinely binary (a NUL byte there is
# expected, not a regression), and fails naming any remaining file that contains a NUL byte. Uses
# `od`/`tr`/`grep` rather than `grep -P '\x00'` so the same script runs identically on GNU grep (CI,
# most Linux) and BSD grep (macOS) — `-P` (PCRE) support isn't guaranteed on the latter, and a shell
# pattern literal can't hold a real NUL byte to match against directly.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 2

# Extensions that are legitimately binary — a NUL byte there is expected, not a regression. Not
# backed by .gitattributes (the repo declares none today); extend this list if a new binary asset
# type is added rather than loosening the NUL check itself.
BINARY_EXTENSIONS='png|jpe?g|gif|ico|icns|webp|bmp|tiff?|woff2?|ttf|eot|otf|wasm|dll|pdb|exe|so|dylib|zip|gz|tar|7z|jar|class|bin|pdf'

# Pre-existing offenders discovered while building this gate, deferred to issue #1528 (the
# repo-wide sweep) rather than fixed inline here — see this issue's Non-goals. Remove an entry
# once its file's byte is actually fixed; a stale entry that no longer contains a NUL byte is
# harmless (just dead weight) but should be cleaned up in the same PR that fixes it.
KNOWN_OFFENDERS=(
  "src/Koine.Compiler/Services/KoineLanguageService.cs"  # QualifiedKey(): literal NUL used as a
                                                           # composite-key delimiter — see #1528
)
is_known_offender() {
  local candidate="$1" known
  for known in "${KNOWN_OFFENDERS[@]}"; do
    [ "$candidate" = "$known" ] && return 0
  done
  return 1
}

offenders=()
known_hits=()
checked=0
while IFS= read -r f; do
  [ -f "$f" ] || continue   # a tracked path can be a submodule gitlink; skip anything not a plain file
  checked=$((checked + 1))
  if od -An -tx1 -- "$f" | tr -s ' ' '\n' | grep -qx '00'; then
    if is_known_offender "$f"; then
      known_hits+=("$f")
    else
      offenders+=("$f")
    fi
  fi
done < <(git ls-files | grep -viE "\.(${BINARY_EXTENSIONS})\$")

if [ "${#known_hits[@]}" -gt 0 ]; then
  echo "Pre-existing NUL byte(s), tracked separately (see #1528), not failing the build:"
  printf '  %s\n' "${known_hits[@]}"
fi

if [ "${#offenders[@]}" -gt 0 ]; then
  echo "NUL byte(s) found in the following tracked file(s):"
  printf '  %s\n' "${offenders[@]}"
  echo
  echo "A NUL byte anywhere in a tracked text file makes Git treat the ENTIRE file as binary,"
  echo "silently defeating line-by-line review (see issue #1384 / #1527). Remove the byte(s) before committing."
  exit 1
fi

echo "check-no-nul-bytes: OK — no new NUL bytes found in ${checked} tracked non-binary file(s)."
exit 0
