#!/usr/bin/env bash
# Build and test Koine.
set -euo pipefail
# This script lives in scripts/build/; run from the repo root so dotnet picks
# up the solution.
cd "$(dirname "$0")/../.."

# MSBuild's persistent build nodes (and the Roslyn VBCSCompiler server) are keyed by a pipe name
# derived from the toolset install, not by working directory — so concurrent `dotnet build`/`dotnet
# test` runs from DIFFERENT git worktrees on the same machine (routine for parallel agents) can end
# up sharing a node and deadlock on it at 0% CPU forever, never timing out on their own (issue #1552).
# Disabling node reuse here, plus the hard per-command timeout below, turns that silent multi-hour
# hang into a fast, loud failure instead.
export MSBUILDDISABLENODEREUSE=1

# Overridable if a legitimately slow cold build/restore ever needs more headroom than the defaults
# below; undocumented otherwise, so surface them here too.
BUILD_TIMEOUT_SECS="${KOINE_BUILD_TIMEOUT_SECS:-600}"
TEST_TIMEOUT_SECS="${KOINE_TEST_TIMEOUT_SECS:-900}"

# Recursively signal a process and every descendant it has spawned — the issue's own repro showed a
# hung `dotnet test` as a parent plus 15 child processes (MSBuild worker nodes, the VSTest host, …), so
# signaling only the top-level pid would leave the rest running and still holding whatever lock/pipe
# caused the hang in the first place.
kill_tree() {
  local pid="$1" sig="$2" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child" "$sig"
  done
  kill "-$sig" "$pid" 2>/dev/null || true
}

# Portable timeout wrapper — macOS ships neither `timeout` nor `gtimeout` by default, so this can't
# lean on coreutils. Deliberately NOT a single long-lived "sleep $secs" watcher subshell: a killed
# subshell doesn't reliably kill the `sleep` it forked to run that command, so a leaked orphaned sleep
# can keep this script's own output pipe open (and the caller blocked) long after the real command
# exited — exactly the silent hang this wrapper exists to prevent. Poll in short intervals instead, so
# there's never a long-lived process to leak, and use $SECONDS (a plain wall-clock arithmetic diff,
# not a blocking timer) to judge elapsed time. Every step in the timeout branch is `|| true`-guarded:
# under `set -e`, an unguarded `kill`/`wait` on an already-dead pid returns non-zero and would abort the
# script right there, before it ever reaches `return 124`.
run_with_timeout() {
  local secs="$1"
  shift
  "$@" &
  local cmd_pid=$!
  local start=$SECONDS
  while kill -0 "$cmd_pid" 2>/dev/null; do
    if (( SECONDS - start >= secs )); then
      echo "error: '$*' did not finish within ${secs}s — this looks like the MSBuild node-reuse deadlock from issue #1552 (concurrent git worktrees sharing a build node/lock), not a slow build. Killing the process tree rooted at pid $cmd_pid." >&2
      kill_tree "$cmd_pid" TERM
      sleep 5
      kill_tree "$cmd_pid" KILL
      wait "$cmd_pid" 2>/dev/null || true
      return 124
    fi
    sleep 5
  done
  wait "$cmd_pid"
}

run_with_timeout "$BUILD_TIMEOUT_SECS" dotnet build -nodereuse:false "$@"
# -m:1 caps the test run to a single MSBuild worker node — this is the exact combination (issue #1552)
# proven to turn a 46-minute cross-worktree hang into a ~1-2 minute pass. Not applied to the build above:
# that would serialize the whole solution's compilation for no proven benefit, since -nodereuse:false
# alone already stops build-phase nodes from persisting into the test phase.
run_with_timeout "$TEST_TIMEOUT_SECS" dotnet test -nodereuse:false -m:1
