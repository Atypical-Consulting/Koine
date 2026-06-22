#!/usr/bin/env bash
# PostToolUse(Edit|Write|MultiEdit): auto-format the edited C# file so the CI
# `dotnet format --verify-no-changes` gate can never fail on hand-written code.
# Scopes to the nearest enclosing .csproj (much faster than loading the whole
# solution) and skips generated / build output.
set -euo pipefail
shopt -s nullglob

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_response.filePath // empty')

[[ "$file" == *.cs ]] || exit 0                       # hand-written C# only
case "$file" in                                       # never format generated/build output
  */Grammar/gen/*|*/Generated/*|*/generated/*|*/bin/*|*/obj/*) exit 0 ;;
esac
[[ -f "$file" ]] || exit 0

root="${CLAUDE_PROJECT_DIR:-$(git -C "$(dirname "$file")" rev-parse --show-toplevel 2>/dev/null || true)}"
[[ -n "$root" && -d "$root" ]] || exit 0
cd "$root" || exit 0

# Walk up to the nearest enclosing project.
dir=$(dirname "$file")
target=""
while [[ "$dir" == "$root"* && "$dir" != "/" ]]; do
  cands=("$dir"/*.csproj)
  if (( ${#cands[@]} )); then target="${cands[0]}"; break; fi
  dir=$(dirname "$dir")
done
[[ -n "$target" ]] || target="$root/Koine.slnx"

# `dotnet format --include` matches paths relative to the CWD (now $root), so
# pass repo-relative paths — an absolute --include silently matches nothing.
# No --no-restore: the hook can fire before the tree is restored, and an
# unrestored project makes `dotnet format` silently no-op. Restore is cached, so
# only the first run pays for it. Failures (e.g. a mid-edit uncompilable file)
# are swallowed — CI is the backstop; the hook must never block or spam.
dotnet format "${target#"$root"/}" --include "${file#"$root"/}" >/dev/null 2>&1 || true
