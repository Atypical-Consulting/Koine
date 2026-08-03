# macOS Bundle Signing and App Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shipped macOS Koine Studio bundle carry a valid code signature (so it stops opening as "damaged"), keep the bundled `koine` sidecar executable under hardened runtime, ship the Koine hexagon-κ app icon instead of Tauri's default, and correct the install docs.

**Architecture:** Signing is done natively by the Tauri v2 bundler rather than by a post-build `codesign` step, because Tauri produces the `.app` and the `.dmg` in one invocation and signs inside-out (sidecar first, then bundle) before DMG assembly. `bundle.macOS.signingIdentity: "-"` makes ad-hoc the permanent fallback for forks and PR builds; the `APPLE_SIGNING_IDENTITY` environment variable overrides it with a real Developer ID when #1137 lands. A committed `Entitlements.plist` grants the one entitlement the .NET sidecar needs under hardened runtime. A new verification script, wired into CI, is the regression guard that was missing when this bug shipped.

**Tech Stack:** Tauri v2 bundler, `codesign` (Xcode CLT), `@tauri-apps/cli` (`tauri icon`), GitHub Actions, Astro (website).

## Global Constraints

- Commit identity: `git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit`.
- PR title must follow Conventional Commits (CI `pr-title-lint.yml` rejects otherwise); use the `ci(studio):`, `fix(studio):`, `docs:` scopes as indicated per task.
- `TreatWarningsAsErrors` is intentionally NOT set repo-wide — do not add it.
- Pin GitHub Actions by SHA, per existing repo convention in `studio-build.yml`.
- When running `dotnet build`/`dotnet test` from a worktree, pass `-nodereuse:false` and set `MSBUILDDISABLENODEREUSE=1` (issue #1552), or use `./scripts/build/build.sh`.
- `ls <path>` is broken in this shell (aliased to `eza --icons`, which swallows the path argument). Use `command ls`.
- Do not add `hardenedRuntime: false` as a workaround. Hardened runtime is mandatory for notarization (#1137); the ad-hoc build must rehearse the notarized build so the only difference at #1137 time is the identity itself.

## Measured facts this plan is built on

All measured 2026-08-03 on macOS 26.5.1 (Darwin 25.5.0) against the shipped
`Koine Studio 0.251.0.dmg`. Do not re-derive these; do re-verify after changing them.

| Fact | Evidence |
|---|---|
| The bundle has no `Contents/_CodeSignature/` | `command ls "/Applications/Koine Studio.app/Contents"` → `Info.plist MacOS Resources` |
| Its signature is therefore *invalid*, not merely untrusted | `codesign --verify` → `code has no resources but signature indicates they must be present` |
| This ships in the DMG (not install-time corruption) | Same failure on the `.app` inside the mounted DMG |
| Ad-hoc signing the bundle repairs it | `codesign --force --sign -` (no `--deep`) → `valid on disk; satisfies its Designated Requirement` |
| **`--deep` destroys the .NET sidecar** | after `--deep`, `Contents/MacOS/koine` is re-signed `Koine.Cli` → `koine-<hash>`, then produces no output and never terminates. Checks 1-3 still `ok`; only check 4 catches it |
| Tauri v2 supports `"signingIdentity": "-"` for ad-hoc | Tauri v2 docs, `distribute/Sign/macos.mdx` |
| `APPLE_SIGNING_IDENTITY` env overrides the config value | Tauri v2 docs, `reference/environment-variables.mdx` |
| **`hardenedRuntime` defaults to `true`** | `https://schema.tauri.app/config/2` → `MacConfig.hardenedRuntime.default = true` |
| **The .NET sidecar dies under hardened runtime without entitlements** | ad-hoc + `--options runtime` → `Failed to create CoreCLR, HRESULT: 0x80070008`, SIGKILL |
| `com.apple.security.cs.allow-jit` **alone** fixes it | Signed with that entitlement alone → `0.251.0`, exit 0 |
| `disable-library-validation` does **not** fix it and is not needed | That entitlement alone → still `Failed to create CoreCLR` |

The two rows in bold are why the entitlements file ships in Task 2 rather than being
deferred to #1137: `signingIdentity: "-"` on its own would enable hardened runtime by
default and break the CLI sidecar, trading "the app won't open" for "the app opens but
cannot compile anything" — a worse and much less obvious failure.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/build/verify-macos-bundle.sh` (create) | Single source of truth for "is this `.app` shippable" — seal present, signature valid, sidecar valid *and executable*. Used locally and by CI. |
| `tooling/koine-studio/src-tauri/Entitlements.plist` (create) | The one entitlement the .NET sidecar needs under hardened runtime. |
| `tooling/koine-studio/src-tauri/tauri.conf.json` (modify) | Wire `signingIdentity` + `entitlements` into `bundle.macOS`. |
| `.github/workflows/studio-build.yml` (modify) | Run the verification script on the macOS leg so this can never silently regress. |
| `tooling/koine-studio/src-tauri/icons/*` (replace, 16 files) | The bundle/installer icon set, regenerated from the brand mark. |
| `website/src/components/Downloads.astro` (modify) | Correct the macOS install note. |
| `website/src/content/docs/start/installation.md` (modify) | Correct the same note in the docs site. |

---

### Task 1: Signature verification script

The guard that was missing. Written first, and proven to *fail* against today's shipped
artifact — that failure is the test that the check actually detects the bug.

**Files:**
- Create: `scripts/build/verify-macos-bundle.sh`

**Interfaces:**
- Produces: `scripts/build/verify-macos-bundle.sh <path-to-.app>` — exit `0` if the bundle is
  shippable, `1` if any check fails, `2` on usage error. Consumed by Task 3 (CI wiring).

- [ ] **Step 1: Write the script**

```bash
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
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x scripts/build/verify-macos-bundle.sh
```

- [ ] **Step 3: Run it against today's shipped artifact to verify it FAILS**

Run: `scripts/build/verify-macos-bundle.sh "/Applications/Koine Studio.app"`

Expected: exit 1, with `FAIL Contents/_CodeSignature missing — the bundle was never
codesigned` and `FAIL codesign --verify rejected the bundle: ... code has no resources but
signature indicates they must be present`.

If `/Applications/Koine Studio.app` is not present, install it from
`~/Downloads/Koine Studio 0.251.0.dmg` first, or point the script at the `.app` inside the
mounted DMG. **A pass here means the script is not detecting the bug — stop and fix the
script before continuing.**

- [ ] **Step 4: Verify it PASSES against a known-good bundle**

```bash
rm -rf /tmp/vgood && mkdir -p /tmp/vgood
cp -R "<a broken .app fixture>" /tmp/vgood/
xattr -dr com.apple.quarantine "/tmp/vgood/Koine Studio.app"
codesign --force --sign - "/tmp/vgood/Koine Studio.app"
scripts/build/verify-macos-bundle.sh "/tmp/vgood/Koine Studio.app"
```

Expected: exit 0, `==> shippable`. This proves the script distinguishes good from bad rather
than always failing. (Quarantine is stripped because a quarantined copy is SIGKILLed on exec
regardless of signature — that would make check 4 fail for an unrelated reason.)

⛔ **Do NOT add `--deep` here, and do not add it later "to be thorough."** Measured 2026-08-03:
`codesign --force --deep --sign -` re-signs the nested sidecar, replacing its `Koine.Cli`
identifier with a generated `koine-<hash>`, after which the .NET single-file binary produces no
output and does not terminate (>60s). Checks 1-3 all still report `ok` — **only check 4 catches
it**, which is the clearest possible argument for keeping check 4. Sign inside-out instead: leave
the sidecar's own signature intact and sign only the bundle. Tauri's bundler works the same way
(`sign_macos_binary()` per binary, never `--deep`), and Apple deprecates `--deep`. This is also
why Task 2 uses Tauri-native signing rather than a post-build `codesign` step.

- [ ] **Step 5: Commit**

```bash
git add scripts/build/verify-macos-bundle.sh
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "ci(studio): add a macOS bundle signature + sidecar executability check

Guards the two failure modes that shipped or nearly shipped in 0.251.0: a
declared-but-absent bundle seal (Gatekeeper reports 'damaged'), and a sidecar
that is validly signed but cannot execute under hardened runtime."
```

---

### Task 2: Ad-hoc bundle signing and the sidecar entitlement

**Files:**
- Create: `tooling/koine-studio/src-tauri/Entitlements.plist`
- Modify: `tooling/koine-studio/src-tauri/tauri.conf.json` (the `bundle.macOS` object)

**Interfaces:**
- Consumes: `scripts/build/verify-macos-bundle.sh` from Task 1.
- Produces: a `bundle.macOS` config in which `signingIdentity` is overridable by the
  `APPLE_SIGNING_IDENTITY` environment variable — the seam #1137 uses to upgrade ad-hoc to
  Developer ID without further config change.

- [ ] **Step 1: Create the entitlements file**

Create `tooling/koine-studio/src-tauri/Entitlements.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <!-- The bundled `koine` sidecar is a self-contained .NET application. Tauri signs it
         with `--options runtime` (bundle.macOS.hardenedRuntime defaults to true, and
         hardened runtime is mandatory for notarization). Without this entitlement CoreCLR
         cannot allocate executable memory for its JIT, and the process is SIGKILLed with
         "Failed to create CoreCLR, HRESULT: 0x80070008" — while the code signature itself
         remains perfectly valid, so signature checks alone will not catch it.

         Measured 2026-08-03: allow-jit ALONE is sufficient.
         com.apple.security.cs.disable-library-validation was tested and is NOT required —
         do not add it, it weakens the runtime for no benefit and draws notarization
         scrutiny. -->
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
</dict>
</plist>
```

- [ ] **Step 2: Wire it into the bundle config**

In `tooling/koine-studio/src-tauri/tauri.conf.json`, replace the `bundle.macOS` object:

```json
    "macOS": {
      "minimumSystemVersion": "10.15"
    }
```

with:

```json
    "macOS": {
      "minimumSystemVersion": "10.15",
      "signingIdentity": "-",
      "entitlements": "Entitlements.plist"
    }
```

`"-"` is Tauri's pseudo-identity for ad-hoc signing. It is the permanent fallback for forks
and PR builds, which will never hold signing secrets; `APPLE_SIGNING_IDENTITY` overrides it
when #1137 provisions a Developer ID.

- [ ] **Step 3: Build the bundle locally**

```bash
cd tooling/koine-studio
npm ci
npm run tauri -- build --bundles app
```

Expected: a release build (slow — a cold cargo release build is several minutes) producing
`src-tauri/target/release/bundle/macos/Koine Studio.app`. `--bundles app` skips DMG assembly
to keep the loop fast; Task 5 covers the full bundle.

- [ ] **Step 4: Verify the bundle now passes**

Run from the repo root:

```bash
scripts/build/verify-macos-bundle.sh "tooling/koine-studio/src-tauri/target/release/bundle/macos/Koine Studio.app"
```

Expected: exit 0, `==> shippable`, with all four `ok` lines — in particular
`ok sidecar executes after signing (--version -> 0.251.0)`.

If it reports `Failed to create CoreCLR`, the entitlements file was not applied: confirm the
`entitlements` path in `tauri.conf.json` resolves relative to `src-tauri/`, and confirm with
`codesign -d --entitlements - "<app>/Contents/MacOS/koine"` that `allow-jit` is present.

- [ ] **Step 5: Verify the full DMG path too**

```bash
cd tooling/koine-studio && npm run tauri -- build
```

Then verify the `.app` *inside* the produced DMG, which is what users actually get:

```bash
hdiutil attach "tooling/koine-studio/src-tauri/target/release/bundle/dmg/Koine Studio_0.251.0_aarch64.dmg" \
  -nobrowse -quiet -mountpoint /tmp/koineverify
scripts/build/verify-macos-bundle.sh "/tmp/koineverify/Koine Studio.app"
hdiutil detach /tmp/koineverify -quiet
```

Expected: exit 0. Adjust the DMG filename to whatever `bundle/dmg/` actually contains. This
step exists because the original bug was only observable in the shipped DMG.

- [ ] **Step 6: Commit**

```bash
git add tooling/koine-studio/src-tauri/Entitlements.plist tooling/koine-studio/src-tauri/tauri.conf.json
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "fix(studio): ad-hoc sign the macOS bundle so it stops opening as 'damaged'

tauri build never ran codesign on the bundle, so Contents/_CodeSignature/ was
absent while the linker's ad-hoc signature on the main binary declared that
sealed resources must be present. Gatekeeper reports that as 'damaged', which
no user-facing bypass clears.

signingIdentity '-' makes Tauri sign inside-out before DMG assembly, and stays
the fallback for forks and PR builds; APPLE_SIGNING_IDENTITY overrides it once
a Developer ID exists (#1137).

Entitlements.plist ships with it, not later: hardenedRuntime defaults to true,
and without com.apple.security.cs.allow-jit the self-contained .NET sidecar is
SIGKILLed with 'Failed to create CoreCLR'."
```

---

### Task 3: Wire the check into CI

**Files:**
- Modify: `.github/workflows/studio-build.yml` — insert a step between `Build Tauri installers`
  and `Collect installers` (around line 300).

**Interfaces:**
- Consumes: `scripts/build/verify-macos-bundle.sh` from Task 1.

- [ ] **Step 1: Add the verification step**

Insert immediately after the `Build Tauri installers` step:

```yaml
      # The 0.251.0 macOS artifact shipped with a declared-but-absent bundle seal and
      # nothing noticed, because nothing looked. This looks. It also runs the sidecar,
      # which is the only way to catch a hardened-runtime entitlements regression — that
      # failure leaves the signature valid.
      - name: Verify macOS bundle is shippable
        if: ${{ inputs.bundle && runner.os == 'macOS' }}
        shell: bash
        run: |
          set -euo pipefail
          app="tooling/koine-studio/src-tauri/target/release/bundle/macos/Koine Studio.app"
          if [ ! -d "$app" ]; then
            echo "::error::Expected bundle not found at $app" >&2
            exit 1
          fi
          scripts/build/verify-macos-bundle.sh "$app"
```

- [ ] **Step 2: Update the stale comment above the build step**

The comment block above `Build Tauri installers` currently ends with
`Installers are UNSIGNED (no signing secrets configured).` — now false for macOS. Replace
that sentence with:

```
      # macOS bundles are ad-hoc signed (tauri.conf.json bundle.macOS.signingIdentity "-"),
      # which makes the signature VALID but not TRUSTED — users still see a Gatekeeper
      # prompt until #1137 provisions a Developer ID. Windows/Linux remain unsigned.
```

- [ ] **Step 3: Validate the workflow parses**

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/studio-build.yml')); print('YAML ok')"
```

Expected: `YAML ok`.

- [ ] **Step 4: Confirm the guard is reachable on the CI leg**

Confirm by reading the file that the new step sits inside the `studio` job (so `runner.os`
resolves per-matrix-entry) and after `Build Tauri installers`. The `if` gates on
`inputs.bundle`, so the read-only CI caller (`koine-studio.yml`, `bundle=false`) skips it and
only the release path runs it.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/studio-build.yml
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "ci(studio): fail the release build if the macOS bundle is not shippable"
```

---

### Task 4: Correct the macOS install instructions

Both surfaces currently lead with "right-click ▸ Open", which could not clear "damaged" and —
independently — has not been the bypass path since macOS 15 Sequoia.

**Files:**
- Modify: `website/src/components/Downloads.astro:109-110`
- Modify: `website/src/content/docs/start/installation.md:18-19`

- [ ] **Step 1: Verify the macOS 15+ claim before writing it down**

On the machine running this, with a quarantined ad-hoc-signed build from Task 2:

```bash
cp -R "tooling/koine-studio/src-tauri/target/release/bundle/macos/Koine Studio.app" /tmp/gktest.app
xattr -w com.apple.quarantine "0081;00000000;Safari;" /tmp/gktest.app
open /tmp/gktest.app   # observe the dialog wording
```

Record which wording appears and which recovery path works: right-click ▸ Open, or
System Settings ▸ Privacy & Security ▸ Open Anyway. **Write whichever is actually true.** The
entire point of this task is that the current text is untrue; do not replace it with a second
claim taken on faith. If right-click ▸ Open still works on this macOS version, keep it.

- [ ] **Step 2: Update `Downloads.astro`**

Replace the `.dl__note` text at lines 109-110. Current:

```
unsigned, so on first launch right-click the app ▸ <strong>Open</strong> (or run
<code>xattr -d com.apple.quarantine "/Applications/Koine Studio.app"</code>).
```

New — adjust the first sentence to match what Step 1 actually observed:

```
signed but not yet notarized, so macOS asks for confirmation on first launch: open
<strong>System Settings ▸ Privacy &amp; Security</strong> and choose <strong>Open Anyway</strong>
(or run <code>xattr -dr com.apple.quarantine "/Applications/Koine Studio.app"</code>).
```

Note `-dr`, not `-d`: the recursive form is the one verified to work.

- [ ] **Step 3: Update `installation.md`**

Apply the same correction to the `:::caution` block at lines 18-19, preserving the existing
Windows SmartScreen sentence unchanged (Windows is still genuinely unsigned).

- [ ] **Step 4: Build the website to confirm nothing broke**

```bash
cd website && npm ci && npm run build
```

Expected: a successful build. (`Downloads.astro` contains HTML entities — `&amp;` above is
deliberate; an unescaped `&` will fail the Astro build.)

- [ ] **Step 5: Commit**

```bash
git add website/src/components/Downloads.astro website/src/content/docs/start/installation.md
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "docs: correct the macOS first-launch instructions

Both surfaces told users to right-click the app and choose Open. That could not
clear the 'damaged' error the unsigned-seal bug produced, and it is not the
bypass path on macOS 15+ regardless."
```

**Do not delete these notes.** #1137's plan calls for removing them once installers are
signed; that applies only to the *notarized* end state. After ad-hoc signing a prompt still
appears, so the notes are still needed and still true.

---

### Task 5: Regenerate the app icon from the hexagon-κ mark

#1141 adopted the new brand across `logo.ts`, the favicon, the PWA icons, README and website;
its file list never touched `src-tauri/icons/`, so the desktop bundle kept Tauri's stock
double-circle.

**Files:**
- Replace: all 16 files in `tooling/koine-studio/src-tauri/icons/`
- Source: `tooling/koine-studio/src/assets/brand/koine-icon-tile.svg`

- [ ] **Step 1: Confirm what `tauri icon` accepts**

```bash
cd tooling/koine-studio && npx tauri icon --help
```

Read the `--help` output for the input argument. Tauri v2 accepts a squared PNG **or** SVG. If
the help text on the pinned CLI version says PNG only, rasterize first:

```bash
npx --yes svgexport src/assets/brand/koine-icon-tile.svg /tmp/koine-icon-1024.png 1024:1024
```

and pass the PNG in Step 2 instead of the SVG.

- [ ] **Step 2: Regenerate the icon set**

```bash
cd tooling/koine-studio
npx tauri icon src/assets/brand/koine-icon-tile.svg
```

Expected: `src-tauri/icons/` rewritten — `icon.icns`, `icon.ico`, `32x32.png`, `128x128.png`,
`128x128@2x.png`, `icon.png`, and the `Square*Logo.png` / `StoreLogo.png` UWP set.

- [ ] **Step 3: Confirm the file set is unchanged in shape**

```bash
git status --porcelain tooling/koine-studio/src-tauri/icons/
```

Expected: 16 `M` lines and no `??` or `D` lines. `tauri.conf.json`'s `bundle.icon` array
names five of these by path; a renamed or missing file breaks the build. If any file was
added or removed, reconcile `bundle.icon` in the same commit.

- [ ] **Step 4: Verify visually — this is the review**

```bash
cd tooling/koine-studio && npm run tauri -- build --bundles app
open "src-tauri/target/release/bundle/macos/"
```

Look at the icon in Finder and drag the app to the Dock. Check two things that no automated
check covers:

- **Corner radius.** The tile draws `rx=28` on a 120 viewBox (23.3%); Apple's squircle is
  ~22.4%. macOS does **not** mask `.icns` content, so the shipped corners are exactly what
  the source draws. Slight mismatch is acceptable; obvious mismatch is not.
- **Inset.** macOS app icons conventionally sit inset with transparent padding rather than
  filling the canvas edge-to-edge. A full-bleed tile reads as oversized next to native icons.

If either is wrong, fix it in a copy of the SVG under `src/assets/brand/` (do not edit the
`design/` handoff original) and regenerate. A binary diff of 16 icon files is not reviewable
by reading — the screenshot is the review, so attach one to the PR.

- [ ] **Step 5: Commit**

```bash
git add tooling/koine-studio/src-tauri/icons
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "fix(studio): ship the hexagon-κ app icon in the desktop bundle

#1141 adopted the mark everywhere except src-tauri/icons/, so the macOS Dock
and Finder icon, the Windows .exe icon and every installer icon were still
Tauri's default."
```

---

### Task 6: Issue bookkeeping

**Files:** none — GitHub only.

- [ ] **Step 1: File the signature bug**

Use the `ai-migration-kit:create-issue` skill, seeded from
`docs/superpowers/specs/2026-08-03-macos-bundle-signing-and-icon-design.md` (Item A) and Tasks
1-4 of this plan.

Title: `macOS bundle ships an invalid code signature — every download opens as "damaged"`
Labels: `bug`, `priority: high`, `area: ci`

- [ ] **Step 2: File the icon issue**

Same skill, seeded from Item B of the spec and Task 5 of this plan.

Title: `Desktop bundle still ships Tauri's default icon — regenerate from the hexagon-κ mark`
Labels: `enhancement`, `area: studio`, `effort: S`

- [ ] **Step 3: Correct #1137 in place**

Edit the issue body (`gh issue edit 1137 --body-file ...`). Four corrections:

1. **The diagnosis.** It says installers "ship unsigned" and users see "the developer cannot
   be verified", recoverable by right-click ▸ Open. Measured reality: the bundle ships with an
   *invalid* signature and users see "damaged", which nothing user-facing clears. Reference
   the new bug from Step 1 as the prerequisite; #1137's remaining job is making the signature
   *trusted*, not *valid*.
2. **The blocker.** Not "obtain an Apple Developer Program membership" — that exists, under
   Atypical Consulting, team `U27M99ZACQ` (proven by an organization-team `Apple Development`
   cert; Apple issues those only under a paid membership). The blocker is creating a
   **Developer ID Application** certificate, which only the team's Account Holder can do.
3. **Hardened runtime is already solved.** `Entitlements.plist` with
   `com.apple.security.cs.allow-jit` ships in Task 2 and is already exercised by the ad-hoc
   build, so notarization inherits a working configuration rather than discovering the
   CoreCLR failure late. Record that `disable-library-validation` was measured and is not
   needed.
4. **Credentials.** Prefer App Store Connect API key (`APPLE_API_KEY`, `APPLE_API_ISSUER`,
   `APPLE_API_KEY_PATH`) over `APPLE_ID` + `APPLE_PASSWORD`; app-specific passwords expire and
   rotate poorly in CI. Note that `gh secret list` does not report organization secrets — use
   `gh api repos/{owner}/{repo}/actions/organization-secrets` when checking what is
   provisioned.

Also correct its Task 3: deleting the website Gatekeeper notes is right for the notarized end
state only, and must not be done when the signature fix lands.

- [ ] **Step 4: Cross-link**

Comment on #1141 noting that `src-tauri/icons/` was outside its scope and is now tracked by
the issue from Step 2.

---

## Self-review

**Spec coverage.** Item A code fix → Tasks 1-3. Item A docs → Task 4. Item B → Task 5.
Item C → Task 6 Step 3. Issue filing (the agreed three-way split) → Task 6 Steps 1-2.

**One spec amendment this plan forces.** The spec placed the hardened-runtime entitlements
risk under Item C (#1137, deferred). Measurement since showed `hardenedRuntime` defaults to
`true`, so `signingIdentity: "-"` alone would break the sidecar — the entitlements are a
hard prerequisite of Item A, not a later concern. Tasks 2 and 6 reflect the corrected
ordering; the spec should be amended to match.

**Type/name consistency.** `scripts/build/verify-macos-bundle.sh` is named identically in
Tasks 1, 2, and 3. The bundle path
`tooling/koine-studio/src-tauri/target/release/bundle/macos/Koine Studio.app` is identical in
Tasks 2, 3, and 5. `Entitlements.plist` is referenced by the same relative name in the config
(Task 2) and the issue correction (Task 6).

**Known cost.** Tasks 2 and 5 each require a real `tauri build` (cold cargo release build,
several minutes). There is no cheaper way to prove a bundling change; the bug being fixed was
invisible to every check that did not build and inspect the artifact.
