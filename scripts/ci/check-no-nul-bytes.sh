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
# pattern literal can't hold a real NUL byte to match against directly. Reads `git ls-files -z`
# (NUL-delimited) rather than piping through another `grep`, so a path containing a backslash,
# quote, or non-ASCII byte — which Git C-quotes in its normal line-based output — is never silently
# skipped.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 2

# Extensions that are legitimately binary — a NUL byte there is expected, not a regression. Not
# backed by .gitattributes (the repo declares none today); extend this list if a new binary asset
# type is added rather than loosening the NUL check itself. Matched case-insensitively via `case`
# below (shopt nocasematch) in a plain loop, not a regex, so it works the same on every bash without
# relying on PCRE or a lowercasing expansion (`${var,,}` needs bash 4+, not guaranteed on macOS's
# default bash, which is still 3.2).
BINARY_EXTENSIONS=(png jpg jpeg gif ico icns webp bmp tif tiff woff woff2 ttf eot otf wasm dll pdb exe so dylib zip gz tar 7z jar class bin pdf)
shopt -s nocasematch

is_binary_extension() {
  local candidate="$1" ext
  for ext in "${BINARY_EXTENSIONS[@]}"; do
    case "$candidate" in
      *".$ext") return 0 ;;
    esac
  done
  return 1
}

# Pre-existing offenders discovered while building this gate, deferred to issue #1528 (the
# repo-wide sweep) rather than fixed inline here — see this issue's Non-goals. Each entry is
# "path:expected NUL-byte count" — a file with MORE NUL bytes than its recorded count still fails
# (a genuinely new byte, even in an already-exempted file, must not be silently swallowed). Once a
# listed file is actually fixed, remove its entry in the same commit — a stale entry whose actual
# count is now 0 is harmless but should be cleaned up.
KNOWN_OFFENDERS=(
  "src/Koine.Compiler/Services/KoineLanguageService.cs:1"  # QualifiedKey(): literal NUL used as a
                                                             # composite-key delimiter — see #1528
)
known_offender_expected_count() {
  local candidate="$1" entry path count
  for entry in "${KNOWN_OFFENDERS[@]}"; do
    path="${entry%:*}"
    count="${entry##*:}"
    if [ "$candidate" = "$path" ]; then
      printf '%s\n' "$count"
      return 0
    fi
  done
  return 1
}

offenders=()
known_hits=()
checked=0
while IFS= read -r -d '' f; do
  is_binary_extension "$f" && continue
  [ -f "$f" ] || continue   # a tracked path can be a submodule gitlink; skip anything not a plain file
  checked=$((checked + 1))

  od_output=$(od -An -tx1 -- "$f" 2>&1)
  od_status=$?
  if [ "$od_status" -ne 0 ]; then
    # Fail closed: a file this check can't even read must not silently read as "clean".
    offenders+=("$f (could not be read: ${od_output})")
    continue
  fi

  nul_count=$(printf '%s' "$od_output" | tr -s ' ' '\n' | grep -cx '00')
  [ "$nul_count" -eq 0 ] && continue

  if expected=$(known_offender_expected_count "$f") && [ "$nul_count" -le "$expected" ]; then
    known_hits+=("$f")
  else
    offenders+=("$f")
  fi
done < <(git ls-files -z)

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
