# macOS bundle: valid code signature and the Koine app icon

**Date:** 2026-08-03
**Status:** Design, approved for planning
**Area:** Studio (Tauri desktop), CI/release

## Context and problem statement

Two defects ship in the macOS Koine Studio desktop artifact today. They were found together
but are independent, have different urgency, and have different blockers.

1. **`Koine Studio.app` opens as "damaged and can't be opened."** Not a Gatekeeper warning —
   a hard stop with no user-facing bypass.
2. **The app icon is Tauri's stock logo** (the yellow/cyan double-circle), not the Koine
   hexagon-κ mark.

A third, dependent problem: the install instructions on the website document a workaround
that does not resolve the error users actually hit.

### Measured evidence

All facts below were measured on macOS 26.5.1 (Tahoe, Darwin 25.5.0) against the shipped
`Koine Studio 0.251.0.dmg` and the installed `/Applications/Koine Studio.app`.

**The bundle carries an invalid signature, not an absent one.**

```
$ codesign --verify --verbose=2 "/Applications/Koine Studio.app"
/Applications/Koine Studio.app: code has no resources but signature indicates they must be present

$ command ls "/Applications/Koine Studio.app/Contents"
Info.plist   MacOS   Resources          # no _CodeSignature/

$ codesign -dv --verbose=4 "/Applications/Koine Studio.app"
CodeDirectory v=20400 flags=0x20002(adhoc,linker-signed)
Signature=adhoc
Info.plist=not bound
```

The main binary carries only the Rust linker's automatic ad-hoc signature (`linker-signed`),
which is mandatory on arm64. That signature declares that sealed resources must be present,
but `tauri build` never ran `codesign` on the bundle, so `Contents/_CodeSignature/` does not
exist. The seal is declared and missing — the signature is therefore *invalid*, not merely
untrusted.

**This is how the artifact ships.** The same verification failure reproduces on the `.app`
inside the mounted `Koine Studio 0.251.0.dmg`, so it is not install-time corruption. Every
macOS download is affected.

**Invalid signature + quarantine produces "damaged", which no bypass clears.** The
`com.apple.quarantine` attribute is present (set by the downloading browser). An *untrusted
but valid* signature yields the recoverable "unidentified developer" path; an *invalid*
signature yields "damaged", which is a dead end.

**Ad-hoc signing the bundle repairs it.** Verified on a copy:

```
$ codesign --force --sign - "Koine Studio.app"
$ codesign --verify --verbose=2 "Koine Studio.app"
Koine Studio.app: valid on disk
Koine Studio.app: satisfies its Designated Requirement
```

`spctl` still reports `rejected` after this, which is correct and expected — ad-hoc is not a
Developer ID. The change that matters is invalid → valid, which moves the user from an
unrecoverable error to a recoverable prompt.

⛔ **Signing must be inside-out; `--deep` destroys the sidecar.** An earlier draft of this
document used `codesign --force --deep --sign -`, and executing it proved that wrong.
`--deep` re-signs nested binaries, replacing the sidecar's `Koine.Cli` identifier with a
generated `koine-<hash>`, after which the .NET single-file binary produces no output and does
not terminate (>60 s). The bundle seal, the bundle signature and the sidecar signature all still
verify — **only actually running the sidecar detects it.** Leave the sidecar's own signature
intact and sign the bundle alone. This independently corroborates the choice of Tauri-native
signing over a post-build `codesign` step: `tauri-bundler` signs external binaries individually
(`sign_macos_binary()`) and never uses `--deep`, which Apple deprecates.

**Stripping quarantine also works, and is the only currently-documented step that does.**

```
$ xattr -dr com.apple.quarantine "Koine Studio.app"
$ "Koine Studio.app/Contents/MacOS/koine" --version
0.251.0
```

**Hardened runtime kills the .NET sidecar, and the minimal fix is one entitlement.**
Measured after the initial draft of this design, and it changes the ordering below.
`bundle.macOS.hardenedRuntime` defaults to **`true`** in Tauri v2 (confirmed against
`https://schema.tauri.app/config/2`), so any signing configuration inherits it:

| Signing of `Contents/MacOS/koine` | Result |
|---|---|
| ad-hoc, no hardened runtime | `0.251.0`, exit 0 |
| ad-hoc + `--options runtime` | `Failed to create CoreCLR, HRESULT: 0x80070008`, SIGKILL |
| + `com.apple.security.cs.allow-jit` | `0.251.0`, exit 0 |
| + `com.apple.security.cs.allow-unsigned-executable-memory` (alone) | `0.251.0`, exit 0 |
| + `com.apple.security.cs.disable-library-validation` (alone) | still fails |

`allow-jit` alone is sufficient; `disable-library-validation` is neither sufficient nor
necessary and should not be granted. Note the failure leaves the code signature perfectly
valid — a signature-only check cannot catch it, so the verification must actually *run* the
sidecar.

