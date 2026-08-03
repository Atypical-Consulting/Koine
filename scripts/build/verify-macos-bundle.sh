#!/usr/bin/env bash
# Verify a built macOS .app bundle is shippable.
#
# Exists because 0.251.0 shipped with a *declared but absent* bundle seal: the Rust
# linker's automatic ad-hoc signature on the main binary says sealed resources must be
# present, but `tauri build` never ran `codesign` on the bundle, so Contents/_CodeSignature/
# did not exist. Gatekeeper reports that as "damaged", which no user-facing bypass clears.
# Nothing in CI noticed for a whole release.
#
# The executability check matters just as much: under hardened runtime (Tauri's default)
# the self-contained .NET sidecar is SIGKILLed with "Failed to create CoreCLR" unless
# Entitlements.plist grants com.apple.security.cs.allow-jit. That failure leaves the
# signature perfectly valid, so signature checks alone would not catch it.
set -uo pipefail

app="${1:-}"
if [ -z "$app" ] || [ ! -d "$app" ]; then
  echo "usage: $0 <path/to/Koine Studio.app>" >&2
  exit 2
fi

fail=0
note() { printf '  ok   %s\n' "$1"; }
bad()  { printf '  FAIL %s\n' "$1" >&2; fail=1; }

echo "==> verifying $app"

# 1. The bundle seal must exist on disk.
if [ -d "$app/Contents/_CodeSignature" ]; then
  note "Contents/_CodeSignature present"
else
  bad "Contents/_CodeSignature missing — the bundle was never codesigned"
fi

# 2. The signature must actually validate.
if out=$(codesign --verify --verbose=2 "$app" 2>&1); then
  note "codesign --verify passed"
else
  bad "codesign --verify rejected the bundle: $out"
fi

# 3. The sidecar must be sealed. An unsigned nested binary invalidates the outer seal.
sidecar="$app/Contents/MacOS/koine"
if [ ! -f "$sidecar" ]; then
  bad "sidecar not found at Contents/MacOS/koine"
else
  if out=$(codesign --verify --verbose=2 "$sidecar" 2>&1); then
    note "sidecar signature valid"
  else
    bad "sidecar signature invalid: $out"
  fi

  # 4. The sidecar must still RUN after signing. This is the hardened-runtime trap.
  #
  # Bound the wait to real wall-clock time. `timeout`/`gtimeout` are not on stock
  # macOS, and a naive `perl -e 'alarm ...; exec ...'` wrapped in `out=$(...)` does
  # NOT bound wall-clock time: command substitution reads a pipe until every
  # process holding its write end closes it, and an orphaned grandchild the
  # sidecar spawned (it is a self-contained .NET app; assume it may fork children)
  # inherits that pipe and keeps the substitution blocked long after the alarm
  # has killed only the direct child. Two changes fix that:
  #   - capture output via a temp file instead of `$(...)` — a file has no such
  #     "wait for every writer to close" behaviour, so waiting on the direct
  #     child's exit is enough;
  #   - run the sidecar in its own process group (bash job control, `set -m`,
  #     inside a subshell so it doesn't affect the rest of this script) so the
  #     watchdog can SIGTERM/SIGKILL the *group* — sidecar plus anything it
  #     spawned — rather than leaving orphans running past the deadline.
  # A separate flag file (existence, not content) distinguishes "the watchdog
  # killed it for running too long" from a same-exit-code coincidence like the
  # process signalling itself. The flag alone is NOT authoritative, though: the
  # watchdog's `kill -0 "$run_pid"` liveness probe can observe a zombie — the
  # sidecar has already exited but this script's own `wait` below hasn't reaped
  # it yet — and wrongly conclude it's still running, setting the flag on a run
  # that in fact succeeded cleanly. So the reaped exit status is authoritative:
  # a clean `rc -eq 0` always wins over the flag, even if the flag got set.
  #
  # That precedence rests on an assumption OUTSIDE this file: `Koine.Cli --version`
  # installs no SIGTERM handler, so a killed sidecar cannot exit 0 — under the
  # watchdog's TERM it dies with 143. If Koine.Cli ever gains graceful shutdown, a
  # timed-out run could exit 0 and this branch would report PASS on a hang: the one
  # direction a release gate must never fail in. Revisit here if that changes.
  # (Reconciling on wall-clock instead is NOT the fix — the zombie misreport happens
  # when elapsed is already ~= the bound, so `elapsed >= bound` is true exactly in
  # the case it is meant to exclude.)
  sidecar_timeout="${KOINE_SIDECAR_TIMEOUT_SECS:-60}"
  sidecar_out="$(mktemp "${TMPDIR:-/tmp}/koine-verify-sidecar.XXXXXX")"
  sidecar_timed_out="$(mktemp "${TMPDIR:-/tmp}/koine-verify-timeout.XXXXXX")"
  rm -f "$sidecar_timed_out"  # existence (not content) is the timeout signal
  trap 'rm -f "$sidecar_out" "$sidecar_timed_out"' EXIT

  (
    set -m
    "$sidecar" --version >"$sidecar_out" 2>&1 &
    run_pid=$!
    (
      sleep "$sidecar_timeout"
      if kill -0 "$run_pid" 2>/dev/null; then
        : >"$sidecar_timed_out"
        kill -TERM -- -"$run_pid" 2>/dev/null
        sleep 1
        kill -KILL -- -"$run_pid" 2>/dev/null
      fi
    ) &
    watchdog_pid=$!
    wait "$run_pid"
    run_rc=$?
    kill -- -"$watchdog_pid" 2>/dev/null   # stop the watchdog's own group (incl. its sleep)
    wait "$watchdog_pid" 2>/dev/null
    exit "$run_rc"
  ) 2>/dev/null   # swallow bash's job-control "Killed: N" notice; real diagnostics are in $sidecar_out
  rc=$?
  out=$(cat "$sidecar_out" 2>/dev/null)

  if [ -e "$sidecar_timed_out" ] && [ "$rc" -ne 0 ]; then
    bad "sidecar did not return within ${sidecar_timeout}s (set KOINE_SIDECAR_TIMEOUT_SECS to override)"
  elif [ "$rc" -eq 0 ]; then
    note "sidecar executes after signing (--version -> ${out%%$'\n'*})"
  elif [ "$rc" -gt 128 ]; then
    if [ -n "$out" ]; then
      bad "sidecar died from signal $((rc-128)) after signing (output before death: ${out%%$'\n'*})"
    else
      bad "sidecar died from signal $((rc-128)) after signing (no output captured)"
    fi
  else
    bad "sidecar failed to execute after signing (exit $rc): ${out:-<no output>}"
    case "$out" in
      *"Failed to create CoreCLR"*)
        bad "  Entitlements.plist is missing or not wired into bundle.macOS.entitlements — see Task 2" ;;
    esac
  fi
  rm -f "$sidecar_out" "$sidecar_timed_out"
  trap - EXIT
fi

if [ "$fail" -ne 0 ]; then
  echo "==> NOT shippable" >&2
  exit 1
fi
echo "==> shippable"
