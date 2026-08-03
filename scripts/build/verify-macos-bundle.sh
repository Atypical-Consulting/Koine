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
  if out=$("$sidecar" --version 2>&1); then
    note "sidecar executes after signing (--version -> ${out%%$'\n'*})"
  else
    bad "sidecar failed to execute after signing: ${out%%$'\n'*}"
    bad "  (if this says 'Failed to create CoreCLR', Entitlements.plist is missing or"
    bad "   not wired into bundle.macOS.entitlements — see Task 2)"
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "==> NOT shippable" >&2
  exit 1
fi
echo "==> shippable"