**The app icon is Tauri's default.** All 16 files in `tooling/koine-studio/src-tauri/icons/`
are stock Tauri assets; `icon.png` was rendered and confirmed to be the double-circle mark.
Issue #1141 ("Adopt the new Koine hexagon-κ logo across the app, README, and website")
adopted the new mark in `logo.ts`, `index.html`, the PWA icon set, README and website — its
file list never touched `src-tauri/icons/`, so the desktop bundle was missed. The brand asset
is committed at `tooling/koine-studio/src/assets/brand/koine-icon-tile.svg`.

**The Apple signing position.** The local keychain holds three *Apple Development*
certificates and **no Developer ID Application certificate**:

```
CN=Apple Development: phmatray@gmail.com (HW46A389P3), OU=874ZH2V26J, O=Philippe Matray
CN=Apple Development: Philippe Matray (FGY4CJP3M3), OU=U27M99ZACQ, O=Atypical Consulting
CN=Apple Development: Philippe Matray (FGY4CJP3M3), OU=U27M99ZACQ, O=Atypical Consulting
```

Apple Development certs cannot notarize and cannot be used for distribution outside the App
Store. However, team `U27M99ZACQ` carries `O=Atypical Consulting` — an *organization* team,
which Apple issues only under a **paid** Developer Program membership. So the membership is
active; only the Developer ID Application certificate has not been created. That team ID also
matches the `publisher: "Atypical Consulting"` already set in `tauri.conf.json`.

CI has no signing secrets: the repo holds only `NUGET_USER`, and the organization only
`NUGET_API_KEY` (checked via `gh api repos/{o}/{r}/actions/organization-secrets`, since
`gh secret list` does not report organization secrets).

## Decision: three tracked items, not one

Issue #1137 ("Code-sign & notarize Koine Studio desktop installers") already exists, is open,
and is the natural home for notarization. It is **not** the right home for the whole of this
work, for two reasons:

- **Its problem statement is factually wrong about the current artifact.** It states the
  installers ship unsigned and that users see "the developer cannot be verified", recoverable
  by right-click → Open. The artifact actually ships with an *invalid* signature and users see
  "damaged", which right-click → Open cannot clear.
- **It is labelled `enhancement` / `priority: low` and is blocked** on a certificate that does
  not yet exist. The signature defect is a release-blocking bug that is not blocked on
  anything. Folding the two together buries an urgent fix behind a dormant one.

Therefore: one new bug (signature + docs), one new enhancement (icon), and an in-place
correction of #1137.

---

## Item A — New issue: `bug`, `priority: high`, `area: ci`

**Title:** macOS bundle ships an invalid code signature — every download opens as "damaged"

**Goal.** `codesign --verify` passes on the shipped `.app` and `.dmg`, so macOS users reach a
recoverable Gatekeeper prompt instead of a dead end.

