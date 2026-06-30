#!/usr/bin/env bash
# repo-profile.sh — deterministic helper for the get-repo-profile skill.
#
# Two subcommands cover the skill's two paths so the model spends tokens on
# synthesis, not on issuing a dozen probe commands and reasoning over each:
#
#   show [dir]     Fast path (the common case). Print the committed profile if
#                  it exists; otherwise print "NO_PROFILE" and exit 3. One call,
#                  no ceremony — this is what the lifecycle skills want 95% of
#                  the time.
#
#   detect [dir]   Generation path (rare: first run or --refresh). Run every
#                  git/gh/marker/CI/label/template probe in one pass and emit a
#                  compact, labelled facts block for the model to turn into the
#                  filled template. Best-effort: any probe that can't answer
#                  prints "TODO" for that field rather than aborting.
#
# All output is plain text designed to be read straight into context.

set -uo pipefail

PROFILE_REL=".claude/skills/repo-profile.md"
CMD="${1:-show}"
# Anchor to the repo root so the profile path resolves from any subdir/worktree.
# An explicit [dir] arg wins; otherwise use the git top-level, falling back to cwd.
DIR="${2:-}"
[ -z "$DIR" ] && DIR="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
cd "$DIR" 2>/dev/null || { echo "ERR: cannot cd to '$DIR'" >&2; exit 2; }

# Run a probe; never let a failing probe kill the script. Prints the captured
# output, or "TODO: <hint>" when the probe produced nothing / errored.
probe() {
  local hint="$1"; shift
  local out
  if out="$("$@" 2>/dev/null)" && [ -n "$out" ]; then
    printf '%s\n' "$out"
  else
    printf 'TODO: %s\n' "$hint"
  fi
}

section() { printf '\n## %s\n' "$1"; }

case "$CMD" in
  show)
    if [ -f "$PROFILE_REL" ]; then
      cat "$PROFILE_REL"
    else
      echo "NO_PROFILE"
      exit 3
    fi
    ;;

  detect)
    if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      echo "ERR: not inside a git repository — nothing to profile." >&2
      exit 4
    fi

    SLUG="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"

    echo "# Detected facts for $(pwd)"
    echo "# (TODO lines = the model must determine these by hand and leave a <!-- TODO --> marker)"

    section "Identity"
    printf 'slug: %s\n' "${SLUG:-TODO: gh repo view failed — auth? run: gh auth login}"
    probe "default branch (gh repo view defaultBranchRef)" \
      gh repo view --json defaultBranchRef --jq .defaultBranchRef.name | sed 's/^/default_branch: /'

    section "Commit identity"
    echo "# A CLAUDE.md commit-identity rule WINS over git config if present:"
    grep -rIn --include=CLAUDE.md -e 'user\.email=' -e 'commit with' -e 'GitHub identity' . 2>/dev/null | head -5 \
      || echo "TODO: no CLAUDE.md commit rule found — fall back to git config / log"
    printf 'git config user.email: %s\n' "$(git config user.email 2>/dev/null || echo TODO)"
    printf 'git config user.name:  %s\n' "$(git config user.name 2>/dev/null || echo TODO)"
    echo "recent log authors (cross-check):"
    git log -8 --format='  %an <%ae>' 2>/dev/null | sort -u || echo "  TODO"

    section "Build system (marker files present)"
    for m in *.slnx *.sln *.csproj package.json Cargo.toml go.mod pyproject.toml setup.py pom.xml build.gradle build.gradle.kts; do
      for f in $m; do [ -e "$f" ] && echo "  found: $f"; done
    done 2>/dev/null
    # surface node scripts verbatim — these ARE the real build/test/lint commands
    if [ -f package.json ]; then
      echo "package.json scripts:"
      grep -A30 '"scripts"' package.json 2>/dev/null | grep -E '^\s*"' | head -25 | sed 's/^/  /'
      for lf in package-lock.json yarn.lock pnpm-lock.yaml; do [ -e "$lf" ] && echo "  lockfile: $lf"; done
    fi

    section "CI gates (commands CI runs and fails on)"
    if [ -d .github/workflows ]; then
      grep -rhE 'run:|dotnet |npm |pnpm |yarn |cargo |go (build|test|vet)|mvn |gradle |pytest|ruff|black|gofmt|--verify-no-changes|--check' \
        .github/workflows/ 2>/dev/null | grep -vE '^\s*#' | sed -E 's/^\s+//' | sort -u | head -40 | sed 's/^/  /'
    else
      echo "  TODO: no .github/workflows/ — CI gates unknown"
    fi

    section "Integration style (infer squash/merge/rebase)"
    echo "branch protection (required_* hints merge policy):"
    if [ -n "${SLUG:-}" ]; then
      gh api "repos/$SLUG/branches/$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null)" \
        --jq '.protection' 2>/dev/null | head -20 | sed 's/^/  /' || echo "  TODO: branch protection unreadable (auth/permissions)"
    else
      echo "  TODO: no slug — cannot read branch protection"
    fi
    echo "recent subjects (… (#N) on linear main ⇒ squash; merge commits ⇒ merge):"
    git log -12 --format='  %s' 2>/dev/null || echo "  TODO"

    section "Labels (record exact strings — skills apply them verbatim)"
    gh label list --limit 200 --json name,description \
      --jq '.[] | "  " + .name + (if .description != "" then " — " + .description else "" end)' 2>/dev/null \
      || echo "  TODO: gh label list failed (auth?) — classify into type / priority / effort / scope by hand"

    section "Issue templates"
    if [ -d .github/ISSUE_TEMPLATE ]; then
      for t in .github/ISSUE_TEMPLATE/*; do [ -e "$t" ] && echo "  $(basename "$t")"; done
    else
      echo "  TODO: no .github/ISSUE_TEMPLATE/ directory"
    fi

    section "Conflict hot-spot candidates (derive resolutions in the template)"
    for c in Directory.Build.props CHANGELOG.md ./*.lock package-lock.json yarn.lock pnpm-lock.yaml Cargo.lock go.sum; do
      [ -e "$c" ] && echo "  ${c#./}"
    done
    echo "  (also: version files, generated/snapshot dirs, the solution/project files)"

    section "Architecture grain (scan CLAUDE.md / README for invariants)"
    grep -rIn --include=CLAUDE.md --include=README.md \
      -iE 'never|always|in order|target-agnostic|do not|must not|keep .* (agnostic|isolated)' . 2>/dev/null | head -8 | sed 's/^/  /' \
      || echo "  TODO: no obvious invariants — leave blank-with-TODO"

    section "Worktree home"
    if [ -d .claude/worktrees ]; then echo "  .claude/worktrees/"; else echo "  (none — use the skills' default)"; fi

    echo ""
    echo "# End of facts. Fill references/profile-template.md from the above, then write $PROFILE_REL"
    ;;

  *)
    echo "usage: repo-profile.sh {show|detect} [dir]" >&2
    exit 2
    ;;
esac
