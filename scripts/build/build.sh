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

BUILD_TIMEOUT_SECS="${KOINE_BUILD_TIMEOUT_SECS:-600}"
TEST_TIMEOUT_SECS="${KOINE_TEST_TIMEOUT_SECS:-900}"

# Portable timeout wrapper — macOS ships neither `timeout` nor `gtimeout` by default, so this can't
# lean on coreutils. Deliberately NOT a single long-lived "sleep $secs" watcher subshell: a killed
# subshell doesn't reliably kill the `sleep` it forked to run that command, so a leaked orphaned sleep
# can keep this script's own output pipe open (and the caller blocked) long after the real command
# exited — exactly the silent hang this wrapper exists to prevent. Poll in short intervals instead, so
# there's never a long-lived process to leak, and use $SECONDS (a plain wall-clock arithmetic diff,
# not a blocking timer) to judge elapsed time.
run_with_timeout() {
  local secs="$1"
  shift
  "$@" &
  local cmd_pid=$!
  local start=$SECONDS
  while kill -0 "$cmd_pid" 2>/dev/null; do
    if (( SECONDS - start >= secs )); then
      echo "error: '$*' did not finish within ${secs}s — this looks like the MSBuild node-reuse deadlock from issue #1552 (concurrent git worktrees sharing a build node/lock), not a slow build. Killing pid $cmd_pid." >&2
      kill -TERM "$cmd_pid" 2>/dev/null
      sleep 5
      kill -KILL "$cmd_pid" 2>/dev/null
      wait "$cmd_pid" 2>/dev/null
      return 124
    fi
    sleep 5
  done
  wait "$cmd_pid"
}

run_with_timeout "$BUILD_TIMEOUT_SECS" dotnet build -nodereuse:false "$@"
run_with_timeout "$TEST_TIMEOUT_SECS" dotnet test -nodereuse:false -m:1