**Non-goals.** Removing the Gatekeeper prompt entirely (that is #1137); Windows Authenticode;
Linux packaging.

**Change.** Set `bundle.macOS.signingIdentity` to `"-"` (Tauri's ad-hoc pseudo-identity) in
`tauri.conf.json`, **together with** an `Entitlements.plist` granting
`com.apple.security.cs.allow-jit`. This is not a temporary shim — it is the permanent fallback
for forks and PR builds, which will never hold signing secrets.

The open question in the first draft of this design — where signing sits relative to DMG
assembly — is resolved: Tauri v2 supports `"signingIdentity": "-"` natively and signs
inside-out (sidecar first, then bundle) *before* assembling the DMG, so no post-build
`codesign` step is needed and Apple's discouraged `--deep` is avoided. The
`APPLE_SIGNING_IDENTITY` environment variable overrides the config value, which is the seam
#1137 uses to upgrade ad-hoc to Developer ID without further config change.

**The entitlements file is a prerequisite of this item, not a #1137 concern.** Because
`hardenedRuntime` defaults to `true`, setting `signingIdentity` alone would sign the sidecar
with `--options runtime` and kill it — trading "the app won't open" for "the app opens but
cannot compile anything", a worse and far less obvious failure. Shipping the entitlement here
also makes the ad-hoc build a faithful rehearsal of the notarized build, so the only
difference at #1137 time is the identity itself.

**A verification step must accompany the fix.** This bug shipped a full release because
nothing built the artifact and inspected it. The check has to assert both that the signature
is valid *and* that the sidecar still executes, since the hardened-runtime failure leaves the
signature valid.

**Docs correction** (in the same change):

- `website/src/components/Downloads.astro:109-110`
- `website/src/content/docs/start/installation.md:18-19`

Both currently lead with "right-click the app ▸ Open". That instruction is wrong twice: it
cannot clear "damaged", and since macOS 15 Sequoia Apple removed the right-click → Open bypass
for apps that fail Gatekeeper — the path is now **System Settings → Privacy & Security → Open
Anyway**. The corrected text should lead with the Open Anyway path and keep
`xattr -dr com.apple.quarantine` (note: `-dr`, not the currently documented `-d`) as the
scripted alternative.

**Verification.**

1. `codesign --verify --verbose=2` passes on the built `.app`.
2. `Contents/_CodeSignature/` exists.
3. `Contents/MacOS/koine --version` still prints the version after signing — the check that
   catches a missing or mis-wired entitlement, which leaves (1) and (2) passing.
4. The `.app` extracted from the built `.dmg` passes (1) through (3). The original bug was
   only observable in the shipped DMG, so verifying the intermediate `.app` alone is not
   sufficient.
5. A quarantined copy reaches the "unidentified developer" prompt, not "damaged", and Open
   Anyway launches it. This is a manual check on a real machine.

Checks 1-4 belong in CI, not in a runbook. The defect reached users because the release
pipeline built an artifact and uploaded it without ever inspecting it.

**Assumption to verify, not assert.** That macOS 15+ removed the right-click → Open bypass is
stated from knowledge, not measured here. Confirm behaviourally before publishing the docs
change, since the whole point of the change is that the current instructions are untrue.

## Item B — New issue: `enhancement`, `area: studio`, `effort: S`

**Title:** Desktop bundle still ships Tauri's default icon — regenerate from the hexagon-κ mark

**Goal.** The macOS Dock/Finder icon, the Windows `.exe` icon and the installer icons show the
Koine hexagon-κ mark.

**Change.** Rasterize `tooling/koine-studio/src/assets/brand/koine-icon-tile.svg` to a
1024×1024 PNG and run `npx tauri icon`, which regenerates the full set in
`tooling/koine-studio/src-tauri/icons/`: `icon.icns`, `icon.ico`, the PNG sizes, and the UWP
`Square*Logo.png` family. All 16 existing files are replaced.

**Two points requiring visual review, not just a green build.**

- The tile uses `rx=28` on a 120 viewBox — a 23.3% corner radius, against Apple's squircle at
  roughly 22.4%. Close, but not identical, and macOS does not mask `.icns` content, so the
  shipped corners are whatever the source draws.
- macOS app icons conventionally sit inset with transparent padding rather than filling the
  canvas edge-to-edge. A full-bleed tile will read as oversized beside native icons in the
  Dock.

Neither is caught by any automated check. The acceptance criterion is a screenshot of the icon
in the Dock and in Finder alongside native apps.

**Relationship to #1141.** This is a follow-up to that closed issue, which covered every brand
surface except the desktop bundle. Reference it for the rationale behind the mark.

## Item C — Correct issue #1137 in place

Keep #1137 as the notarization issue; rewrite its problem statement and record what has since
been established.

- **Correct the diagnosis.** Replace "ship unsigned → developer cannot be verified" with the
  measured finding: the bundle ships with an *invalid* signature and produces "damaged". Cite
  Item A as the prerequisite that makes the signature valid; #1137's remaining job is to make
  it *trusted*.
- **Record the real blocker.** Not "obtain an Apple Developer Program membership" — that
  exists, under Atypical Consulting, team `U27M99ZACQ`. The blocker is creating a **Developer
  ID Application** certificate, which only the team's Account Holder can do.
- **Record that hardened runtime is already solved.** Notarization requires hardened runtime,
  and the self-contained .NET sidecar dies under it with `Failed to create CoreCLR` unless
  granted `com.apple.security.cs.allow-jit`. That entitlement ships with Item A and is
  exercised on every ad-hoc build, so notarization inherits a working configuration instead of
  discovering this late. Record that `com.apple.security.cs.disable-library-validation` was
  measured and is *not* required, so nobody adds it defensively.
- **Prefer App Store Connect API key credentials.** `APPLE_API_KEY` / `APPLE_API_ISSUER` /
  `APPLE_API_KEY_PATH` over `APPLE_ID` + `APPLE_PASSWORD`: app-specific passwords expire and
  rotate poorly in CI.
- **Correct its Task 3.** #1137 currently plans to delete the Gatekeeper workaround notes from
  the website once signing lands. That deletion is right for the notarized end state, but it
  must not happen when Item A lands — after ad-hoc signing alone, a prompt still appears and
  the notes are still needed. The comment on #1137 from #1910 lists both note locations; that
  guidance stands, but only as the final step of #1137.

## Sequencing

Item A and Item B are independent and unblocked; either can land first. Item C is
documentation-only and can land immediately. The implementation work of #1137 stays blocked
until the Developer ID Application certificate exists and the `APPLE_*` secrets are
provisioned.

Item A should land before the next release, since the current release is unopenable on macOS
without a terminal command that the documentation does not correctly describe.

## Consequences

- macOS users get a recoverable install path instead of a dead end, without any purchase or
  certificate.
- The ad-hoc fallback remains permanently valuable for forks and PR builds.
- The prompt does not disappear until #1137 lands; the docs must continue to describe it.
- Regenerating the icons replaces 16 committed binary files in one change; the diff is not
  reviewable by reading, so the visual check is the review.
