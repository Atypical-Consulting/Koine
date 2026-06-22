#!/usr/bin/env bash
# PreToolUse(Edit|Write|MultiEdit): refuse edits to generated or build-output
# files. They are regenerated from source on every build, so editing them is
# wasted work that gets blown away.
set -euo pipefail

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')

deny() {
  jq -n --arg r "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

case "$file" in
  */Grammar/gen/*)
    deny "ANTLR-generated parser code — don't hand-edit. Change the grammar instead: src/Koine.Compiler/Grammar/KoineLexer.g4 / KoineParser.g4 (it regenerates on build)." ;;
  */Generated/*|*/generated/*)
    deny "Emitted by the Koine CLI and wiped on every build. Edit the .koi source or the emitter under src/Koine.Compiler/Emit/ instead." ;;
  */bin/*|*/obj/*)
    deny "Build artifact (bin/obj). Edit the corresponding source file instead." ;;
esac

exit 0
